import type { BasicSettings } from "../types.ts";
import type { Rgb } from "./profiles.ts";

export interface LocalAdjustmentValues {
  readonly basic: BasicSettings;
  readonly texture: number;
  readonly clarity: number;
  readonly sharpness: number;
  readonly noise: number;
  readonly moire: number;
  readonly defringe: number;
  readonly colorize: {
    readonly color: Rgb;
    readonly amount: number;
  };
}

export type LocalAdjustmentField =
  | keyof BasicSettings
  | "texture"
  | "clarity"
  | "sharpness"
  | "noise"
  | "moire"
  | "defringe"
  | "colorizeAmount";

export interface LocalAdjustmentDefinition {
  readonly field: LocalAdjustmentField;
  readonly label: string;
  readonly group: "basic" | "presence" | "detail" | "color";
  readonly minimum: number;
  readonly maximum: number;
  readonly defaultValue: number;
  readonly order: number;
  readonly capability: "cpu-reference";
}

const DEFINITIONS = [
  ["exposure", "Exposure", "basic", -5, 5, 0],
  ["contrast", "Contrast", "basic", -100, 100, 0],
  ["highlights", "Highlights", "basic", -100, 100, 0],
  ["shadows", "Shadows", "basic", -100, 100, 0],
  ["whites", "Whites", "basic", -100, 100, 0],
  ["blacks", "Blacks", "basic", -100, 100, 0],
  ["temperature", "Temperature", "basic", -100, 100, 0],
  ["tint", "Tint", "basic", -100, 100, 0],
  ["vibrance", "Vibrance", "basic", -100, 100, 0],
  ["saturation", "Saturation", "basic", -100, 100, 0],
  ["texture", "Texture", "presence", -100, 100, 0],
  ["clarity", "Clarity", "presence", -100, 100, 0],
  ["sharpness", "Sharpness", "detail", 0, 100, 0],
  ["noise", "Noise", "detail", 0, 100, 0],
  ["moire", "Moire", "detail", 0, 100, 0],
  ["defringe", "Defringe", "detail", 0, 100, 0],
  ["colorizeAmount", "Colorize", "color", 0, 100, 0],
] as const satisfies readonly [
  LocalAdjustmentField,
  string,
  LocalAdjustmentDefinition["group"],
  number,
  number,
  number,
][];

const REGISTRY: readonly LocalAdjustmentDefinition[] = DEFINITIONS.map(
  ([field, label, group, minimum, maximum, defaultValue], index) => ({
    field,
    label,
    group,
    minimum,
    maximum,
    defaultValue,
    order: index,
    capability: "cpu-reference",
  }),
);

const DEFINITIONS_BY_FIELD = new Map(REGISTRY.map((definition) => [definition.field, definition]));

const BASIC_FIELDS = [
  "exposure", "contrast", "highlights", "shadows", "whites", "blacks",
  "temperature", "tint", "vibrance", "saturation",
] as const satisfies readonly (keyof BasicSettings)[];

export const DEFAULT_LOCAL_ADJUSTMENTS: LocalAdjustmentValues = {
  basic: {
    exposure: 0,
    contrast: 0,
    highlights: 0,
    shadows: 0,
    whites: 0,
    blacks: 0,
    temperature: 0,
    tint: 0,
    vibrance: 0,
    saturation: 0,
  },
  texture: 0,
  clarity: 0,
  sharpness: 0,
  noise: 0,
  moire: 0,
  defringe: 0,
  colorize: { color: [1, 1, 1], amount: 0 },
};

function record(value: unknown, path: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(`${path} must be an object.`);
  }
  return Object.fromEntries(Object.entries(value));
}

function bounded(value: unknown, path: string, minimum: number, maximum: number): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value < minimum || value > maximum) {
    throw new Error(`${path} must be between ${minimum} and ${maximum}.`);
  }
  return Object.is(value, -0) ? 0 : value;
}

