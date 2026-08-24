import { getEntryMetadata } from "@/lib/catalog/defaults";
import type { AssetId, CatalogId } from "@/lib/catalog/ids";
import { loadDevelopImage } from "@/lib/cache/develop-image-cache";
import { BASELINE_CAPABILITY_REPORT, type V3SourceSignature } from "@/lib/develop/process";
import { getDevelopRepository, type DevelopRepository } from "@/lib/develop/repository";
import {
  getOrCreateDevelopSession,
  type DevelopSessionCore,
  type DevelopSessionSnapshot,
} from "@/lib/develop/session";
import type { LibraryEntry } from "@/lib/fs/types";
import { getLibraryResultSnapshot } from "@/lib/library/result-repository";
import { useDevelopStore } from "@/stores/develop-store";
import { useLibraryStore } from "@/stores/library-store";
import {
  BatchRunnerAdapterError,
  type BatchOpenHandle,
  type BatchReconciledPhoto,
  type BatchRunnerAdapter,
  type BatchSourceSnapshot,
  type BatchValidationResult,
} from "./batch-runner";
import type { ExactBatchSelection } from "./batch";
import { applyV3EditCommand } from "./commands";
import type { DevelopDocumentV3, PersistedInputProfile } from "./document";
import { buildV3SourceRecord } from "./runtime";

export interface AppExactLibraryResult {
  readonly resultId: string;
  readonly catalogId: CatalogId;
  readonly catalogRevision: number;
  readonly orderedEntryIds: readonly AssetId[];
}

export interface AppBatchAdapterOptions {
  readonly exactResult: AppExactLibraryResult;
  readonly isCancelled?: () => boolean;
  readonly onProgress?: BatchRunnerAdapter["onProgress"];
}

export interface AppV3BatchAdapter {
  readonly adapter: BatchRunnerAdapter;
  readonly prepareSource: (sourceEntryId: AssetId) => Promise<BatchSourceSnapshot>;
}

interface OpenContext {
  readonly handle: BatchOpenHandle;
  readonly entry: LibraryEntry;
  readonly repository: DevelopRepository;
  readonly session: DevelopSessionCore;
}

function adapterError(code: string, message: string): BatchRunnerAdapterError {
  return new BatchRunnerAdapterError(code, message);
}

function v3SignatureForEntry(entry: LibraryEntry): V3SourceSignature {
  return {
    entryId: entry.id,
    catalogId: entry.catalogId,
    assetRevision: entry.assetRevision,
    relativePath: entry.relativePath,
    size: entry.size,
    lastModified: entry.lastModified,
  };
}

function sameSignature(left: V3SourceSignature, right: V3SourceSignature): boolean {
  return left.entryId === right.entryId &&
    left.catalogId === right.catalogId &&
    left.assetRevision === right.assetRevision &&
    left.relativePath === right.relativePath &&
    left.size === right.size &&
    left.lastModified === right.lastModified;
}

function currentEntry(entryId: AssetId, catalogId: CatalogId): LibraryEntry | null {
  return useLibraryStore.getState().entries.find(
    (entry) => entry.id === entryId && entry.catalogId === catalogId,
  ) ?? null;
}

function currentV3Snapshot(
  context: OpenContext,
  expectedRevision?: string,
): Extract<DevelopSessionSnapshot, { readonly processKind: "v3" }> {
  const snapshot = context.session.snapshot();
  if (snapshot.processKind !== "v3") {
    throw adapterError("process-changed", "The target is no longer an editable v3 photo.");
  }
  if (expectedRevision !== undefined && String(snapshot.documentRevision) !== expectedRevision) {
    throw adapterError("revision-conflict", "The target Develop document changed during the batch.");
  }
  const latest = currentEntry(context.entry.id, context.entry.catalogId);
  if (!latest || latest.health !== "present") {
    throw adapterError("source-missing", "The target source is no longer available.");
  }
  if (!sameSignature(v3SignatureForEntry(latest), v3SignatureForEntry(context.entry))) {
    throw adapterError("source-changed", "The target source changed during the batch.");
  }
  return snapshot;
}

