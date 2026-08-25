import type { EntryMetadata } from "@/lib/catalog/types";
import {
  applyDevelopCommand,
  replayDevelopPatches,
  type DevelopCommand,
  type DevelopPatch,
} from "@/lib/develop/commands";
import {
  renderFrozenV2,
  type FrozenV2ExportRequest,
  type FrozenV2PrepareRequest,
  type FrozenV2PreviewRequest,
} from "@/lib/develop/frozen-v2-backend";
import type {
  DevelopDiagnostic,
  V3SourceSignature,
} from "@/lib/develop/process";
import type {
  CropSettings,
  DevelopDocument,
  SourceSignature,
} from "@/lib/develop/types";
import { decodePersistedDevelopDocument } from "@/lib/develop/v3/codec";
import {
  applyV3EditCommand,
  type V3EditCommand,
} from "@/lib/develop/v3/commands";
import type {
  DevelopDocumentV3,
  NewerDevelopDocument,
  PersistedDevelopDocument,
} from "@/lib/develop/v3/document";
import {
  createV3MigrationCandidate,
  type RequiredV2AssetCopy,
} from "@/lib/develop/v3/migration";
import type { DevelopAssetRef } from "@/lib/develop/v3/assets";
import type { CpuRenderResult } from "@/lib/develop/v3/cpu-backend";
import {
  renderV3Runtime,
  type V3SessionRenderRequest,
} from "@/lib/develop/v3/runtime";
import type { RawExportRenderResult } from "@/lib/export/types";
import { sourceSignaturesEqual } from "@/lib/develop/source-transform";
import type { RenderPreparation } from "@/lib/develop/renderer";

const HISTORY_LIMIT = 100;

export type DevelopMetadataValues = Pick<
  EntryMetadata,
  "pick" | "rating" | "colorLabel"
>;

export interface DevelopReadOnlyReason {
  readonly code: "newer-process";
  readonly foundVersion: number;
  readonly message: string;
  readonly diagnostic: Extract<
    DevelopDiagnostic,
    { readonly kind: "newer-process-read-only" }
  >;
}

export type DevelopSessionOpenDocument =
  | { readonly kind: "editable"; readonly document: PersistedDevelopDocument }
  | {
      readonly kind: "read-only-newer";
      readonly raw: NewerDevelopDocument;
      readonly reason: DevelopReadOnlyReason;
    };

export function openDevelopSessionDocument(
  value: unknown,
): DevelopSessionOpenDocument {
  const decoded = decodePersistedDevelopDocument(value);
  if (decoded.kind === "invalid") {
    throw new DevelopSessionCommandError("invalid-document", decoded.message);
  }
  if (decoded.kind === "read-only-newer") {
    return {
      kind: "read-only-newer",
      raw: decoded.raw,
      reason: {
        code: "newer-process",
        foundVersion: decoded.foundVersion,
        message: `Develop process v${decoded.foundVersion} is newer than this app and is read-only.`,
        diagnostic: decoded.diagnostic,
      },
    };
  }
  return { kind: "editable", document: decoded.document };
}

export interface V3CompleteStatePatch {
  readonly kind: "replace-v3-complete-state";
  readonly document: DevelopDocumentV3;
}

export interface CommittedDevelopCommand {
  readonly entryId: string;
  readonly operationId: string;
  readonly label: string;
  readonly before: DevelopDocumentV3;
  readonly after: DevelopDocumentV3;
  readonly forwardPatch: V3CompleteStatePatch;
  readonly inversePatch: V3CompleteStatePatch;
}

export type DevelopHistoryEntry =
  | {
      readonly kind: "document";
      readonly label: string;
      readonly patches: readonly DevelopPatch[];
      readonly editGroup: string | null;
    }
  | {
      readonly kind: "v3-document";
      readonly label: string;
      readonly command: CommittedDevelopCommand;
    }
  | {
      readonly kind: "v3-document-metadata";
      readonly label: string;
      readonly command: CommittedDevelopCommand;
      readonly beforeMetadata: DevelopMetadataValues;
      readonly afterMetadata: DevelopMetadataValues;
    }
  | {
      readonly kind: "metadata";
      readonly label: string;
      readonly before: DevelopMetadataValues;
      readonly after: DevelopMetadataValues;
    };

interface DevelopSessionSnapshotBase {
  readonly catalogId: string;
  readonly entryId: string;
  readonly documentRevision: number;
  readonly persistedDocumentRevision: number;
  readonly metadataRevision: number;
  readonly persistedMetadataRevision: number;
  readonly undo: readonly DevelopHistoryEntry[];
  readonly redo: readonly DevelopHistoryEntry[];
  readonly transientEdit: { readonly id: string; readonly label: string } | null;
  readonly previewDocument: DevelopDocumentV3 | null;
}

