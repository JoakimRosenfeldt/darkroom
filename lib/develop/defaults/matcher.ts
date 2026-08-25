import { parseDevelopPresetRecord, type DevelopPresetRecord } from "../presets/schema.ts";
import type { SourceRecord } from "../process.ts";
import {
  cloneDevelopDefaultRule,
  type DevelopDefaultRule,
  type DevelopDefaultRuleId,
} from "./schema.ts";

export type DevelopDefaultKnownFact = { readonly kind: "known"; readonly value: string };
export type DevelopDefaultTextFact = DevelopDefaultKnownFact | { readonly kind: "unknown"; readonly reason: string };
export type DevelopDefaultIsoFact =
  | { readonly kind: "known"; readonly value: number }
  | { readonly kind: "unknown"; readonly reason: string };

export interface DevelopDefaultFacts {
  readonly camera:
    | { readonly kind: "known"; readonly make: string; readonly model: string }
    | { readonly kind: "unknown"; readonly reason: string };
  readonly decoder: DevelopDefaultTextFact;
  readonly inputProfile:
    | {
        readonly kind: "known";
        readonly profileId: string;
        readonly profileRevision: string;
        readonly stage: "before-develop-tone";
      }
    | { readonly kind: "unknown"; readonly reason: string };
  readonly iso: DevelopDefaultIsoFact;
}

export function developDefaultFactsFromSource(
  source: SourceRecord,
  iso: number | null,
): DevelopDefaultFacts {
  const camera: DevelopDefaultFacts["camera"] = source.camera.kind === "available"
    ? { kind: "known", make: source.camera.make.trim(), model: source.camera.model.trim() }
    : { kind: "unknown", reason: "Camera make and model are unavailable." };
  const decoder: DevelopDefaultFacts["decoder"] = {
    kind: "known",
    value: source.decoder.decoderId.trim(),
  };
  const inputProfile: DevelopDefaultFacts["inputProfile"] = source.inputProfile.kind === "available" &&
    source.inputProfile.stage === "before-develop-tone"
    ? {
        kind: "known",
        profileId: source.inputProfile.profile.id.trim(),
        profileRevision: source.inputProfile.profile.revision.trim(),
        stage: "before-develop-tone",
      }
    : {
        kind: "unknown",
        reason: source.decoder.kind === "embedded-preview"
          ? "Embedded previews have no available before-tone input profile stage."
          : source.inputProfile.kind === "unavailable"
            ? source.inputProfile.reason
            : "No selected before-tone input profile is available.",
      };
  const isoFact: DevelopDefaultFacts["iso"] = iso !== null &&
    Number.isSafeInteger(iso) && iso >= 1
    ? { kind: "known", value: iso }
    : { kind: "unknown", reason: "ISO is unavailable." };
  return { camera, decoder, inputProfile, iso: isoFact };
}

export type DevelopDefaultHydration =
  | { readonly kind: "new-document" }
  | { readonly kind: "existing-document"; readonly source: "app" | "accepted-source-xmp" };

export type DevelopDefaultTraceFact = "enabled" | "camera" | "raw-profile" | "iso" | "preset";

export interface DevelopDefaultTraceEntry {
  readonly fact: DevelopDefaultTraceFact;
  readonly matched: boolean;
  readonly expected: string;
  readonly actual: string;
  readonly reason: string;
}

export interface DevelopDefaultRuleTrace {
  readonly ruleId: DevelopDefaultRuleId;
  readonly ruleRevision: number;
  readonly ruleName: string;
  readonly matched: boolean;
  readonly summary: string;
  readonly facts: readonly DevelopDefaultTraceEntry[];
}

export interface MatchedDevelopDefault {
  readonly rule: DevelopDefaultRule;
  readonly preset: DevelopPresetRecord;
  readonly trace: DevelopDefaultRuleTrace;
}

export type DevelopDefaultMatchResult =
  | { readonly kind: "existing-document"; readonly source: "app" | "accepted-source-xmp"; readonly traces: readonly [] }
  | { readonly kind: "no-match"; readonly traces: readonly DevelopDefaultRuleTrace[] }
  | {
      readonly kind: "matched";
      readonly match: MatchedDevelopDefault;
      readonly traces: readonly DevelopDefaultRuleTrace[];
    };

export interface DevelopDefaultPresetResolver {
  readonly getPresetRevision: (
    presetId: DevelopDefaultRule["preset"]["presetId"],
    revision: number,
  ) => DevelopPresetRecord | null;
}

function normalized(value: string): string {
  return value.trim().toLowerCase();
}