async function v3Reconciled(context: OpenContext): Promise<Extract<BatchReconciledPhoto, { readonly kind: "v3" }>> {
  const snapshot = currentV3Snapshot(context);
  const image = await loadDevelopImage(context.entry);
  const source = buildV3SourceRecord(context.entry, image, "preview");
  if (source.kind === "blocked") {
    throw adapterError(
      "source-unavailable",
      "reason" in source.diagnostic
        ? source.diagnostic.reason
        : `Source preparation is blocked by ${source.diagnostic.kind}.`,
    );
  }
  return {
    kind: "v3",
    catalogId: context.entry.catalogId,
    entryId: context.entry.id,
    document: snapshot.document,
    documentRevision: String(snapshot.documentRevision),
    source: source.source,
    capabilities: BASELINE_CAPABILITY_REPORT,
  };
}

function profileCompatible(
  profile: PersistedInputProfile,
  source: BatchSourceSnapshot,
  target: Extract<BatchReconciledPhoto, { readonly kind: "v3" }>,
): boolean {
  if (profile.selection.kind !== "decoder-default") return false;
  const sourceProfile = source.source.inputProfile;
  const targetProfile = target.source.inputProfile;
  return sourceProfile.kind === "decoder-default" &&
    targetProfile.kind === "decoder-default" &&
    sourceProfile.decoderId === targetProfile.decoderId &&
    sourceProfile.decoderColorSpace === targetProfile.decoderColorSpace;
}

function validateGroupCapability(
  group: Parameters<BatchRunnerAdapter["validate"]>[0] & { readonly kind: "group-capability" },
): BatchValidationResult {
  switch (group.group) {
    case "output-intent":
      return {
        kind: "unsupported",
        reason: "unsupported-capability",
        message: "Batch export is not connected. Develop settings can be saved only.",
      };
    case "lens-blur":
      return {
        kind: "unsupported",
        reason: "unsupported-capability",
        message: "Lens Blur cannot be copied because no depth model is available.",
      };
    case "hdr-edit":
      return {
        kind: "unsupported",
        reason: "unsupported-capability",
        message: "HDR editing is unavailable in the proven SDR RGBA8 tier.",
      };
    case "optics": {
      const optics = group.proposedDocument.optics;
      const profileNeutral = optics.profile.kind === "off" &&
        optics.amounts.distortion === 0 &&
        optics.amounts.illumination === 0 &&
        optics.amounts.lateralChromaticAberration === 0;
      return profileNeutral
        ? { kind: "supported" }
        : {
            kind: "unsupported",
            reason: "unsupported-capability",
            message: "Automatic lens profiles cannot be copied because no licensed profile registry is installed.",
          };
    }
    case "input-profile":
    case "white-balance":
    case "geometry-and-crop":
    case "tone":
    case "curve-and-color":
    case "local-adjustments":
    case "presence":
    case "detail":
    case "cleanup":
    case "post-crop-effects":
      return { kind: "supported" };
    default: {
      const exhaustive: never = group.group;
      return exhaustive;
    }
  }
}

function selectionMatchesResult(
  selection: ExactBatchSelection,
  result: AppExactLibraryResult,
): boolean {
  if (
    selection.resultId !== result.resultId ||
    selection.catalogId !== result.catalogId ||
    selection.catalogRevision !== result.catalogRevision
  ) return false;
  const selected = new Set(selection.entryIds);
  if (selected.size !== selection.entryIds.length) return false;
  return result.orderedEntryIds.filter((entryId) => selected.has(entryId)).every(
    (entryId, index) => entryId === selection.entryIds[index],
  ) && selection.entryIds.every((entryId) => result.orderedEntryIds.includes(entryId));
}

function persistedResultMatches(result: AppExactLibraryResult): boolean {
  const snapshot = getLibraryResultSnapshot(result.resultId);
  return snapshot !== null &&
    snapshot.catalogId === result.catalogId &&
    snapshot.catalogRevision === result.catalogRevision &&
    snapshot.orderedEntryIds.length === result.orderedEntryIds.length &&
    snapshot.orderedEntryIds.every((entryId, index) => entryId === result.orderedEntryIds[index]);
}

