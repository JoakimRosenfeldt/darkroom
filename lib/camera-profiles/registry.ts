import {
  parseMatrixCameraProfile,
  type CameraProfileMatrix3,
  type MatrixCameraProfile,
} from "./matrix.ts";

export const CAMERA_PROFILE_FILE_LIMIT = 16 * 1024 * 1024;
export const CAMERA_PROFILE_REGISTRY_VERSION = 1;

export type CameraProfileFormat = "dcp" | "xmp";

export interface CameraProfileCapabilities {
  readonly matrixToLinearSrgb: true;
  readonly channelScale: true;
  readonly exposureOffset: true;
  readonly hueSaturationMap: false;
  readonly lookTable: false;
  readonly toneCurve: false;
  readonly opcodes: false;
}

export interface ReadyCameraProfileRecord {
  readonly kind: "ready";
  readonly hash: string;
  readonly sourceFilename: string;
  readonly storedFilename: string;
  readonly format: CameraProfileFormat;
  readonly profile: MatrixCameraProfile;
  readonly capabilities: CameraProfileCapabilities;
  readonly unsupportedOperations: readonly string[];
}

export interface InvalidCameraProfileRecord {
  readonly kind: "invalid";
  readonly hash: string;
  readonly sourceFilename: string;
  readonly storedFilename: string;
  readonly format: CameraProfileFormat;
  readonly parseError: string;
  readonly unsupportedOperations: readonly string[];
}

export type CameraProfileRecord =
  | ReadyCameraProfileRecord
  | InvalidCameraProfileRecord;

export interface CameraProfileRegistrySnapshot {
  readonly version: typeof CAMERA_PROFILE_REGISTRY_VERSION;
  readonly revision: string;
  readonly profiles: readonly CameraProfileRecord[];
  readonly replacements: Readonly<Record<string, string>>;
}

export type CameraProfileImportResult =
  | { readonly kind: "cancelled" }
  | { readonly kind: "imported"; readonly record: ReadyCameraProfileRecord }
  | { readonly kind: "duplicate"; readonly record: ReadyCameraProfileRecord }
  | {
      readonly kind: "conflict";
      readonly token: string;
      readonly existing: ReadyCameraProfileRecord;
      readonly incoming: ReadyCameraProfileRecord;
    };

export interface CameraProfileConflictRequest {
  readonly token: string;
  readonly action: "replace" | "import-copy" | "cancel";
}

export interface CameraProfileRemoveRequest {
  readonly profileId: string;
  readonly replacementProfileId: string;
}

const MATRIX_CAPABILITIES = {
  matrixToLinearSrgb: true,
  channelScale: true,
  exposureOffset: true,
  hueSaturationMap: false,
  lookTable: false,
  toneCurve: false,
  opcodes: false,
} as const satisfies CameraProfileCapabilities;

function record(value: unknown, path: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(`${path} must be an object.`);
  }
  return value as Record<string, unknown>;
}

function strictRecord(
  value: unknown,
  path: string,
  fields: readonly string[],
): Record<string, unknown> {
  const input = record(value, path);
  const unsupported = Object.keys(input).find((key) => !fields.includes(key));
  if (unsupported) throw new Error(`${path}.${unsupported} is not supported.`);
  return input;
}

function text(value: unknown, path: string, maximum = 256): string {
  if (
    typeof value !== "string" ||
    value.trim().length === 0 ||
    value.length > maximum ||
    value.includes("\0")
  ) {
    throw new Error(`${path} is invalid.`);
  }
  return value.trim();
}

function sha256(value: unknown, path: string): string {
  const parsed = text(value, path, 64).toLocaleLowerCase();
  if (!/^[a-f0-9]{64}$/.test(parsed)) throw new Error(`${path} must be a SHA-256 digest.`);
  return parsed;
}

function stringArray(value: unknown, path: string): readonly string[] {
  if (!Array.isArray(value) || value.length > 64) throw new Error(`${path} must be an array.`);
  return value.map((item, index) => text(item, `${path}[${index}]`));
}

function format(value: unknown, path: string): CameraProfileFormat {
  if (value === "dcp" || value === "xmp") return value;
  throw new Error(`${path} is not supported.`);
}

function capabilities(value: unknown, path: string): CameraProfileCapabilities {
  const input = strictRecord(value, path, Object.keys(MATRIX_CAPABILITIES));
  for (const [key, expected] of Object.entries(MATRIX_CAPABILITIES)) {
    if (input[key] !== expected) throw new Error(`${path}.${key} is invalid.`);
  }
  return MATRIX_CAPABILITIES;
}

