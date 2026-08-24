import {
  getCachedThumbnail,
} from "@/lib/cache/thumbnail-cache";
import {
  getPersistedAspectRatio,
  rememberEntryAspectRatio,
} from "@/lib/cache/aspect-ratio-cache";
import { parseImageDimensions } from "@/lib/image/dimensions";
import {
  getFileFromEntry,
  getFileHeadFromEntry,
} from "@/lib/fs/directory";
import type { LibraryEntry } from "@/lib/fs/types";
import { getFormatFamilyForEntry } from "@/lib/formats/registry";
import { readRawDimensions } from "@/lib/raw/libraw-client";
import { assetCacheKey } from "@/lib/cache/asset-cache-key";

const STANDARD_PROBE_BYTES = 512 * 1024;
const inFlightProbes = new Map<string, Promise<number>>();

function probeKey(entry: LibraryEntry): string {
  return assetCacheKey({
    catalogId: entry.catalogId,
    assetId: entry.id,
    revision: entry.assetRevision,
  }, "dimensions");
}

function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) {
    throw new DOMException("Aspect ratio probe was cancelled.", "AbortError");
  }
}

async function ratioFromCachedThumbnail(entry: LibraryEntry): Promise<number | null> {
  const blob = await getCachedThumbnail({
    catalogId: entry.catalogId,
    assetId: entry.id,
    revision: entry.assetRevision,
    thumbnail: true,
  });

  if (!blob) {
    return null;
  }

  const bitmap = await createImageBitmap(blob);
  const ratio = bitmap.width / bitmap.height;
  bitmap.close();
  return ratio;
}

async function probeEntryAspectRatio(entry: LibraryEntry): Promise<number> {
  if (entry.formatAvailability.status !== "supported") {
    return 1;
  }

  const family = getFormatFamilyForEntry(entry.name, entry.profileId);
  if (!family) {
    return 1;
  }

  if (family === "standard") {
    const head = await getFileHeadFromEntry(entry, STANDARD_PROBE_BYTES);
    const dimensions = parseImageDimensions(entry.name, head);
    if (dimensions) {
      return dimensions.width / dimensions.height;
    }

    const file = await getFileFromEntry(entry);
    const dimensionsFromFullFile = parseImageDimensions(
      entry.name,
      new Uint8Array(await file.arrayBuffer()),
    );
    if (dimensionsFromFullFile) {
      return dimensionsFromFullFile.width / dimensionsFromFullFile.height;
    }

    return 1;
  }

  if (family !== "raw") {
    return 1;
  }

  const file = await getFileFromEntry(entry);
  const dimensions = await readRawDimensions(new Uint8Array(await file.arrayBuffer()));
  if (dimensions) {
    return dimensions.width / dimensions.height;
  }

  return 1;
}

export async function resolveEntryAspectRatio(
  entry: LibraryEntry,
  options: { signal?: AbortSignal } = {},
): Promise<number> {
  throwIfAborted(options.signal);
  if (entry.formatAvailability.status !== "supported") {
    return 1;
  }

  const cachedThumbnailRatio = await ratioFromCachedThumbnail(entry);
  throwIfAborted(options.signal);
  if (cachedThumbnailRatio) {
    rememberEntryAspectRatio(entry, cachedThumbnailRatio);
    return cachedThumbnailRatio;
  }

  const persisted = await getPersistedAspectRatio(entry);
  throwIfAborted(options.signal);
  if (persisted) {
    return persisted;
  }

  const key = probeKey(entry);
  const activeProbe = inFlightProbes.get(key);
  if (activeProbe) {
    return activeProbe;
  }

  const probe = probeEntryAspectRatio(entry)
    .then((ratio) => {
      rememberEntryAspectRatio(entry, ratio);
      return ratio;
    })
    .finally(() => {
      inFlightProbes.delete(key);
    });

  inFlightProbes.set(key, probe);
  return probe;
}
