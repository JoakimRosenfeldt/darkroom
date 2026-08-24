import type { AssetId, CatalogId } from "@/lib/catalog/ids";
import type {
  DevelopCapabilityReport,
  SourceRecord,
  V3SourceSignature,
} from "../process";
import type { ExportOutputIntent } from "../render-contract";
import type { LocalMask, MaskComponent } from "../types";
import {
  orderedBatchGroups,
  parseExactBatchSelection,
  summarizeBatchResults,
  type BatchFailurePhase,
  type BatchGroupSkip,
  type BatchGroupSkipReason,
  type BatchPhotoResult,
  type BatchPlan,
  type BatchProgress,
  type BatchSemanticGroup,
  type BatchSkipReason,
  type BatchSummaryResult,
  type ExactBatchSelection,
} from "./batch";
import {
  applyV3EditCommand,
  validateV3CommandDocument,
  type V3EditCommand,
} from "./commands";
import {
  canonicalV3DocumentHashInput,
  type DevelopDocumentV3,
  type PersistedCrop,
  type PersistedInputProfile,
} from "./document";
import { parseSourceRecord } from "./source";

const MAX_BATCH_ERROR_CODE = 128;
const MAX_BATCH_RESULT_MESSAGE = 1_024;

export interface BatchSourceSnapshot {
  readonly catalogId: CatalogId;
  readonly entryId: AssetId;
  readonly document: DevelopDocumentV3;
  readonly documentRevision: string;
  readonly source: SourceRecord;
  readonly capabilities: DevelopCapabilityReport;
}

export interface BatchOpenHandle {
  readonly entryId: AssetId;
  readonly token: string;
}

export type BatchReconciledPhoto =
  | {
      readonly kind: "v3";
      readonly catalogId: CatalogId;
      readonly entryId: AssetId;
      readonly document: DevelopDocumentV3;
      readonly documentRevision: string;
      readonly source: SourceRecord;
      readonly capabilities: DevelopCapabilityReport;
    }
  | {
      readonly kind: "v2";
      readonly catalogId: CatalogId;
      readonly entryId: AssetId;
      readonly documentRevision: string;
    }
  | {
      readonly kind: "read-only-newer";
      readonly catalogId: CatalogId;
      readonly entryId: AssetId;
      readonly documentRevision: string;
      readonly foundVersion: number;
    };

export type BatchValidationRequest =
  | {
      readonly kind: "group-capability";
      readonly group: BatchSemanticGroup;
      readonly source: BatchSourceSnapshot;
      readonly target: Extract<BatchReconciledPhoto, { readonly kind: "v3" }>;
      readonly proposedDocument: DevelopDocumentV3;
      readonly outputIntent: ExportOutputIntent | null;
    }
  | {
      readonly kind: "input-profile-compatibility";
      readonly source: BatchSourceSnapshot;
      readonly target: Extract<BatchReconciledPhoto, { readonly kind: "v3" }>;
      readonly profile: PersistedInputProfile;
    }
  | {
      readonly kind: "crop";
      readonly source: BatchSourceSnapshot;
      readonly target: Extract<BatchReconciledPhoto, { readonly kind: "v3" }>;
      readonly crop: PersistedCrop;
    };

export type BatchValidationResult =
  | { readonly kind: "supported" }
  | {
      readonly kind: "unsupported";
      readonly reason: "unsupported-capability" | "missing-asset";
      readonly message: string;
    }
  | { readonly kind: "compatible-profile" }
  | { readonly kind: "incompatible-profile"; readonly message: string }
  | { readonly kind: "valid-crop"; readonly crop: PersistedCrop }
  | { readonly kind: "invalid-crop"; readonly message: string };

export type BatchRevisionResult =
  | { readonly kind: "current" }
  | { readonly kind: "conflict"; readonly message: string };

export interface BatchExpectedSourceRevision {
  readonly entryId: AssetId;
  readonly documentRevision: string;
  readonly signature: V3SourceSignature;
}

export interface BatchDispatchReceipt {
  readonly document: DevelopDocumentV3;
  readonly documentRevision: string;
}

export interface BatchSaveReceipt {
  readonly documentRevision: string;
}

export interface BatchExportReceipt {
  readonly documentRevision: string;
}