export function parseCameraProfileRecord(value: unknown): CameraProfileRecord {
  const input = record(value, "cameraProfile");
  if (input.kind === "ready") {
    const ready = strictRecord(input, "cameraProfile", [
      "kind", "hash", "sourceFilename", "storedFilename", "format", "profile",
      "capabilities", "unsupportedOperations",
    ]);
    return {
      kind: "ready",
      hash: sha256(ready.hash, "cameraProfile.hash"),
      sourceFilename: text(ready.sourceFilename, "cameraProfile.sourceFilename"),
      storedFilename: text(ready.storedFilename, "cameraProfile.storedFilename"),
      format: format(ready.format, "cameraProfile.format"),
      profile: parseMatrixCameraProfile(ready.profile),
      capabilities: capabilities(ready.capabilities, "cameraProfile.capabilities"),
      unsupportedOperations: stringArray(
        ready.unsupportedOperations,
        "cameraProfile.unsupportedOperations",
      ),
    };
  }
  if (input.kind === "invalid") {
    const invalid = strictRecord(input, "cameraProfile", [
      "kind", "hash", "sourceFilename", "storedFilename", "format", "parseError",
      "unsupportedOperations",
    ]);
    return {
      kind: "invalid",
      hash: sha256(invalid.hash, "cameraProfile.hash"),
      sourceFilename: text(invalid.sourceFilename, "cameraProfile.sourceFilename"),
      storedFilename: text(invalid.storedFilename, "cameraProfile.storedFilename"),
      format: format(invalid.format, "cameraProfile.format"),
      parseError: text(invalid.parseError, "cameraProfile.parseError", 4_096),
      unsupportedOperations: stringArray(
        invalid.unsupportedOperations,
        "cameraProfile.unsupportedOperations",
      ),
    };
  }
  throw new Error("cameraProfile.kind is not supported.");
}

export function parseCameraProfileRegistrySnapshot(
  value: unknown,
): CameraProfileRegistrySnapshot {
  const input = strictRecord(value, "cameraProfileRegistry", [
    "version", "revision", "profiles", "replacements",
  ]);
  if (input.version !== CAMERA_PROFILE_REGISTRY_VERSION) {
    throw new Error("Camera profile registry version is not supported.");
  }
  if (!Array.isArray(input.profiles) || input.profiles.length > 10_000) {
    throw new Error("cameraProfileRegistry.profiles must be an array.");
  }
  const replacementInput = record(input.replacements, "cameraProfileRegistry.replacements");
  const replacements: Record<string, string> = {};
  for (const [profileId, replacementId] of Object.entries(replacementInput)) {
    replacements[text(profileId, "cameraProfileRegistry.replacementId")] = text(
      replacementId,
      `cameraProfileRegistry.replacements.${profileId}`,
    );
  }
  return {
    version: CAMERA_PROFILE_REGISTRY_VERSION,
    revision: text(input.revision, "cameraProfileRegistry.revision"),
    profiles: input.profiles.map(parseCameraProfileRecord),
    replacements,
  };
}

export function parseCameraProfileImportResult(value: unknown): CameraProfileImportResult {
  const input = record(value, "cameraProfileImportResult");
  switch (input.kind) {
    case "cancelled":
      strictRecord(input, "cameraProfileImportResult", ["kind"]);
      return { kind: "cancelled" };
    case "imported":
    case "duplicate": {
      const parsed = strictRecord(input, "cameraProfileImportResult", ["kind", "record"]);
      const imported = parseCameraProfileRecord(parsed.record);
      if (imported.kind !== "ready") throw new Error("Imported camera profile must be ready.");
      return { kind: input.kind, record: imported };
    }
    case "conflict": {
      const parsed = strictRecord(input, "cameraProfileImportResult", [
        "kind", "token", "existing", "incoming",
      ]);
      const existing = parseCameraProfileRecord(parsed.existing);
      const incoming = parseCameraProfileRecord(parsed.incoming);
      if (existing.kind !== "ready" || incoming.kind !== "ready") {
        throw new Error("Conflicting camera profiles must be ready.");
      }
      return {
        kind: "conflict",
        token: text(parsed.token, "cameraProfileImportResult.token"),
        existing,
        incoming,
      };
    }
    default:
      throw new Error("cameraProfileImportResult.kind is not supported.");
  }
}

