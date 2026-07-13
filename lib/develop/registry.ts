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
  return DEVELOP_PLUGINS.reduce((settings, plugin) => {
    return {
      ...settings,
      [plugin.id]: structuredClone(plugin.defaults),
    };
  }, {} as DevelopSettings);
}

export function createDevelopSettings(
  patch: Partial<DevelopSettings> = {},
): DevelopSettings {
  const defaults = structuredClone(DEFAULT_DEVELOP_SETTINGS);
  const settings = {
    ...defaults,
    ...Object.fromEntries(
      Object.entries(patch).map(([pluginId, pluginSettings]) => [
        pluginId,
        {
          ...defaults[pluginId as DevelopPluginId],
          ...(pluginSettings as object),
        },
      ]),
    ),
  } as DevelopSettings;
  settings.curve = normalizeCurveSettings(patch.curve ?? settings.curve);
  return settings;
}

export function isDefaultDevelopSettings(settings: DevelopSettings): boolean {
  return DEVELOP_PLUGINS.every((plugin) =>
    plugin.isDefault(settings[plugin.id] as never),
  );
}

export function developSettingsHash(settings: DevelopSettings): string {
  return JSON.stringify(settings);
}
