import { parseCatalogId, parseEntryId, type CatalogId, type EntryId } from "../../catalog/ids.ts";
import { parseSessionId, type SessionId } from "../../catalog/runtime.ts";
import { parseDevelopHistoryLoadedRevision, type DevelopHistoryLoadedRevision } from "../history.ts";
import {
  parseInstalledDevelopDefault,
  type InstalledDevelopDefault,
} from "./installed.ts";
import type { DevelopDefaultFacts, DevelopDefaultRuleTrace } from "./matcher.ts";
import { parseDevelopDefaultRuleId, type DevelopDefaultRuleId } from "./schema.ts";

export interface DevelopDefaultRuleEnabledRequest {
  readonly ruleId: DevelopDefaultRuleId;
  readonly expectedRevision: number;
  readonly enabled: boolean;
  readonly updatedAt: number;
}

export interface DevelopDefaultRuleDeleteRequest {
  readonly ruleId: DevelopDefaultRuleId;
  readonly expectedRevision: number;
}

export interface DevelopDefaultsPreviewRequest {
  readonly facts: DevelopDefaultFacts;
}

export type DevelopDefaultsPreviewResult =
  | { readonly kind: "matched"; readonly winner: { readonly ruleId: DevelopDefaultRuleId; readonly ruleRevision: number; readonly ruleName: string }; readonly traces: readonly DevelopDefaultRuleTrace[] }
  | { readonly kind: "no-match"; readonly winner: null; readonly traces: readonly DevelopDefaultRuleTrace[] };

export interface DevelopDefaultsEntryRequest {
  readonly catalogId: CatalogId;
  readonly sessionId: SessionId;
  readonly entryId: EntryId;
}

export interface DevelopDefaultsInstallRequest extends DevelopDefaultsEntryRequest {
  readonly facts: DevelopDefaultFacts;
}

export type DevelopDefaultsProductionResult =
  | { readonly kind: "installed" | "already-installed"; readonly head: DevelopHistoryLoadedRevision; readonly installed: InstalledDevelopDefault }
  | { readonly kind: "not-pristine" | "no-match"; readonly head: DevelopHistoryLoadedRevision; readonly installed: null };

function fail(message: string): never { throw new Error(message); }
function record(value: unknown, label: string, keys: readonly string[]): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) fail(`${label} is invalid.`);
  const input = value as Record<string, unknown>;
  if (Object.keys(input).some((key) => !keys.includes(key))) fail(`${label} has unknown fields.`);
  return input;
}
function text(value: unknown, label: string): string {
  return typeof value === "string" && value.trim().length > 0 && value.length <= 512 && !value.includes("\0")
    ? value.trim()
    : fail(`${label} is invalid.`);
}
function integer(value: unknown, label: string, minimum = 0): number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= minimum
    ? value
    : fail(`${label} is invalid.`);
}

export function parseDevelopDefaultFacts(value: unknown): DevelopDefaultFacts {
  const input = record(value, "Develop default facts", ["camera", "decoder", "inputProfile", "iso"]);
  const camera = record(input.camera, "Develop default camera fact", ["kind", "make", "model", "reason"]);
  const decoder = record(input.decoder, "Develop default decoder fact", ["kind", "value", "reason"]);
  const profile = record(input.inputProfile, "Develop default profile fact", ["kind", "profileId", "profileRevision", "stage", "reason"]);
  const iso = record(input.iso, "Develop default ISO fact", ["kind", "value", "reason"]);
  return {
    camera: camera.kind === "known"
      ? { kind: "known", make: text(camera.make, "Camera make"), model: text(camera.model, "Camera model") }
      : camera.kind === "unknown"
        ? { kind: "unknown", reason: text(camera.reason, "Unknown camera reason") }
        : fail("Develop default camera fact kind is invalid."),
    decoder: decoder.kind === "known"
      ? { kind: "known", value: text(decoder.value, "Decoder ID") }
      : decoder.kind === "unknown"
        ? { kind: "unknown", reason: text(decoder.reason, "Unknown decoder reason") }
        : fail("Develop default decoder fact kind is invalid."),
    inputProfile: profile.kind === "known"
      ? {
          kind: "known",
          profileId: text(profile.profileId, "Input profile ID"),
          profileRevision: text(profile.profileRevision, "Input profile revision"),
          stage: profile.stage === "before-develop-tone" ? profile.stage : fail("Input profile stage is invalid."),
        }
      : profile.kind === "unknown"
        ? { kind: "unknown", reason: text(profile.reason, "Unknown input profile reason") }
        : fail("Develop default input profile fact kind is invalid."),
    iso: iso.kind === "known"
      ? { kind: "known", value: integer(iso.value, "ISO", 1) }
      : iso.kind === "unknown"
        ? { kind: "unknown", reason: text(iso.reason, "Unknown ISO reason") }
        : fail("Develop default ISO fact kind is invalid."),
  };
}