export function parseCameraProfileConflictRequest(
  value: unknown,
): CameraProfileConflictRequest {
  const input = strictRecord(value, "cameraProfileConflict", ["token", "action"]);
  if (input.action !== "replace" && input.action !== "import-copy" && input.action !== "cancel") {
    throw new Error("cameraProfileConflict.action is not supported.");
  }
  return {
    token: text(input.token, "cameraProfileConflict.token"),
    action: input.action,
  };
}

export function parseCameraProfileRemoveRequest(
  value: unknown,
): CameraProfileRemoveRequest {
  const input = strictRecord(value, "cameraProfileRemove", [
    "profileId", "replacementProfileId",
  ]);
  const profileId = text(input.profileId, "cameraProfileRemove.profileId");
  const replacementProfileId = text(
    input.replacementProfileId,
    "cameraProfileRemove.replacementProfileId",
  );
  if (profileId === replacementProfileId) {
    throw new Error("A removed profile needs a different replacement.");
  }
  return { profileId, replacementProfileId };
}

function finiteList(value: string, count: number, path: string): number[] {
  const parts = value.trim().split(/[\s,]+/).filter(Boolean);
  if (parts.length !== count) throw new Error(`${path} must contain ${count} numbers.`);
  return parts.map((part, index) => {
    const parsed = Number(part);
    if (!Number.isFinite(parsed)) throw new Error(`${path}[${index}] is invalid.`);
    return parsed;
  });
}

function parseXmlAttributes(source: string): Record<string, string> {
  if (/<!DOCTYPE|<!ENTITY/i.test(source) || source.includes("&")) {
    throw new Error("Profile XMP cannot contain DTDs or entities.");
  }
  const withoutDeclaration = source.replace(/^\uFEFF?\s*<\?xml[^?]*\?>\s*/i, "").trim();
  const root = /^<DarkroomMatrixProfile\s+([\s\S]*?)\s*\/>$/.exec(withoutDeclaration);
  if (!root) {
    throw new Error("Profile XMP must contain one self-closing DarkroomMatrixProfile element.");
  }
  const attributes: Record<string, string> = {};
  const body = root[1] ?? "";
  const pattern = /([A-Za-z_][A-Za-z0-9_.:-]*)\s*=\s*(?:"([^"]*)"|'([^']*)')/g;
  let consumed = "";
  for (const match of body.matchAll(pattern)) {
    consumed += match[0];
    const name = match[1]!;
    if (Object.hasOwn(attributes, name)) throw new Error(`Duplicate XMP attribute ${name}.`);
    attributes[name] = match[2] ?? match[3] ?? "";
  }
  const compactBody = body.replace(/\s+/g, "");
  const compactConsumed = consumed.replace(/\s+/g, "");
  if (compactBody !== compactConsumed) throw new Error("Profile XMP contains invalid attributes.");
  const allowed = [
    "id", "revision", "label", "make", "model", "matrixToLinearSrgb",
    "channelScale", "exposureOffsetEv", "unsupportedOpcodes",
  ];
  const unsupported = Object.keys(attributes).find((key) => !allowed.includes(key));
  if (unsupported) throw new Error(`Profile XMP field ${unsupported} is not supported.`);
  for (const required of allowed) {
    if (!Object.hasOwn(attributes, required)) throw new Error(`Profile XMP needs ${required}.`);
  }
  if (attributes.unsupportedOpcodes !== "") {
    throw new Error("Profile XMP contains unsupported profile operations.");
  }
  return attributes;
}

function parseProfileXmp(bytes: Uint8Array): MatrixCameraProfile {
  let source: string;
  try {
    source = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    throw new Error("Profile XMP must be valid UTF-8.");
  }
  const attributes = parseXmlAttributes(source);
  return parseMatrixCameraProfile({
    version: 1,
    kind: "matrix",
    id: attributes.id,
    revision: attributes.revision,
    label: attributes.label,
    compatibility: { make: attributes.make, model: attributes.model },
    matrixToLinearSrgb: finiteList(attributes.matrixToLinearSrgb!, 9, "matrixToLinearSrgb"),
    channelScale: finiteList(attributes.channelScale!, 3, "channelScale"),
    exposureOffsetEv: Number(attributes.exposureOffsetEv),
    unsupportedTags: [],
    opcodes: [],
  });
}

