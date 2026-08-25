import {
  parseDevelopPresetId,
  parseDevelopPresetRecord,
  type DevelopPresetId,
  type DevelopPresetRecord,
} from "./schema.ts";

export interface DevelopPresetSearchRequest {
  readonly query: string;
  readonly category: string | null;
  readonly favoriteOnly: boolean;
}

export type DevelopPresetImportResult =
  | { readonly kind: "cancelled" }
  | { readonly kind: "imported"; readonly preset: DevelopPresetRecord }
  | { readonly kind: "exact-duplicate"; readonly preset: DevelopPresetRecord }
  | {
      readonly kind: "conflict";
      readonly token: string;
      readonly existing: DevelopPresetRecord;
      readonly incoming: DevelopPresetRecord;
      readonly decisions: readonly ("replace" | "import-copy")[];
    };

export interface DevelopPresetFavoriteRequest {
  readonly presetId: DevelopPresetId;
  readonly favorite: boolean;
}

export interface DevelopPresetDeleteRequest {
  readonly presetId: DevelopPresetId;
}

export interface DevelopPresetConflictRequest {
  readonly token: string;
  readonly action: "replace" | "import-copy" | "cancel";
}

function fail(message: string): never {
  throw new Error(message);
}

function record(
  value: unknown,
  label: string,
  keys: readonly string[],
): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return fail(`${label} must be an object.`);
  }
  const input = value as Record<string, unknown>;
  if (Object.keys(input).some((key) => !keys.includes(key))) {
    return fail(`${label} has unknown fields.`);
  }
  return input;
}

function token(value: unknown): string {
  return typeof value === "string" &&
    /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value)
    ? value.toLowerCase()
    : fail("Develop preset import token is invalid.");
}

export function parseDevelopPresetSearchRequest(
  value: unknown,
): DevelopPresetSearchRequest {
  const input = record(value, "Develop preset search", [
    "query",
    "category",
    "favoriteOnly",
  ]);
  if (typeof input.query !== "string" || input.query.length > 256) {
    return fail("Develop preset search query is invalid.");
  }
  if (
    input.category !== null &&
    (typeof input.category !== "string" ||
      input.category.trim().length === 0 ||
      input.category.length > 256)
  ) {
    return fail("Develop preset search category is invalid.");
  }
  if (typeof input.favoriteOnly !== "boolean") {
    return fail("Develop preset favorite filter is invalid.");
  }
  return {
    query: input.query.trim(),
    category: input.category === null ? null : input.category.trim(),
    favoriteOnly: input.favoriteOnly,
  };
}

export function parseDevelopPresetList(
  value: unknown,
): readonly DevelopPresetRecord[] {
  if (!Array.isArray(value) || value.length > 10_000) {
    return fail("Develop preset list is invalid.");
  }
  return value.map(parseDevelopPresetRecord);
}

export function parseDevelopPresetFavoriteRequest(
  value: unknown,
): DevelopPresetFavoriteRequest {
  const input = record(value, "Develop preset favorite request", [
    "presetId",
    "favorite",
  ]);
  if (typeof input.favorite !== "boolean") {
    return fail("Develop preset favorite is invalid.");
  }
  return {
    presetId: parseDevelopPresetId(input.presetId),
    favorite: input.favorite,
  };
}

export function parseDevelopPresetDeleteRequest(
  value: unknown,
): DevelopPresetDeleteRequest {
  const input = record(value, "Develop preset delete request", ["presetId"]);
  return { presetId: parseDevelopPresetId(input.presetId) };
}

export function parseDevelopPresetConflictRequest(
  value: unknown,
): DevelopPresetConflictRequest {
  const input = record(value, "Develop preset conflict request", [
    "token",
    "action",
  ]);
  if (
    input.action !== "replace" &&
    input.action !== "import-copy" &&
    input.action !== "cancel"
  ) {
    return fail("Develop preset conflict action is invalid.");
  }
  return { token: token(input.token), action: input.action };
}

export function parseDevelopPresetImportResult(
  value: unknown,
): DevelopPresetImportResult {
  const input = record(value, "Develop preset import result", [
    "kind",
    "preset",
    "token",
    "existing",
    "incoming",
    "decisions",
  ]);
  if (input.kind === "cancelled") {
    record(value, "Develop preset cancelled import", ["kind"]);
    return { kind: "cancelled" };
  }
  if (input.kind === "imported" || input.kind === "exact-duplicate") {
    record(value, "Develop preset completed import", ["kind", "preset"]);
    return { kind: input.kind, preset: parseDevelopPresetRecord(input.preset) };
  }
  if (input.kind === "conflict") {
    record(value, "Develop preset import conflict", [
      "kind",
      "token",
      "existing",
      "incoming",
      "decisions",
    ]);
    if (!Array.isArray(input.decisions) || input.decisions.length < 1 ||
      input.decisions.length > 2 ||
      input.decisions.some((decision) => decision !== "replace" && decision !== "import-copy") ||
      new Set(input.decisions).size !== input.decisions.length) {
      return fail("Develop preset conflict decisions are invalid.");
    }
    return {
      kind: "conflict",
      token: token(input.token),
      existing: parseDevelopPresetRecord(input.existing),
      incoming: parseDevelopPresetRecord(input.incoming),
      decisions: input.decisions as ("replace" | "import-copy")[],
    };
  }
  return fail("Develop preset import result kind is invalid.");
}
