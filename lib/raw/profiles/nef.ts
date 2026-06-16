import type { DecodeOptions, ImageProfile } from "../types";
import { decodeWithLibRaw } from "../libraw-client";

export const nefProfile: ImageProfile = {
  id: "nef",
  extensions: [".nef"],
  detect: (file) => file.name.toLowerCase().endsWith(".nef"),
  decode: (input, options?: DecodeOptions) => decodeWithLibRaw(input, options),
};
