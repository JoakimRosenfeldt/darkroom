import type { SourceId } from "../../catalog/ids.ts";
import type { CurvePoint, CurveSettings } from "../types.ts";
import { validateV3CommandDocument, type V3DirectEditCommand } from "../v3/commands.ts";
import type { DevelopDocumentV3, PersistedInputProfile } from "../v3/document.ts";
import { referencedMaskArtifacts, type LocalMaskV3, type MaskExpression } from "../v3/masking.ts";
import { resolveAdjustedWhiteBalance } from "../v3/white-balance.ts";
import {
  cloneDevelopPreset,
  parseAppliedPresetState,
  parseDevelopPresetRecord,
  type AppliedPresetState,
  type DevelopPresetField,
  type DevelopPresetPayloadEntry,
  type DevelopPresetRecord,
} from "./schema.ts";

export type DevelopPresetCameraProfileContext =
  | {
      readonly kind: "unavailable";
      readonly reason: string;
    }
  | {
      readonly kind: "available-before-tone";
      readonly decoderDefault: PersistedInputProfile;
      readonly compatibleProfiles: readonly PersistedInputProfile[];
    };

export interface DevelopPresetApplyContext {
  readonly sourceId: SourceId;
  readonly cameraProfile?: DevelopPresetCameraProfileContext;
  /** @deprecated Callers without a full stage/profile snapshot safely skip profile fields. */
  readonly compatibleInputProfileIds?: readonly string[];
  readonly regenerateAiMasks: boolean;
}

export interface DevelopPresetFieldReport {
  readonly field: DevelopPresetField;
  readonly reason: string;
}

export interface DevelopPresetApplyReport {
  readonly included: readonly DevelopPresetField[];
  readonly unsupported: readonly DevelopPresetFieldReport[];
  readonly skipped: readonly DevelopPresetFieldReport[];
  readonly regenerationRequests: readonly DevelopPresetFieldReport[];
}

export interface DevelopPresetApplicationResult {
  readonly document: DevelopDocumentV3;
  readonly report: DevelopPresetApplyReport;
  readonly command: Extract<V3DirectEditCommand, { readonly kind: "replace-v3-complete-state" }>;
}

function canonical(value: unknown): string {
  if (value === null || typeof value === "boolean" || typeof value === "string" || typeof value === "number") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (typeof value !== "object") throw new Error("Preset value is not JSON data.");
  return `{${Object.entries(value).sort(([left], [right]) => left.localeCompare(right)).map(([key, child]) => `${JSON.stringify(key)}:${canonical(child)}`).join(",")}}`;
}

function sourceKinds(expression: MaskExpression): readonly string[] {
  switch (expression.kind) {
    case "source": return [expression.source.kind];
    case "combine": return [...sourceKinds(expression.left), ...sourceKinds(expression.right)];
    case "invert": return sourceKinds(expression.child);
    default: { const exhaustive: never = expression; return exhaustive; }
  }
}

export type DevelopMaskTransferClass = "manual" | "ai" | "source-specific";

export function developMaskTransferClass(mask: LocalMaskV3): DevelopMaskTransferClass {
  const kinds = sourceKinds(mask.expression);
  if (kinds.length > 0 && kinds.every((kind) => kind === "ai-matte")) return "ai";
  if (kinds.length > 0 && kinds.every((kind) => kind !== "ai-matte" && kind !== "depth-range")) return "manual";
  return "source-specific";
}

export function countDevelopMaskTransferClasses(
  document: DevelopDocumentV3,
): Readonly<Record<DevelopMaskTransferClass, number>> {
  const counts: Record<DevelopMaskTransferClass, number> = {
    manual: 0,
    ai: 0,
    "source-specific": 0,
  };
  for (const mask of document.local.masks) counts[developMaskTransferClass(mask)] += 1;
  return counts;
}

function sampleCurve(points: readonly CurvePoint[], x: number): number {
  if (x <= points[0]!.x) return points[0]!.y;
  if (x >= points.at(-1)!.x) return points.at(-1)!.y;
  for (let index = 1; index < points.length; index += 1) {
    const right = points[index]!;
    const left = points[index - 1]!;
    if (x <= right.x) {
      const amount = (x - left.x) / (right.x - left.x);
      return left.y + (right.y - left.y) * amount;
    }
  }
  return points.at(-1)!.y;
}

