import type { LibRawSettings } from "libraw-wasm";
import type { DecodeOptions, DecodedImage } from "./types";
import { metadataToRecord, rgbDataToBlob } from "./utils";

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
  return {
    width: thumbnail.width,
    height: thumbnail.height,
    rgb: thumbnail.data,
    bits: 8,
    colors: 3,
    metadata,
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
): Promise<DecodedImage> {
  const blob = await rgbDataToBlob(
    image.data,
    image.width,
    image.height,
    image.bits,
  );
  const objectUrl = URL.createObjectURL(blob);

  return {
    width: image.width,
    height: image.height,
    rgb: image.data,
    bits: image.bits,
    colors: image.colors,
    metadata,
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

    const metadataRecord = metadataToRecord(
      metadata as Record<string, unknown>,
    );

    if (options.thumbnail) {
      const thumbnail = await raw.thumbnailData();
      if (
        thumbnail?.data?.length &&
        thumbnail.width > 0 &&
        thumbnail.height > 0
      ) {
        return buildFromEmbeddedThumbnail(thumbnail, metadataRecord);
      }
    }

    const image = await raw.imageData();
    if (!image?.data?.length || image.width <= 0 || image.height <= 0) {
      return null;
    }

    return buildFromImageData(image, metadataRecord);
  });
}

async function decodeEmbeddedThumbnail(
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
      metadataToRecord(metadata as Record<string, unknown>),
    );
  });
}

export async function decodeWithLibRaw(
  input: Uint8Array,
  options: DecodeOptions = {},
): Promise<DecodedImage> {
  if (options.thumbnail) {
    const embedded = await decodeEmbeddedThumbnail(input);
    if (embedded) {
      return embedded;
    }

    const thumbnail = await decodeOpenedRaw(input, options, true);
    if (thumbnail) {
      return thumbnail;
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
