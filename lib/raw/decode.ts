import type { LibraryEntry } from "@/lib/fs/types";
import { getFileFromEntry } from "@/lib/fs/directory";
import { runWithThumbnailLimit } from "@/lib/cache/concurrency";
import { nefProfile } from "./profiles/nef";
import { standardImageProfile } from "./profiles/standard";
import type { DecodeOptions, DecodedImage } from "./types";

const PROFILES = [standardImageProfile, nefProfile];

export function resolveProfile(
  file: Pick<LibraryEntry, "name">,
): (typeof PROFILES)[number] | null {
  return PROFILES.find((profile) => profile.detect(file)) ?? null;
}

export function decodeEntry(
  entry: LibraryEntry,
  options: DecodeOptions & { thumbnail: true; rawSource?: "embedded" },
): Promise<DecodedImage & { blob: Blob; objectUrl: string }>;
export function decodeEntry(
  entry: LibraryEntry,
  options?: DecodeOptions,
): Promise<DecodedImage>;
export async function decodeEntry(
  entry: LibraryEntry,
  options?: DecodeOptions,
): Promise<DecodedImage> {
  const profile = resolveProfile(entry);
  if (!profile) {
    throw new Error(`No decoder profile found for ${entry.name}`);
  }

  const decode = async () => {
    const file = await getFileFromEntry(entry);
    const buffer = new Uint8Array(await file.arrayBuffer());
    return profile.decode(buffer, {
      ...options,
      relativePath: entry.relativePath,
    });
  };

  if (options?.thumbnail) {
    return runWithThumbnailLimit(decode, {
      priority: options.priority,
      signal: options.signal,
    });
  }

  return decode();
}

export type { DecodeOptions, DecodedImage, ImageProfile } from "./types";