export function normalizePresetCurves(curves: CurveSettings): CurveSettings {
  const normalize = (points: readonly CurvePoint[]): CurvePoint[] => Array.from({ length: 256 }, (_, index) => {
    const x = index / 255;
    return { x, y: sampleCurve(points, x) };
  });
  return {
    rgb: normalize(curves.rgb),
    red: normalize(curves.red),
    green: normalize(curves.green),
    blue: normalize(curves.blue),
  };
}

function interpolateObject<T>(baseline: T, target: T, amount: number): T {
  const blend = (left: unknown, right: unknown): unknown => {
    if (typeof left === "number" && typeof right === "number") return left + (right - left) * amount;
    if (Array.isArray(left) && Array.isArray(right) && left.length === right.length) return left.map((item, index) => blend(item, right[index]));
    if (typeof left === "object" && left !== null && !Array.isArray(left) && typeof right === "object" && right !== null && !Array.isArray(right)) {
      return Object.fromEntries(Object.keys(left).map((key) => [key, blend(Reflect.get(left, key), Reflect.get(right, key))]));
    }
    if (canonical(left) !== canonical(right)) throw new Error("Blendable preset field shapes do not match.");
    return structuredClone(left);
  };
  return blend(baseline, target) as T;
}

function interpolateCurves(baseline: CurveSettings, target: CurveSettings, amount: number): CurveSettings {
  const left = normalizePresetCurves(baseline);
  const right = normalizePresetCurves(target);
  const channel = (name: keyof CurveSettings): CurvePoint[] => left[name].map((point, index) => ({
    x: point.x,
    y: point.y + (right[name][index]!.y - point.y) * amount,
  }));
  return { rgb: channel("rgb"), red: channel("red"), green: channel("green"), blue: channel("blue") };
}

function fieldEntry(document: DevelopDocumentV3, field: DevelopPresetField, sourceId: SourceId | null): DevelopPresetPayloadEntry {
  switch (field) {
    case "basic": return {
      field,
      value: {
        tone: structuredClone(document.tone.basic),
        global: structuredClone(document.color.global),
        whiteBalanceAdjustment: structuredClone(document.color.whiteBalance.adjustment),
      },
    };
    case "mixer": return { field, value: structuredClone(document.color.mixer) };
    case "effects": return {
      field,
      value: {
        presence: structuredClone(document.presence),
        noiseReduction: structuredClone(document.detail.noiseReduction),
        sharpening: structuredClone(document.detail.sharpening),
        postCrop: structuredClone(document.effects.postCrop),
      },
    };
    case "tone-curves": return { field, value: normalizePresetCurves(document.tone.curves) };
    case "camera-profile": return { field, value: structuredClone(document.color.inputProfile) };
    case "crop": return { field, value: structuredClone(document.geometry.crop) };
    case "manual-masks": return { field, value: structuredClone(document.local.masks.filter((mask) => developMaskTransferClass(mask) === "manual")) };
    case "ai-masks": {
      if (sourceId === null) throw new Error("AI mask provenance needs a SourceId.");
      const masks = document.local.masks.filter((mask) => developMaskTransferClass(mask) === "ai");
      const ids = new Set(masks.flatMap((mask) => referencedMaskArtifacts(mask.expression).map((asset) => asset.assetId)));
      return { field, value: { sourceId, masks: structuredClone(masks), assetRefs: structuredClone(document.local.maskAssetRefs.filter((asset) => ids.has(asset.assetId))) } };
    }
    default: { const exhaustive: never = field; return exhaustive; }
  }
}

export function captureDevelopPresetPayload(
  document: DevelopDocumentV3,
  fields: readonly DevelopPresetField[],
  sourceId: SourceId | null,
): readonly DevelopPresetPayloadEntry[] {
  if (fields.includes("ai-masks") && sourceId === null) throw new Error("AI mask provenance needs a SourceId.");
  return fields.map((field) => fieldEntry(document, field, sourceId));
}

export function expandDevelopPresetPayload(
  presetValue: unknown,
  selectedFields?: readonly DevelopPresetField[],
): readonly DevelopPresetPayloadEntry[] {
  const preset = parseDevelopPresetRecord(presetValue);
  const fields = selectedFields ?? preset.fields;
  if (new Set(fields).size !== fields.length || fields.some((field) => !preset.fields.includes(field))) {
    throw new Error("Preset field selection contains undeclared fields or duplicates.");
  }
  return fields.map((field) => {
    const entry = preset.payload.find((candidate) => candidate.field === field);
    if (!entry) throw new Error(`Preset payload is missing ${field}.`);
    return entry.field === "tone-curves"
      ? { field: entry.field, value: normalizePresetCurves(entry.value) }
      : structuredClone(entry);
  });
}