const TIFF_TYPE_SIZES: Readonly<Record<number, number>> = {
  1: 1, 2: 1, 3: 2, 4: 4, 5: 8, 6: 1,
  7: 1, 8: 2, 9: 4, 10: 8, 11: 4, 12: 8,
};
const MAX_TIFF_IFDS = 8;
const MAX_TIFF_ENTRIES = 2_048;
const MAX_TIFF_VALUES = 1_000_000;
const UNIQUE_CAMERA_MODEL = 50_708;
const COLOR_MATRIX_1 = 50_721;
const COLOR_MATRIX_2 = 50_722;
const REDUCTION_MATRIX_1 = 50_725;
const REDUCTION_MATRIX_2 = 50_726;
const PROFILE_NAME = 50_936;
const PROFILE_HUE_SAT_MAP_DIMS = 50_937;
const PROFILE_HUE_SAT_MAP_DATA_1 = 50_938;
const PROFILE_HUE_SAT_MAP_DATA_2 = 50_939;
const PROFILE_TONE_CURVE = 50_940;
const FORWARD_MATRIX_1 = 50_964;
const FORWARD_MATRIX_2 = 50_965;
const PROFILE_LOOK_TABLE_DIMS = 50_981;
const PROFILE_LOOK_TABLE_DATA = 50_982;
const OPCODE_LIST_1 = 51_008;
const OPCODE_LIST_2 = 51_009;
const OPCODE_LIST_3 = 51_022;

interface TiffEntry {
  readonly tag: number;
  readonly type: number;
  readonly count: number;
  readonly dataOffset: number;
  readonly byteLength: number;
}

class TiffReader {
  private readonly bytes: Uint8Array;
  private readonly view: DataView;
  private readonly littleEndian: boolean;

  constructor(bytes: Uint8Array) {
    this.bytes = bytes;
    if (bytes.byteLength < 8) throw new Error("DCP TIFF header is truncated.");
    this.view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    const marker = String.fromCharCode(bytes[0]!, bytes[1]!);
    if (marker !== "II" && marker !== "MM") throw new Error("DCP byte order is invalid.");
    this.littleEndian = marker === "II";
    if (this.u16(2) !== 42) throw new Error("DCP TIFF magic is invalid.");
  }

  private range(offset: number, length: number): void {
    if (!Number.isSafeInteger(offset) || !Number.isSafeInteger(length) || offset < 0 || length < 0 || offset + length > this.bytes.byteLength) {
      throw new Error("DCP TIFF offset is outside the file.");
    }
  }

  u16(offset: number): number {
    this.range(offset, 2);
    return this.view.getUint16(offset, this.littleEndian);
  }

  u32(offset: number): number {
    this.range(offset, 4);
    return this.view.getUint32(offset, this.littleEndian);
  }

  i32(offset: number): number {
    this.range(offset, 4);
    return this.view.getInt32(offset, this.littleEndian);
  }

  entries(): readonly TiffEntry[] {
    const result: TiffEntry[] = [];
    const seen = new Set<number>();
    let ifdOffset = this.u32(4);
    for (let ifdIndex = 0; ifdOffset !== 0; ifdIndex += 1) {
      if (ifdIndex >= MAX_TIFF_IFDS) throw new Error("DCP has too many TIFF directories.");
      if (seen.has(ifdOffset)) throw new Error("DCP TIFF directory cycle detected.");
      seen.add(ifdOffset);
      const count = this.u16(ifdOffset);
      if (count > MAX_TIFF_ENTRIES || result.length + count > MAX_TIFF_ENTRIES) {
        throw new Error("DCP has too many TIFF fields.");
      }
      const entriesOffset = ifdOffset + 2;
      this.range(entriesOffset, count * 12 + 4);
      for (let index = 0; index < count; index += 1) {
        const offset = entriesOffset + index * 12;
        const type = this.u16(offset + 2);
        const typeSize = TIFF_TYPE_SIZES[type];
        if (!typeSize) throw new Error(`DCP TIFF field uses unsupported type ${type}.`);
        const valueCount = this.u32(offset + 4);
        if (valueCount > MAX_TIFF_VALUES) throw new Error("DCP TIFF field has too many values.");
        const byteLength = valueCount * typeSize;
        if (!Number.isSafeInteger(byteLength)) throw new Error("DCP TIFF field is too large.");
        const dataOffset = byteLength <= 4 ? offset + 8 : this.u32(offset + 8);
        this.range(dataOffset, byteLength);
        result.push({ tag: this.u16(offset), type, count: valueCount, dataOffset, byteLength });
      }
      ifdOffset = this.u32(entriesOffset + count * 12);
    }
    if (result.length === 0) throw new Error("DCP contains no TIFF fields.");
    return result;
  }

