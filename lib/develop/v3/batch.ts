import {
  parseEntryId,
  parseCatalogId,
  type EntryId,
  type CatalogId,
} from "@/lib/catalog/ids";
import type { ExportOutputIntent } from "../render-contract";

export const MAX_BATCH_PHOTOS = 10_000;

export const BATCH_SEMANTIC_GROUPS = [
  "input-profile",
  "white-balance",
  "optics",
  "geometry-and-crop",
  "tone",
  "curve-and-color",
  "local-adjustments",
  "presence",
  "detail",
  "cleanup",
  "lens-blur",
  "post-crop-effects",
  "hdr-edit",
  "output-intent",
] as const satisfies readonly string[];

export type BatchSemanticGroup = (typeof BATCH_SEMANTIC_GROUPS)[number];

export interface ExactBatchSelection {
  readonly source: "stored-library-result";
  readonly resultId: string;
  readonly catalogId: CatalogId;
  readonly catalogRevision: number;
  readonly entryIds: readonly [EntryId, ...EntryId[]];
}

export type BatchCopyScope =
  | {
      readonly kind: "current-group";
      readonly group: BatchSemanticGroup;
    }
  | {
      readonly kind: "selected-groups";
      readonly groups: readonly [BatchSemanticGroup, ...BatchSemanticGroup[]];
    }
  | {
      readonly kind: "full-document";
      readonly confirmation: "explicit";
    };

export type BatchOutputAction =
  | { readonly kind: "save" }
  | {
      readonly kind: "save-and-export";
      readonly outputIntent: ExportOutputIntent;
    };

export interface BatchPlan {
  readonly selection: ExactBatchSelection;
  readonly sourceEntryId: EntryId;
  readonly scope: BatchCopyScope;
  readonly output: BatchOutputAction;
}

export type BatchSourceSpecificField =
  | "input-profile-id"
  | "white-balance-sample-coordinate"
  | "repair"
  | "generated-asset"
  | "crop"
  | "mask"
  | "output-intent";

export type BatchSourceSpecificPolicy =
  | {
      readonly kind: "match-compatible-or-skip";
      readonly reason: string;
    }
  | {
      readonly kind: "copy-resolved-values";
      readonly reason: string;
    }
  | {
      readonly kind: "same-source-only";
      readonly reason: string;
    }
  | {
      readonly kind: "copy-normalized-and-validate";
      readonly reason: string;
    }
  | {
      readonly kind: "copy-portable-components-only";
      readonly reason: string;
    }
  | {
      readonly kind: "explicit-only";
      readonly reason: string;
    };

export const BATCH_SOURCE_SPECIFIC_POLICIES = {
  "input-profile-id": {
    kind: "match-compatible-or-skip",
    reason: "Resolve the profile against each target source. Never force an incompatible ID.",
  },
  "white-balance-sample-coordinate": {
    kind: "copy-resolved-values",
    reason: "Copy accepted numeric WB values, not the source sample coordinate.",
  },
  repair: {
    kind: "same-source-only",
    reason: "Repair geometry and patches remain bound to their original source.",
  },
  "generated-asset": {
    kind: "same-source-only",
    reason: "Generated assets require an exact current source and producer fingerprint.",
  },
  crop: {
    kind: "copy-normalized-and-validate",
    reason: "Copy normalized crop geometry, then validate it for the target source.",
  },
  mask: {
    kind: "copy-portable-components-only",
    reason: "Copy manual normalized components. Skip source-signed generated mattes.",
  },
  "output-intent": {
    kind: "explicit-only",
    reason: "Copy output intent only when the batch scope explicitly includes it.",
  },
} as const satisfies Readonly<
  Record<BatchSourceSpecificField, BatchSourceSpecificPolicy>
>;

export type BatchSkipReason =
  | "unchanged"
  | "v2-upgrade-required"
  | "read-only-newer"
  | "unsupported-capability"
  | "source-specific-policy"
  | "conflict"
  | "missing-asset"
  | "cancelled";

export type BatchGroupSkipReason =
  | "unchanged"
  | "unsupported-capability"
  | "source-specific-policy"
  | "missing-asset";

export interface BatchGroupSkip {
  readonly group: BatchSemanticGroup;
  readonly reason: BatchGroupSkipReason;
  readonly message: string;
}