function sameCalibration(left: PersistedInputProfile, right: PersistedInputProfile): boolean {
  return canonical(left.calibration) === canonical(right.calibration);
}

function compatibleProfile(entry: Extract<DevelopPresetPayloadEntry, { readonly field: "camera-profile" }>, context: DevelopPresetApplyContext): boolean {
  const target = entry.value;
  const available = context.cameraProfile;
  if (target.selection.kind === "unavailable" || available?.kind !== "available-before-tone") return false;
  if (target.selection.kind === "decoder-default") {
    return available.decoderDefault.selection.kind === "decoder-default" &&
      available.decoderDefault.registryRevision === target.registryRevision &&
      sameCalibration(target, available.decoderDefault);
  }
  const targetSelection = target.selection;
  return available.compatibleProfiles.some((candidate) =>
    candidate.selection.kind === "selected" &&
    candidate.selection.profileId === targetSelection.profileId &&
    candidate.selection.profileRevision === targetSelection.profileRevision &&
    candidate.registryRevision === target.registryRevision &&
    sameCalibration(candidate, target),
  );
}

function payloadByField(entries: readonly DevelopPresetPayloadEntry[]): Map<DevelopPresetField, DevelopPresetPayloadEntry> {
  return new Map(entries.map((entry) => [entry.field, entry]));
}

function expandedEntry(
  baseline: DevelopPresetPayloadEntry,
  target: DevelopPresetPayloadEntry,
  amount: number,
): DevelopPresetPayloadEntry {
  if (baseline.field !== target.field) throw new Error("Preset provenance fields do not match.");
  const blendAmount = amount / 100;
  switch (baseline.field) {
    case "basic":
      if (target.field !== baseline.field) throw new Error("Basic preset provenance is invalid.");
      return { field: baseline.field, value: interpolateObject(baseline.value, target.value, blendAmount) };
    case "mixer":
      if (target.field !== baseline.field) throw new Error("Mixer preset provenance is invalid.");
      return { field: baseline.field, value: interpolateObject(baseline.value, target.value, blendAmount) };
    case "effects":
      if (target.field !== baseline.field) throw new Error("Effects preset provenance is invalid.");
      return { field: baseline.field, value: interpolateObject(baseline.value, target.value, blendAmount) };
    case "tone-curves":
      if (target.field !== baseline.field) throw new Error("Tone curve preset provenance is invalid.");
      return { field: baseline.field, value: interpolateCurves(baseline.value, target.value, blendAmount) };
    case "camera-profile":
    case "crop":
    case "manual-masks":
    case "ai-masks":
      return amount === 100 ? structuredClone(target) : structuredClone(baseline);
    default: { const exhaustive: never = baseline; return exhaustive; }
  }
}

function duplicateMaskId(document: DevelopDocumentV3, entry: DevelopPresetPayloadEntry): boolean {
  if (entry.field !== "manual-masks" && entry.field !== "ai-masks") return false;
  const replacedClass = entry.field === "manual-masks" ? "manual" : "ai";
  const preserved = new Set(document.local.masks.filter((mask) => developMaskTransferClass(mask) !== replacedClass).map((mask) => mask.id));
  const masks = entry.field === "manual-masks" ? entry.value : entry.value.masks;
  return masks.some((mask) => preserved.has(mask.id));
}