export function parseDevelopDefaultsInstallRequest(value: unknown): DevelopDefaultsInstallRequest {
  const input = record(value, "Develop defaults install request", ["catalogId", "sessionId", "entryId", "facts"]);
  return {
    catalogId: parseCatalogId(input.catalogId),
    sessionId: parseSessionId(input.sessionId),
    entryId: parseEntryId(input.entryId),
    facts: parseDevelopDefaultFacts(input.facts),
  };
}
export function parseDevelopDefaultsEntryRequest(value: unknown): DevelopDefaultsEntryRequest {
  const input = record(value, "Develop defaults entry request", ["catalogId", "sessionId", "entryId"]);
  return {
    catalogId: parseCatalogId(input.catalogId),
    sessionId: parseSessionId(input.sessionId),
    entryId: parseEntryId(input.entryId),
  };
}
export function parseDevelopDefaultsPreviewRequest(value: unknown): DevelopDefaultsPreviewRequest {
  const input = record(value, "Develop defaults preview request", ["facts"]);
  return { facts: parseDevelopDefaultFacts(input.facts) };
}
export function parseDevelopDefaultRuleEnabledRequest(value: unknown): DevelopDefaultRuleEnabledRequest {
  const input = record(value, "Develop default enabled request", ["ruleId", "expectedRevision", "enabled", "updatedAt"]);
  if (typeof input.enabled !== "boolean") fail("Develop default enabled state is invalid.");
  return { ruleId: parseDevelopDefaultRuleId(input.ruleId), expectedRevision: integer(input.expectedRevision, "Expected rule revision", 1), enabled: input.enabled, updatedAt: integer(input.updatedAt, "Rule update timestamp") };
}
export function parseDevelopDefaultRuleDeleteRequest(value: unknown): DevelopDefaultRuleDeleteRequest {
  const input = record(value, "Develop default delete request", ["ruleId", "expectedRevision"]);
  return { ruleId: parseDevelopDefaultRuleId(input.ruleId), expectedRevision: integer(input.expectedRevision, "Expected rule revision", 1) };
}

function trace(value: unknown): DevelopDefaultRuleTrace {
  const input = record(value, "Develop default trace", ["ruleId", "ruleRevision", "ruleName", "matched", "summary", "facts"]);
  if (typeof input.matched !== "boolean" || !Array.isArray(input.facts) || input.facts.length > 8) fail("Develop default trace is invalid.");
  const facts = input.facts.map((item) => {
    const fact = record(item, "Develop default trace fact", ["fact", "matched", "expected", "actual", "reason"]);
    if (typeof fact.matched !== "boolean" || !["enabled", "camera", "raw-profile", "iso", "preset"].includes(String(fact.fact))) fail("Develop default trace fact is invalid.");
    return { fact: fact.fact as DevelopDefaultRuleTrace["facts"][number]["fact"], matched: fact.matched, expected: text(fact.expected, "Trace expected value"), actual: text(fact.actual, "Trace actual value"), reason: text(fact.reason, "Trace reason") };
  });
  return { ruleId: parseDevelopDefaultRuleId(input.ruleId), ruleRevision: integer(input.ruleRevision, "Trace rule revision", 1), ruleName: text(input.ruleName, "Trace rule name"), matched: input.matched, summary: text(input.summary, "Trace summary"), facts };
}

export function parseDevelopDefaultsPreviewResult(value: unknown): DevelopDefaultsPreviewResult {
  const input = record(value, "Develop defaults preview result", ["kind", "winner", "traces"]);
  if (!Array.isArray(input.traces) || input.traces.length > 10_000) fail("Develop defaults preview traces are invalid.");
  const traces = input.traces.map(trace);
  if (input.kind === "no-match") {
    if (input.winner !== null) fail("No-match Develop defaults preview cannot have a winner.");
    return { kind: "no-match", winner: null, traces };
  }
  if (input.kind !== "matched") fail("Develop defaults preview result kind is invalid.");
  const winner = record(input.winner, "Develop defaults preview winner", ["ruleId", "ruleRevision", "ruleName"]);
  return { kind: "matched", winner: { ruleId: parseDevelopDefaultRuleId(winner.ruleId), ruleRevision: integer(winner.ruleRevision, "Winner rule revision", 1), ruleName: text(winner.ruleName, "Winner rule name") }, traces };
}

export function parseDevelopDefaultsProductionResult(value: unknown): DevelopDefaultsProductionResult {
  const input = record(value, "Develop defaults production result", ["kind", "head", "installed"]);
  const head = parseDevelopHistoryLoadedRevision(input.head);
  if (input.kind === "not-pristine" || input.kind === "no-match") {
    if (input.installed !== null) fail("Develop defaults result cannot have installed provenance.");
    return { kind: input.kind, head, installed: null };
  }
  if (input.kind !== "installed" && input.kind !== "already-installed") fail("Develop defaults production result kind is invalid.");
  return { kind: input.kind, head, installed: parseInstalledDevelopDefault(input.installed) };
}