export type DevelopSessionSnapshot = DevelopSessionSnapshotBase & (
  | {
      readonly processKind: "v2";
      readonly document: DevelopDocument;
      readonly readOnly: null;
    }
  | {
      readonly processKind: "v3";
      readonly document: DevelopDocumentV3;
      readonly readOnly: null;
    }
  | {
      readonly processKind: "read-only-newer";
      readonly document: null;
      readonly rawDocument: NewerDevelopDocument;
      readonly readOnly: DevelopReadOnlyReason;
    }
);

export interface DevelopSaveResult {
  readonly status: "scheduled" | "saved";
  readonly documentRevision: number;
  readonly metadataRevision: number;
}

export interface DevelopSessionRepository {
  save(snapshot: DevelopSessionSnapshot): Promise<DevelopSaveResult>;
}

export interface DevelopMetadataMutation {
  readonly entryId: string;
  readonly values: DevelopMetadataValues;
}

export interface DevelopCompositeCommitResult {
  readonly snapshot: DevelopSessionSnapshot;
  readonly documentChanged: boolean;
  readonly metadataChanged: boolean;
}

export interface V3AssetCopyReceipt {
  readonly kind: "copied";
  readonly references: readonly DevelopAssetRef[];
}

export interface V3UpgradeAssetCopyAdapter {
  copyRequiredAssets(input: {
    readonly catalogId: string;
    readonly entryId: string;
    readonly sourceSignature: V3SourceSignature;
    readonly copies: readonly RequiredV2AssetCopy[];
  }): Promise<V3AssetCopyReceipt>;
}

export type DevelopSessionControlCommand =
  | { readonly kind: "undo" }
  | { readonly kind: "redo" }
  | { readonly kind: "commit-v2-crop-draft"; readonly crop: CropSettings };

export type DevelopSessionCommand =
  | DevelopCommand
  | V3EditCommand
  | DevelopSessionControlCommand;

export type DevelopSessionCommandErrorCode =
  | "asset-copy-required"
  | "asset-copy-failed"
  | "asset-copy-invalid"
  | "invalid-document"
  | "process-mismatch"
  | "read-only"
  | "upgrade-stale";

export class DevelopSessionCommandError extends Error {
  readonly code: DevelopSessionCommandErrorCode;

  constructor(code: DevelopSessionCommandErrorCode, message: string) {
    super(message);
    this.name = "DevelopSessionCommandError";
    this.code = code;
  }
}

export class DevelopRenderUnavailableError extends Error {
  readonly code: "v3-process-required" | "newer-process-read-only";

  constructor(
    code: "v3-process-required" | "newer-process-read-only",
    message: string,
  ) {
    super(message);
    this.name = "DevelopRenderUnavailableError";
    this.code = code;
  }
}

export interface DevelopSession {
  readonly catalogId: string;
  readonly entryId: string;
  snapshot(): DevelopSessionSnapshot;
  dispatch(command: DevelopSessionCommand, label?: string): DevelopSessionSnapshot;
  subscribeCommittedCommands(
    listener: (command: CommittedDevelopCommand) => void,
  ): () => void;
  beginEditGroup(label: string): DevelopSessionSnapshot;
  endEditGroup(): DevelopSessionSnapshot;
  cancelEditGroup(): DevelopSessionSnapshot;
  commitV3CompleteStateWithMetadata(
    document: DevelopDocumentV3,
    beforeMetadata: DevelopMetadataValues,
    afterMetadata: DevelopMetadataValues,
    label: string,
  ): DevelopCompositeCommitResult;
  upgradeToCurrentProcess(): Promise<DevelopSessionSnapshot>;
  render(request: FrozenV2PrepareRequest): Promise<RenderPreparation>;
  render(request: FrozenV2PreviewRequest): Promise<RenderPreparation>;
  render(request: FrozenV2ExportRequest): Promise<RawExportRenderResult>;
  render(request: V3SessionRenderRequest): Promise<CpuRenderResult>;
  attachSourceSignatureProvider(
    provider: (() => Readonly<SourceSignature> | null) | null,
  ): () => void;
  save(): Promise<DevelopSaveResult>;
}

interface MutableDevelopSessionState {
  process: DevelopSessionOpenDocument;
  documentRevision: number;
  persistedDocumentRevision: number;
  metadataRevision: number;
  persistedMetadataRevision: number;
  undo: DevelopHistoryEntry[];
  redo: DevelopHistoryEntry[];
  transientEdit:
    | { kind: "v2"; id: string; label: string }
    | {
        kind: "v3";
        id: string;
        label: string;
        previewDocument: DevelopDocumentV3;
      }
    | null;
}