export type BatchFailurePhase =
  | "open"
  | "reconcile"
  | "upgrade"
  | "command"
  | "save"
  | "export";

export type BatchPhotoResult =
  | {
      readonly kind: "changed";
      readonly entryId: EntryId;
      readonly changedGroups: readonly [BatchSemanticGroup, ...BatchSemanticGroup[]];
      readonly skippedGroups: readonly BatchGroupSkip[];
      readonly documentRevision: string;
      readonly completed: BatchOutputAction["kind"];
    }
  | {
      readonly kind: "skipped";
      readonly entryId: EntryId;
      readonly reason: BatchSkipReason;
      readonly message: string;
      readonly skippedGroups: readonly BatchGroupSkip[];
    }
  | {
      readonly kind: "failed";
      readonly entryId: EntryId;
      readonly phase: BatchFailurePhase;
      readonly code: string;
      readonly message: string;
    };

export interface BatchResultSummary {
  readonly selection: ExactBatchSelection;
  readonly results: readonly BatchPhotoResult[];
  readonly changed: number;
  readonly skipped: number;
  readonly failed: number;
}

export type BatchSummaryResult =
  | { readonly kind: "complete"; readonly summary: BatchResultSummary }
  | { readonly kind: "invalid"; readonly reason: string };

export type BatchProgress =
  | { readonly kind: "pending"; readonly total: number }
  | {
      readonly kind: "running";
      readonly completed: number;
      readonly total: number;
      readonly currentEntryId: EntryId;
    }
  | {
      readonly kind: "complete";
      readonly completed: number;
      readonly total: number;
    };

