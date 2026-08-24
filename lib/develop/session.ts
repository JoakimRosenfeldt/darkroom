import type { EntryMetadata } from "@/lib/catalog/types";
import type { DevelopImage } from "@/lib/cache/develop-image-cache";
import {
  applyDevelopCommand,
  replayDevelopPatches,
  type DevelopCommand,
  type DevelopPatch,
} from "@/lib/develop/commands";
import {
  FrozenV2Renderer,
  renderFrozenV2,
  type FrozenV2ExportRequest,
  type FrozenV2PrepareRequest,
  type FrozenV2PreviewRequest,
} from "@/lib/develop/frozen-v2-backend";
import type { DevelopDiagnostic, PixelDimensions } from "@/lib/develop/process";
import type {
  CropSettings,
  DevelopDocument,
  GlobalDevelopPluginId,
  SourceSignature,
} from "@/lib/develop/types";
import { decodePersistedDevelopDocument } from "@/lib/develop/v3/codec";
import {
  applyV3EditCommand,
  mergeV3GroupPatches,
  replayV3Patches,
  type V3EditCommand,
  type V3GroupPatch,
} from "@/lib/develop/v3/commands";
import type {
  DevelopDocumentV3,
  NewerDevelopDocument,
  PersistedDevelopDocument,
  StoredDevelopDocument,
} from "@/lib/develop/v3/document";
import {
  createV3MigrationCandidate,
  type RequiredV2AssetCopy,
  type V3MigrationCandidate,
} from "@/lib/develop/v3/migration";
import type { DevelopAssetRef } from "@/lib/develop/v3/assets";
import {
  MAX_CPU_RENDER_PIXELS,
  type CpuAnalysisTapResult,
  type CpuBackendBlockingDiagnostic,
  type CpuBackendDiagnostic,
  type CpuBackendValidationIssue,
  type CpuRenderResult,
} from "@/lib/develop/v3/cpu-backend";
import {
  renderV3Runtime,
  type V3SessionRenderRequest,
} from "@/lib/develop/v3/runtime";
import type { CancellationProbe } from "@/lib/develop/v3/source";
import type { RawExportRenderResult } from "@/lib/export/types";
import type { LibraryEntry } from "@/lib/fs/types";
import { sourceSignatureForEntry } from "@/lib/develop/source-transform";
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
  value: StoredDevelopDocument,
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
      readonly patches: readonly V3GroupPatch[];
      readonly editGroup: string | null;
    }
  | {
      readonly kind: "process-upgrade";
      readonly label: string;
      readonly before: DevelopDocument;
      readonly after: DevelopDocumentV3;
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

export interface V3AssetCopyReceipt {
  readonly kind: "copied";
  readonly references: readonly DevelopAssetRef[];
}

export interface V3UpgradeAssetCopyAdapter {
  copyRequiredAssets(input: {
    readonly catalogId: string;
    readonly entryId: string;
    readonly copies: readonly RequiredV2AssetCopy[];
  }): Promise<V3AssetCopyReceipt>;
}

export type UpgradeAndFirstV3EditCommand = {
  readonly kind: "upgrade-and-first-v3-edit";
  readonly acceptance: V3MigrationAcceptanceReceipt;
  readonly edit: V3EditCommand;
};

export interface V3MigrationAcceptanceReceipt {
  readonly kind: "same-quality-comparison-accepted";
  readonly sourceDocumentRevision: number;
  readonly baselineVersion: 2;
  readonly candidateVersion: 3;
  readonly quality: "fit";
  readonly sourceSignature: Readonly<SourceSignature>;
  readonly firstEdit: V3EditCommand;
  readonly acceptedGroups: readonly [
    "tone-and-color",
    "geometry",
    "masks",
    "detail-and-post-crop",
  ];
}

export interface V3UpgradeComparisonRequest {
  readonly kind: "v3-upgrade-comparison";
  readonly entry: LibraryEntry;
  readonly image: DevelopImage;
  readonly firstEdit: V3EditCommand;
  readonly outputDimensions: PixelDimensions;
  readonly cancellation?: CancellationProbe;
}

export interface V3UpgradeComparisonFrame {
  readonly pixels: Uint8Array;
  readonly dimensions: PixelDimensions;
}

export type V3UpgradeComparisonResult =
  | {
      readonly kind: "compared";
      readonly baseline: V3UpgradeComparisonFrame;
      readonly candidate: V3UpgradeComparisonFrame;
      readonly candidateDiagnostics: readonly CpuBackendDiagnostic[];
      readonly candidateAnalysis: readonly CpuAnalysisTapResult[];
      readonly acceptance: V3MigrationAcceptanceReceipt;
    }
  | {
      readonly kind: "blocked";
      readonly diagnostics: readonly [
        CpuBackendBlockingDiagnostic,
        ...CpuBackendBlockingDiagnostic[],
      ];
    }
  | {
      readonly kind: "invalid";
      readonly issues: readonly [
        CpuBackendValidationIssue | { readonly kind: "comparison-invalid"; readonly reason: string },
        ...(CpuBackendValidationIssue | { readonly kind: "comparison-invalid"; readonly reason: string })[],
      ];
    }
  | { readonly kind: "cancelled" };

export type DevelopSessionControlCommand =
  | { readonly kind: "undo" }
  | { readonly kind: "redo" }
  | { readonly kind: "commit-v2-crop-draft"; readonly crop: CropSettings };

export type DevelopSessionCommand =
  | DevelopCommand
  | V3EditCommand
  | UpgradeAndFirstV3EditCommand
  | DevelopSessionControlCommand;

export type DevelopSessionCommandErrorCode =
  | "asset-copy-required"
  | "asset-copy-failed"
  | "asset-copy-invalid"
  | "comparison-required"
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
  dispatch(
    command: UpgradeAndFirstV3EditCommand,
    label?: string,
  ): Promise<DevelopSessionSnapshot>;
  dispatch(
    command: Exclude<DevelopSessionCommand, UpgradeAndFirstV3EditCommand>,
    label?: string,
  ): DevelopSessionSnapshot;
  render(request: FrozenV2PrepareRequest): Promise<RenderPreparation>;
  render(request: FrozenV2PreviewRequest): Promise<RenderPreparation>;
  render(request: FrozenV2ExportRequest): Promise<RawExportRenderResult>;
  render(request: V3SessionRenderRequest): Promise<CpuRenderResult>;
  render(request: V3UpgradeComparisonRequest): Promise<V3UpgradeComparisonResult>;
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
  transientEdit: { id: string; label: string } | null;
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

function invalidUpgradeComparison(reason: string): V3UpgradeComparisonResult {
  return {
    kind: "invalid",
    issues: [{ kind: "comparison-invalid", reason }],
  };
}

function migrationAcceptance(
  sourceDocumentRevision: number,
  candidate: V3MigrationCandidate,
  sourceSignature: Readonly<SourceSignature>,
  firstEdit: V3EditCommand,
): V3MigrationAcceptanceReceipt {
  return {
    kind: "same-quality-comparison-accepted",
    sourceDocumentRevision,
    baselineVersion: candidate.comparison.baselineVersion,
    candidateVersion: candidate.comparison.candidateVersion,
    quality: candidate.comparison.quality,
    sourceSignature,
    firstEdit,
    acceptedGroups: candidate.comparison.compareGroups,
  };
}

export function createDevelopPluginCommand(
  document: DevelopDocument,
  pluginId: GlobalDevelopPluginId,
  patch: unknown,
): DevelopCommand {
  const values = typeof patch === "object" && patch !== null ? patch : {};
  switch (pluginId) {
    case "basic": return { kind: "replace-global", pluginId, value: Object.assign({}, document.settings.basic, values) };
    case "crop": return { kind: "replace-global", pluginId, value: Object.assign({}, document.settings.crop, values) };
    case "curve": return { kind: "replace-global", pluginId, value: Object.assign({}, document.settings.curve, values) };
    case "mixer": return { kind: "replace-global", pluginId, value: Object.assign({}, document.settings.mixer, values) };
    case "effects": return { kind: "replace-global", pluginId, value: Object.assign({}, document.settings.effects, values) };
    default: {
      const exhaustive: never = pluginId;
      return exhaustive;
    }
  }
}

export class DevelopSessionCore implements DevelopSession {
  readonly catalogId: string;
  readonly entryId: string;
  #state: MutableDevelopSessionState;
  #repository: DevelopSessionRepository | null;
  #assetCopy: V3UpgradeAssetCopyAdapter | null = null;

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
      transientEdit: this.#state.transientEdit,
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

  dispatch(
    command: UpgradeAndFirstV3EditCommand,
    label?: string,
  ): Promise<DevelopSessionSnapshot>;
  dispatch(
    command: Exclude<DevelopSessionCommand, UpgradeAndFirstV3EditCommand>,
    label?: string,
  ): DevelopSessionSnapshot;
  dispatch(
    command: DevelopSessionCommand,
    label = "Edit",
  ): DevelopSessionSnapshot | Promise<DevelopSessionSnapshot> {
    if (command.kind === "upgrade-and-first-v3-edit") {
      return this.#upgradeAndFirstEdit(command, label);
    }
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
    const result = applyV3EditCommand(this.#state.process.document, command);
    if (!result.changed) return this.snapshot();
    const editGroup = this.#state.transientEdit?.id ?? null;
    const previous = this.#state.undo.at(-1);
    if (editGroup && previous?.kind === "v3-document" && previous.editGroup === editGroup) {
      this.#state.undo[this.#state.undo.length - 1] = {
        ...previous,
        patches: mergeV3GroupPatches(previous.patches, result.patches),
      };
    } else {
      this.#state.undo = boundedHistory([
        ...this.#state.undo,
        {
          kind: "v3-document",
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

  async #upgradeAndFirstEdit(
    command: UpgradeAndFirstV3EditCommand,
    label: string,
  ): Promise<DevelopSessionSnapshot> {
    if (this.#state.process.kind === "read-only-newer") {
      throw new DevelopSessionCommandError("read-only", this.#state.process.reason.message);
    }
    if (this.#state.process.document.version !== 2) {
      throw new DevelopSessionCommandError(
        "process-mismatch",
        "Only frozen v2 documents can be upgraded.",
      );
    }
    const sourceDocument = this.#state.process.document;
    const sourceDocumentRevision = this.#state.documentRevision;
    const candidate = createV3MigrationCandidate(sourceDocument);
    const acceptance = command.acceptance;
    if (
      acceptance.kind !== "same-quality-comparison-accepted" ||
      acceptance.sourceDocumentRevision !== sourceDocumentRevision ||
      acceptance.baselineVersion !== candidate.comparison.baselineVersion ||
      acceptance.candidateVersion !== candidate.comparison.candidateVersion ||
      acceptance.quality !== candidate.comparison.quality ||
      acceptance.sourceSignature.catalogId !== this.catalogId ||
      acceptance.sourceSignature.entryId !== this.entryId ||
      JSON.stringify(acceptance.firstEdit) !== JSON.stringify(command.edit) ||
      acceptance.acceptedGroups.length !== candidate.comparison.compareGroups.length ||
      candidate.comparison.compareGroups.some(
        (group, index) => acceptance.acceptedGroups[index] !== group,
      )
    ) {
      throw new DevelopSessionCommandError(
        "comparison-required",
        "Accept the fit-quality v2/v3 comparison for this exact revision before upgrading.",
      );
    }
    const edited = applyV3EditCommand(candidate.document, command.edit);
    if (!edited.changed) {
      throw new DevelopSessionCommandError(
        "invalid-document",
        "The first v3 edit must change the migration candidate.",
      );
    }
    if (candidate.requiredAssetCopies.length > 0) {
      if (!this.#assetCopy) {
        throw new DevelopSessionCommandError(
          "asset-copy-required",
          "Copy the retained v2 mask assets before accepting this upgrade.",
        );
      }
      let receipt: V3AssetCopyReceipt;
      try {
        receipt = await this.#assetCopy.copyRequiredAssets({
          catalogId: this.catalogId,
          entryId: this.entryId,
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
    if (
      this.#state.documentRevision !== sourceDocumentRevision ||
      this.#state.process.kind !== "editable" ||
      this.#state.process.document.version !== 2 ||
      JSON.stringify(this.#state.process.document) !== JSON.stringify(sourceDocument)
    ) {
      throw new DevelopSessionCommandError(
        "upgrade-stale",
        "The v2 document changed during upgrade. Compare and accept the current revision again.",
      );
    }
    this.#state.undo = boundedHistory([
      ...this.#state.undo,
      {
        kind: "process-upgrade",
        label,
        before: sourceDocument,
        after: edited.document,
      },
    ]);
    this.#state.process = { kind: "editable", document: edited.document };
    this.#state.documentRevision += 1;
    this.#state.redo = [];
    this.#state.transientEdit = null;
    return this.snapshot();
  }

  beginEditGroup(label: string): DevelopSessionSnapshot {
    if (!this.#state.transientEdit) {
      this.#state.transientEdit = { id: crypto.randomUUID(), label };
    }
    return this.snapshot();
  }

  endEditGroup(): DevelopSessionSnapshot {
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
      (history.kind === "v3-document" || history.kind === "process-upgrade") &&
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
        this.#state.process = {
          kind: "editable",
          document: replayV3Patches(this.#state.process.document, history.patches, "backward"),
        };
        this.#state.documentRevision += 1;
        return null;
      }
      case "process-upgrade":
        this.#state.process = { kind: "editable", document: history.before };
        this.#state.documentRevision += 1;
        return null;
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
      (history.kind === "document" || history.kind === "process-upgrade") &&
      (this.#state.process.kind !== "editable" || this.#state.process.document.version !== 2)
    ) {
      throw new DevelopSessionCommandError("process-mismatch", "V2 redo history is not applicable.");
    }
    if (
      history.kind === "v3-document" &&
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
        this.#state.process = {
          kind: "editable",
          document: replayV3Patches(this.#state.process.document, history.patches, "forward"),
        };
        this.#state.documentRevision += 1;
        return null;
      }
      case "process-upgrade":
        this.#state.process = { kind: "editable", document: history.after };
        this.#state.documentRevision += 1;
        return null;
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

  async #renderUpgradeComparison(
    request: V3UpgradeComparisonRequest,
  ): Promise<V3UpgradeComparisonResult> {
    const snapshot = this.snapshot();
    if (snapshot.processKind === "read-only-newer") {
      return { kind: "blocked", diagnostics: [snapshot.readOnly.diagnostic] };
    }
    if (snapshot.processKind !== "v2") {
      return invalidUpgradeComparison("Upgrade comparison requires an editable v2 document.");
    }
    if (
      request.entry.catalogId !== this.catalogId ||
      request.entry.id !== this.entryId
    ) {
      return invalidUpgradeComparison("The comparison source does not belong to this session.");
    }
    const bounds = request.outputDimensions;
    const pixelCount = bounds.width * bounds.height;
    if (
      !Number.isSafeInteger(bounds.width) ||
      !Number.isSafeInteger(bounds.height) ||
      bounds.width < 1 ||
      bounds.height < 1 ||
      !Number.isSafeInteger(pixelCount) ||
      pixelCount > MAX_CPU_RENDER_PIXELS
    ) {
      return invalidUpgradeComparison("Comparison dimensions exceed the fit preview limit.");
    }
    if (request.cancellation?.isCancelled()) return { kind: "cancelled" };

    const sourceDocument = snapshot.document;
    const sourceDocumentRevision = snapshot.documentRevision;
    const candidate = createV3MigrationCandidate(sourceDocument);
    const editedCandidate = applyV3EditCommand(candidate.document, request.firstEdit);
    if (!editedCandidate.changed) {
      return invalidUpgradeComparison("The first v3 edit must change the migration candidate.");
    }
    const sourceSignature = sourceSignatureForEntry(request.entry);
    let baseline: RawExportRenderResult;
    const renderer = new FrozenV2Renderer(document.createElement("canvas"), true);
    try {
      baseline = await renderFrozenV2(sourceDocument, {
        kind: "export",
        image: request.image,
        sourceSignature,
        size: {
          mode: "fit",
          width: bounds.width,
          height: bounds.height,
          neverUpscale: true,
        },
        renderer,
      });
    } catch (error) {
      return invalidUpgradeComparison(
        error instanceof Error ? error.message : "Could not render the v2 comparison frame.",
      );
    } finally {
      renderer.dispose();
    }
    if (request.cancellation?.isCancelled()) return { kind: "cancelled" };

    const candidateResult = await renderV3Runtime(editedCandidate.document, {
      kind: "v3-fit-comparison",
      entry: request.entry,
      image: request.image,
      outputDimensions: bounds,
      cancellation: request.cancellation,
    });
    if (candidateResult.kind !== "rendered") return candidateResult;
    if (request.cancellation?.isCancelled()) return { kind: "cancelled" };
    const current = this.snapshot();
    if (
      current.processKind !== "v2" ||
      current.documentRevision !== sourceDocumentRevision ||
      current.document !== sourceDocument
    ) {
      return invalidUpgradeComparison(
        "The v2 document changed during comparison. Compare the current revision again.",
      );
    }
    if (
      baseline.width !== candidateResult.dimensions.width ||
      baseline.height !== candidateResult.dimensions.height
    ) {
      return invalidUpgradeComparison(
        "The v2 and v3 candidates did not resolve to identical fit dimensions.",
      );
    }
    return {
      kind: "compared",
      baseline: {
        pixels: baseline.pixels,
        dimensions: { width: baseline.width, height: baseline.height },
      },
      candidate: {
        pixels: candidateResult.pixels.pixels,
        dimensions: candidateResult.dimensions,
      },
      candidateDiagnostics: candidateResult.diagnostics,
      candidateAnalysis: candidateResult.analysis,
      acceptance: migrationAcceptance(
        sourceDocumentRevision,
        candidate,
        sourceSignature,
        request.firstEdit,
      ),
    };
  }

  render(request: FrozenV2PrepareRequest): Promise<RenderPreparation>;
  render(request: FrozenV2PreviewRequest): Promise<RenderPreparation>;
  render(request: FrozenV2ExportRequest): Promise<RawExportRenderResult>;
  render(request: V3SessionRenderRequest): Promise<CpuRenderResult>;
  render(request: V3UpgradeComparisonRequest): Promise<V3UpgradeComparisonResult>;
  render(
    request:
      | FrozenV2PrepareRequest
      | FrozenV2PreviewRequest
      | FrozenV2ExportRequest
      | V3SessionRenderRequest
      | V3UpgradeComparisonRequest,
  ): Promise<
    | RenderPreparation
    | RawExportRenderResult
    | CpuRenderResult
    | V3UpgradeComparisonResult
  > {
    if (request.kind === "v3-upgrade-comparison") {
      return this.#renderUpgradeComparison(request);
    }
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
