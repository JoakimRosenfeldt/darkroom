import type { SourceId } from "../../catalog/ids.ts";
import {
  calculateDevelopPresetApplication,
  immutablePresetSnapshot,
  type DevelopPresetCameraProfileContext,
  type DevelopPresetFieldReport,
} from "../presets/apply.ts";
import type { DevelopPresetField } from "../presets/schema.ts";
import type { V3DirectEditCommand } from "../v3/commands.ts";
import { validateV3CommandDocument } from "../v3/commands.ts";
import type { DevelopDocumentV3 } from "../v3/document.ts";
import type { DevelopDefaultMatchResult, MatchedDevelopDefault } from "./matcher.ts";
import { cloneDevelopDefaultRule, type DevelopDefaultRuleId } from "./schema.ts";

export interface DevelopDefaultApplicationReport {
  readonly applied: readonly DevelopPresetField[];
  readonly skipped: readonly DevelopPresetFieldReport[];
  readonly unsupported: readonly DevelopPresetFieldReport[];
}

export interface DevelopDefaultBaselineProvenance {
  readonly ruleId: DevelopDefaultRuleId;
  readonly ruleRevision: number;
  readonly presetId: MatchedDevelopDefault["preset"]["presetId"];
  readonly presetRevision: number;
  readonly selectedFields: readonly DevelopPresetField[];
  readonly report: DevelopDefaultApplicationReport;
}

interface DevelopDefaultCandidateBase {
  readonly document: DevelopDocumentV3;
  readonly controls: {
    readonly kind: "blocked";
    readonly reason: "initial-document-not-durable";
  };
}

export type DevelopDefaultCreationCandidate =
  | DevelopDefaultCandidateBase & {
      readonly kind: "matched-default-candidate";
      readonly baseline: DevelopDefaultBaselineProvenance;
      readonly rule: MatchedDevelopDefault["rule"];
      readonly preset: MatchedDevelopDefault["preset"];
    }
  | DevelopDefaultCandidateBase & {
      readonly kind: "neutral-default-candidate";
      readonly baseline: null;
      readonly rule: null;
      readonly preset: null;
    };

export interface DevelopDefaultApplicationContext {
  readonly sourceId: SourceId;
  readonly cameraProfile: DevelopPresetCameraProfileContext;
}

export interface DurableDevelopDefaultDocument<Head> {
  readonly head: Head;
  readonly document: DevelopDocumentV3;
  readonly baseline: DevelopDefaultBaselineProvenance | null;
}

export interface DevelopDefaultInstallAdapter<Head> {
  readonly load: () => Promise<DurableDevelopDefaultDocument<Head> | null>;
  readonly installIfAbsent: (
    candidate: DevelopDefaultCreationCandidate,
  ) => Promise<
    | { readonly kind: "installed"; readonly value: DurableDevelopDefaultDocument<Head> }
    | { readonly kind: "already-installed"; readonly value: DurableDevelopDefaultDocument<Head> }
  >;
}

export type LoadOrCreateDevelopDefaultResult<Head> =
  | {
      readonly kind: "existing-hydrated-document";
      readonly source: "app" | "accepted-source-xmp";
      readonly controls: { readonly kind: "enabled" };
    }
  | {
      readonly kind: "existing-head" | "created" | "created-without-default" | "lost-race";
      readonly value: DurableDevelopDefaultDocument<Head>;
      readonly controls: { readonly kind: "enabled" };
    };

function selectedReport(
  selectedFields: readonly DevelopPresetField[],
  sourceSpecificSkipped: readonly DevelopPresetFieldReport[],
  report: ReturnType<typeof calculateDevelopPresetApplication>["report"],
): DevelopDefaultApplicationReport {
  const selected = new Set(selectedFields);
  return {
    applied: report.included.filter((field) => selected.has(field)),
    skipped: [
      ...sourceSpecificSkipped,
      ...report.skipped.filter((entry) => selected.has(entry.field)),
    ],
    unsupported: report.unsupported.filter((entry) => selected.has(entry.field)),
  };
}