/** The caller owns sessions and persistence. Dispatch must apply the command list atomically. */
export interface BatchRunnerAdapter {
  readonly validateSelection: (
    selection: ExactBatchSelection,
  ) => Promise<{ readonly kind: "current" } | { readonly kind: "stale"; readonly message: string }>;
  readonly open: (input: {
    readonly selection: ExactBatchSelection;
    readonly entryId: AssetId;
  }) => Promise<BatchOpenHandle>;
  readonly reconcile: (input: {
    readonly selection: ExactBatchSelection;
    readonly handle: BatchOpenHandle;
  }) => Promise<BatchReconciledPhoto>;
  readonly validate: (request: BatchValidationRequest) => Promise<BatchValidationResult>;
  readonly revalidate: (input: {
    readonly source: BatchExpectedSourceRevision;
    readonly target: {
      readonly entryId: AssetId;
      readonly documentRevision: string;
      readonly signature: V3SourceSignature;
    };
  }) => Promise<BatchRevisionResult>;
  readonly dispatch: (input: {
    readonly entryId: AssetId;
    readonly expectedDocumentRevision: string;
    readonly source: BatchExpectedSourceRevision;
    readonly commands: readonly [V3EditCommand, ...V3EditCommand[]];
    readonly label: string;
  }) => Promise<BatchDispatchReceipt>;
  readonly save: (input: {
    readonly entryId: AssetId;
    readonly expectedDocumentRevision: string;
    readonly source: BatchExpectedSourceRevision;
  }) => Promise<BatchSaveReceipt>;
  readonly export?: (input: {
    readonly entryId: AssetId;
    readonly expectedDocumentRevision: string;
    readonly source: BatchExpectedSourceRevision;
    readonly outputIntent: ExportOutputIntent;
  }) => Promise<BatchExportReceipt>;
  readonly isCancelled?: () => boolean;
  readonly onProgress?: (progress: BatchProgress) => void;
}

export class BatchRunnerAdapterError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = "BatchRunnerAdapterError";
    this.code = code;
  }
}

interface GroupCopyChanged {
  readonly kind: "changed";
  readonly document: DevelopDocumentV3;
  readonly commands: readonly [V3EditCommand, ...V3EditCommand[]];
  readonly note: BatchGroupSkip | null;
}

type GroupCopyResult =
  | GroupCopyChanged
  | { readonly kind: "external"; readonly note: BatchGroupSkip | null }
  | { readonly kind: "skipped"; readonly skip: BatchGroupSkip };

interface TargetPlan {
  readonly document: DevelopDocumentV3;
  readonly commands: readonly V3EditCommand[];
  readonly changedGroups: readonly BatchSemanticGroup[];
  readonly skippedGroups: readonly BatchGroupSkip[];
  readonly exportIntent: ExportOutputIntent | null;
}

function boundedText(value: string, maximum: number, fallback: string): string {
  const withoutNull = value.replaceAll("\0", "").trim();
  if (withoutNull.length === 0) return fallback;
  return withoutNull.slice(0, maximum);
}

function failure(
  entryId: AssetId,
  phase: BatchFailurePhase,
  error: unknown,
): BatchPhotoResult {
  const code = error instanceof BatchRunnerAdapterError
    ? boundedText(error.code, MAX_BATCH_ERROR_CODE, `${phase}-failed`)
    : `${phase}-failed`;
  const message = error instanceof Error
    ? boundedText(error.message, MAX_BATCH_RESULT_MESSAGE, `Batch ${phase} failed.`)
    : `Batch ${phase} failed.`;
  return { kind: "failed", entryId, phase, code, message };
}