export function parseLocalAdjustmentValues(value: unknown): LocalAdjustmentValues {
  const input = record(value, "local adjustments");
  const basic = record(input.basic, "local adjustments.basic");
  const colorize = record(input.colorize, "local adjustments.colorize");
  if (!Array.isArray(colorize.color) || colorize.color.length !== 3) {
    throw new Error("local adjustments.colorize.color must contain three channels.");
  }
  const definition = (field: LocalAdjustmentField): LocalAdjustmentDefinition => {
    const found = DEFINITIONS_BY_FIELD.get(field);
    if (!found) throw new Error(`Missing local adjustment definition for ${field}.`);
    return found;
  };
  const valueFor = (field: LocalAdjustmentField, raw: unknown, path: string): number => {
    const bounds = definition(field);
    return bounded(raw, path, bounds.minimum, bounds.maximum);
  };
  return {
    basic: {
      exposure: valueFor("exposure", basic.exposure, "local adjustments.basic.exposure"),
      contrast: valueFor("contrast", basic.contrast, "local adjustments.basic.contrast"),
      highlights: valueFor("highlights", basic.highlights, "local adjustments.basic.highlights"),
      shadows: valueFor("shadows", basic.shadows, "local adjustments.basic.shadows"),
      whites: valueFor("whites", basic.whites, "local adjustments.basic.whites"),
      blacks: valueFor("blacks", basic.blacks, "local adjustments.basic.blacks"),
      temperature: valueFor("temperature", basic.temperature, "local adjustments.basic.temperature"),
      tint: valueFor("tint", basic.tint, "local adjustments.basic.tint"),
      vibrance: valueFor("vibrance", basic.vibrance, "local adjustments.basic.vibrance"),
      saturation: valueFor("saturation", basic.saturation, "local adjustments.basic.saturation"),
    },
    texture: valueFor("texture", input.texture, "local adjustments.texture"),
    clarity: valueFor("clarity", input.clarity, "local adjustments.clarity"),
    sharpness: valueFor("sharpness", input.sharpness, "local adjustments.sharpness"),
    noise: valueFor("noise", input.noise, "local adjustments.noise"),
    moire: valueFor("moire", input.moire, "local adjustments.moire"),
    defringe: valueFor("defringe", input.defringe, "local adjustments.defringe"),
    colorize: {
      color: [
        bounded(colorize.color[0], "local adjustments.colorize.color[0]", 0, 1),
        bounded(colorize.color[1], "local adjustments.colorize.color[1]", 0, 1),
        bounded(colorize.color[2], "local adjustments.colorize.color[2]", 0, 1),
      ],
      amount: valueFor("colorizeAmount", colorize.amount, "local adjustments.colorize.amount"),
    },
  };
}

export function localAdjustmentDefinitions(): readonly LocalAdjustmentDefinition[] {
  return REGISTRY;
}

export function localAdjustmentsAreNeutral(values: LocalAdjustmentValues): boolean {
  return Object.values(values.basic).every((value) => value === 0) &&
    values.texture === 0 && values.clarity === 0 && values.sharpness === 0 &&
    values.noise === 0 && values.moire === 0 && values.defringe === 0 &&
    values.colorize.amount === 0;
}

export function createDefaultLocalAdjustments(): LocalAdjustmentValues {
  return structuredClone(DEFAULT_LOCAL_ADJUSTMENTS);
}

export function legacyBasicLocalAdjustments(basic: BasicSettings): LocalAdjustmentValues {
  return { ...createDefaultLocalAdjustments(), basic: structuredClone(basic) };
}

export interface LocalAccumulationInput {
  readonly contributions: readonly {
    readonly values: LocalAdjustmentValues;
    readonly coverage: number;
  }[];
}

