import { captureDevelopPresetPayload } from "./apply.ts";
import { parseDevelopPresetRecord, type DevelopPresetRecord } from "./schema.ts";
import { createDefaultV3DevelopDocument } from "../v3/document.ts";

const compatibility = {
  process: "darkroom-v3",
  documentSchemaRevision: "darkroom-v3-document-2",
} as const;

function builtIn(
  presetId: string,
  name: string,
  category: string,
  contrast: number,
  saturation: number,
): DevelopPresetRecord {
  const baseline = createDefaultV3DevelopDocument();
  const document = {
    ...baseline,
    tone: {
      ...baseline.tone,
      basic: { ...baseline.tone.basic, contrast },
    },
    color: {
      ...baseline.color,
      global: { ...baseline.color.global, saturation },
    },
  };
  const fields = ["basic", "tone-curves", "effects"] as const;
  return parseDevelopPresetRecord({
    schemaVersion: 1,
    presetId,
    revision: 1,
    name,
    author: "Darkroom",
    category,
    source: "built-in",
    favorite: false,
    fields,
    payload: captureDevelopPresetPayload(document, fields, null),
    compatibility,
  });
}

export const BUILT_IN_DEVELOP_PRESETS: readonly DevelopPresetRecord[] = [
  builtIn(
    "18c2fc94-8145-4f58-a700-671df5a90705",
    "Neutral base",
    "Essentials",
    0,
    0,
  ),
  builtIn(
    "b2198efe-2629-4a36-91c9-776787823d6a",
    "Clean contrast",
    "Essentials",
    18,
    4,
  ),
];
