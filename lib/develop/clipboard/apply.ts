import {
  calculateDevelopPresetApplication,
  markAppliedPresetModified,
  type DevelopPresetApplyContext,
  type DevelopPresetApplyReport,
} from "../presets/apply.ts";
import { parseDevelopPresetRecord, type DevelopPresetField } from "../presets/schema.ts";
import { validateV3CommandDocument } from "../v3/commands.ts";
import type { DevelopDocumentV3 } from "../v3/document.ts";
import {
  parseDevelopClipboardPayload,
  type DevelopClipboardGroup,
  type DevelopClipboardPayload,
} from "./schema.ts";

const CLIPBOARD_PRESET_ID = "6225686c-29d1-43b7-b6bb-eae33f846ab2";

export interface DevelopClipboardApplication {
  readonly document: DevelopDocumentV3;
  readonly report: DevelopPresetApplyReport;
  readonly appliedMetadata: boolean;
}

export function calculateDevelopClipboardApplication(input: {
  readonly document: DevelopDocumentV3;
  readonly clipboard: unknown;
  readonly selectedGroups: readonly DevelopClipboardGroup[];
  readonly context: DevelopPresetApplyContext;
}): DevelopClipboardApplication {
  const clipboard: DevelopClipboardPayload = parseDevelopClipboardPayload(input.clipboard);
  const selected = [...new Set(input.selectedGroups)];
  if (
    selected.length !== input.selectedGroups.length ||
    selected.some((group) => !clipboard.selectedGroups.includes(group))
  ) {
    throw new Error("Paste selection contains unavailable clipboard groups.");
  }
  const fields = selected.filter(
    (group): group is DevelopPresetField => group !== "metadata",
  );
  if (fields.length === 0) {
    return {
      document: input.document,
      report: { included: [], unsupported: [], skipped: [], regenerationRequests: [] },
      appliedMetadata: selected.includes("metadata"),
    };
  }
  const preset = parseDevelopPresetRecord({
    schemaVersion: 1,
    presetId: CLIPBOARD_PRESET_ID,
    revision: 1,
    name: "Clipboard settings",
    author: "Darkroom",
    category: "Clipboard",
    source: "user",
    favorite: false,
    fields: clipboard.payload.map((entry) => entry.field),
    payload: clipboard.payload,
    compatibility: {
      process: "darkroom-v3",
      documentSchemaRevision: "darkroom-v3-document-2",
    },
  });
  const result = calculateDevelopPresetApplication({
    document: input.document,
    preset,
    selectedFields: fields,
    amount: 100,
    context: input.context,
  });
  const withoutClipboardPreset = validateV3CommandDocument({
    ...result.document,
    appliedPreset: input.document.appliedPreset,
  });
  return {
    document: validateV3CommandDocument(
      markAppliedPresetModified(input.document, withoutClipboardPreset),
    ),
    report: result.report,
    appliedMetadata: selected.includes("metadata"),
  };
}
