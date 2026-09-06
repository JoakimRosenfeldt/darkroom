export const DEVELOP_PRESET_FIELDS = [
  "basic",
  "mixer",
  "effects",
  "tone-curves",
  "camera-profile",
  "crop",
  "manual-masks",
  "ai-masks",
] as const;

export type DevelopPresetField = (typeof DEVELOP_PRESET_FIELDS)[number];

export function parseDevelopPresetField(value: unknown): DevelopPresetField {
  const field = DEVELOP_PRESET_FIELDS.find((candidate) => candidate === value);
  if (!field) throw new Error("Develop preset field is not supported.");
  return field;
}