function groupSkip(
  group: BatchSemanticGroup,
  reason: BatchGroupSkipReason,
  message: string,
): BatchGroupSkip {
  return {
    group,
    reason,
    message: boundedText(message, MAX_BATCH_RESULT_MESSAGE, "The batch group was skipped."),
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

function documentsEqual(left: DevelopDocumentV3, right: DevelopDocumentV3): boolean {
  return canonicalV3DocumentHashInput(left) === canonicalV3DocumentHashInput(right) &&
    JSON.stringify(left.compatibility) === JSON.stringify(right.compatibility);
}

function validRevision(value: string): boolean {
  return value.length > 0 && value.length <= 256 && !value.includes("\0");
}

function cloneDocument(document: DevelopDocumentV3): DevelopDocumentV3 {
  return validateV3CommandDocument(document);
}

function portableComponent(component: MaskComponent): MaskComponent | null {
  switch (component.kind) {
    case "brush":
    case "linear-gradient":
    case "radial-gradient":
      return structuredClone(component);
    case "ai":
      return null;
    default: {
      const exhaustive: never = component;
      return exhaustive;
    }
  }
}

function portableMask(mask: LocalMask): LocalMask | null {
  const components = mask.components.flatMap((component) => {
    const portable = portableComponent(component);
    return portable ? [portable] : [];
  });
  const first = components[0];
  return first
    ? { ...structuredClone(mask), components: [first, ...components.slice(1)] }
    : null;
}

function portableLocal(source: DevelopDocumentV3): {
  readonly value: DevelopDocumentV3["local"] | null;
  readonly stripped: boolean;
} {
  if (source.local.geometryFrame !== "canonical-v3") {
    return { value: null, stripped: true };
  }
  const masks = source.local.masks.flatMap((mask) => {
    const portable = portableMask(mask);
    return portable ? [portable] : [];
  });
  const componentCount = source.local.masks.reduce(
    (count, mask) => count + mask.components.length,
    0,
  );
  const portableCount = masks.reduce(
    (count, mask) => count + mask.components.length,
    0,
  );
  return {
    value: { geometryFrame: "canonical-v3", masks, maskAssetRefs: [] },
    stripped: portableCount !== componentCount || source.local.maskAssetRefs.length > 0,
  };
}

function applyCommands(
  document: DevelopDocumentV3,
  commands: readonly V3EditCommand[],
): {
  readonly document: DevelopDocumentV3;
  readonly changedCommands: readonly V3EditCommand[];
} {
  let current = document;
  const changedCommands: V3EditCommand[] = [];
  for (const command of commands) {
    const result = applyV3EditCommand(current, command);
    if (!result.changed) continue;
    current = result.document;
    changedCommands.push(command);
  }
  return { document: current, changedCommands };
}

function nonEmptyCommands(
  commands: readonly V3EditCommand[],
): readonly [V3EditCommand, ...V3EditCommand[]] | null {
  const first = commands[0];
  return first ? [first, ...commands.slice(1)] : null;
}

function commandsForSimpleGroup(
  group: BatchSemanticGroup,
  source: DevelopDocumentV3,
  target: DevelopDocumentV3,
): readonly V3EditCommand[] {
  switch (group) {
    case "optics":
      return [{ kind: "replace-v3-semantic-group", group: "optics", value: structuredClone(source.optics) }];
    case "presence":
      return [{ kind: "replace-v3-semantic-group", group: "presence", value: structuredClone(source.presence) }];
    case "detail":
      return [{ kind: "replace-v3-semantic-group", group: "detail", value: structuredClone(source.detail) }];
    case "post-crop-effects":
      return [{ kind: "replace-v3-semantic-group", group: "effects", value: structuredClone(source.effects) }];
    case "hdr-edit":
      return [{ kind: "replace-v3-semantic-group", group: "hdr", value: structuredClone(source.hdr) }];
    case "tone":
      return [
        {
          kind: "replace-v3-semantic-group",
          group: "tone",
          value: { ...structuredClone(target.tone), basic: structuredClone(source.tone.basic) },
        },
        {
          kind: "replace-v3-semantic-group",
          group: "color",
          value: { ...structuredClone(target.color), global: structuredClone(source.color.global) },
        },
      ];
    case "curve-and-color":
      return [
        {
          kind: "replace-v3-semantic-group",
          group: "tone",
          value: { ...structuredClone(target.tone), curves: structuredClone(source.tone.curves) },
        },
        {
          kind: "replace-v3-semantic-group",
          group: "color",
          value: {
            ...structuredClone(target.color),
            pointColor: structuredClone(source.color.pointColor),
            mixer: structuredClone(source.color.mixer),
            monochrome: structuredClone(source.color.monochrome),
            grading: structuredClone(source.color.grading),
          },
        },
      ];
    case "input-profile":
    case "white-balance":
    case "geometry-and-crop":
    case "local-adjustments":
    case "cleanup":
    case "lens-blur":
    case "output-intent":
      return [];
    default: {
      const exhaustive: never = group;
      return exhaustive;
    }
  }
}

async function validateCapability(input: {
  readonly adapter: BatchRunnerAdapter;
  readonly group: BatchSemanticGroup;
  readonly source: BatchSourceSnapshot;
  readonly target: Extract<BatchReconciledPhoto, { readonly kind: "v3" }>;
  readonly document: DevelopDocumentV3;
  readonly outputIntent: ExportOutputIntent | null;
}): Promise<BatchGroupSkip | null> {
  const result = await input.adapter.validate({
    kind: "group-capability",
    group: input.group,
    source: input.source,
    target: input.target,
    proposedDocument: input.document,
    outputIntent: input.outputIntent,
  });
  switch (result.kind) {
    case "supported": return null;
    case "unsupported": return groupSkip(input.group, result.reason, result.message);
    default:
      throw new BatchRunnerAdapterError(
        "validation-contract",
        `Capability validation returned ${result.kind}.`,
      );
  }
}

async function copyInputProfile(input: {
  readonly adapter: BatchRunnerAdapter;
  readonly source: BatchSourceSnapshot;
  readonly target: Extract<BatchReconciledPhoto, { readonly kind: "v3" }>;
  readonly current: DevelopDocumentV3;
}): Promise<GroupCopyResult> {
  const compatibility = await input.adapter.validate({
    kind: "input-profile-compatibility",
    source: input.source,
    target: input.target,
    profile: input.source.document.color.inputProfile,
  });
  if (compatibility.kind === "incompatible-profile") {
    return {
      kind: "skipped",
      skip: groupSkip("input-profile", "source-specific-policy", compatibility.message),
    };
  }
  if (compatibility.kind !== "compatible-profile") {
    throw new BatchRunnerAdapterError(
      "validation-contract",
      `Input-profile validation returned ${compatibility.kind}.`,
    );
  }
  const command: V3EditCommand = {
    kind: "replace-v3-semantic-group",
    group: "color",
    value: {
      ...structuredClone(input.current.color),
      inputProfile: structuredClone(input.source.document.color.inputProfile),
    },
  };
  return changedGroup("input-profile", input.current, [command]);
}

function changedGroup(
  group: BatchSemanticGroup,
  current: DevelopDocumentV3,
  commands: readonly V3EditCommand[],
  note: BatchGroupSkip | null = null,
): GroupCopyResult {
  const applied = applyCommands(current, commands);
  const changed = nonEmptyCommands(applied.changedCommands);
  return changed
    ? { kind: "changed", document: applied.document, commands: changed, note }
    : { kind: "skipped", skip: groupSkip(group, "unchanged", "The requested values already match.") };
}

function unchangedGroup(group: BatchSemanticGroup): GroupCopyResult {
  return {
    kind: "skipped",
    skip: groupSkip(group, "unchanged", "The requested values already match."),
  };
}

async function copyCrop(input: {
  readonly adapter: BatchRunnerAdapter;
  readonly source: BatchSourceSnapshot;
  readonly target: Extract<BatchReconciledPhoto, { readonly kind: "v3" }>;
  readonly current: DevelopDocumentV3;
}): Promise<GroupCopyResult> {
  if (
    input.source.document.local.geometryFrame !== input.current.local.geometryFrame
    && input.current.local.masks.length > 0
  ) {
    return {
      kind: "skipped",
      skip: groupSkip(
        "geometry-and-crop",
        "source-specific-policy",
        "Geometry cannot be copied across coordinate frames while the target has masks.",
      ),
    };
  }
  const validation = await input.adapter.validate({
    kind: "crop",
    source: input.source,
    target: input.target,
    crop: input.source.document.geometry.crop,
  });
  if (validation.kind === "invalid-crop") {
    return {
      kind: "skipped",
      skip: groupSkip("geometry-and-crop", "source-specific-policy", validation.message),
    };
  }
  if (validation.kind !== "valid-crop") {
    throw new BatchRunnerAdapterError(
      "validation-contract",
      `Crop validation returned ${validation.kind}.`,
    );
  }
  const command: V3EditCommand = {
    kind: "replace-v3-semantic-group",
    group: "geometry",
    value: {
      ...structuredClone(input.source.document.geometry),
      crop: structuredClone(validation.crop),
    },
  };
  const frameCommand: V3EditCommand = {
    kind: "patch-v3-semantic-group",
    group: "local",
    patch: { geometryFrame: input.source.document.local.geometryFrame },
  };
  const applied = applyCommands(input.current, [command, frameCommand]);
  const changed = nonEmptyCommands(applied.changedCommands);
  return changed
    ? { kind: "changed", document: applied.document, commands: changed, note: null }
    : unchangedGroup("geometry-and-crop");
}

function copyWhiteBalance(
  source: DevelopDocumentV3,
  current: DevelopDocumentV3,
): GroupCopyResult {
  const command: V3EditCommand = {
    kind: "replace-v3-semantic-group",
    group: "color",
    value: {
      ...structuredClone(current.color),
      whiteBalance: {
        mode: "custom",
        adjustment: structuredClone(source.color.whiteBalance.adjustment),
        resolved: structuredClone(source.color.whiteBalance.resolved),
      },
    },
  };
  const applied = applyCommands(current, [command]);
  const changed = nonEmptyCommands(applied.changedCommands);
  return changed
    ? { kind: "changed", document: applied.document, commands: changed, note: null }
    : unchangedGroup("white-balance");
}

function copyLocal(source: DevelopDocumentV3, current: DevelopDocumentV3): GroupCopyResult {
  if (source.local.geometryFrame !== current.local.geometryFrame) {
    return {
      kind: "skipped",
      skip: groupSkip(
        "local-adjustments",
        "source-specific-policy",
        "Masks cannot be copied across coordinate frames.",
      ),
    };
  }
  const portable = portableLocal(source);
  if (!portable.value) {
    return {
      kind: "skipped",
      skip: groupSkip(
        "local-adjustments",
        "source-specific-policy",
        "Legacy-oriented or source-signed masks cannot be copied across photos.",
      ),
    };
  }
  if (source.local.masks.length > 0 && portable.value.masks.length === 0) {
    return {
      kind: "skipped",
      skip: groupSkip(
        "local-adjustments",
        "source-specific-policy",
        "The source has no portable manual mask components.",
      ),
    };
  }
  const command: V3EditCommand = {
    kind: "replace-v3-semantic-group",
    group: "local",
    value: {
      ...portable.value,
      geometryFrame: current.local.geometryFrame,
    },
  };
  const note = portable.stripped
    ? groupSkip(
        "local-adjustments",
        "source-specific-policy",
        "AI components and source-signed mask references were not copied.",
      )
    : null;
  const applied = applyCommands(current, [command]);
  const changed = nonEmptyCommands(applied.changedCommands);
  return changed
    ? { kind: "changed", document: applied.document, commands: changed, note }
    : unchangedGroup("local-adjustments");
}

function sameSourceOnlyGroup(input: {
  readonly group: "cleanup" | "lens-blur";
  readonly source: BatchSourceSnapshot;
  readonly target: Extract<BatchReconciledPhoto, { readonly kind: "v3" }>;
  readonly current: DevelopDocumentV3;
}): GroupCopyResult {
  if (!sameSignature(input.source.source.signature, input.target.source.signature)) {
    return {
      kind: "skipped",
      skip: groupSkip(
        input.group,
        "source-specific-policy",
        input.group === "cleanup"
          ? "Cleanup repairs and generated patches stay with their source photo."
          : "Lens Blur depth stays with its source photo.",
      ),
    };
  }
  const command: V3EditCommand = input.group === "cleanup"
    ? {
        kind: "replace-v3-semantic-group",
        group: "cleanup",
        value: structuredClone(input.source.document.cleanup),
      }
    : {
        kind: "replace-v3-semantic-group",
        group: "lensBlur",
        value: structuredClone(input.source.document.lensBlur),
      };
  const applied = applyCommands(input.current, [command]);
  const changed = nonEmptyCommands(applied.changedCommands);
  return changed
    ? { kind: "changed", document: applied.document, commands: changed, note: null }
    : unchangedGroup(input.group);
}

async function copyGroup(input: {
  readonly adapter: BatchRunnerAdapter;
  readonly group: BatchSemanticGroup;
  readonly source: BatchSourceSnapshot;
  readonly target: Extract<BatchReconciledPhoto, { readonly kind: "v3" }>;
  readonly current: DevelopDocumentV3;
  readonly output: BatchPlan["output"];
}): Promise<GroupCopyResult> {
  let result: GroupCopyResult;
  switch (input.group) {
    case "input-profile":
      result = await copyInputProfile(input);
      break;
    case "white-balance":
      result = copyWhiteBalance(input.source.document, input.current);
      break;
    case "geometry-and-crop":
      result = await copyCrop(input);
      break;
    case "local-adjustments":
      result = copyLocal(input.source.document, input.current);
      break;
    case "cleanup":
    case "lens-blur":
      result = sameSourceOnlyGroup({
        group: input.group,
        source: input.source,
        target: input.target,
        current: input.current,
      });
      break;
    case "output-intent":
      result = input.output.kind === "save-and-export"
        ? { kind: "external", note: null }
        : unchangedGroup(input.group);
      break;
    case "optics":
    case "tone":
    case "curve-and-color":
    case "presence":
    case "detail":
    case "post-crop-effects":
    case "hdr-edit": {
      const commands = commandsForSimpleGroup(
        input.group,
        input.source.document,
        input.current,
      );
      const applied = applyCommands(input.current, commands);
      const changed = nonEmptyCommands(applied.changedCommands);
      result = changed
        ? { kind: "changed", document: applied.document, commands: changed, note: null }
        : unchangedGroup(input.group);
      break;
    }
    default: {
      const exhaustive: never = input.group;
      return exhaustive;
    }
  }
  if (result.kind === "skipped") return result;
  const proposedDocument = result.kind === "changed" ? result.document : input.current;
  const outputIntent = input.group === "output-intent" && input.output.kind === "save-and-export"
    ? input.output.outputIntent
    : null;
  const capabilitySkip = await validateCapability({
    adapter: input.adapter,
    group: input.group,
    source: input.source,
    target: input.target,
    document: proposedDocument,
    outputIntent,
  });
  return capabilitySkip ? { kind: "skipped", skip: capabilitySkip } : result;
}

async function planTarget(input: {
  readonly adapter: BatchRunnerAdapter;
  readonly groups: readonly BatchSemanticGroup[];
  readonly plan: BatchPlan;
  readonly source: BatchSourceSnapshot;
  readonly target: Extract<BatchReconciledPhoto, { readonly kind: "v3" }>;
}): Promise<TargetPlan> {
  let document = cloneDocument(input.target.document);
  const commands: V3EditCommand[] = [];
  const changedGroups: BatchSemanticGroup[] = [];
  const skippedGroups: BatchGroupSkip[] = [];
  let exportIntent: ExportOutputIntent | null = null;
  for (const group of input.groups) {
    const result = await copyGroup({
      adapter: input.adapter,
      group,
      source: input.source,
      target: input.target,
      current: document,
      output: input.plan.output,
    });
    if (result.kind === "skipped") {
      skippedGroups.push(result.skip);
      continue;
    }
    changedGroups.push(group);
    if (result.note) skippedGroups.push(result.note);
    if (result.kind === "external") {
      if (input.plan.output.kind === "save-and-export") {
        exportIntent = input.plan.output.outputIntent;
      }
      continue;
    }
    document = result.document;
    commands.push(...result.commands);
  }
  return { document, commands, changedGroups, skippedGroups, exportIntent };
}

function skipPrecedence(reason: BatchGroupSkipReason): number {
  switch (reason) {
    case "missing-asset": return 4;
    case "unsupported-capability": return 3;
    case "source-specific-policy": return 2;
    case "unchanged": return 1;
    default: {
      const exhaustive: never = reason;
      return exhaustive;
    }
  }
}

function skippedTarget(
  entryId: AssetId,
  skippedGroups: readonly BatchGroupSkip[],
): BatchPhotoResult {
  const best = [...skippedGroups].sort(
    (left, right) => skipPrecedence(right.reason) - skipPrecedence(left.reason),
  )[0];
  const reason: BatchSkipReason = best?.reason ?? "unchanged";
  return {
    kind: "skipped",
    entryId,
    reason,
    message: best?.message ?? "The target already matches the requested batch groups.",
    skippedGroups,
  };
}

function processKindSkip(photo: Exclude<BatchReconciledPhoto, { readonly kind: "v3" }>): BatchPhotoResult {
  if (photo.kind === "v2") {
    return {
      kind: "skipped",
      entryId: photo.entryId,
      reason: "v2-upgrade-required",
      message: "This photo requires an explicitly accepted v2 to v3 upgrade.",
      skippedGroups: [],
    };
  }
  return {
    kind: "skipped",
    entryId: photo.entryId,
    reason: "read-only-newer",
    message: `Develop process v${photo.foundVersion} is newer and read-only.`,
    skippedGroups: [],
  };
}

function sourceSkip(
  source: BatchSourceSnapshot,
  current: Extract<BatchReconciledPhoto, { readonly kind: "v3" }>,
  groups: readonly BatchSemanticGroup[],
): BatchPhotoResult {
  const matches = current.documentRevision === source.documentRevision &&
    sameSignature(current.source.signature, source.source.signature) &&
    documentsEqual(current.document, source.document);
  return matches
    ? {
        kind: "skipped",
        entryId: source.entryId,
        reason: "unchanged",
        message: "The source photo already contains the copied values.",
        skippedGroups: groups.map((group) =>
          groupSkip(group, "unchanged", "This is the batch source photo.")),
      }
    : {
        kind: "skipped",
        entryId: source.entryId,
        reason: "conflict",
        message: "The batch source changed after the plan was created.",
        skippedGroups: [],
      };
}

function cancelledResult(entryId: AssetId): BatchPhotoResult {
  return {
    kind: "skipped",
    entryId,
    reason: "cancelled",
    message: "Batch processing was cancelled before this photo.",
    skippedGroups: [],
  };
}

function progress(
  adapter: BatchRunnerAdapter,
  value: BatchProgress,
): void {
  adapter.onProgress?.(value);
}

function canonicalSelection(plan: BatchPlan): ExactBatchSelection {
  const selection = parseExactBatchSelection(plan.selection);
  const exact = selection.source === plan.selection.source &&
    selection.resultId === plan.selection.resultId &&
    selection.catalogId === plan.selection.catalogId &&
    selection.catalogRevision === plan.selection.catalogRevision &&
    selection.entryIds.length === plan.selection.entryIds.length &&
    selection.entryIds.every((entryId, index) => entryId === plan.selection.entryIds[index]);
  if (!exact) throw new Error("Batch selection identity is not canonical.");
  if (!selection.entryIds.includes(plan.sourceEntryId)) {
    throw new Error("Batch source photo is outside the exact selection.");
  }
  return selection;
}

function canonicalSource(
  plan: BatchPlan,
  selection: ExactBatchSelection,
  source: BatchSourceSnapshot,
): BatchSourceSnapshot {
  if (
    source.catalogId !== selection.catalogId ||
    source.entryId !== plan.sourceEntryId ||
    source.source.signature.catalogId !== selection.catalogId ||
    source.source.signature.entryId !== plan.sourceEntryId ||
    !validRevision(source.documentRevision)
  ) {
    throw new Error("Batch source identity does not match the exact selection.");
  }
  const parsedSource = parseSourceRecord(source.source);
  if (
    parsedSource.signature.catalogId !== selection.catalogId ||
    parsedSource.signature.entryId !== plan.sourceEntryId
  ) {
    throw new Error("Batch source record does not match the exact selection.");
  }
  return {
    ...source,
    document: cloneDocument(source.document),
    source: parsedSource,
  };
}

function expectedSource(source: BatchSourceSnapshot): BatchExpectedSourceRevision {
  return {
    entryId: source.entryId,
    documentRevision: source.documentRevision,
    signature: source.source.signature,
  };
}

async function processTarget(input: {
  readonly adapter: BatchRunnerAdapter;
  readonly plan: BatchPlan;
  readonly selection: ExactBatchSelection;
  readonly source: BatchSourceSnapshot;
  readonly groups: readonly BatchSemanticGroup[];
  readonly entryId: AssetId;
}): Promise<BatchPhotoResult> {
  let handle: BatchOpenHandle;
  try {
    handle = await input.adapter.open({ selection: input.selection, entryId: input.entryId });
    if (handle.entryId !== input.entryId || !validRevision(handle.token)) {
      throw new BatchRunnerAdapterError("open-identity", "The opened photo does not match the requested entry.");
    }
  } catch (error) {
    return failure(input.entryId, "open", error);
  }

  let photo: BatchReconciledPhoto;
  try {
    photo = await input.adapter.reconcile({ selection: input.selection, handle });
    if (
      photo.entryId !== input.entryId ||
      photo.catalogId !== input.selection.catalogId ||
      !validRevision(photo.documentRevision)
    ) {
      throw new BatchRunnerAdapterError(
        "reconcile-identity",
        "The reconciled photo does not match the exact selection.",
      );
    }
  } catch (error) {
    return failure(input.entryId, "reconcile", error);
  }

  if (photo.kind !== "v3") return processKindSkip(photo);
  let target: Extract<BatchReconciledPhoto, { readonly kind: "v3" }>;
  try {
    target = {
      ...photo,
      document: cloneDocument(photo.document),
      source: parseSourceRecord(photo.source),
    };
    if (
      target.source.signature.entryId !== input.entryId ||
      target.source.signature.catalogId !== input.selection.catalogId
    ) {
      throw new BatchRunnerAdapterError(
        "source-identity",
        "The target source identity does not match the selected entry.",
      );
    }
  } catch (error) {
    return failure(input.entryId, "reconcile", error);
  }
  if (input.entryId === input.source.entryId) {
    return sourceSkip(input.source, target, input.groups);
  }

  let targetPlan: TargetPlan;
  try {
    targetPlan = await planTarget({
      adapter: input.adapter,
      groups: input.groups,
      plan: input.plan,
      source: input.source,
      target,
    });
  } catch (error) {
    return failure(input.entryId, "command", error);
  }
  if (targetPlan.changedGroups.length === 0) {
    return skippedTarget(input.entryId, targetPlan.skippedGroups);
  }

  let revision = target.documentRevision;
  try {
    const revisionResult = await input.adapter.revalidate({
      source: expectedSource(input.source),
      target: {
        entryId: target.entryId,
        documentRevision: target.documentRevision,
        signature: target.source.signature,
      },
    });
    if (revisionResult.kind === "conflict") {
      return {
        kind: "skipped",
        entryId: input.entryId,
        reason: "conflict",
        message: boundedText(
          revisionResult.message,
          MAX_BATCH_RESULT_MESSAGE,
          "The source or target changed before commit.",
        ),
        skippedGroups: targetPlan.skippedGroups,
      };
    }
  } catch (error) {
    return failure(input.entryId, "reconcile", error);
  }

  const commands = nonEmptyCommands(targetPlan.commands);
  if (commands) {
    let receipt: BatchDispatchReceipt;
    try {
      receipt = await input.adapter.dispatch({
        entryId: input.entryId,
        expectedDocumentRevision: target.documentRevision,
        source: expectedSource(input.source),
        commands,
        label: "Apply batch develop settings",
      });
      if (
        !validRevision(receipt.documentRevision) ||
        !documentsEqual(receipt.document, targetPlan.document)
      ) {
        throw new BatchRunnerAdapterError(
          "command-receipt",
          "The session dispatch receipt does not match the planned v3 document.",
        );
      }
      revision = receipt.documentRevision;
    } catch (error) {
      return failure(input.entryId, "command", error);
    }
  }

  try {
    const receipt = await input.adapter.save({
      entryId: input.entryId,
      expectedDocumentRevision: revision,
      source: expectedSource(input.source),
    });
    if (!validRevision(receipt.documentRevision)) {
      throw new BatchRunnerAdapterError("save-receipt", "The save receipt has no valid revision.");
    }
    revision = receipt.documentRevision;
  } catch (error) {
    return failure(input.entryId, "save", error);
  }

  let completed: "save" | "save-and-export" = "save";
  if (targetPlan.exportIntent) {
    if (!input.adapter.export) {
      return failure(
        input.entryId,
        "export",
        new BatchRunnerAdapterError("export-unavailable", "The batch adapter has no export method."),
      );
    }
    try {
      const receipt = await input.adapter.export({
        entryId: input.entryId,
        expectedDocumentRevision: revision,
        source: expectedSource(input.source),
        outputIntent: targetPlan.exportIntent,
      });
      if (!validRevision(receipt.documentRevision)) {
        throw new BatchRunnerAdapterError(
          "export-receipt",
          "The export receipt has no valid document revision.",
        );
      }
      revision = receipt.documentRevision;
      completed = "save-and-export";
    } catch (error) {
      return failure(input.entryId, "export", error);
    }
  }

  const firstGroup = targetPlan.changedGroups[0];
  if (!firstGroup) return skippedTarget(input.entryId, targetPlan.skippedGroups);
  return {
    kind: "changed",
    entryId: input.entryId,
    changedGroups: [firstGroup, ...targetPlan.changedGroups.slice(1)],
    skippedGroups: targetPlan.skippedGroups,
    documentRevision: revision,
    completed,
  };
}

export async function runV3Batch(input: {
  readonly plan: BatchPlan;
  readonly source: BatchSourceSnapshot;
  readonly adapter: BatchRunnerAdapter;
}): Promise<BatchSummaryResult> {
  let selection: ExactBatchSelection;
  let source: BatchSourceSnapshot;
  let groups: readonly [BatchSemanticGroup, ...BatchSemanticGroup[]];
  try {
    selection = canonicalSelection(input.plan);
    source = canonicalSource(input.plan, selection, input.source);
    groups = orderedBatchGroups(input.plan.scope);
  } catch (error) {
    return {
      kind: "invalid",
      reason: error instanceof Error ? error.message : "Batch plan is invalid.",
    };
  }
  let selectionState: Awaited<ReturnType<BatchRunnerAdapter["validateSelection"]>>;
  try {
    selectionState = await input.adapter.validateSelection(selection);
  } catch (error) {
    return {
      kind: "invalid",
      reason: error instanceof Error ? error.message : "Exact batch selection validation failed.",
    };
  }
  if (selectionState.kind === "stale") {
    return {
      kind: "invalid",
      reason: boundedText(
        selectionState.message,
        MAX_BATCH_RESULT_MESSAGE,
        "The stored Library result changed.",
      ),
    };
  }

  const total = selection.entryIds.length;
  progress(input.adapter, { kind: "pending", total });
  const results: BatchPhotoResult[] = [];
  for (let index = 0; index < selection.entryIds.length; index += 1) {
    const entryId = selection.entryIds[index];
    if (!entryId) continue;
    progress(input.adapter, {
      kind: "running",
      completed: index,
      total,
      currentEntryId: entryId,
    });
    if (input.adapter.isCancelled?.()) {
      for (let remaining = index; remaining < selection.entryIds.length; remaining += 1) {
        const cancelledEntryId = selection.entryIds[remaining];
        if (cancelledEntryId) results.push(cancelledResult(cancelledEntryId));
      }
      break;
    }
    results.push(await processTarget({
      adapter: input.adapter,
      plan: input.plan,
      selection,
      source,
      groups,
      entryId,
    }));
  }
  progress(input.adapter, { kind: "complete", completed: total, total });
  return summarizeBatchResults(selection, results);
}