function metadataValues(metadata: DevelopMetadataValues): DevelopMetadataValues {
  return {
    pick: metadata.pick,
    rating: metadata.rating,
    colorLabel: metadata.colorLabel,
  };
}

function boundedHistory(entries: DevelopHistoryEntry[]): DevelopHistoryEntry[] {
  return entries.length > HISTORY_LIMIT
    ? entries.slice(entries.length - HISTORY_LIMIT)
    : entries;
}

function createCommittedDevelopCommand(
  entryId: string,
  label: string,
  before: DevelopDocumentV3,
  after: DevelopDocumentV3,
): CommittedDevelopCommand {
  return {
    entryId,
    operationId: crypto.randomUUID(),
    label,
    before,
    after,
    forwardPatch: { kind: "replace-v3-complete-state", document: after },
    inversePatch: { kind: "replace-v3-complete-state", document: before },
  };
}

function patchTarget(patch: DevelopPatch): string {
  switch (patch.kind) {
    case "global": return `global:${patch.pluginId}`;
    case "masking": return "masking";
    case "asset": return `asset:${patch.assetId}`;
    default: {
      const exhaustive: never = patch;
      return exhaustive;
    }
  }
}

function mergePatch(current: DevelopPatch, next: DevelopPatch): DevelopPatch {
  switch (current.kind) {
    case "masking":
      return next.kind === "masking" ? { ...current, after: next.after } : current;
    case "asset":
      return next.kind === "asset" && next.assetId === current.assetId
        ? { ...current, after: next.after }
        : current;
    case "global": {
      if (next.kind !== "global" || next.pluginId !== current.pluginId) return current;
      switch (current.pluginId) {
        case "basic": return next.pluginId === "basic" ? { ...current, after: next.after } : current;
        case "crop": return next.pluginId === "crop" ? { ...current, after: next.after } : current;
        case "curve": return next.pluginId === "curve" ? { ...current, after: next.after } : current;
        case "mixer": return next.pluginId === "mixer" ? { ...current, after: next.after } : current;
        case "effects": return next.pluginId === "effects" ? { ...current, after: next.after } : current;
        default: {
          const exhaustive: never = current;
          return exhaustive;
        }
      }
    }
    default: {
      const exhaustive: never = current;
      return exhaustive;
    }
  }
}

function mergeGroupedPatches(
  current: readonly DevelopPatch[],
  next: readonly DevelopPatch[],
): DevelopPatch[] {
  const merged = [...current];
  const targetIndexes = new Map(
    merged.map((patch, index) => [patchTarget(patch), index]),
  );
  for (const patch of next) {
    const target = patchTarget(patch);
    const index = targetIndexes.get(target);
    if (index === undefined) {
      targetIndexes.set(target, merged.length);
      merged.push(patch);
      continue;
    }
    const existing = merged[index];
    if (existing) merged[index] = mergePatch(existing, patch);
  }
  return merged;
}

function isV3EditCommand(command: DevelopSessionCommand): command is V3EditCommand {
  switch (command.kind) {
    case "replace-v3-semantic-group":
    case "patch-v3-semantic-group":
    case "reset-v3-semantic-group":
    case "reset-v3-all":
    case "commit-v3-crop-draft":
    case "accept-v3-job-result":
    case "replace-v3-complete-state":
      return true;
    default:
      return false;
  }
}

function sameAssetReference(left: DevelopAssetRef, right: DevelopAssetRef): boolean {
  return left.assetId === right.assetId &&
    left.kind === right.kind &&
    left.sha256 === right.sha256 &&
    left.producerRevision === right.producerRevision &&
    left.coordinateFrameRevision === right.coordinateFrameRevision &&
    left.colorStageId === right.colorStageId;
}

function invalidV3Render(reason: string): CpuRenderResult {
  return {
    kind: "invalid",
    issues: [{ kind: "request-mismatch", reason }],
  };
}

export class DevelopSessionCore implements DevelopSession {
  readonly catalogId: string;
  readonly entryId: string;
  #state: MutableDevelopSessionState;
  #repository: DevelopSessionRepository | null;
  #assetCopy: V3UpgradeAssetCopyAdapter | null = null;
  #sourceSignatureProvider: (() => Readonly<SourceSignature> | null) | null = null;
  #committedCommandListeners = new Set<
    (command: CommittedDevelopCommand) => void
  >();

