import { idbGet, idbSet } from "./idb";
import type { LibraryEntry } from "@/lib/fs/types";
import { decodeEntry } from "@/lib/raw/decode";
import { assetCacheKey, type AssetCacheIdentity } from "./asset-cache-key";
import type { StoredDevelopDocument } from "@/lib/develop/v3/document";
import { renderEditedPreview } from "./render-edited-preview";

const CACHE_PREFIX = "darkroom-thumb-v2:";
const MAX_MEMORY_THUMBNAILS = 300;

export interface ThumbnailCacheKey {
  catalogId: AssetCacheIdentity["catalogId"];
  assetId: AssetCacheIdentity["assetId"];
  revision: number;
  thumbnail: boolean;
  maxEdge?: number;
  entryId?: string;
  editHash?: string;
}

interface LoadThumbnailOptions {
  priority?: number;
  signal?: AbortSignal;
  document?: StoredDevelopDocument | null;
}

const memoryCache = new Map<string, Blob>();
interface InFlightThumbnailLoad {
  promise: Promise<Blob>;
  controller: AbortController;
  consumers: number;
  settled: boolean;
}

const inFlightLoads = new Map<string, InFlightThumbnailLoad>();

function waitForCaller(
  load: InFlightThumbnailLoad,
  signal?: AbortSignal,
): Promise<Blob> {
  if (signal?.aborted) {
    return Promise.reject(new DOMException("Thumbnail request was cancelled.", "AbortError"));
  }
  load.consumers += 1;
  return new Promise<Blob>((resolve, reject) => {
    let finished = false;
    function release(aborted: boolean) {
      if (finished) return;
      finished = true;
      load.consumers -= 1;
      signal?.removeEventListener("abort", onAbort);
      if (aborted && load.consumers === 0 && !load.settled) {
        load.controller.abort();
      }
    }
    const onAbort = () => {
      release(true);
      reject(new DOMException("Thumbnail request was cancelled.", "AbortError"));
    };
    signal?.addEventListener("abort", onAbort, { once: true });
    load.promise.then(
      (blob) => {
        release(false);
        resolve(blob);
      },
      (error: unknown) => {
        release(false);
        reject(error);
      },
    );
  });
}

function buildCacheKey(key: ThumbnailCacheKey): string {
  return `${CACHE_PREFIX}${assetCacheKey(key, key.thumbnail ? "thumb" : "full")}:${JSON.stringify([key.maxEdge ?? 360, key.entryId ?? null, key.editHash ?? "source"])}`;
}

const documentHashes = new WeakMap<StoredDevelopDocument, Promise<string>>();

function editHash(document: StoredDevelopDocument | null | undefined): Promise<string> {
  if (document === undefined) return Promise.resolve("source");
  if (document === null) return Promise.resolve("neutral-v3");
  let digest = documentHashes.get(document);
  if (!digest) {
    digest = crypto.subtle.digest("SHA-256", new TextEncoder().encode(JSON.stringify(document)))
      .then((bytes) => Array.from(new Uint8Array(bytes), (byte) => byte.toString(16).padStart(2, "0")).join(""));
    documentHashes.set(document, digest);
  }
  return digest;
}

function rememberThumbnail(cacheKey: string, blob: Blob): void {
  if (memoryCache.has(cacheKey)) {
    memoryCache.delete(cacheKey);
  }

  memoryCache.set(cacheKey, blob);

  if (memoryCache.size > MAX_MEMORY_THUMBNAILS) {
    const oldestKey = memoryCache.keys().next().value;
    if (oldestKey) {
      memoryCache.delete(oldestKey);
    }
  }
}

export async function getCachedThumbnail(
  key: ThumbnailCacheKey,
): Promise<Blob | null> {
  const cacheKey = buildCacheKey(key);
  const memoryCached = memoryCache.get(cacheKey);
  if (memoryCached) {
    memoryCache.delete(cacheKey);
    memoryCache.set(cacheKey, memoryCached);
    return memoryCached;
  }

  const cached = await idbGet<Blob>(cacheKey);
  if (cached) {
    rememberThumbnail(cacheKey, cached);
  }

  return cached ?? null;
}

export async function setCachedThumbnail(
  key: ThumbnailCacheKey,
  blob: Blob,
): Promise<void> {
  const cacheKey = buildCacheKey(key);
  rememberThumbnail(cacheKey, blob);
  await idbSet(cacheKey, blob);
}

export async function loadThumbnailBlob(
  entry: LibraryEntry,
  maxEdge: number,
  options: LoadThumbnailOptions = {},
): Promise<Blob> {
  options.signal?.throwIfAborted();
  const edge = Math.max(1, Math.min(16_384, Math.ceil(maxEdge)));
  if (!Number.isFinite(edge)) throw new Error("Thumbnail size must be finite.");
  const documentHash = await editHash(options.document);
  options.signal?.throwIfAborted();
  const key = {
    catalogId: entry.catalogId,
    assetId: entry.assetId,
    revision: entry.assetRevision,
    thumbnail: true,
    maxEdge: edge,
    entryId: options.document === undefined ? undefined : entry.id,
    editHash: documentHash,
  };
  const cacheKey = buildCacheKey(key);
  const activeLoad = inFlightLoads.get(cacheKey);

  if (activeLoad) {
    return waitForCaller(activeLoad, options.signal);
  }

  const controller = new AbortController();
  const promise = (async () => {
    const cached = await getCachedThumbnail(key);
    if (cached) {
      return cached;
    }

    if (options.document != null) {
      const blob = await renderEditedPreview(entry, options.document, edge, { priority: options.priority, signal: controller.signal });
      controller.signal.throwIfAborted();
      await setCachedThumbnail(key, blob);
      return blob;
    }
    const decoded = await decodeEntry(entry, {
      thumbnail: true,
      maxEdge: edge,
      priority: options.priority,
      signal: controller.signal,
    });
    URL.revokeObjectURL(decoded.objectUrl);
    await setCachedThumbnail(key, decoded.blob);
    return decoded.blob;
  })();
  const load: InFlightThumbnailLoad = {
    promise,
    controller,
    consumers: 0,
    settled: false,
  };

  function clearCompletedLoad() {
    load.settled = true;
    if (inFlightLoads.get(cacheKey) === load) {
      inFlightLoads.delete(cacheKey);
    }
  }

  inFlightLoads.set(cacheKey, load);
  promise.then(clearCompletedLoad, clearCompletedLoad);
  return waitForCaller(load, options.signal);
}
