import { getPersistedAspectRatio, setPersistedAspectRatio } from "@/lib/cache/aspect-ratio-cache";
import { getCachedThumbnail } from "@/lib/cache/thumbnail-cache";
import {
  dimensionsToAspectRatio,
  parseImageDimensions,
} from "@/lib/image/dimensions";
import {
  getFileFromEntry,
  getFileHeadFromEntry,
} from "@/lib/fs/directory";
import type { LibraryEntry } from "@/lib/fs/types";
import { readRawDimensions } from "@/lib/raw/libraw-client";
import { resolveProfile } from "@/lib/raw/registry";

const STANDARD_PROBE_BYTES = 512 * 1024;
const inFlightProbes = new Map<string, Promise<number>>();

function probeKey(entry: LibraryEntry): string {
  return `${entry.relativePath}:${entry.lastModified}`;
}

function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) {
    throw new DOMException("Aspect ratio probe was cancelled.", "AbortError");
  }
}

async function ratioFromCachedThumbnail(entry: LibraryEntry): Promise<number | null> {
  const blob = await getCachedThumbnail({
    relativePath: entry.relativePath,
    lastModified: entry.lastModified,
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
  const profile = resolveProfile(entry);
  if (!profile) {
    return 1;
  }

  if (profile.id === "standard") {
    const head = await getFileHeadFromEntry(entry, STANDARD_PROBE_BYTES);
    const dimensions = parseImageDimensions(entry.name, head);
    if (dimensions) {
      return dimensionsToAspectRatio(dimensions);
    }

    const file = await getFileFromEntry(entry);
    const dimensionsFromFullFile = parseImageDimensions(
      entry.name,
      new Uint8Array(await file.arrayBuffer()),
    );
    if (dimensionsFromFullFile) {
      return dimensionsToAspectRatio(dimensionsFromFullFile);
    }

    return 1;
  }

  const file = await getFileFromEntry(entry);
  const dimensions = await readRawDimensions(new Uint8Array(await file.arrayBuffer()));
  if (dimensions) {
    return dimensionsToAspectRatio(dimensions);
  }

  return 1;
}

export async function resolveEntryAspectRatio(
  entry: LibraryEntry,
  options: { signal?: AbortSignal } = {},
): Promise<number> {
  throwIfAborted(options.signal);

  const cachedThumbnailRatio = await ratioFromCachedThumbnail(entry);
  throwIfAborted(options.signal);
  if (cachedThumbnailRatio) {
    await setPersistedAspectRatio(entry, cachedThumbnailRatio);
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
    .then(async (ratio) => {
      await setPersistedAspectRatio(entry, ratio);
      return ratio;
    })
    .finally(() => {
      inFlightProbes.delete(key);
    });

  inFlightProbes.set(key, probe);
  return probe;
}