function applyPayload(document: DevelopDocumentV3, entries: readonly DevelopPresetPayloadEntry[]): DevelopDocumentV3 {
  let next = structuredClone(document);
  for (const entry of entries) {
    switch (entry.field) {
      case "basic":
        next = {
          ...next,
          tone: { ...next.tone, basic: entry.value.tone },
          color: {
            ...next.color,
            global: entry.value.global,
            whiteBalance: {
              ...next.color.whiteBalance,
              adjustment: entry.value.whiteBalanceAdjustment,
              resolved: resolveAdjustedWhiteBalance({
                previousAdjustment: next.color.whiteBalance.adjustment,
                previousValues: next.color.whiteBalance.resolved,
                adjustment: entry.value.whiteBalanceAdjustment,
              }),
            },
          },
        };
        break;
      case "mixer": next = { ...next, color: { ...next.color, mixer: entry.value } }; break;
      case "effects": next = { ...next, presence: entry.value.presence, detail: { noiseReduction: entry.value.noiseReduction, sharpening: entry.value.sharpening }, effects: { postCrop: entry.value.postCrop } }; break;
      case "tone-curves": next = { ...next, tone: { ...next.tone, curves: entry.value } }; break;
      case "camera-profile": next = { ...next, color: { ...next.color, inputProfile: entry.value } }; break;
      case "crop": next = { ...next, geometry: { ...next.geometry, crop: entry.value } }; break;
      case "manual-masks": {
        const masks = [...next.local.masks.filter((mask) => developMaskTransferClass(mask) !== "manual"), ...entry.value];
        next = { ...next, local: { ...next.local, masks } };
        break;
      }
      case "ai-masks": {
        const replacedAssetIds = new Set(next.local.masks.filter((mask) => developMaskTransferClass(mask) === "ai").flatMap((mask) => referencedMaskArtifacts(mask.expression).map((asset) => asset.assetId)));
        const masks = [...next.local.masks.filter((mask) => developMaskTransferClass(mask) !== "ai"), ...entry.value.masks];
        const referenced = new Map(next.local.maskAssetRefs.map((asset) => [asset.assetId, asset]));
        for (const assetId of replacedAssetIds) referenced.delete(assetId);
        for (const asset of entry.value.assetRefs) referenced.set(asset.assetId, asset);
        next = { ...next, local: { ...next.local, masks, maskAssetRefs: [...referenced.values()] } };
        break;
      }
      default: { const exhaustive: never = entry; return exhaustive; }
    }
  }
  return next;
}

function applicationFromProvenance(
  document: DevelopDocumentV3,
  state: AppliedPresetState,
  context: DevelopPresetApplyContext,
  report: DevelopPresetApplyReport,
): DevelopPresetApplicationResult {
  const baseline = payloadByField(state.baseline);
  const target = payloadByField(state.target);
  const expanded: DevelopPresetPayloadEntry[] = [];
  for (const field of state.includedFields) {
    const left = baseline.get(field);
    const right = target.get(field);
    if (!left || !right) throw new Error("Applied preset provenance is incomplete.");
    if (field === "camera-profile" && right.field === "camera-profile" && state.amount === 100 && !compatibleProfile(right, context)) {
      throw new Error("Applied preset camera profile is no longer compatible.");
    }
    if (field === "ai-masks" && right.field === "ai-masks" && right.value.sourceId !== context.sourceId) {
      throw new Error("Applied preset AI masks belong to another source.");
    }
    expanded.push(expandedEntry(left, right, state.amount));
  }
  const appliedState = parseAppliedPresetState({ ...state, lastExpanded: expanded, linkState: "linked" });
  const next = validateV3CommandDocument({ ...applyPayload(document, expanded), appliedPreset: appliedState });
  return { document: next, report, command: { kind: "replace-v3-complete-state", document: next } };
}

