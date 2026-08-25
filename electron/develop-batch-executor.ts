import type { SourceId } from "../lib/catalog/ids.ts";
import type { DevelopBatchControl, DevelopBatchOperation, DevelopBatchOperationId } from "../lib/develop/batch/domain.ts";
import {
  calculateDevelopPresetApplication,
  captureDevelopPresetPayload,
  developMaskTransferClass,
  type DevelopPresetCameraProfileContext,
} from "../lib/develop/presets/apply.ts";
import type { DevelopPresetField, DevelopPresetPayloadEntry } from "../lib/develop/presets/schema.ts";
import { DEFAULT_V3_DEVELOP_DOCUMENT, type DevelopDocumentV3 } from "../lib/develop/v3/document.ts";
import { validateV3CommandDocument } from "../lib/develop/v3/commands.ts";
import { referencedMaskArtifacts } from "../lib/develop/v3/masking.ts";
import { resolveAdjustedWhiteBalance } from "../lib/develop/v3/white-balance.ts";

export interface DevelopBatchExecutionInput {
  readonly operationId: DevelopBatchOperationId;
  readonly operation: Exclude<DevelopBatchOperation, { readonly kind: "undo" }>;
  readonly sourceDocument: DevelopDocumentV3 | null;
  readonly sourceId: SourceId | null;
  readonly targetDocument: DevelopDocumentV3;
  readonly targetSourceId: SourceId;
  readonly targetCameraProfile: DevelopPresetCameraProfileContext;
}

export type DevelopBatchExecutionResult =
  | { readonly kind: "changed"; readonly document: DevelopDocumentV3; readonly warnings: readonly string[] }
  | { readonly kind: "skipped"; readonly reason: string };

function ephemeralPreset(
  operationId: DevelopBatchOperationId,
  fields: readonly DevelopPresetField[],
  payload: unknown,
) {
  return {
    schemaVersion: 1,
    presetId: operationId,
    revision: 1,
    name: "Frozen batch settings",
    author: "Darkroom",
    category: "Batch",
    source: "user",
    favorite: false,
    fields,
    payload,
    compatibility: { process: "darkroom-v3", documentSchemaRevision: "darkroom-v3-document-2" },
  };
}

function sourcePayload(input: DevelopBatchExecutionInput, fields: readonly DevelopPresetField[]): readonly DevelopPresetPayloadEntry[] {
  if (!input.sourceDocument || !input.sourceId) throw new Error("Develop batch source document is unavailable.");
  return captureDevelopPresetPayload(input.sourceDocument, fields, input.sourceId);
}

function operationPreset(input: DevelopBatchExecutionInput): { readonly preset: unknown; readonly fields?: readonly DevelopPresetField[]; readonly amount: number } {
  if (input.operation.kind === "frozen") {
    return operationPreset({ ...input, operation: input.operation.action });
  }
  const operation = input.operation;
  switch (operation.kind) {
    case "copy-fields":
      return { preset: ephemeralPreset(input.operationId, operation.fields, sourcePayload(input, operation.fields)), amount: 100 };
    case "preset":
      return { preset: operation.preset, ...(operation.fields === null ? {} : { fields: operation.fields }), amount: operation.amount };
    case "paste-settings":
      return { preset: ephemeralPreset(input.operationId, operation.fields, operation.payload), amount: 100 };
    case "section-reset": throw new Error("Develop batch resets use their target context.");
    case "selected-control": throw new Error("Develop batch controls use their exact control path.");
    default: {
      const exhaustive: never = operation;
      return exhaustive;
    }
  }
}

export function captureDevelopBatchControl(document: DevelopDocumentV3, control: DevelopBatchControl): number {
  switch (control) {
    case "exposure": case "contrast": case "highlights": case "shadows": case "whites": case "blacks": return document.tone.basic[control];
    case "vibrance": case "saturation": return document.color.global[control];
    case "texture": case "clarity": case "dehaze": return document.presence[control];
    default: { const exhaustive: never = control; return exhaustive; }
  }
}

function applyControl(document: DevelopDocumentV3, control: DevelopBatchControl, value: number): DevelopDocumentV3 {
  switch (control) {
    case "exposure": case "contrast": case "highlights": case "shadows": case "whites": case "blacks":
      return validateV3CommandDocument({ ...document, tone: { ...document.tone, basic: { ...document.tone.basic, [control]: value } } });
    case "vibrance": case "saturation":
      return validateV3CommandDocument({ ...document, color: { ...document.color, global: { ...document.color.global, [control]: value } } });
    case "texture": case "clarity": case "dehaze":
      return validateV3CommandDocument({ ...document, presence: { ...document.presence, [control]: value } });
    default: { const exhaustive: never = control; return exhaustive; }
  }
}

