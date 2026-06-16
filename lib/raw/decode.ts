import type { LibraryEntry } from "@/lib/fs/types";
import { getFileFromEntry } from "@/lib/fs/directory";
import { initializeProfiles } from "./profiles";
import { resolveProfile } from "./registry";
import type { DecodeOptions, DecodedImage } from "./types";

initializeProfiles();

export async function decodeEntry(
  entry: LibraryEntry,
  options?: DecodeOptions,
): Promise<DecodedImage> {
  const profile = resolveProfile(entry);
  if (!profile) {
    throw new Error(`No decoder profile found for ${entry.name}`);
  }

  const file = await getFileFromEntry(entry);
  const buffer = new Uint8Array(await file.arrayBuffer());
  return profile.decode(buffer, options);
}

export { resolveProfile, getSupportedExtensions } from "./registry";
export type { DecodeOptions, DecodedImage, ImageProfile } from "./types";