export function calculateDevelopPresetApplication(input: {
  readonly document: DevelopDocumentV3;
  readonly preset: unknown;
  readonly selectedFields?: readonly DevelopPresetField[];
  readonly amount: number;
  readonly context: DevelopPresetApplyContext;
}): DevelopPresetApplicationResult {
  const preset = parseDevelopPresetRecord(input.preset);
  if (!Number.isFinite(input.amount) || input.amount < 0 || input.amount > 100) throw new Error("Preset Amount must be between 0 and 100.");
  const amount = input.amount;
  const selected = input.selectedFields ?? preset.fields;
  const requested = expandDevelopPresetPayload(preset, selected);
  const unsupported: DevelopPresetFieldReport[] = [];
  const skipped: DevelopPresetFieldReport[] = preset.fields.filter((field) => !selected.includes(field)).map((field) => ({ field, reason: "Field was not selected." }));
  const regenerationRequests: DevelopPresetFieldReport[] = [];
  const supported = requested.filter((entry) => {
    if (entry.field === "manual-masks" && entry.value.length === 0) {
      skipped.push({ field: entry.field, reason: "The source has no transferable manual masks." });
      return false;
    }
    if (entry.field === "ai-masks" && entry.value.masks.length === 0) {
      skipped.push({ field: entry.field, reason: "The source has no transferable AI masks." });
      return false;
    }
    if (entry.field === "camera-profile" && !compatibleProfile(entry, input.context)) {
      unsupported.push({ field: entry.field, reason: "Camera profile is not compatible with this source." });
      return false;
    }
    if (entry.field === "ai-masks" && entry.value.sourceId !== input.context.sourceId) {
      if (input.context.regenerateAiMasks) {
        regenerationRequests.push({ field: entry.field, reason: "AI masks require regeneration for this source." });
        skipped.push({ field: entry.field, reason: "AI masks were not applied until regeneration completes." });
      } else unsupported.push({ field: entry.field, reason: "AI masks belong to another source." });
      return false;
    }
    if (duplicateMaskId(input.document, entry)) {
      skipped.push({ field: entry.field, reason: "Mask IDs conflict with masks preserved on the target." });
      return false;
    }
    return true;
  });
  if (supported.length === 0) {
    const document = validateV3CommandDocument(input.document);
    return {
      document,
      report: { included: [], unsupported, skipped, regenerationRequests },
      command: { kind: "replace-v3-complete-state", document },
    };
  }
  const fields = supported.map((entry) => entry.field);
  const baseline = captureDevelopPresetPayload(input.document, fields, input.context.sourceId);
  const target = supported.map((entry) => entry.field === "tone-curves" ? { field: entry.field, value: normalizePresetCurves(entry.value) } : structuredClone(entry));
  const state = parseAppliedPresetState({
    presetId: preset.presetId,
    revision: preset.revision,
    amount,
    includedFields: fields,
    baseline,
    target,
    lastExpanded: baseline,
    linkState: "linked",
  });
  return applicationFromProvenance(input.document, state, input.context, { included: fields, unsupported, skipped, regenerationRequests });
}

export function setAppliedPresetAmount(
  document: DevelopDocumentV3,
  amountValue: number,
  context: DevelopPresetApplyContext,
): DevelopPresetApplicationResult {
  if (!document.appliedPreset || document.appliedPreset.linkState !== "linked") throw new Error("Preset Amount is unavailable until the preset is reapplied.");
  if (!Number.isFinite(amountValue) || amountValue < 0 || amountValue > 100) throw new Error("Preset Amount must be between 0 and 100.");
  const amount = amountValue;
  const state = parseAppliedPresetState({ ...document.appliedPreset, amount });
  return applicationFromProvenance(document, state, context, { included: state.includedFields, unsupported: [], skipped: [], regenerationRequests: [] });
}

export function reapplyDevelopPreset(
  document: DevelopDocumentV3,
  context: DevelopPresetApplyContext,
): DevelopPresetApplicationResult {
  if (!document.appliedPreset) throw new Error("No applied preset is recorded.");
  return applicationFromProvenance(document, { ...document.appliedPreset, linkState: "linked" }, context, { included: document.appliedPreset.includedFields, unsupported: [], skipped: [], regenerationRequests: [] });
}

export function markAppliedPresetModified(before: DevelopDocumentV3, after: DevelopDocumentV3): DevelopDocumentV3 {
  const state = before.appliedPreset;
  if (!state || state.linkState === "modified") return after;
  if (after.appliedPreset?.presetId !== state.presetId || after.appliedPreset.revision !== state.revision) return after;
  const sourceId = state.target.find((entry) => entry.field === "ai-masks");
  const captured = captureDevelopPresetPayload(after, state.includedFields, sourceId?.field === "ai-masks" ? sourceId.value.sourceId : null);
  return canonical(captured) === canonical(state.lastExpanded)
    ? after
    : { ...after, appliedPreset: { ...state, linkState: "modified" } };
}

export function appliedPresetAmountAvailable(document: DevelopDocumentV3): boolean {
  return document.appliedPreset?.linkState === "linked";
}

export function incrementPresetAmount(amount: number, direction: -1 | 1, step = 1): number {
  if (!Number.isFinite(amount) || amount < 0 || amount > 100 || (direction !== -1 && direction !== 1) || !Number.isFinite(step) || step <= 0) throw new Error("Preset Amount increment is invalid.");
  return Math.max(0, Math.min(100, amount + direction * step));
}

export function resetPresetAmount(): number {
  return 100;
}

export function immutablePresetSnapshot(preset: DevelopPresetRecord): DevelopPresetRecord {
  return cloneDevelopPreset(parseDevelopPresetRecord(preset));
}
