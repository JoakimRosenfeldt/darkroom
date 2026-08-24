import { createHash, randomUUID } from "node:crypto";
import path from "node:path";
import {
  canonicalJson,
  parseJsonValue,
  renderImportTemplate,
  type FileObservation,
  type FrozenImportPlan,
  type FrozenPresetSnapshot,
  type ImportAction,
  type ImportConflict,
  type ImportConflictDecisions,
  type ImportDestinationDecision,
  type ImportDuplicateDecision,
  type ImportPlanDraft,
  type ImportPlanItem,
  type ImportPlanReview,
  type ImportPreset,
  type ImportSource,
  type JsonObject,
  type DngAdapterResult,
} from "../lib/import/domain.ts";
import {
  createAssetId,
  parseOperationId,
  type AssetId,
  type CatalogId,
  type OperationId,
  type RootId,
} from "../lib/catalog/ids.ts";

export interface ImportPlanSourceInput {
  readonly source: ImportSource;
  readonly action: ImportAction;
  readonly sourceAssetId?: AssetId;
  readonly destinationDate?: Date;
  readonly cameraMake?: string;
  readonly cameraModel?: string;
  readonly sequence?: number;
}

export interface CreateImportPlanInput {
  readonly operationId: OperationId;
  readonly catalogId: CatalogId;
  readonly destinationRootId: RootId;
  readonly preset: ImportPreset;
  readonly sources: readonly ImportPlanSourceInput[];
  readonly now?: number;
}

export interface ImportPlanReviewInput {
  readonly destinationExists?: ReadonlySet<string>;
  readonly duplicateItems?: ReadonlySet<AssetId>;
  readonly notFullyCheckedItems?: ReadonlySet<AssetId>;
  readonly duplicateDecisions?: ReadonlyMap<AssetId, ImportDuplicateDecision>;
  readonly destinationDecisions?: ReadonlyMap<AssetId, ImportDestinationDecision>;
}

export interface FreezeImportPlanInput {
  readonly draft: ImportPlanDraft;
  readonly review: ImportPlanReview;
}

export interface DngAdapter {
  readonly convert: (input: unknown) => Promise<DngAdapterResult>;
}