  constructor(
    catalogId: string,
    entryId: string,
    initial: DevelopSessionOpenDocument,
    repository: DevelopSessionRepository | null = null,
  ) {
    this.catalogId = catalogId;
    this.entryId = entryId;
    this.#repository = repository;
    this.#state = {
      process: initial,
      documentRevision: 0,
      persistedDocumentRevision: 0,
      metadataRevision: 0,
      persistedMetadataRevision: 0,
      undo: [],
      redo: [],
      transientEdit: null,
    };
  }

  attachRepository(repository: DevelopSessionRepository): void {
    this.#repository = repository;
  }

  attachUpgradeAssetCopy(adapter: V3UpgradeAssetCopyAdapter | null): void {
    this.#assetCopy = adapter;
  }

  attachSourceSignatureProvider(
    provider: (() => Readonly<SourceSignature> | null) | null,
  ): () => void {
    this.#sourceSignatureProvider = provider;
    return () => {
      if (this.#sourceSignatureProvider === provider) {
        this.#sourceSignatureProvider = null;
      }
    };
  }

  snapshot(): DevelopSessionSnapshot {
    const common = {
      catalogId: this.catalogId,
      entryId: this.entryId,
      documentRevision: this.#state.documentRevision,
      persistedDocumentRevision: this.#state.persistedDocumentRevision,
      metadataRevision: this.#state.metadataRevision,
      persistedMetadataRevision: this.#state.persistedMetadataRevision,
      undo: [...this.#state.undo],
      redo: [...this.#state.redo],
      transientEdit: this.#state.transientEdit
        ? { id: this.#state.transientEdit.id, label: this.#state.transientEdit.label }
        : null,
      previewDocument: this.#state.transientEdit?.kind === "v3"
        ? this.#state.transientEdit.previewDocument
        : null,
    };
    if (this.#state.process.kind === "read-only-newer") {
      return {
        ...common,
        processKind: "read-only-newer",
        document: null,
        rawDocument: this.#state.process.raw,
        readOnly: this.#state.process.reason,
      };
    }
    if (this.#state.process.document.version === 2) {
      return {
        ...common,
        processKind: "v2",
        document: this.#state.process.document,
        readOnly: null,
      };
    }
    return {
      ...common,
      processKind: "v3",
      document: this.#state.process.document,
      readOnly: null,
    };
  }

  subscribeCommittedCommands(
    listener: (command: CommittedDevelopCommand) => void,
  ): () => void {
    this.#committedCommandListeners.add(listener);
    return () => this.#committedCommandListeners.delete(listener);
  }

  hydrate(process: DevelopSessionOpenDocument): DevelopSessionSnapshot {
    if (this.#state.documentRevision !== this.#state.persistedDocumentRevision) {
      return this.snapshot();
    }
    this.#state = {
      ...this.#state,
      process,
      documentRevision: this.#state.documentRevision + 1,
      persistedDocumentRevision: this.#state.persistedDocumentRevision + 1,
      undo: this.#state.undo.filter((entry) => entry.kind === "metadata"),
      redo: this.#state.redo.filter((entry) => entry.kind === "metadata"),
      transientEdit: null,
    };
    return this.snapshot();
  }

  hydrateAuthoritative(process: DevelopSessionOpenDocument): DevelopSessionSnapshot {
    const revision = this.#state.documentRevision + 1;
    this.#state = {
      ...this.#state,
      process,
      documentRevision: revision,
      persistedDocumentRevision: revision,
      undo: [],
      redo: [],
      transientEdit: null,
    };
    return this.snapshot();
  }

  dispatch(
    command: DevelopSessionCommand,
    label = "Edit",
  ): DevelopSessionSnapshot {
    if (command.kind === "undo") {
      this.undo();
      return this.snapshot();
    }
    if (command.kind === "redo") {
      this.redo();
      return this.snapshot();
    }
    if (this.#state.process.kind === "read-only-newer") {
      throw new DevelopSessionCommandError("read-only", this.#state.process.reason.message);
    }
    if (command.kind === "commit-v2-crop-draft") {
      if (this.#state.process.document.version !== 2) {
        throw new DevelopSessionCommandError(
          "process-mismatch",
          "Use the v3 crop command for a v3 document.",
        );
      }
      return this.#dispatchV2(
        {
          kind: "replace-global",
          pluginId: "crop",
          value: command.crop,
        },
        label,
      );
    }
    if (isV3EditCommand(command)) {
      if (this.#state.process.document.version !== 3) {
        throw new DevelopSessionCommandError(
          "process-mismatch",
          "Upgrade the v2 document before applying v3 edits.",
        );
      }
      return this.#dispatchV3(command, label);
    }
    if (this.#state.process.document.version !== 2) {
      throw new DevelopSessionCommandError(
        "process-mismatch",
        "Frozen v2 commands cannot edit a v3 document.",
      );
    }
    return this.#dispatchV2(command, label);
  }

  #dispatchV2(command: DevelopCommand, label: string): DevelopSessionSnapshot {
    if (this.#state.process.kind !== "editable" || this.#state.process.document.version !== 2) {
      throw new DevelopSessionCommandError("process-mismatch", "The session is not editable v2.");
    }
    const result = applyDevelopCommand(this.#state.process.document, command);
    if (!result.changed) return this.snapshot();
    const editGroup = this.#state.transientEdit?.id ?? null;
    const previous = this.#state.undo.at(-1);
    if (editGroup && previous?.kind === "document" && previous.editGroup === editGroup) {
      this.#state.undo[this.#state.undo.length - 1] = {
        ...previous,
        patches: mergeGroupedPatches(previous.patches, result.patches),
      };
    } else {
      this.#state.undo = boundedHistory([
        ...this.#state.undo,
        {
          kind: "document",
          label: this.#state.transientEdit?.label ?? label,
          patches: result.patches,
          editGroup,
        },
      ]);
    }
    this.#state.process = { kind: "editable", document: result.document };
    this.#state.documentRevision += 1;
    this.#state.redo = [];
    return this.snapshot();
  }

  #dispatchV3(command: V3EditCommand, label: string): DevelopSessionSnapshot {
    if (this.#state.process.kind !== "editable" || this.#state.process.document.version !== 3) {
      throw new DevelopSessionCommandError("process-mismatch", "The session is not editable v3.");
    }
    const preview = this.#state.transientEdit?.kind === "v3"
      ? this.#state.transientEdit
      : null;
    const baseDocument = preview?.previewDocument ?? this.#state.process.document;
    const result = applyV3EditCommand(baseDocument, command);
    if (!result.changed) return this.snapshot();
    if (preview) {
      preview.previewDocument = result.document;
      return this.snapshot();
    }
    return this.#commitV3Document(result.document, label);
  }

  #commitV3Document(
    after: DevelopDocumentV3,
    label: string,
  ): DevelopSessionSnapshot {
    return this.#commitV3DocumentWithMetadata(after, label).snapshot;
  }

  commitV3CompleteStateWithMetadata(
    document: DevelopDocumentV3,
    beforeMetadata: DevelopMetadataValues,
    afterMetadata: DevelopMetadataValues,
    label: string,
  ): DevelopCompositeCommitResult {
    return this.#commitV3DocumentWithMetadata(document, label, {
      before: metadataValues(beforeMetadata),
      after: metadataValues(afterMetadata),
    });
  }

  #commitV3DocumentWithMetadata(
    after: DevelopDocumentV3,
    label: string,
    metadata?: {
      readonly before: DevelopMetadataValues;
      readonly after: DevelopMetadataValues;
    },
  ): DevelopCompositeCommitResult {
    if (this.#state.process.kind !== "editable" || this.#state.process.document.version !== 3) {
      throw new DevelopSessionCommandError("process-mismatch", "The session is not editable v3.");
    }
    const before = this.#state.process.document;
    const validatedAfter = decodePersistedDevelopDocument(after);
    if (validatedAfter.kind !== "editable" || validatedAfter.document.version !== 3) {
      throw new DevelopSessionCommandError(
        "invalid-document",
        validatedAfter.kind === "invalid"
          ? validatedAfter.message
          : "The completed command did not produce an editable v3 document.",
      );
    }
    const documentChanged = JSON.stringify(before) !== JSON.stringify(validatedAfter.document);
    const metadataChanged = metadata !== undefined &&
      JSON.stringify(metadata.before) !== JSON.stringify(metadata.after);
    if (!documentChanged) {
      if (metadataChanged && metadata) {
        this.#state.undo = boundedHistory([
          ...this.#state.undo,
          {
            kind: "metadata",
            label,
            before: metadata.before,
            after: metadata.after,
          },
        ]);
        this.#state.redo = [];
        this.#state.metadataRevision += 1;
      }
      return { snapshot: this.snapshot(), documentChanged, metadataChanged };
    }
    const command = createCommittedDevelopCommand(
      this.entryId,
      label,
      before,
      validatedAfter.document,
    );
    this.#state.undo = boundedHistory([
      ...this.#state.undo,
      metadataChanged && metadata
        ? {
            kind: "v3-document-metadata",
            label,
            command,
            beforeMetadata: metadata.before,
            afterMetadata: metadata.after,
          }
        : { kind: "v3-document", label, command },
    ]);
    this.#state.process = { kind: "editable", document: command.after };
    this.#state.documentRevision += 1;
    if (metadataChanged) this.#state.metadataRevision += 1;
    this.#state.redo = [];
    this.#emitCommittedCommand(command);
    return { snapshot: this.snapshot(), documentChanged, metadataChanged };
  }

  #emitCommittedCommand(command: CommittedDevelopCommand): void {
    for (const listener of this.#committedCommandListeners) {
      try {
        listener(command);
      } catch {
        continue;
      }
    }
  }

  async upgradeToCurrentProcess(): Promise<DevelopSessionSnapshot> {
    if (this.#state.process.kind === "read-only-newer") {
      throw new DevelopSessionCommandError("read-only", this.#state.process.reason.message);
    }
    if (this.#state.process.document.version === 3) return this.snapshot();
    const sourceDocument = this.#state.process.document;
    const sourceDocumentRevision = this.#state.documentRevision;
    const candidate = createV3MigrationCandidate(sourceDocument);
    const currentSourceSignature = this.#sourceSignatureProvider?.() ?? null;
    if (
      currentSourceSignature === null ||
      currentSourceSignature.catalogId === undefined ||
      currentSourceSignature.assetRevision === undefined
    ) {
      throw new DevelopSessionCommandError(
        "upgrade-stale",
        "The photo is unavailable. Reconnect it before opening the editor.",
      );
    }
    const upgradeSourceSignature: V3SourceSignature = {
      ...currentSourceSignature,
      catalogId: currentSourceSignature.catalogId,
      assetRevision: currentSourceSignature.assetRevision,
    };
    if (candidate.requiredAssetCopies.length > 0) {
      if (!this.#assetCopy) {
        throw new DevelopSessionCommandError(
          "asset-copy-required",
          "The stored mask assets could not be prepared for editing.",
        );
      }
      let receipt: V3AssetCopyReceipt;
      try {
        receipt = await this.#assetCopy.copyRequiredAssets({
          catalogId: this.catalogId,
          entryId: this.entryId,
          sourceSignature: upgradeSourceSignature,
          copies: candidate.requiredAssetCopies,
        });
      } catch (error) {
        throw new DevelopSessionCommandError(
          "asset-copy-failed",
          error instanceof Error ? error.message : "Could not copy retained v2 mask assets.",
        );
      }
      if (
        receipt.kind !== "copied" ||
        receipt.references.length !== candidate.requiredAssetCopies.length ||
        candidate.requiredAssetCopies.some((copy) =>
          !receipt.references.some((reference) =>
            sameAssetReference(reference, copy.expectedReference)
          )
        )
      ) {
        throw new DevelopSessionCommandError(
          "asset-copy-invalid",
          "The copied mask assets do not match the migration candidate.",
        );
      }
    }
    const latestSourceSignature = this.#sourceSignatureProvider?.() ?? null;
    if (
      this.#state.documentRevision !== sourceDocumentRevision ||
      this.#state.process.kind !== "editable" ||
      this.#state.process.document.version !== 2 ||
      JSON.stringify(this.#state.process.document) !== JSON.stringify(sourceDocument) ||
      latestSourceSignature === null ||
      !sourceSignaturesEqual(currentSourceSignature, latestSourceSignature)
    ) {
      throw new DevelopSessionCommandError(
        "upgrade-stale",
        "The photo or its edits changed while the editor was opening. Reopen the photo.",
      );
    }
    this.#state.process = { kind: "editable", document: candidate.document };
    this.#state.documentRevision += 1;
    this.#state.undo = this.#state.undo.filter((entry) => entry.kind === "metadata");
    this.#state.redo = this.#state.redo.filter((entry) => entry.kind === "metadata");
    this.#state.transientEdit = null;
    return this.snapshot();
  }

  beginEditGroup(label: string): DevelopSessionSnapshot {
    if (!this.#state.transientEdit) {
      if (
        this.#state.process.kind === "editable" &&
        this.#state.process.document.version === 3
      ) {
        this.#state.transientEdit = {
          kind: "v3",
          id: crypto.randomUUID(),
          label,
          previewDocument: this.#state.process.document,
        };
      } else {
        this.#state.transientEdit = {
          kind: "v2",
          id: crypto.randomUUID(),
          label,
        };
      }
    }
    return this.snapshot();
  }

  endEditGroup(): DevelopSessionSnapshot {
    const transientEdit = this.#state.transientEdit;
    this.#state.transientEdit = null;
    return transientEdit?.kind === "v3"
      ? this.#commitV3Document(transientEdit.previewDocument, transientEdit.label)
      : this.snapshot();
  }

  cancelEditGroup(): DevelopSessionSnapshot {
    this.#state.transientEdit = null;
    return this.snapshot();
  }

  undo(): DevelopMetadataMutation | null {
    const history = this.#state.undo.at(-1);
    if (!history) return null;
    if (
      history.kind === "document" &&
      (this.#state.process.kind !== "editable" || this.#state.process.document.version !== 2)
    ) {
      throw new DevelopSessionCommandError("process-mismatch", "V2 undo history is not applicable.");
    }
    if (
      (history.kind === "v3-document" || history.kind === "v3-document-metadata") &&
      (this.#state.process.kind !== "editable" || this.#state.process.document.version !== 3)
    ) {
      throw new DevelopSessionCommandError("process-mismatch", "V3 undo history is not applicable.");
    }
    this.#state.undo.pop();
    this.#state.redo.push(history);
    this.#state.transientEdit = null;
    switch (history.kind) {
      case "document": {
        if (this.#state.process.kind !== "editable" || this.#state.process.document.version !== 2) return null;
        this.#state.process = {
          kind: "editable",
          document: replayDevelopPatches(this.#state.process.document, history.patches, "backward"),
        };
        this.#state.documentRevision += 1;
        return null;
      }
      case "v3-document": {
        if (this.#state.process.kind !== "editable" || this.#state.process.document.version !== 3) return null;
        const before = this.#state.process.document;
        this.#state.process = {
          kind: "editable",
          document: history.command.before,
        };
        this.#state.documentRevision += 1;
        this.#emitCommittedCommand(createCommittedDevelopCommand(
          this.entryId,
          `Undo ${history.label}`,
          before,
          history.command.before,
        ));
        return null;
      }
      case "v3-document-metadata": {
        if (this.#state.process.kind !== "editable" || this.#state.process.document.version !== 3) return null;
        const before = this.#state.process.document;
        this.#state.process = {
          kind: "editable",
          document: history.command.before,
        };
        this.#state.documentRevision += 1;
        this.#state.metadataRevision += 1;
        this.#emitCommittedCommand(createCommittedDevelopCommand(
          this.entryId,
          `Undo ${history.label}`,
          before,
          history.command.before,
        ));
        return { entryId: this.entryId, values: history.beforeMetadata };
      }
      case "metadata":
        this.#state.metadataRevision += 1;
        return { entryId: this.entryId, values: history.before };
      default: {
        const exhaustive: never = history;
        return exhaustive;
      }
    }
  }

  redo(): DevelopMetadataMutation | null {
    const history = this.#state.redo.at(-1);
    if (!history) return null;
    if (
      history.kind === "document" &&
      (this.#state.process.kind !== "editable" || this.#state.process.document.version !== 2)
    ) {
      throw new DevelopSessionCommandError("process-mismatch", "V2 redo history is not applicable.");
    }
    if (
      (history.kind === "v3-document" || history.kind === "v3-document-metadata") &&
      (this.#state.process.kind !== "editable" || this.#state.process.document.version !== 3)
    ) {
      throw new DevelopSessionCommandError("process-mismatch", "V3 redo history is not applicable.");
    }
    this.#state.redo.pop();
    this.#state.undo = boundedHistory([...this.#state.undo, history]);
    this.#state.transientEdit = null;
    switch (history.kind) {
      case "document": {
        if (this.#state.process.kind !== "editable" || this.#state.process.document.version !== 2) return null;
        this.#state.process = {
          kind: "editable",
          document: replayDevelopPatches(this.#state.process.document, history.patches, "forward"),
        };
        this.#state.documentRevision += 1;
        return null;
      }
      case "v3-document": {
        if (this.#state.process.kind !== "editable" || this.#state.process.document.version !== 3) return null;
        const before = this.#state.process.document;
        this.#state.process = {
          kind: "editable",
          document: history.command.after,
        };
        this.#state.documentRevision += 1;
        this.#emitCommittedCommand(createCommittedDevelopCommand(
          this.entryId,
          `Redo ${history.label}`,
          before,
          history.command.after,
        ));
        return null;
      }
      case "v3-document-metadata": {
        if (this.#state.process.kind !== "editable" || this.#state.process.document.version !== 3) return null;
        const before = this.#state.process.document;
        this.#state.process = {
          kind: "editable",
          document: history.command.after,
        };
        this.#state.documentRevision += 1;
        this.#state.metadataRevision += 1;
        this.#emitCommittedCommand(createCommittedDevelopCommand(
          this.entryId,
          `Redo ${history.label}`,
          before,
          history.command.after,
        ));
        return { entryId: this.entryId, values: history.afterMetadata };
      }
      case "metadata":
        this.#state.metadataRevision += 1;
        return { entryId: this.entryId, values: history.after };
      default: {
        const exhaustive: never = history;
        return exhaustive;
      }
    }
  }

  recordMetadataEdit(
    before: DevelopMetadataValues,
    after: DevelopMetadataValues,
  ): DevelopSessionSnapshot {
    const beforeMetadata = metadataValues(before);
    const afterMetadata = metadataValues(after);
    if (JSON.stringify(beforeMetadata) === JSON.stringify(afterMetadata)) {
      return this.snapshot();
    }
    this.#state.undo = boundedHistory([
      ...this.#state.undo,
      { kind: "metadata", label: "Edit metadata", before: beforeMetadata, after: afterMetadata },
    ]);
    this.#state.redo = [];
    this.#state.metadataRevision += 1;
    return this.snapshot();
  }

  markMetadataHydrated(): DevelopSessionSnapshot {
    this.#state.persistedMetadataRevision = this.#state.metadataRevision;
    return this.snapshot();
  }

  markPersisted(
    documentRevision: number,
    metadataRevision: number,
  ): DevelopSessionSnapshot {
    if (
      documentRevision >= this.#state.persistedDocumentRevision &&
      documentRevision <= this.#state.documentRevision &&
      metadataRevision >= this.#state.persistedMetadataRevision &&
      metadataRevision <= this.#state.metadataRevision
    ) {
      this.#state.persistedDocumentRevision = documentRevision;
      this.#state.persistedMetadataRevision = metadataRevision;
    }
    return this.snapshot();
  }

  render(request: FrozenV2PrepareRequest): Promise<RenderPreparation>;
  render(request: FrozenV2PreviewRequest): Promise<RenderPreparation>;
  render(request: FrozenV2ExportRequest): Promise<RawExportRenderResult>;
  render(request: V3SessionRenderRequest): Promise<CpuRenderResult>;
  render(
    request:
      | FrozenV2PrepareRequest
      | FrozenV2PreviewRequest
      | FrozenV2ExportRequest
      | V3SessionRenderRequest,
  ): Promise<
    | RenderPreparation
    | RawExportRenderResult
    | CpuRenderResult
  > {
    const snapshot = this.snapshot();
    if (request.kind === "v3-preview" || request.kind === "v3-export") {
      if (snapshot.processKind === "read-only-newer") {
        return Promise.resolve({
          kind: "blocked",
          diagnostics: [snapshot.readOnly.diagnostic],
        });
      }
      if (snapshot.processKind !== "v3") {
        return Promise.resolve(
          invalidV3Render("V3 rendering requires an editable v3 document."),
        );
      }
      if (
        request.entry.catalogId !== this.catalogId ||
        request.entry.id !== this.entryId
      ) {
        return Promise.resolve(
          invalidV3Render("The render source does not belong to this session."),
        );
      }
      return renderV3Runtime(snapshot.document, request);
    }
    if (snapshot.processKind === "read-only-newer") {
      return Promise.reject(
        new DevelopRenderUnavailableError("newer-process-read-only", snapshot.readOnly.message),
      );
    }
    if (snapshot.processKind === "v3") {
      return Promise.reject(
        new DevelopRenderUnavailableError(
          "v3-process-required",
          "Use the v3 render request for this Develop document.",
        ),
      );
    }
    switch (request.kind) {
      case "prepare": return renderFrozenV2(snapshot.document, request);
      case "preview": return renderFrozenV2(snapshot.document, request);
      case "export": return renderFrozenV2(snapshot.document, request);
      default: {
        const exhaustive: never = request;
        return exhaustive;
      }
    }
  }

  save(): Promise<DevelopSaveResult> {
    const snapshot = this.snapshot();
    if (snapshot.processKind === "read-only-newer") {
      return Promise.reject(
        new DevelopSessionCommandError("read-only", snapshot.readOnly.message),
      );
    }
    if (!this.#repository) {
      return Promise.reject(
        new Error(`Develop session ${this.entryId} has no persistence repository.`),
      );
    }
    return this.#repository.save(snapshot);
  }
}

