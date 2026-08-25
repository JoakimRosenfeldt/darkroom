import {
  DEVELOP_PRESET_FIELDS,
  parseDevelopPresetId,
  type DevelopPresetField,
  type DevelopPresetId,
} from "../presets/schema.ts";

type Brand<Value, Name extends string> = Value & { readonly __brand: Name };

export type DevelopDefaultRuleId = Brand<string, "DevelopDefaultRuleId">;

export const DEVELOP_DEFAULT_RULE_SCHEMA_VERSION = 1;
export const DEVELOP_DEFAULT_RULE_MAX_BYTES = 2 * 1024 * 1024;
export const DEVELOP_DEFAULT_RULE_MAX_NODES = 100_000;
export const DEVELOP_DEFAULT_RULE_MAX_DEPTH = 16;
export const DEVELOP_DEFAULT_RULE_MAX_RECORDS = 10_000;
export const DEVELOP_DEFAULT_RULE_MAX_AGGREGATE_BYTES = 256 * 1024 * 1024;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export type CameraDefaultSelector =
  | { readonly kind: "exact"; readonly make: string; readonly model: string }
  | { readonly kind: "unknown" };

export type RawProfileDefaultSelector =
  | {
      readonly kind: "exact";
      readonly decoderId: string;
      readonly profileId: string;
      readonly profileRevision: string;
    }
  | { readonly kind: "wildcard" }
  | { readonly kind: "unknown" };

export type IsoDefaultSelector =
  | { readonly kind: "range"; readonly minimum: number; readonly maximum: number }
  | { readonly kind: "unknown" };

export interface DevelopDefaultPresetReference {
  readonly presetId: DevelopPresetId;
  readonly presetRevision: number;
  readonly selectedFields: readonly DevelopPresetField[];
}

export interface DevelopDefaultRule {
  readonly schemaVersion: typeof DEVELOP_DEFAULT_RULE_SCHEMA_VERSION;
  readonly ruleId: DevelopDefaultRuleId;
  readonly revision: number;
  readonly name: string;
  readonly enabled: boolean;
  readonly priority: number;
  readonly camera: CameraDefaultSelector;
  readonly rawProfile: RawProfileDefaultSelector;
  readonly iso: IsoDefaultSelector;
  readonly preset: DevelopDefaultPresetReference;
  readonly createdAt: number;
  readonly updatedAt: number;
}

function fail(message: string): never {
  throw new Error(message);
}

function record(value: unknown, label: string, keys: readonly string[]): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return fail(`${label} must be an object.`);
  }
  const input = value as Record<string, unknown>;
  const expected = new Set(keys);
  if (Object.keys(input).some((key) => !expected.has(key))) {
    return fail(`${label} has unknown fields.`);
  }
  return input;
}

function text(value: unknown, label: string, maximum = 256): string {
  if (
    typeof value !== "string" ||
    value.trim().length === 0 ||
    value.length > maximum ||
    value.includes("\0")
  ) {
    return fail(`${label} is invalid.`);
  }
  return value.trim();
}

function integer(value: unknown, label: string, minimum: number, maximum: number): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < minimum || value > maximum) {
    return fail(`${label} is invalid.`);
  }
  return value;
}

function serializedBytes(value: unknown): number {
  let nodes = 0;
  const visit = (item: unknown, depth: number): void => {
    nodes += 1;
    if (nodes > DEVELOP_DEFAULT_RULE_MAX_NODES) fail("Develop default rule exceeds the JSON node limit.");
    if (depth > DEVELOP_DEFAULT_RULE_MAX_DEPTH) fail("Develop default rule exceeds the JSON depth limit.");
    if (item === null || typeof item === "boolean" || typeof item === "string") return;
    if (typeof item === "number") {
      if (!Number.isFinite(item)) fail("Develop default rule contains a non-finite number.");
      return;
    }
    if (Array.isArray(item)) {
      item.forEach((child) => visit(child, depth + 1));
      return;
    }
    if (typeof item !== "object") fail("Develop default rule is not JSON data.");
    for (const [key, child] of Object.entries(item)) {
      if (key === "__proto__" || key === "prototype" || key === "constructor" || key.includes("\0")) {
        fail("Develop default rule contains an invalid field name.");
      }
      visit(child, depth + 1);
    }
  };
  visit(value, 0);
  let serialized: string;
  try {
    serialized = JSON.stringify(value);
  } catch {
    return fail("Develop default rule is not serializable JSON data.");
  }
  return new TextEncoder().encode(serialized).byteLength;
}

export function parseDevelopDefaultRuleId(value: unknown): DevelopDefaultRuleId {
  return typeof value === "string" && UUID.test(value)
    ? value.toLowerCase() as DevelopDefaultRuleId
    : fail("DevelopDefaultRuleId must be a UUID.");
}

export function createDevelopDefaultRuleId(value?: string): DevelopDefaultRuleId {
  return parseDevelopDefaultRuleId(value ?? crypto.randomUUID());
}