function sha256(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function pathExtension(relativePath: string): string {
  const basename = relativePath.split("/").at(-1) ?? relativePath;
  const dot = basename.lastIndexOf(".");
  return dot > 0 ? basename.slice(dot + 1) : "";
}

function pathStem(relativePath: string): string {
  const basename = relativePath.split("/").at(-1) ?? relativePath;
  const dot = basename.lastIndexOf(".");
  return dot > 0 ? basename.slice(0, dot) : basename;
}

function pathFilename(relativePath: string): string {
  return relativePath.split("/").at(-1) ?? relativePath;
}

function sourceDate(source: ImportSource, fallback: number): Date {
  const timestamp = source.observation.modifiedAt || fallback;
  const date = new Date(timestamp);
  if (Number.isNaN(date.getTime())) {
    return new Date(fallback);
  }
  return date;
}

function xmpRelativePath(destinationRelativePath: string): string {
  const extension = path.posix.extname(destinationRelativePath);
  const basename = extension
    ? destinationRelativePath.slice(0, -extension.length)
    : destinationRelativePath;
  return `${basename}.xmp`;
}

function itemCanonicalJson(item: ImportPlanItem): JsonObject {
  return {
    itemId: item.itemId,
    sourceAssetId: item.sourceAssetId,
    destinationAssetId: item.destinationAssetId,
    action: item.action,
    source: {
      rootId: item.source.rootId,
      relativePath: item.source.relativePath,
      observation: {
        size: item.source.observation.size,
        modifiedAt: item.source.observation.modifiedAt,
        localFileId: item.source.observation.localFileId,
        observedAt: item.source.observation.observedAt,
      },
      xmpState: item.source.xmpState,
      formatId: item.source.formatId,
    },
    destinationRelativePath: item.destinationRelativePath,
    xmpDestinationRelativePath: item.xmpDestinationRelativePath,
    conflictDecisions: {
      duplicate: item.conflictDecisions.duplicate === null
        ? null
        : item.conflictDecisions.duplicate.kind === "use-existing-location"
          ? { kind: "use-existing-location", existingAssetId: item.conflictDecisions.duplicate.existingAssetId }
          : { kind: item.conflictDecisions.duplicate.kind },
      destination: item.conflictDecisions.destination === null
        ? null
        : item.conflictDecisions.destination.kind === "rename"
          ? { kind: "rename", destinationRelativePath: item.conflictDecisions.destination.destinationRelativePath }
          : { kind: item.conflictDecisions.destination.kind },
    },
  };
}

function presetSnapshotCanonicalJson(preset: FrozenPresetSnapshot): JsonObject {
  return {
    catalogId: preset.catalogId,
    presetId: preset.presetId,
    name: preset.name,
    version: preset.version,
    canonicalJson: preset.canonicalJson,
    sha256: preset.sha256,
  };
}

function presetCanonicalJson(preset: ImportPreset): string {
  const value: JsonObject = {
    catalogId: preset.catalogId,
    presetId: preset.presetId,
    name: preset.name,
    version: preset.version,
    template: { pattern: preset.template.pattern },
    payload: preset.payload,
    updatedAt: preset.updatedAt,
  };
  return canonicalJson(value);
}

function freezePreset(preset: ImportPreset): FrozenPresetSnapshot {
  const canonical = presetCanonicalJson(preset);
  return {
    catalogId: preset.catalogId,
    presetId: preset.presetId,
    name: preset.name,
    version: preset.version,
    canonicalJson: canonical,
    sha256: sha256(canonical),
  };
}

function planCanonicalJson(
  draft: ImportPlanDraft,
  preset: FrozenPresetSnapshot,
): string {
  const value: JsonObject = {
    operationId: draft.operationId,
    catalogId: draft.catalogId,
    destinationRootId: draft.destinationRootId,
    preset: presetSnapshotCanonicalJson(preset),
    items: draft.items.map((item) => itemCanonicalJson(item)),
    createdAt: draft.createdAt,
  };
  return canonicalJson(value);
}

function applyReviewDecisions(
  draft: ImportPlanDraft,
  decisionsByItem: ReadonlyMap<AssetId, ImportConflictDecisions>,
): ImportPlanDraft {
  return {
    ...draft,
    items: draft.items.map((item) => {
      const decisions = decisionsByItem.get(item.itemId) ?? item.conflictDecisions;
      const destination = decisions.destination;
      const destinationRelativePath = destination?.kind === "rename"
        ? destination.destinationRelativePath
        : item.destinationRelativePath;
      const duplicate = decisions.duplicate;
      const destinationAssetId = duplicate?.kind === "use-existing-location"
        ? duplicate.existingAssetId
        : item.destinationAssetId;
      return {
        ...item,
        destinationRelativePath,
        xmpDestinationRelativePath: destination?.kind === "rename" && item.xmpDestinationRelativePath !== null
          ? xmpRelativePath(destinationRelativePath)
          : item.xmpDestinationRelativePath,
        destinationAssetId,
        conflictDecisions: decisions,
      };
    }),
  };
}

export function createImportPlan(input: CreateImportPlanInput): ImportPlanDraft {
  if (input.preset.catalogId !== input.catalogId) {
    throw new Error("Import preset belongs to a different catalog.");
  }
  const now = input.now ?? Date.now();
  const items = input.sources.map((sourceInput): ImportPlanItem => {
    if (sourceInput.source.formatId.toLowerCase() === "dng") {
      throw new Error("DNG import is unavailable until a conversion backend exists.");
    }
    if (sourceInput.action !== "add" && sourceInput.action !== "copy" && sourceInput.action !== "move" && sourceInput.action !== "rename") {
      throw new Error("Import action is invalid.");
    }
    if (sourceInput.action === "rename" && sourceInput.sourceAssetId === undefined) {
      throw new Error("Rename requires an existing AssetId.");
    }
    const destinationDate = sourceInput.destinationDate ?? sourceDate(sourceInput.source, now);
    const destinationRelativePath = sourceInput.action === "add"
      ? sourceInput.source.relativePath
      : renderImportTemplate(input.preset.template, {
        filename: pathFilename(sourceInput.source.relativePath),
        stem: pathStem(sourceInput.source.relativePath),
        extension: pathExtension(sourceInput.source.relativePath),
        original: pathFilename(sourceInput.source.relativePath),
        cameraMake: sourceInput.cameraMake ?? "Unknown",
        cameraModel: sourceInput.cameraModel ?? "Unknown",
        sequence: sourceInput.sequence ?? 1,
        date: destinationDate,
      });
    const sourceAssetId = sourceInput.sourceAssetId ?? null;
    const destinationAssetId =
      sourceInput.action === "copy" || sourceAssetId === null
        ? createAssetId()
        : sourceAssetId;
    return {
      itemId: createAssetId(),
      sourceAssetId,
      destinationAssetId,
      action: sourceInput.action,
      source: sourceInput.source,
      destinationRelativePath,
      xmpDestinationRelativePath:
        sourceInput.source.xmpState === "present"
          ? xmpRelativePath(destinationRelativePath)
          : null,
      conflictDecisions: { duplicate: null, destination: null },
    };
  });
  return {
    operationId: input.operationId,
    catalogId: input.catalogId,
    destinationRootId: input.destinationRootId,
    preset: input.preset,
    items,
    createdAt: now,
  };
}

export function reviewImportPlan(
  draft: ImportPlanDraft,
  input: ImportPlanReviewInput = {},
): ImportPlanReview {
  const conflicts: ImportConflict[] = [];
  const decisions: { itemId: AssetId; decisions: ImportConflictDecisions }[] = [];
  const destinations = new Set<string>();
  for (const item of draft.items) {
    const duplicate = input.duplicateDecisions?.get(item.itemId) ?? item.conflictDecisions.duplicate;
    const destination = input.destinationDecisions?.get(item.itemId) ?? item.conflictDecisions.destination;
    const itemDecisions: ImportConflictDecisions = { duplicate, destination };
    if (duplicate !== null || destination !== null) {
      decisions.push({ itemId: item.itemId, decisions: itemDecisions });
    }
    const effectiveDestination = destination?.kind === "rename"
      ? destination.destinationRelativePath
      : item.destinationRelativePath;
    const duplicateSkipped = duplicate?.kind === "skip-incoming";
    const destinationSkipped = destination?.kind === "skip";
    if (!duplicateSkipped && !destinationSkipped && destinations.has(effectiveDestination)) {
      conflicts.push({
        itemId: item.itemId,
        destinationRelativePath: effectiveDestination,
        kind: "destination-exists",
        severity: "error",
      });
    }
    if (!duplicateSkipped && !destinationSkipped) {
      destinations.add(effectiveDestination);
    }
    if (!duplicateSkipped && !destinationSkipped && input.destinationExists?.has(item.destinationRelativePath) && destination === null) {
      conflicts.push({
        itemId: item.itemId,
        destinationRelativePath: item.destinationRelativePath,
        kind: "destination-exists",
        severity: "error",
      });
    }
    if (!duplicateSkipped && !destinationSkipped && destination?.kind === "rename" && input.destinationExists?.has(destination.destinationRelativePath)) {
      conflicts.push({
        itemId: item.itemId,
        destinationRelativePath: destination.destinationRelativePath,
        kind: "destination-exists",
        severity: "error",
      });
    }
    if (!destinationSkipped && input.duplicateItems?.has(item.itemId) && duplicate === null) {
      conflicts.push({
        itemId: item.itemId,
        destinationRelativePath: item.destinationRelativePath,
        kind: "duplicate",
        severity: "error",
      });
    }
    if (
      !destinationSkipped &&
      input.notFullyCheckedItems?.has(item.itemId) &&
      duplicate?.kind !== "skip-incoming" &&
      duplicate?.kind !== "continue-unchecked"
    ) {
      conflicts.push({
        itemId: item.itemId,
        destinationRelativePath: item.destinationRelativePath,
        kind: "duplicate",
        severity: "error",
      });
    }
    if (item.source.xmpState === "unreadable") {
      conflicts.push({
        itemId: item.itemId,
        destinationRelativePath: item.destinationRelativePath,
        kind: "xmp-mismatch",
        severity: "error",
      });
    }
  }
  if (input.duplicateDecisions !== undefined || input.destinationDecisions !== undefined) {
    const itemIds = new Set(draft.items.map((item) => item.itemId));
    const providedItemIds = [
      ...(input.duplicateDecisions?.keys() ?? []),
      ...(input.destinationDecisions?.keys() ?? []),
    ];
    for (const itemId of providedItemIds) {
      if (!itemIds.has(itemId)) {
        throw new Error("Import conflict decision refers to an unknown item.");
      }
    }
  }
  const decisionsByItem = new Map(decisions.map((entry) => [entry.itemId, entry.decisions]));
  const reviewedDraft = applyReviewDecisions(draft, decisionsByItem);
  return {
    planSha256: sha256(planCanonicalJson(reviewedDraft, freezePreset(draft.preset))),
    conflicts,
    decisions,
    canFreeze: conflicts.every((conflict) => conflict.severity !== "error"),
  };
}

export function freezeImportPlan(input: FreezeImportPlanInput): FrozenImportPlan {
  if (!input.review.canFreeze) {
    throw new Error("Import plan has blocking conflicts.");
  }
  const preset = freezePreset(input.draft.preset);
  const itemIds = new Set(input.draft.items.map((item) => item.itemId));
  const decisionsByItem = new Map<AssetId, ImportConflictDecisions>();
  for (const entry of input.review.decisions) {
    if (!itemIds.has(entry.itemId) || decisionsByItem.has(entry.itemId)) {
      throw new Error("Import plan review contains an invalid decision entry.");
    }
    decisionsByItem.set(entry.itemId, entry.decisions);
  }
  const reviewedDraft = applyReviewDecisions(input.draft, decisionsByItem);
  const reviewedCanonical = planCanonicalJson(reviewedDraft, preset);
  if (input.review.planSha256 !== sha256(reviewedCanonical)) {
    throw new Error("Import plan review is stale.");
  }
  const canonical = planCanonicalJson(reviewedDraft, preset);
  return {
    operationId: input.draft.operationId,
    catalogId: input.draft.catalogId,
    destinationRootId: input.draft.destinationRootId,
    preset,
    items: reviewedDraft.items.map((item) => structuredClone(item)),
    createdAt: reviewedDraft.createdAt,
    planSha256: sha256(canonical),
  };
}

export function verifyFrozenImportPlan(plan: FrozenImportPlan): void {
  let presetValue: ReturnType<typeof parseJsonValue>;
  try {
    presetValue = parseJsonValue(JSON.parse(plan.preset.canonicalJson), "Frozen preset JSON");
  } catch {
    throw new Error("Frozen preset canonical JSON is invalid.");
  }
  if (
    canonicalJson(presetValue) !== plan.preset.canonicalJson ||
    sha256(plan.preset.canonicalJson) !== plan.preset.sha256
  ) {
    throw new Error("Frozen preset snapshot hash does not match its contents.");
  }
  const canonical = canonicalJson({
    operationId: plan.operationId,
    catalogId: plan.catalogId,
    destinationRootId: plan.destinationRootId,
    preset: presetSnapshotCanonicalJson(plan.preset),
    items: plan.items.map((item) => itemCanonicalJson(item)),
    createdAt: plan.createdAt,
  });
  if (sha256(canonical) !== plan.planSha256) {
    throw new Error("Frozen import plan hash does not match its contents.");
  }
}

export function createUnavailableDngAdapter(reason = "DNG conversion backend is unavailable."): DngAdapter {
  return {
    convert: async () => ({ status: "unavailable", reason }),
  };
}

export function randomOperationId(): OperationId {
  return parseOperationId(randomUUID());
}

export function observationFromStat(
  stat: { readonly size: number; readonly mtimeMs: number; readonly localFileId?: string | null },
  observedAt = Date.now(),
): FileObservation {
  return {
    size: stat.size,
    modifiedAt: stat.mtimeMs,
    localFileId: stat.localFileId ?? null,
    observedAt,
  };
}