export function accumulateLocalAdjustments(
  input: LocalAccumulationInput,
): LocalAdjustmentValues {
  const basic = { ...DEFAULT_LOCAL_ADJUSTMENTS.basic };
  let texture = 0;
  let clarity = 0;
  let sharpness = 0;
  let noise = 0;
  let moire = 0;
  let defringe = 0;
  let colorWeight = 0;
  let red = 0;
  let green = 0;
  let blue = 0;
  for (const contribution of input.contributions) {
    const coverage = clamp(contribution.coverage, 0, 1);
    for (const field of BASIC_FIELDS) {
      basic[field] += contribution.values.basic[field] * coverage;
    }
    texture += contribution.values.texture * coverage;
    clarity += contribution.values.clarity * coverage;
    sharpness += contribution.values.sharpness * coverage;
    noise += contribution.values.noise * coverage;
    moire += contribution.values.moire * coverage;
    defringe += contribution.values.defringe * coverage;
    const weight = contribution.values.colorize.amount * coverage;
    colorWeight += weight;
    red += contribution.values.colorize.color[0] * weight;
    green += contribution.values.colorize.color[1] * weight;
    blue += contribution.values.colorize.color[2] * weight;
  }
  const boundsFor = (field: LocalAdjustmentField): LocalAdjustmentDefinition => {
    const definition = DEFINITIONS_BY_FIELD.get(field);
    if (!definition) throw new Error(`Missing local adjustment definition for ${field}.`);
    return definition;
  };
  for (const field of BASIC_FIELDS) {
    const bounds = boundsFor(field);
    basic[field] = clamp(basic[field], bounds.minimum, bounds.maximum);
  }
  const boundedValue = (field: "texture" | "clarity" | "sharpness" | "noise" | "moire" | "defringe", value: number): number => {
    const bounds = boundsFor(field);
    return clamp(value, bounds.minimum, bounds.maximum);
  };
  return {
    basic,
    texture: boundedValue("texture", texture),
    clarity: boundedValue("clarity", clarity),
    sharpness: boundedValue("sharpness", sharpness),
    noise: boundedValue("noise", noise),
    moire: boundedValue("moire", moire),
    defringe: boundedValue("defringe", defringe),
    colorize: {
      color: colorWeight > 0 ? [red / colorWeight, green / colorWeight, blue / colorWeight] : [1, 1, 1],
      amount: clamp(colorWeight, 0, 100),
    },
  };
}

function clamp(value: number, minimum: number, maximum: number): number {
  return Math.max(minimum, Math.min(maximum, Number.isFinite(value) ? value : 0));
}

export function applyLocalEffectAdjustments(rgb: Rgb, values: LocalAdjustmentValues): Rgb {
  let result: Rgb = [...rgb];
  const luminance = result[0] * 0.2126 + result[1] * 0.7152 + result[2] * 0.0722;
  const presence = (values.texture * 0.0015 + values.clarity * 0.002) * (luminance - 0.5);
  result = [result[0] + presence, result[1] + presence, result[2] + presence];
  const detail = values.sharpness * 0.001 * (luminance - 0.5);
  result = [result[0] + detail, result[1] + detail, result[2] + detail];
  const smoothing = clamp((values.noise + values.moire) / 250, 0, 0.8);
  result = [
    result[0] + (luminance - result[0]) * smoothing,
    result[1] + (luminance - result[1]) * smoothing,
    result[2] + (luminance - result[2]) * smoothing,
  ];
  if (values.defringe > 0) {
    const neutral = (result[0] + result[2]) * 0.5;
    const amount = values.defringe / 100;
    result = [
      result[0] + (neutral - result[0]) * amount,
      result[1],
      result[2] + (neutral - result[2]) * amount,
    ];
  }
  const colorize = values.colorize.amount / 100;
  if (colorize > 0) {
    result = [
      result[0] + (values.colorize.color[0] - result[0]) * colorize,
      result[1] + (values.colorize.color[1] - result[1]) * colorize,
      result[2] + (values.colorize.color[2] - result[2]) * colorize,
    ];
  }
  return [
    clamp(result[0], -16, 16),
    clamp(result[1], -16, 16),
    clamp(result[2], -16, 16),
  ];
}