export function createAppV3BatchAdapter(
  options: AppBatchAdapterOptions,
): AppV3BatchAdapter {
  const contextsByToken = new Map<string, OpenContext>();
  const contextsByEntry = new Map<AssetId, OpenContext>();

  const requireContext = (entryId: AssetId): OpenContext => {
    const context = contextsByEntry.get(entryId);
    if (!context) throw adapterError("not-open", "The batch target is not open.");
    return context;
  };

  const open: BatchRunnerAdapter["open"] = async ({ selection, entryId }) => {
    if (!selectionMatchesResult(selection, options.exactResult) || !selection.entryIds.includes(entryId)) {
      throw adapterError("selection-mismatch", "The requested photo is outside the exact Library selection.");
    }
    const existing = contextsByEntry.get(entryId);
    if (existing) return existing.handle;
    const entry = currentEntry(entryId, selection.catalogId);
    if (!entry || entry.health !== "present") {
      throw adapterError("missing-entry", "This photo is missing from the stored Library result.");
    }
    const library = useLibraryStore.getState();
    const metadata = getEntryMetadata(library.entryMetadata, entry.id);
    const repository = getDevelopRepository(entry);
    const session = getOrCreateDevelopSession(
      entry.catalogId,
      entry.id,
      repository.catalogDocument(metadata),
    );
    repository.configure(session, metadata, {
      mirrorCatalog: (input) => useLibraryStore.getState().persistDevelopState(
        entry.catalogId,
        entry.id,
        input,
      ),
      hydrateKeywords: (flat, hierarchical) => {
        useLibraryStore.getState().hydrateEntryKeywords(entry.id, flat, hierarchical);
      },
      setStatus: (status, error = null) => {
        const develop = useDevelopStore.getState();
        if (develop.activeCatalogId === entry.catalogId && develop.activeEntryId === entry.id) {
          develop.setSidecarStatus(status, error);
        }
      },
      onSessionChanged: (snapshot) => {
        useDevelopStore.getState().synchronizeSession(entry.id, snapshot);
      },
    });
    await repository.open(metadata);
    const handle = { entryId, token: crypto.randomUUID() } satisfies BatchOpenHandle;
    const context = { handle, entry, repository, session } satisfies OpenContext;
    contextsByEntry.set(entryId, context);
    contextsByToken.set(handle.token, context);
    return handle;
  };

  const adapter: BatchRunnerAdapter = {
    validateSelection: async (selection) => {
      const library = useLibraryStore.getState();
      return selectionMatchesResult(selection, options.exactResult) &&
          persistedResultMatches(options.exactResult) &&
          library.catalogId === options.exactResult.catalogId &&
          library.catalogRevision === options.exactResult.catalogRevision
        ? { kind: "current" }
        : { kind: "stale", message: "The stored Library result or catalog changed. Refresh it before batching." };
    },
    open,
    reconcile: async ({ selection, handle }) => {
      if (!selectionMatchesResult(selection, options.exactResult)) {
        throw adapterError("selection-stale", "The exact Library selection changed.");
      }
      const context = contextsByToken.get(handle.token);
      if (!context || context.entry.id !== handle.entryId) {
        throw adapterError("open-handle", "The batch photo handle is invalid.");
      }
      const snapshot = context.session.snapshot();
      if (snapshot.processKind === "v2") {
        return {
          kind: "v2",
          catalogId: context.entry.catalogId,
          entryId: context.entry.id,
          documentRevision: String(snapshot.documentRevision),
        };
      }
      if (snapshot.processKind === "read-only-newer") {
        return {
          kind: "read-only-newer",
          catalogId: context.entry.catalogId,
          entryId: context.entry.id,
          documentRevision: String(snapshot.documentRevision),
          foundVersion: snapshot.readOnly.foundVersion,
        };
      }
      return v3Reconciled(context);
    },
    validate: async (request) => {
      switch (request.kind) {
        case "group-capability":
          return validateGroupCapability(request);
        case "input-profile-compatibility":
          return profileCompatible(request.profile, request.source, request.target)
            ? { kind: "compatible-profile" }
            : {
                kind: "incompatible-profile",
                message: "The decoder-provided input profiles do not match. The profile was not copied.",
              };
        case "crop": {
          try {
            const result = applyV3EditCommand(request.target.document, {
              kind: "replace-v3-semantic-group",
              group: "geometry",
              value: { ...request.source.document.geometry, crop: request.crop },
            });
            return { kind: "valid-crop", crop: result.document.geometry.crop };
          } catch (error) {
            return {
              kind: "invalid-crop",
              message: error instanceof Error ? error.message : "The crop is invalid for this photo.",
            };
          }
        }
        default: {
          const exhaustive: never = request;
          return exhaustive;
        }
      }
    },
    revalidate: async ({ source, target }) => {
      const sourceContext = requireContext(source.entryId);
      const targetContext = requireContext(target.entryId);
      try {
        const sourceSnapshot = currentV3Snapshot(sourceContext, source.documentRevision);
        currentV3Snapshot(targetContext, target.documentRevision);
        const currentSource = v3SignatureForEntry(sourceContext.entry);
        const currentTarget = v3SignatureForEntry(targetContext.entry);
        if (
          sourceSnapshot.document.version !== 3 ||
          !sameSignature(currentSource, source.signature) ||
          !sameSignature(currentTarget, target.signature)
        ) {
          return { kind: "conflict", message: "The source or target changed during the batch." };
        }
        return { kind: "current" };
      } catch (error) {
        return {
          kind: "conflict",
          message: error instanceof Error ? error.message : "The source or target changed during the batch.",
        };
      }
    },
    dispatch: async ({ entryId, expectedDocumentRevision, source, commands, label }) => {
      const sourceContext = requireContext(source.entryId);
      currentV3Snapshot(sourceContext, source.documentRevision);
      const context = requireContext(entryId);
      const before = currentV3Snapshot(context, expectedDocumentRevision);
      let planned: DevelopDocumentV3 = before.document;
      for (const command of commands) planned = applyV3EditCommand(planned, command).document;
      context.session.beginEditGroup(label);
      try {
        for (const command of commands) context.session.dispatch(command, label);
      } finally {
        context.session.endEditGroup();
      }
      const after = currentV3Snapshot(context);
      useDevelopStore.getState().synchronizeSession(entryId, after);
      return {
        document: after.document,
        documentRevision: String(after.documentRevision),
      };
    },
    save: async ({ entryId, expectedDocumentRevision, source }) => {
      const sourceContext = requireContext(source.entryId);
      currentV3Snapshot(sourceContext, source.documentRevision);
      const context = requireContext(entryId);
      const before = currentV3Snapshot(context, expectedDocumentRevision);
      await context.session.save();
      await context.repository.flush();
      const after = currentV3Snapshot(context, expectedDocumentRevision);
      if (
        after.documentRevision !== before.documentRevision ||
        after.persistedDocumentRevision !== after.documentRevision
      ) {
        throw adapterError("save-not-persisted", "Develop settings were not persisted. Review the XMP save status and retry.");
      }
      useDevelopStore.getState().synchronizeSession(entryId, after);
      return { documentRevision: String(after.documentRevision) };
    },
    ...(options.isCancelled ? { isCancelled: options.isCancelled } : {}),
    ...(options.onProgress ? { onProgress: options.onProgress } : {}),
  };

  return {
    adapter,
    prepareSource: async (sourceEntryId) => {
      const selection: ExactBatchSelection = {
        source: "stored-library-result",
        resultId: options.exactResult.resultId,
        catalogId: options.exactResult.catalogId,
        catalogRevision: options.exactResult.catalogRevision,
        entryIds: [sourceEntryId],
      };
      const handle = await open({ selection, entryId: sourceEntryId });
      const reconciled = await adapter.reconcile({ selection, handle });
      if (reconciled.kind !== "v3") {
        throw adapterError("source-process", "Batch copying requires an editable v3 source photo.");
      }
      return reconciled;
    },
  };
}
