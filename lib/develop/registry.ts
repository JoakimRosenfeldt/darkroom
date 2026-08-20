import { basicPlugin } from "@/lib/develop/plugins/basic";
import { cropPlugin } from "@/lib/develop/plugins/crop";
import {
  curvePlugin,
  normalizeCurveSettings,
} from "@/lib/develop/plugins/curve";
import { effectsPlugin } from "@/lib/develop/plugins/effects";
import { mixerPlugin } from "@/lib/develop/plugins/mixer";
import type {
  DevelopPlugin,
  DevelopPluginId,
  DevelopSettings,
} from "@/lib/develop/types";

export const DEVELOP_PLUGINS = [
  cropPlugin,
  basicPlugin,
  curvePlugin,
  mixerPlugin,
  effectsPlugin,
] as const satisfies readonly DevelopPlugin<DevelopPluginId>[];

export const DEFAULT_DEVELOP_SETTINGS: DevelopSettings = composeDefaults();

function composeDefaults(): DevelopSettings {
  const globals = DEVELOP_PLUGINS.reduce<Partial<DevelopSettings>>((settings, plugin) => {
    return {
      ...settings,
      [plugin.id]: structuredClone(plugin.defaults),
    };
  }, {});
  return {
    basic: globals.basic ?? structuredClone(basicPlugin.defaults),
    crop: globals.crop ?? structuredClone(cropPlugin.defaults),
    curve: globals.curve ?? structuredClone(curvePlugin.defaults),
    mixer: globals.mixer ?? structuredClone(mixerPlugin.defaults),
    effects: globals.effects ?? structuredClone(effectsPlugin.defaults),
    masking: { masks: [] },
  };
}

export function createDevelopSettings(
  patch: Partial<DevelopSettings> = {},
): DevelopSettings {
  const defaults = structuredClone(DEFAULT_DEVELOP_SETTINGS);
  return {
    basic: { ...defaults.basic, ...patch.basic },
    crop: { ...defaults.crop, ...patch.crop },
    curve: normalizeCurveSettings(patch.curve ?? defaults.curve),
    mixer: {
      red: { ...defaults.mixer.red, ...patch.mixer?.red },
      orange: { ...defaults.mixer.orange, ...patch.mixer?.orange },
      yellow: { ...defaults.mixer.yellow, ...patch.mixer?.yellow },
      green: { ...defaults.mixer.green, ...patch.mixer?.green },
      aqua: { ...defaults.mixer.aqua, ...patch.mixer?.aqua },
      blue: { ...defaults.mixer.blue, ...patch.mixer?.blue },
      purple: { ...defaults.mixer.purple, ...patch.mixer?.purple },
      magenta: { ...defaults.mixer.magenta, ...patch.mixer?.magenta },
    },
    effects: { ...defaults.effects, ...patch.effects },
    masking: patch.masking
      ? { masks: structuredClone(patch.masking.masks) }
      : defaults.masking,
  };
}

export function isDefaultDevelopSettings(settings: DevelopSettings): boolean {
  return settings.masking.masks.length === 0 && DEVELOP_PLUGINS.every((plugin) =>
    plugin.isDefault(settings[plugin.id] as never),
  );
}

export function developSettingsHash(settings: DevelopSettings): string {
  return JSON.stringify(settings);
}