function cameraSelector(value: unknown): CameraDefaultSelector {
  const input = record(value, "Develop default camera selector", ["kind", "make", "model"]);
  if (input.kind === "unknown") {
    record(value, "Develop default unknown camera selector", ["kind"]);
    return { kind: "unknown" };
  }
  if (input.kind === "exact") {
    return {
      kind: "exact",
      make: text(input.make, "Develop default camera make"),
      model: text(input.model, "Develop default camera model"),
    };
  }
  return fail("Develop default camera selector is invalid.");
}

function rawProfileSelector(value: unknown): RawProfileDefaultSelector {
  const input = record(value, "Develop default raw profile selector", ["kind", "decoderId", "profileId", "profileRevision"]);
  if (input.kind === "wildcard" || input.kind === "unknown") {
    record(value, `Develop default ${input.kind} raw profile selector`, ["kind"]);
    return { kind: input.kind };
  }
  if (input.kind === "exact") {
    return {
      kind: "exact",
      decoderId: text(input.decoderId, "Develop default decoder ID"),
      profileId: text(input.profileId, "Develop default profile ID"),
      profileRevision: text(input.profileRevision, "Develop default profile revision"),
    };
  }
  return fail("Develop default raw profile selector is invalid.");
}

function isoSelector(value: unknown): IsoDefaultSelector {
  const input = record(value, "Develop default ISO selector", ["kind", "minimum", "maximum"]);
  if (input.kind === "unknown") {
    record(value, "Develop default unknown ISO selector", ["kind"]);
    return { kind: "unknown" };
  }
  if (input.kind !== "range") return fail("Develop default ISO selector is invalid.");
  const minimum = integer(input.minimum, "Develop default minimum ISO", 1, Number.MAX_SAFE_INTEGER);
  const maximum = integer(input.maximum, "Develop default maximum ISO", 1, Number.MAX_SAFE_INTEGER);
  if (minimum > maximum) fail("Develop default ISO range is reversed.");
  return { kind: "range", minimum, maximum };
}

function presetFields(value: unknown): readonly DevelopPresetField[] {
  if (!Array.isArray(value) || value.length === 0 || value.length > DEVELOP_PRESET_FIELDS.length) {
    return fail("Develop default preset fields are invalid.");
  }
  const fields = value.map((item) => {
    const field = DEVELOP_PRESET_FIELDS.find((candidate) => candidate === item);
    return field ?? fail("Develop default preset field is not supported.");
  });
  if (new Set(fields).size !== fields.length) fail("Develop default preset fields contain duplicates.");
  return fields;
}

function presetReference(value: unknown): DevelopDefaultPresetReference {
  const input = record(value, "Develop default preset reference", ["presetId", "presetRevision", "selectedFields"]);
  return {
    presetId: parseDevelopPresetId(input.presetId),
    presetRevision: integer(input.presetRevision, "Develop default preset revision", 1, Number.MAX_SAFE_INTEGER),
    selectedFields: presetFields(input.selectedFields),
  };
}

export function parseDevelopDefaultRule(value: unknown): DevelopDefaultRule {
  if (serializedBytes(value) > DEVELOP_DEFAULT_RULE_MAX_BYTES) {
    fail("Develop default rule exceeds the byte limit.");
  }
  const input = record(value, "Develop default rule", [
    "schemaVersion", "ruleId", "revision", "name", "enabled", "priority",
    "camera", "rawProfile", "iso", "preset", "createdAt", "updatedAt",
  ]);
  if (input.schemaVersion !== DEVELOP_DEFAULT_RULE_SCHEMA_VERSION) {
    fail("Develop default rule schema version is not supported.");
  }
  if (typeof input.enabled !== "boolean") fail("Develop default rule enabled state is invalid.");
  const createdAt = integer(input.createdAt, "Develop default created timestamp", 0, Number.MAX_SAFE_INTEGER);
  const updatedAt = integer(input.updatedAt, "Develop default updated timestamp", 0, Number.MAX_SAFE_INTEGER);
  if (updatedAt < createdAt) fail("Develop default updated timestamp precedes creation.");
  return {
    schemaVersion: DEVELOP_DEFAULT_RULE_SCHEMA_VERSION,
    ruleId: parseDevelopDefaultRuleId(input.ruleId),
    revision: integer(input.revision, "Develop default rule revision", 1, Number.MAX_SAFE_INTEGER),
    name: text(input.name, "Develop default rule name"),
    enabled: input.enabled,
    priority: integer(input.priority, "Develop default rule priority", -1_000_000, 1_000_000),
    camera: cameraSelector(input.camera),
    rawProfile: rawProfileSelector(input.rawProfile),
    iso: isoSelector(input.iso),
    preset: presetReference(input.preset),
    createdAt,
    updatedAt,
  };
}

export function cloneDevelopDefaultRule(rule: DevelopDefaultRule): DevelopDefaultRule {
  return structuredClone(parseDevelopDefaultRule(rule));
}