  ascii(entry: TiffEntry, label: string): string {
    if (entry.type !== 2 || entry.count < 2 || entry.count > 1_024) {
      throw new Error(`${label} must be bounded TIFF ASCII.`);
    }
    const data = this.bytes.subarray(entry.dataOffset, entry.dataOffset + entry.byteLength);
    if (data[data.length - 1] !== 0) throw new Error(`${label} must be NUL terminated.`);
    const body = data.subarray(0, data.length - 1);
    if (body.includes(0) || body.some((byte) => byte < 0x20 || byte > 0x7e)) {
      throw new Error(`${label} contains invalid ASCII.`);
    }
    return text(String.fromCharCode(...body), label);
  }

  rationalMatrix(entry: TiffEntry, label: string): CameraProfileMatrix3 {
    if ((entry.type !== 5 && entry.type !== 10) || entry.count !== 9) {
      throw new Error(`${label} must contain nine rational values.`);
    }
    const values: number[] = [];
    for (let index = 0; index < 9; index += 1) {
      const offset = entry.dataOffset + index * 8;
      const numerator = entry.type === 10 ? this.i32(offset) : this.u32(offset);
      const denominator = entry.type === 10 ? this.i32(offset + 4) : this.u32(offset + 4);
      if (denominator === 0) throw new Error(`${label} has a zero denominator.`);
      const value = numerator / denominator;
      if (!Number.isFinite(value) || Math.abs(value) > 16) throw new Error(`${label} is out of range.`);
      values.push(value);
    }
    return [
      values[0]!, values[1]!, values[2]!,
      values[3]!, values[4]!, values[5]!,
      values[6]!, values[7]!, values[8]!,
    ];
  }
}

const D50_XYZ_TO_LINEAR_SRGB: CameraProfileMatrix3 = [
  3.1338561, -1.6168667, -0.4906146,
  -0.9787684, 1.9161415, 0.033454,
  0.0719453, -0.2289914, 1.4052427,
];

function multiplyMatrix(left: CameraProfileMatrix3, right: CameraProfileMatrix3): CameraProfileMatrix3 {
  const value = (row: number, column: number) =>
    left[row * 3]! * right[column]! +
    left[row * 3 + 1]! * right[column + 3]! +
    left[row * 3 + 2]! * right[column + 6]!;
  return [
    value(0, 0), value(0, 1), value(0, 2),
    value(1, 0), value(1, 1), value(1, 2),
    value(2, 0), value(2, 1), value(2, 2),
  ];
}

function normalizedSlug(value: string): string {
  const slug = value.trim().toLocaleLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 80);
  if (!slug) throw new Error("DCP identity cannot form a profile ID.");
  return slug;
}

function cameraIdentity(uniqueModel: string): { readonly make: string; readonly model: string } {
  const normalized = uniqueModel.replace(/\s+/g, " ").trim();
  const knownMakes = [
    "NIKON CORPORATION", "EASTMAN KODAK COMPANY", "FUJIFILM", "Hasselblad",
    "Leica Camera AG", "OLYMPUS IMAGING CORP.", "OM Digital Solutions", "PENTAX",
    "RICOH IMAGING COMPANY, LTD.", "SONY", "Canon",
  ];
  const make = knownMakes.find((candidate) =>
    normalized.toLocaleLowerCase().startsWith(`${candidate.toLocaleLowerCase()} `),
  );
  if (make) return { make, model: text(normalized.slice(make.length), "DCP camera model") };
  const separator = normalized.indexOf(" ");
  if (separator <= 0 || separator === normalized.length - 1) {
    throw new Error("DCP UniqueCameraModel must include make and model.");
  }
  return {
    make: text(normalized.slice(0, separator), "DCP camera make"),
    model: text(normalized.slice(separator + 1), "DCP camera model"),
  };
}

function sameMatrix(left: CameraProfileMatrix3, right: CameraProfileMatrix3): boolean {
  return left.every((value, index) => Math.abs(value - right[index]!) <= 1e-9);
}

