import type { LibRawSettings } from "libraw-wasm";
import type { DecodeOptions, DecodedImage } from "./types";
import { orientedImageSize, rgbDataToBlob } from "./utils";

type LibRawInstance = InstanceType<
  Awaited<typeof import("libraw-wasm")>["default"]
>;

let librawModule: typeof import("libraw-wasm") | null = null;
let librawInstance: LibRawInstance | null = null;
let librawQueue: Promise<unknown> = Promise.resolve();

async function acquireLibRaw(): Promise<LibRawInstance> {
  if (!librawModule) {
    librawModule = await import("libraw-wasm");
  }

  if (!librawInstance) {
    librawInstance = new librawModule.default();
  }

  return librawInstance;
}

function runLibRaw<T>(
  operation: (raw: LibRawInstance) => Promise<T>,
): Promise<T> {
  const task = librawQueue
    .then(() => acquireLibRaw())
    .then((raw) => operation(raw));

  librawQueue = task.then(
    () => undefined,
    () => undefined,
  );

  return task;
}

function buildSettings(
  options: DecodeOptions,
  halfSize: boolean,
): LibRawSettings {
  return {
    halfSize,
    outputBps: 8,
    useCameraWb: true,
    userQual: options.thumbnail ? 0 : halfSize ? 1 : 2,
  };
}

function buildFromEmbeddedThumbnail(
  thumbnail: { data: Uint8Array; width: number; height: number },
  metadata: Record<string, unknown>,
): DecodedImage {
  const blob = new Blob([thumbnail.data as BlobPart], { type: "image/jpeg" });
  const objectUrl = URL.createObjectURL(blob);
  const size = orientedImageSize(
    thumbnail.width,
    thumbnail.height,
    Number(metadata.flip),
  );
  return {
    ...size,
    rgb: thumbnail.data,
    bits: 8,
    colors: 3,
    metadata: { ...metadata, decoderProvenance: "embedded" },
    blob,
    objectUrl,
  };
}

async function buildFromImageData(
  image: {
    data: Uint8Array | Uint16Array;
    width: number;
    height: number;
    bits: number;
    colors: number;
  },
  metadata: Record<string, unknown>,
  maxEdge?: number,
): Promise<DecodedImage> {
  const scale = maxEdge
    ? Math.min(1, maxEdge / Math.max(image.width, image.height))
    : 1;
  const width = Math.max(1, Math.round(image.width * scale));
  const height = Math.max(1, Math.round(image.height * scale));
  const blob = await rgbDataToBlob(
    image.data,
    image.width,
    image.height,
    image.bits,
    maxEdge,
  );
  const objectUrl = URL.createObjectURL(blob);

  return {
    width,
    height,
    rgb: scale === 1 ? image.data : new Uint8Array(0),
    bits: image.bits,
    colors: image.colors,
    metadata: { ...metadata, decoderProvenance: "libraw" },
    blob,
    objectUrl,
  };
}

async function decodeOpenedRaw(
  input: Uint8Array,
  options: DecodeOptions,
  halfSize: boolean,
): Promise<DecodedImage | null> {
  return runLibRaw(async (raw) => {
    await raw.open(input.slice() as BufferSource, buildSettings(options, halfSize));

    const metadata = await raw.metadata(true);
    if (!metadata) {
      throw new Error("Could not read RAW metadata");
    }

    const metadataRecord = structuredClone(
      metadata as Record<string, unknown>,
    );
    const image = await raw.imageData();
    if (!image?.data?.length || image.width <= 0 || image.height <= 0) {
      return null;
    }

    return buildFromImageData(
      image,
      metadataRecord,
      halfSize ? options.maxEdge : undefined,
    );
  });
}

export async function decodeEmbeddedThumbnail(
  input: Uint8Array,
): Promise<DecodedImage | null> {
  return runLibRaw(async (raw) => {
    await raw.open(
      input.slice() as BufferSource,
      buildSettings({ thumbnail: true }, true),
    );

    const metadata = await raw.metadata(true);
    if (!metadata) {
      return null;
    }

    const thumbnail = await raw.thumbnailData();
    if (
      !thumbnail?.data?.length ||
      thumbnail.width <= 0 ||
      thumbnail.height <= 0
    ) {
      return null;
    }

    return buildFromEmbeddedThumbnail(
      thumbnail,
      structuredClone(metadata as Record<string, unknown>),
    );
  });
}

export async function readRawDimensions(
  input: Uint8Array,
): Promise<{ width: number; height: number } | null> {
  return runLibRaw(async (raw) => {
    await raw.open(
      input.slice() as BufferSource,
      buildSettings({ thumbnail: true }, true),
    );

    const metadata = await raw.metadata(false);
    if (!metadata?.width || !metadata?.height) {
      return null;
    }

    return {
      width: metadata.width,
      height: metadata.height,
    };
  });
}

export async function decodeWithLibRaw(
  input: Uint8Array,
  options: DecodeOptions = {},
): Promise<DecodedImage> {
  if (options.fullResolution) {
    const fullResolution = await decodeOpenedRaw(input, options, false);
    if (fullResolution) {
      return fullResolution;
    }
    throw new Error("Could not decode RAW image");
  }

  if (options.thumbnail) {
    if (options.rawSource !== "developed") {
      const embedded = await decodeEmbeddedThumbnail(input);
      if (embedded) {
        return embedded;
      }
    }

    const thumbnail = await decodeOpenedRaw(input, options, true);
    if (thumbnail) {
      if (options.rawSource === "developed") {
        thumbnail.metadata.developSource = "raw";
      }
      return thumbnail;
    }

    if (options.rawSource === "developed") {
      throw new Error("Could not process RAW thumbnail");
    }

    throw new Error("Could not decode RAW thumbnail");
  }

  const preview = await decodeOpenedRaw(input, options, true);
  if (preview) {
    return preview;
  }

  const embeddedPreview = await decodeEmbeddedThumbnail(input);
  if (embeddedPreview) {
    return embeddedPreview;
  }

  const fullResolution = await decodeOpenedRaw(input, options, false);
  if (fullResolution) {
    return fullResolution;
  }

  throw new Error("Could not decode RAW image data");
}