function resetFields(input: DevelopBatchExecutionInput, fields: readonly DevelopPresetField[]): DevelopBatchExecutionResult {
  let document = structuredClone(input.targetDocument);
  const warnings: string[] = [];
  for (const field of fields) {
    switch (field) {
      case "basic": {
        const adjustment = structuredClone(DEFAULT_V3_DEVELOP_DOCUMENT.color.whiteBalance.adjustment);
        document = { ...document, tone: { ...document.tone, basic: structuredClone(DEFAULT_V3_DEVELOP_DOCUMENT.tone.basic) }, color: { ...document.color, global: structuredClone(DEFAULT_V3_DEVELOP_DOCUMENT.color.global), whiteBalance: { ...document.color.whiteBalance, adjustment, resolved: resolveAdjustedWhiteBalance({ previousAdjustment: document.color.whiteBalance.adjustment, previousValues: document.color.whiteBalance.resolved, adjustment }) } } };
        break;
      }
      case "mixer": document = { ...document, color: { ...document.color, mixer: structuredClone(DEFAULT_V3_DEVELOP_DOCUMENT.color.mixer) } }; break;
      case "effects": document = { ...document, presence: structuredClone(DEFAULT_V3_DEVELOP_DOCUMENT.presence), detail: structuredClone(DEFAULT_V3_DEVELOP_DOCUMENT.detail), effects: structuredClone(DEFAULT_V3_DEVELOP_DOCUMENT.effects) }; break;
      case "tone-curves": document = { ...document, tone: { ...document.tone, curves: structuredClone(DEFAULT_V3_DEVELOP_DOCUMENT.tone.curves) } }; break;
      case "camera-profile":
        if (input.targetCameraProfile.kind === "available-before-tone" && input.targetCameraProfile.decoderDefault.selection.kind === "decoder-default") document = { ...document, color: { ...document.color, inputProfile: structuredClone(input.targetCameraProfile.decoderDefault) } };
        else warnings.push("camera-profile: Decoder-default profile is unavailable for this target.");
        break;
      case "crop": document = { ...document, geometry: { ...document.geometry, crop: structuredClone(DEFAULT_V3_DEVELOP_DOCUMENT.geometry.crop) } }; break;
      case "manual-masks": document = { ...document, local: { ...document.local, masks: document.local.masks.filter((mask) => developMaskTransferClass(mask) !== "manual") } }; break;
      case "ai-masks": document = { ...document, local: { ...document.local, masks: document.local.masks.filter((mask) => developMaskTransferClass(mask) !== "ai") } }; break;
      default: { const exhaustive: never = field; return exhaustive; }
    }
  }
  const retainedAssets = new Set(document.local.masks.flatMap((mask) => referencedMaskArtifacts(mask.expression).map((asset) => asset.assetId)));
  document = { ...document, local: { ...document.local, maskAssetRefs: document.local.maskAssetRefs.filter((asset) => retainedAssets.has(asset.assetId)) } };
  return { kind: "changed", document: validateV3CommandDocument(document), warnings };
}

export function executeDevelopBatchOperation(input: DevelopBatchExecutionInput): DevelopBatchExecutionResult {
  const action = input.operation.kind === "frozen" ? input.operation.action : input.operation;
  if (action.kind === "selected-control") return { kind: "changed", document: applyControl(input.targetDocument, action.control, action.value), warnings: [] };
  if (action.kind === "section-reset") return resetFields(input, action.fields);
  const operation = operationPreset(input);
  const application = calculateDevelopPresetApplication({
    document: input.targetDocument,
    preset: operation.preset,
    ...(operation.fields === undefined ? {} : { selectedFields: operation.fields }),
    amount: operation.amount,
    context: {
      sourceId: input.targetSourceId,
      cameraProfile: input.targetCameraProfile,
      regenerateAiMasks: false,
    },
  });
  const warnings = [
    ...application.report.unsupported,
    ...application.report.skipped,
    ...application.report.regenerationRequests,
  ].map((item) => `${item.field}: ${item.reason}`);
  if (application.report.included.length === 0) {
    return { kind: "skipped", reason: warnings[0] ?? "No compatible Develop fields were selected." };
  }
  return { kind: "changed", document: application.document, warnings };
}