export function orderedBatchGroups(
  scope: BatchCopyScope,
): readonly [BatchSemanticGroup, ...BatchSemanticGroup[]] {
  switch (scope.kind) {
    case "current-group":
      return [parseBatchSemanticGroup(scope.group)];
    case "selected-groups": {
      const parsed = scope.groups.map(parseBatchSemanticGroup);
      const selected = new Set(parsed);
      if (selected.size !== parsed.length) {
        throw new Error("Selected batch groups contain duplicates.");
      }
      const groups = BATCH_SEMANTIC_GROUPS.filter((group) => selected.has(group));
      const first = groups[0];
      if (!first) throw new Error("Selected batch groups are empty.");
      return [first, ...groups.slice(1)];
    }
    case "full-document":
      if (scope.confirmation !== "explicit") {
        throw new Error("Full-document batch copy requires explicit confirmation.");
      }
      return BATCH_SEMANTIC_GROUPS;
    default: {
      const exhaustive: never = scope;
      return exhaustive;
    }
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function boundedResultId(value: unknown): string {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value.length > 256 ||
    value.includes("\0")
  ) {
    throw new Error("Library result ID is invalid.");
  }
  return value;
}

function parseBatchSemanticGroup(value: unknown): BatchSemanticGroup {
  for (const group of BATCH_SEMANTIC_GROUPS) {
    if (value === group) return group;
  }
  throw new Error("Batch semantic group is invalid.");
}

export function parseExactBatchSelection(value: unknown): ExactBatchSelection {
  if (
    !isRecord(value) ||
    value.source !== "stored-library-result" ||
    !Array.isArray(value.entryIds) ||
    value.entryIds.length === 0 ||
    value.entryIds.length > MAX_BATCH_PHOTOS ||
    typeof value.catalogRevision !== "number" ||
    !Number.isSafeInteger(value.catalogRevision) ||
    value.catalogRevision < 0
  ) {
    throw new Error("Exact batch selection is invalid.");
  }
  const entryIds = value.entryIds.map(parseEntryId);
  if (new Set(entryIds).size !== entryIds.length) {
    throw new Error("Exact batch selection contains duplicate photos.");
  }
  const first = entryIds[0];
  if (!first) throw new Error("Exact batch selection is empty.");
  return {
    source: "stored-library-result",
    resultId: boundedResultId(value.resultId),
    catalogId: parseCatalogId(value.catalogId),
    catalogRevision: value.catalogRevision,
    entryIds: [first, ...entryIds.slice(1)],
  };
}

export function defaultBatchPlan(input: {
  readonly selection: ExactBatchSelection;
  readonly sourceEntryId: EntryId;
  readonly currentGroup: BatchSemanticGroup;
  readonly output?: BatchOutputAction;
}): BatchPlan {
  if (!input.selection.entryIds.includes(input.sourceEntryId)) {
    throw new Error("Batch source photo is outside the exact selection.");
  }
  parseBatchSemanticGroup(input.currentGroup);
  return {
    selection: input.selection,
    sourceEntryId: input.sourceEntryId,
    scope: { kind: "current-group", group: input.currentGroup },
    output: input.output ?? { kind: "save" },
  };
}

export function selectedGroupsScope(value: unknown): BatchCopyScope {
  if (!Array.isArray(value) || value.length === 0 || value.length > BATCH_SEMANTIC_GROUPS.length) {
    throw new Error("Selected batch groups are invalid.");
  }
  const groups = value.map(parseBatchSemanticGroup);
  if (new Set(groups).size !== groups.length) {
    throw new Error("Selected batch groups contain duplicates.");
  }
  const first = groups[0];
  if (!first) throw new Error("Selected batch groups are empty.");
  return { kind: "selected-groups", groups: [first, ...groups.slice(1)] };
}

export function fullDocumentScope(confirmation: unknown): BatchCopyScope {
  if (confirmation !== "explicit") {
    throw new Error("Full-document batch copy requires explicit confirmation.");
  }
  return { kind: "full-document", confirmation: "explicit" };
}

function boundedResultText(value: string): boolean {
  return value.length > 0 && value.length <= 1_024 && !value.includes("\0");
}

function groupSkipsAreValid(skips: readonly BatchGroupSkip[]): boolean {
  return skips.length <= BATCH_SEMANTIC_GROUPS.length &&
    new Set(skips.map((skip) => skip.group)).size === skips.length &&
    skips.every((skip) =>
      BATCH_SEMANTIC_GROUPS.includes(skip.group) && boundedResultText(skip.message)
    );
}

function resultIsValid(result: BatchPhotoResult): boolean {
  switch (result.kind) {
    case "changed":
      return result.changedGroups.length > 0 &&
        result.changedGroups.length <= BATCH_SEMANTIC_GROUPS.length &&
        new Set(result.changedGroups).size === result.changedGroups.length &&
        result.changedGroups.every((group) => BATCH_SEMANTIC_GROUPS.includes(group)) &&
        groupSkipsAreValid(result.skippedGroups) &&
        boundedResultText(result.documentRevision);
    case "skipped":
      return boundedResultText(result.message) && groupSkipsAreValid(result.skippedGroups);
    case "failed":
      return boundedResultText(result.code) && boundedResultText(result.message);
    default: {
      const exhaustive: never = result;
      return exhaustive;
    }
  }
}

export function summarizeBatchResults(
  selection: ExactBatchSelection,
  results: readonly BatchPhotoResult[],
): BatchSummaryResult {
  if (results.length !== selection.entryIds.length) {
    return { kind: "invalid", reason: "Batch results do not cover the exact selection." };
  }
  for (let index = 0; index < results.length; index += 1) {
    const result = results[index];
    if (!result || result.entryId !== selection.entryIds[index] || !resultIsValid(result)) {
      return { kind: "invalid", reason: "Batch result order or content is invalid." };
    }
  }
  let changed = 0;
  let skipped = 0;
  let failed = 0;
  for (const result of results) {
    switch (result.kind) {
      case "changed":
        changed += 1;
        break;
      case "skipped":
        skipped += 1;
        break;
      case "failed":
        failed += 1;
        break;
      default: {
        const exhaustive: never = result;
        return exhaustive;
      }
    }
  }
  return {
    kind: "complete",
    summary: { selection, results, changed, skipped, failed },
  };
}

export function batchProgress(input: {
  readonly selection: ExactBatchSelection;
  readonly completed: number;
}): BatchProgress {
  const total = input.selection.entryIds.length;
  if (!Number.isSafeInteger(input.completed) || input.completed < 0 || input.completed > total) {
    throw new Error("Batch progress is invalid.");
  }
  if (input.completed === 0) return { kind: "pending", total };
  if (input.completed === total) {
    return { kind: "complete", completed: total, total };
  }
  const currentEntryId = input.selection.entryIds[input.completed];
  if (!currentEntryId) throw new Error("Batch progress has no current photo.");
  return {
    kind: "running",
    completed: input.completed,
    total,
    currentEntryId,
  };
}