function actualCamera(facts: DevelopDefaultFacts): string {
  return facts.camera.kind === "known"
    ? `${facts.camera.make} ${facts.camera.model}`
    : `unknown: ${facts.camera.reason}`;
}

function actualRawProfile(facts: DevelopDefaultFacts): string {
  if (facts.decoder.kind === "unknown") return `unknown decoder: ${facts.decoder.reason}`;
  if (facts.inputProfile.kind === "unknown") return `unknown profile: ${facts.inputProfile.reason}`;
  return `${facts.decoder.value} / ${facts.inputProfile.profileId}@${facts.inputProfile.profileRevision}`;
}

function traceFact(input: Omit<DevelopDefaultTraceEntry, "reason"> & { readonly reason?: string }): DevelopDefaultTraceEntry {
  return { ...input, reason: input.reason ?? (input.matched ? "Matched." : "Did not match.") };
}

function evaluateRule(
  rule: DevelopDefaultRule,
  facts: DevelopDefaultFacts,
  resolver: DevelopDefaultPresetResolver,
): { readonly trace: DevelopDefaultRuleTrace; readonly preset: DevelopPresetRecord | null } {
  const entries: DevelopDefaultTraceEntry[] = [];
  entries.push(traceFact({
    fact: "enabled",
    matched: rule.enabled,
    expected: "enabled",
    actual: rule.enabled ? "enabled" : "disabled",
    reason: rule.enabled ? "Rule is enabled." : "Disabled rules never match.",
  }));

  const cameraMatched = rule.camera.kind === "unknown"
    ? facts.camera.kind === "unknown"
    : facts.camera.kind === "known" &&
      normalized(rule.camera.make) === normalized(facts.camera.make) &&
      normalized(rule.camera.model) === normalized(facts.camera.model);
  entries.push(traceFact({
    fact: "camera",
    matched: cameraMatched,
    expected: rule.camera.kind === "unknown" ? "explicit unknown camera" : `${rule.camera.make} ${rule.camera.model}`,
    actual: actualCamera(facts),
    reason: cameraMatched
      ? "Camera selector matched."
      : facts.camera.kind === "unknown" && rule.camera.kind !== "unknown"
        ? "Unknown camera facts require an explicit unknown selector."
        : "Camera make or model differs.",
  }));

  const rawKnown = facts.decoder.kind === "known" && facts.inputProfile.kind === "known";
  const rawUnknown = facts.decoder.kind === "unknown" || facts.inputProfile.kind === "unknown";
  const rawMatched = rule.rawProfile.kind === "unknown"
    ? rawUnknown
    : rule.rawProfile.kind === "wildcard"
      ? rawKnown
      : rawKnown &&
        normalized(rule.rawProfile.decoderId) === normalized(facts.decoder.value) &&
        normalized(rule.rawProfile.profileId) === normalized(facts.inputProfile.profileId) &&
        normalized(rule.rawProfile.profileRevision) === normalized(facts.inputProfile.profileRevision);
  entries.push(traceFact({
    fact: "raw-profile",
    matched: rawMatched,
    expected: rule.rawProfile.kind === "exact"
      ? `${rule.rawProfile.decoderId} / ${rule.rawProfile.profileId}@${rule.rawProfile.profileRevision}`
      : rule.rawProfile.kind === "wildcard" ? "any known decoder/profile" : "explicit unknown decoder/profile",
    actual: actualRawProfile(facts),
    reason: rawMatched
      ? "Decoder and profile selector matched."
      : rawUnknown && rule.rawProfile.kind !== "unknown"
        ? "Unknown decoder or profile facts require an explicit unknown selector."
        : "Decoder or profile differs.",
  }));

  const isoMatched = rule.iso.kind === "unknown"
    ? facts.iso.kind === "unknown"
    : facts.iso.kind === "known" && facts.iso.value >= rule.iso.minimum && facts.iso.value <= rule.iso.maximum;
  entries.push(traceFact({
    fact: "iso",
    matched: isoMatched,
    expected: rule.iso.kind === "unknown" ? "explicit unknown ISO" : `${rule.iso.minimum}-${rule.iso.maximum} inclusive`,
    actual: facts.iso.kind === "known" ? String(facts.iso.value) : `unknown: ${facts.iso.reason}`,
    reason: isoMatched
      ? "ISO selector matched."
      : facts.iso.kind === "unknown" && rule.iso.kind !== "unknown"
        ? "Unknown ISO requires an explicit unknown selector."
        : "ISO is outside the inclusive range.",
  }));

  const resolvedPreset = resolver.getPresetRevision(rule.preset.presetId, rule.preset.presetRevision);
  const preset = resolvedPreset === null ? null : parseDevelopPresetRecord(resolvedPreset);
  const declaredFields = preset ? new Set(preset.fields) : null;
  const missingFields = declaredFields
    ? rule.preset.selectedFields.filter((field) => !declaredFields.has(field))
    : [];
  const presetIdentityMatched = preset !== null &&
    preset.presetId === rule.preset.presetId &&
    preset.revision === rule.preset.presetRevision;
  const presetMatched = presetIdentityMatched && missingFields.length === 0;
  entries.push(traceFact({
    fact: "preset",
    matched: presetMatched,
    expected: `${rule.preset.presetId}@${rule.preset.presetRevision}`,
    actual: preset === null ? "missing preset revision" : `${preset.presetId}@${preset.revision}`,
    reason: preset === null
      ? "The referenced immutable preset revision is missing."
      : !presetIdentityMatched
        ? "Preset resolver returned a different immutable revision."
      : missingFields.length > 0
        ? `Preset does not declare selected fields: ${missingFields.join(", ")}.`
        : "Preset revision and selected fields are available.",
  }));

  const matched = entries.every((entry) => entry.matched);
  return {
    trace: {
      ruleId: rule.ruleId,
      ruleRevision: rule.revision,
      ruleName: rule.name,
      matched,
      summary: matched ? `Matched ${rule.name}.` : `Rejected ${rule.name}: ${entries.filter((entry) => !entry.matched).map((entry) => entry.reason).join(" ")}`,
      facts: entries,
    },
    preset: matched ? preset : null,
  };
}

