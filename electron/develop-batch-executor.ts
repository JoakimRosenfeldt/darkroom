import type { SourceId } from "../lib/catalog/ids.ts";
import type { DevelopBatchOperation, DevelopBatchOperationId } from "../lib/develop/batch/domain.ts";
import {
  calculateDevelopPresetApplication,
  captureDevelopPresetPayload,
  type DevelopPresetCameraProfileContext,
} from "../lib/develop/presets/apply.ts";
import type { DevelopPresetField, DevelopPresetPayloadEntry } from "../lib/develop/presets/schema.ts";
import { DEFAULT_V3_DEVELOP_DOCUMENT, type DevelopDocumentV3 } from "../lib/develop/v3/document.ts";

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
  switch (input.operation.kind) {
    case "copy-fields":
      return { preset: ephemeralPreset(input.operationId, input.operation.fields, sourcePayload(input, input.operation.fields)), amount: 100 };
    case "preset":
      return { preset: input.operation.preset, ...(input.operation.fields === null ? {} : { fields: input.operation.fields }), amount: input.operation.amount };
    case "paste-settings":
      return { preset: ephemeralPreset(input.operationId, input.operation.fields, input.operation.payload), amount: 100 };
    case "section-reset": {
      const payload = captureDevelopPresetPayload(DEFAULT_V3_DEVELOP_DOCUMENT, input.operation.fields, input.targetSourceId);
      return { preset: ephemeralPreset(input.operationId, input.operation.fields, payload), amount: 100 };
    }
    case "selected-control":
      return { preset: ephemeralPreset(input.operationId, [input.operation.field], [input.operation.payloadEntry]), amount: 100 };
    default: {
      const exhaustive: never = input.operation;
      return exhaustive;
    }
  }
}

export function executeDevelopBatchOperation(input: DevelopBatchExecutionInput): DevelopBatchExecutionResult {
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