export { DevelopSessionCore as V2DevelopSession };

const sessions = new Map<string, DevelopSessionCore>();
let activeSessionKey: string | null = null;

function sessionKey(catalogId: string, entryId: string): string {
  return JSON.stringify([catalogId, entryId]);
}

export function getOrCreateDevelopSession(
  catalogId: string,
  entryId: string,
  initial: DevelopSessionOpenDocument,
): DevelopSessionCore {
  const key = sessionKey(catalogId, entryId);
  const existing = sessions.get(key);
  if (existing) return existing;
  const session = new DevelopSessionCore(catalogId, entryId, initial);
  sessions.set(key, session);
  return session;
}

export function getDevelopSession(
  catalogId: string,
  entryId: string,
): DevelopSessionCore | null {
  return sessions.get(sessionKey(catalogId, entryId)) ?? null;
}

export function activateDevelopSession(catalogId: string, entryId: string): void {
  activeSessionKey = sessionKey(catalogId, entryId);
}

export function getActiveDevelopSession(
  catalogId: string,
  entryId: string,
): DevelopSessionCore | null {
  const key = sessionKey(catalogId, entryId);
  return activeSessionKey === key ? sessions.get(key) ?? null : null;
}

export function clearDevelopSessions(): void {
  sessions.clear();
  activeSessionKey = null;
}
