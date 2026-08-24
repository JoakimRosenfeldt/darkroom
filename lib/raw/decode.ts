import type { LibraryEntry } from "@/lib/fs/types";
import {
  getFormatCapability,
  getDecoderProfileIdForFileName,
  getFormatCapabilityForFileName,
} from "@/lib/formats/registry";
import { getFileFromEntry } from "@/lib/fs/directory";
import { getAssetRequest } from "@/lib/fs/session-catalog";
import { runWithThumbnailLimit } from "@/lib/cache/concurrency";
import { nefProfile } from "./profiles/nef";
import { standardImageProfile } from "./profiles/standard";
import type { DecodeOptions, DecodedImage, ImageProfile } from "./types";

const PROFILES: Record<"standard" | "nef", typeof standardImageProfile> = {
  standard: standardImageProfile,
  nef: nefProfile,
};

export function resolveProfile(
  file: Pick<LibraryEntry, "name"> & Partial<Pick<LibraryEntry, "formatId">>,
): ImageProfile | null {
  const profileId = file.formatId === "nef"
    ? "nef"
    : file.formatId === "jpeg" || file.formatId === "png" || file.formatId === "webp"
      ? "standard"
      : getDecoderProfileIdForFileName(file.name);
  return profileId ? PROFILES[profileId] : null;
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
  const capability = entry.formatId === null
    ? getFormatCapabilityForFileName(entry.name)
    : getFormatCapability(entry.formatId);
  if (!capability || capability.preview.status !== "supported") {
    throw new Error(
      entry.formatAvailability.reason ?? `Preview is unavailable for ${entry.name}.`,
    );
  }
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
      assetRequest: getAssetRequest(entry),
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