export function prepareDevelopDefaultCandidate(input: {
  readonly match: MatchedDevelopDefault;
  readonly initialDocument: DevelopDocumentV3;
  readonly context: DevelopDefaultApplicationContext;
}): DevelopDefaultCreationCandidate {
  const initialDocument = validateV3CommandDocument(input.initialDocument);
  const rule = cloneDevelopDefaultRule(input.match.rule);
  const preset = immutablePresetSnapshot(input.match.preset);
  if (
    rule.preset.presetId !== preset.presetId ||
    rule.preset.presetRevision !== preset.revision ||
    rule.preset.selectedFields.some((field) => !preset.fields.includes(field))
  ) {
    throw new Error("Develop default candidate does not match its immutable preset revision.");
  }
  const selectedFields = rule.preset.selectedFields;
  const safeFields = selectedFields.filter((field) => field !== "ai-masks");
  const sourceSpecificSkipped: DevelopPresetFieldReport[] = selectedFields.includes("ai-masks")
    ? [{ field: "ai-masks", reason: "Source-specific AI masks never apply as Develop defaults." }]
    : [];
  const application = safeFields.length > 0
    ? calculateDevelopPresetApplication({
        document: initialDocument,
        preset,
        selectedFields: safeFields,
        amount: 100,
        context: {
          sourceId: input.context.sourceId,
          cameraProfile: input.context.cameraProfile,
          regenerateAiMasks: false,
        },
      })
    : {
        document: initialDocument,
        report: { included: [], skipped: [], unsupported: [], regenerationRequests: [] },
      };
  return {
    kind: "matched-default-candidate",
    document: validateV3CommandDocument(application.document),
    baseline: {
      ruleId: rule.ruleId,
      ruleRevision: rule.revision,
      presetId: preset.presetId,
      presetRevision: preset.revision,
      selectedFields: [...selectedFields],
      report: selectedReport(selectedFields, sourceSpecificSkipped, application.report),
    },
    rule,
    preset,
    controls: { kind: "blocked", reason: "initial-document-not-durable" },
  };
}

export function prepareNeutralDevelopDocumentCandidate(
  initialDocument: DevelopDocumentV3,
): DevelopDefaultCreationCandidate {
  return {
    kind: "neutral-default-candidate",
    document: validateV3CommandDocument(initialDocument),
    baseline: null,
    rule: null,
    preset: null,
    controls: { kind: "blocked", reason: "initial-document-not-durable" },
  };
}

export function createDevelopDefaultResetCommand(
  baselineDocument: DevelopDocumentV3,
): Extract<V3DirectEditCommand, { readonly kind: "replace-v3-complete-state" }> {
  return { kind: "replace-v3-complete-state", document: validateV3CommandDocument(baselineDocument) };
}

export async function loadOrCreateDevelopDefault<Head>(input: {
  readonly match: DevelopDefaultMatchResult;
  readonly initialDocument: DevelopDocumentV3;
  readonly context: DevelopDefaultApplicationContext;
  readonly repository: DevelopDefaultInstallAdapter<Head>;
}): Promise<LoadOrCreateDevelopDefaultResult<Head>> {
  if (input.match.kind === "existing-document") {
    return {
      kind: "existing-hydrated-document",
      source: input.match.source,
      controls: { kind: "enabled" },
    };
  }
  const existing = await input.repository.load();
  if (existing) return { kind: "existing-head", value: existing, controls: { kind: "enabled" } };
  const candidate = input.match.kind === "no-match"
    ? prepareNeutralDevelopDocumentCandidate(input.initialDocument)
    : prepareDevelopDefaultCandidate({
        match: input.match.match,
        initialDocument: input.initialDocument,
        context: input.context,
      });
  const installed = await input.repository.installIfAbsent(candidate);
  return installed.kind === "installed"
    ? {
        kind: candidate.kind === "neutral-default-candidate" ? "created-without-default" : "created",
        value: installed.value,
        controls: { kind: "enabled" },
      }
    : { kind: "lost-race", value: installed.value, controls: { kind: "enabled" } };
}
