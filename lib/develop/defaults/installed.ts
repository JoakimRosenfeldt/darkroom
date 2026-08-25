import { parseCatalogId, parseEntryId, parseOperationId, type CatalogId, type EntryId, type OperationId } from "../../catalog/ids.ts";
import {
  canonicalDevelopHistoryDocument,
  parseDevelopHistoryLoadedRevision,
  parseDevelopRevisionId,
  type DevelopHistoryLoadedRevision,
  type DevelopRevisionId,
} from "../history.ts";
import { validateV3CommandDocument } from "../v3/commands.ts";
import type { DevelopDocumentV3 } from "../v3/document.ts";
import { parseDevelopPresetId, type DevelopPresetId } from "../presets/schema.ts";
import { parseDevelopPresetField, type DevelopPresetField } from "../presets/policy.ts";
import { parseDevelopDefaultRuleId, type DevelopDefaultRuleId } from "./schema.ts";

export interface InstalledDevelopDefault {
  readonly catalogId: CatalogId;
  readonly entryId: EntryId;
  readonly revisionId: DevelopRevisionId;
  readonly ruleId: DevelopDefaultRuleId;
  readonly ruleRevision: number;
  readonly presetId: DevelopPresetId;
  readonly presetRevision: number;
  readonly selectedFields: readonly DevelopPresetField[];
  readonly baselineDocument: DevelopDocumentV3;
  readonly appliedFields: readonly DevelopPresetField[];
  readonly skipped: readonly { readonly field: DevelopPresetField; readonly reason: string }[];
  readonly unsupported: readonly { readonly field: DevelopPresetField; readonly reason: string }[];
  readonly createdAt: number;
}

export interface DevelopDefaultInstallInput {
  readonly catalogId: CatalogId;
  readonly entryId: EntryId;
  readonly expectedParentRevisionId: DevelopRevisionId;
  readonly revisionId: DevelopRevisionId;
  readonly operationId: OperationId;
  readonly label: string;
  readonly document: DevelopDocumentV3;
  readonly installed: Omit<InstalledDevelopDefault, "catalogId" | "entryId" | "revisionId">;
}

export type DevelopDefaultInstallResult =
  | { readonly kind: "installed"; readonly head: DevelopHistoryLoadedRevision; readonly installed: InstalledDevelopDefault }
  | { readonly kind: "already-installed"; readonly head: DevelopHistoryLoadedRevision; readonly installed: InstalledDevelopDefault }
  | { readonly kind: "not-pristine"; readonly head: DevelopHistoryLoadedRevision; readonly installed: null };

function fail(message: string): never { throw new Error(message); }
function record(value: unknown, label: string, keys: readonly string[]): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) fail(`${label} is invalid.`);
  const input = value as Record<string, unknown>;
  if (Object.keys(input).some((key) => !keys.includes(key))) fail(`${label} has unknown fields.`);
  return input;
}
function integer(value: unknown, label: string, minimum = 0): number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= minimum ? value : fail(`${label} is invalid.`);
}
function text(value: unknown, label: string, maximum = 512): string {
  return typeof value === "string" && value.trim().length > 0 && value.length <= maximum && !value.includes("\0")
    ? value.trim()
    : fail(`${label} is invalid.`);
}
function fields(value: unknown, label: string): readonly DevelopPresetField[] {
  if (!Array.isArray(value) || value.length > 32) fail(`${label} is invalid.`);
  const parsed = value.map(parseDevelopPresetField);
  if (new Set(parsed).size !== parsed.length) fail(`${label} contains duplicates.`);
  return parsed;
}
function reports(value: unknown, label: string): readonly { readonly field: DevelopPresetField; readonly reason: string }[] {
  if (!Array.isArray(value) || value.length > 32) fail(`${label} is invalid.`);
  return value.map((item) => {
    const input = record(item, label, ["field", "reason"]);
    return { field: parseDevelopPresetField(input.field), reason: text(input.reason, `${label} reason`) };
  });
}

export function parseInstalledDevelopDefault(value: unknown): InstalledDevelopDefault {
  const input = record(value, "Installed Develop default", [
    "catalogId", "entryId", "revisionId", "ruleId", "ruleRevision", "presetId", "presetRevision",
    "selectedFields", "baselineDocument", "appliedFields", "skipped", "unsupported", "createdAt",
  ]);
  return {
    catalogId: parseCatalogId(input.catalogId),
    entryId: parseEntryId(input.entryId),
    revisionId: parseDevelopRevisionId(input.revisionId),
    ruleId: parseDevelopDefaultRuleId(input.ruleId),
    ruleRevision: integer(input.ruleRevision, "Installed Develop default rule revision", 1),
    presetId: parseDevelopPresetId(input.presetId),
    presetRevision: integer(input.presetRevision, "Installed Develop default preset revision", 1),
    selectedFields: fields(input.selectedFields, "Installed Develop default selected fields"),
    baselineDocument: validateV3CommandDocument(input.baselineDocument),
    appliedFields: fields(input.appliedFields, "Installed Develop default applied fields"),
    skipped: reports(input.skipped, "Installed Develop default skipped field"),
    unsupported: reports(input.unsupported, "Installed Develop default unsupported field"),
    createdAt: integer(input.createdAt, "Installed Develop default timestamp"),
  };
}

export function parseDevelopDefaultInstallInput(value: unknown): DevelopDefaultInstallInput {
  const input = record(value, "Develop default install", [
    "catalogId", "entryId", "expectedParentRevisionId", "revisionId", "operationId", "label", "document", "installed",
  ]);
  const catalogId = parseCatalogId(input.catalogId);
  const entryId = parseEntryId(input.entryId);
  const revisionId = parseDevelopRevisionId(input.revisionId);
  const installed = parseInstalledDevelopDefault({
    ...record(input.installed, "Develop default install provenance", [
      "ruleId", "ruleRevision", "presetId", "presetRevision", "selectedFields", "baselineDocument",
      "appliedFields", "skipped", "unsupported", "createdAt",
    ]),
    catalogId,
    entryId,
    revisionId,
  });
  const document = validateV3CommandDocument(input.document);
  if (canonicalDevelopHistoryDocument(document) !== canonicalDevelopHistoryDocument(installed.baselineDocument)) {
    fail("Develop default baseline does not match its installed document.");
  }
  return {
    catalogId,
    entryId,
    expectedParentRevisionId: parseDevelopRevisionId(input.expectedParentRevisionId),
    revisionId,
    operationId: parseOperationId(input.operationId),
    label: text(input.label, "Develop default install label", 120),
    document,
    installed: {
      ruleId: installed.ruleId,
      ruleRevision: installed.ruleRevision,
      presetId: installed.presetId,
      presetRevision: installed.presetRevision,
      selectedFields: installed.selectedFields,
      baselineDocument: installed.baselineDocument,
      appliedFields: installed.appliedFields,
      skipped: installed.skipped,
      unsupported: installed.unsupported,
      createdAt: installed.createdAt,
    },
  };
}

export function parseDevelopDefaultInstallResult(value: unknown): DevelopDefaultInstallResult {
  const input = record(value, "Develop default install result", ["kind", "head", "installed"]);
  if (input.kind === "not-pristine") {
    if (input.installed !== null) fail("Not-pristine Develop default result cannot have provenance.");
    return { kind: "not-pristine", head: parseDevelopHistoryLoadedRevision(input.head), installed: null };
  }
  if (input.kind !== "installed" && input.kind !== "already-installed") fail("Develop default install result kind is invalid.");
  return { kind: input.kind, head: parseDevelopHistoryLoadedRevision(input.head), installed: parseInstalledDevelopDefault(input.installed) };
}