function parseDcp(bytes: Uint8Array): MatrixCameraProfile {
  const reader = new TiffReader(bytes);
  const entries = reader.entries();
  const byTag = new Map<number, TiffEntry>();
  for (const entry of entries) {
    if (byTag.has(entry.tag)) throw new Error(`DCP TIFF tag ${entry.tag} is duplicated.`);
    byTag.set(entry.tag, entry);
  }
  const unsupportedTags = [
    REDUCTION_MATRIX_1, REDUCTION_MATRIX_2,
    PROFILE_HUE_SAT_MAP_DIMS, PROFILE_HUE_SAT_MAP_DATA_1, PROFILE_HUE_SAT_MAP_DATA_2,
    PROFILE_TONE_CURVE, PROFILE_LOOK_TABLE_DIMS, PROFILE_LOOK_TABLE_DATA,
    OPCODE_LIST_1, OPCODE_LIST_2, OPCODE_LIST_3,
  ].filter((tag) => byTag.has(tag));
  if (unsupportedTags.length > 0) {
    throw new Error(`DCP requires unsupported transform tags: ${unsupportedTags.join(", ")}.`);
  }
  const cameraEntry = byTag.get(UNIQUE_CAMERA_MODEL);
  if (!cameraEntry) throw new Error("DCP needs UniqueCameraModel.");
  const profileNameEntry = byTag.get(PROFILE_NAME);
  if (!profileNameEntry) throw new Error("DCP needs ProfileName.");
  const forward1 = byTag.get(FORWARD_MATRIX_1);
  const forward2 = byTag.get(FORWARD_MATRIX_2);
  if (!forward1 && !forward2) {
    const hasColorMatrix = byTag.has(COLOR_MATRIX_1) || byTag.has(COLOR_MATRIX_2);
    throw new Error(hasColorMatrix
      ? "DCP ColorMatrix-only profiles are unsupported. A ForwardMatrix is required."
      : "DCP needs ForwardMatrix1 or ForwardMatrix2.");
  }
  const matrix1 = forward1 ? reader.rationalMatrix(forward1, "DCP ForwardMatrix1") : null;
  const matrix2 = forward2 ? reader.rationalMatrix(forward2, "DCP ForwardMatrix2") : null;
  if (matrix1 && matrix2 && !sameMatrix(matrix1, matrix2)) {
    throw new Error("DCP dual-illuminant matrix interpolation is unsupported.");
  }
  const camera = cameraIdentity(reader.ascii(cameraEntry, "DCP UniqueCameraModel"));
  const label = reader.ascii(profileNameEntry, "DCP ProfileName");
  const forward = matrix1 ?? matrix2!;
  return parseMatrixCameraProfile({
    version: 1,
    kind: "matrix",
    id: `dcp.${normalizedSlug(camera.make)}.${normalizedSlug(camera.model)}.${normalizedSlug(label)}`,
    revision: "dcp-forward-matrix-v1",
    label,
    compatibility: camera,
    matrixToLinearSrgb: multiplyMatrix(D50_XYZ_TO_LINEAR_SRGB, forward),
    channelScale: [1, 1, 1],
    exposureOffsetEv: 0,
    unsupportedTags: [],
    opcodes: [],
  });
}

export function cameraProfileFormatFromFilename(filename: string): CameraProfileFormat {
  const lower = filename.trim().toLocaleLowerCase();
  if (lower.endsWith(".dcp")) return "dcp";
  if (lower.endsWith(".xmp")) return "xmp";
  throw new Error("Choose a .dcp or .xmp camera profile.");
}

export function parseCameraProfileFile(input: {
  readonly bytes: Uint8Array;
  readonly format: CameraProfileFormat;
}): MatrixCameraProfile {
  if (input.bytes.byteLength === 0) throw new Error("Camera profile file is empty.");
  if (input.bytes.byteLength > CAMERA_PROFILE_FILE_LIMIT) {
    throw new Error("Camera profile file exceeds the 16 MiB limit.");
  }
  return input.format === "dcp" ? parseDcp(input.bytes) : parseProfileXmp(input.bytes);
}

export function cameraProfileCapabilities(): CameraProfileCapabilities {
  return MATRIX_CAPABILITIES;
}

export function deterministicCameraProfileCopyId(profileId: string, hash: string): string {
  return `${profileId}.copy-${sha256(hash, "cameraProfile.hash").slice(0, 12)}`;
}