function cameraSpecificity(rule: DevelopDefaultRule): number {
  return rule.camera.kind === "exact" ? 1 : 0;
}

function profileSpecificity(rule: DevelopDefaultRule): number {
  if (rule.rawProfile.kind === "exact") return 2;
  return rule.rawProfile.kind === "wildcard" ? 1 : 0;
}

function isoWidth(rule: DevelopDefaultRule): number {
  return rule.iso.kind === "range" ? rule.iso.maximum - rule.iso.minimum : Number.POSITIVE_INFINITY;
}

function compareMatches(left: MatchedDevelopDefault, right: MatchedDevelopDefault): number {
  return right.rule.priority - left.rule.priority ||
    cameraSpecificity(right.rule) - cameraSpecificity(left.rule) ||
    profileSpecificity(right.rule) - profileSpecificity(left.rule) ||
    isoWidth(left.rule) - isoWidth(right.rule) ||
    left.rule.ruleId.localeCompare(right.rule.ruleId);
}

function currentRevisions(rules: readonly DevelopDefaultRule[]): readonly DevelopDefaultRule[] {
  const current = new Map<DevelopDefaultRuleId, DevelopDefaultRule>();
  const revisions = new Set<string>();
  for (const source of rules) {
    const rule = cloneDevelopDefaultRule(source);
    const revisionKey = `${rule.ruleId}:${rule.revision}`;
    if (revisions.has(revisionKey)) throw new Error("Develop default rules contain duplicate revisions.");
    revisions.add(revisionKey);
    const existing = current.get(rule.ruleId);
    if (!existing || rule.revision > existing.revision) current.set(rule.ruleId, rule);
  }
  return [...current.values()];
}

export function matchDevelopDefault(input: {
  readonly hydration: DevelopDefaultHydration;
  readonly facts: DevelopDefaultFacts;
  readonly rules: readonly DevelopDefaultRule[];
  readonly presets: DevelopDefaultPresetResolver;
}): DevelopDefaultMatchResult {
  if (input.hydration.kind === "existing-document") {
    return { kind: "existing-document", source: input.hydration.source, traces: [] };
  }
  const evaluations = [...currentRevisions(input.rules)]
    .sort((left, right) => left.ruleId.localeCompare(right.ruleId))
    .map((rule) => ({ rule, ...evaluateRule(rule, input.facts, input.presets) }));
  const traces = evaluations.map((evaluation) => evaluation.trace);
  const matches = evaluations.flatMap((evaluation): MatchedDevelopDefault[] =>
    evaluation.preset
      ? [{ rule: evaluation.rule, preset: structuredClone(evaluation.preset), trace: evaluation.trace }]
      : []
  ).sort(compareMatches);
  const winner = matches[0];
  return winner
    ? { kind: "matched", match: winner, traces }
    : { kind: "no-match", traces };
}
