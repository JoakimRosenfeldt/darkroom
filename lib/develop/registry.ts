import {
  DEFAULT_BASIC_SETTINGS,
  isDefaultBasic,
} from "@/lib/develop/plugins/basic";
import {
  DEFAULT_CROP_SETTINGS,
  isDefaultCrop,
} from "@/lib/develop/plugins/crop";
import {
  DEFAULT_CURVE_SETTINGS,
  isDefaultCurve,
} from "@/lib/develop/plugins/curve";
import {
  DEFAULT_EFFECTS_SETTINGS,
  isDefaultEffects,
} from "@/lib/develop/plugins/effects";
import {
  DEFAULT_MIXER_SETTINGS,
  isDefaultMixer,
} from "@/lib/develop/plugins/mixer";
import type { DevelopSettings } from "@/lib/develop/types";

type DevelopSettingsPatch = {
  [Plugin in keyof DevelopSettings]?: Partial<DevelopSettings[Plugin]>;
};

export const DEFAULT_DEVELOP_SETTINGS: DevelopSettings = {
  crop: DEFAULT_CROP_SETTINGS,
  basic: DEFAULT_BASIC_SETTINGS,
  curve: DEFAULT_CURVE_SETTINGS,
  mixer: DEFAULT_MIXER_SETTINGS,
  effects: DEFAULT_EFFECTS_SETTINGS,
};

export function createDevelopSettings(
  patch: DevelopSettingsPatch = {},
): DevelopSettings {
  return {
    crop: { ...DEFAULT_CROP_SETTINGS, ...patch.crop },
    basic: { ...DEFAULT_BASIC_SETTINGS, ...patch.basic },
    curve: { ...DEFAULT_CURVE_SETTINGS, ...patch.curve },
    mixer: { ...DEFAULT_MIXER_SETTINGS, ...patch.mixer },
    effects: { ...DEFAULT_EFFECTS_SETTINGS, ...patch.effects },
  };
}

export function developSettingsHash(settings: DevelopSettings): string {
  return JSON.stringify(settings);
}

export function isDefaultDevelopSettings(settings: DevelopSettings): boolean {
  return (
    isDefaultCrop(settings.crop) &&
    isDefaultBasic(settings.basic) &&
    isDefaultCurve(settings.curve) &&
    isDefaultMixer(settings.mixer) &&
    isDefaultEffects(settings.effects)
  );
}
