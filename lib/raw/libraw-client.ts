import type { LibRawSettings } from "libraw-wasm";
import type { DecodeOptions, DecodedImage } from "./types";
import { matrixCameraProfileFromLibRawMetadata } from "../camera-profiles/matrix";
import { orientedImageSize, rgbDataToBlob } from "./utils";
import { runWithRawLimit } from "@/lib/cache/concurrency";

type LibRawInstance = InstanceType<
  Awaited<typeof import("libraw-wasm")>["default"]
>;

let librawModule: typeof import("libraw-wasm") | null = null;
let librawInstance: LibRawInstance | null = null;

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
  options: DecodeOptions = {},
): Promise<T> {
  return runWithRawLimit(async () => {
    const raw = await acquireLibRaw();
    options.signal?.throwIfAborted();
    const result = await operation(raw);
    if (options.signal?.aborted && typeof result === "object" && result !== null &&
        "objectUrl" in result && typeof result.objectUrl === "string") URL.revokeObjectURL(result.objectUrl);
    options.signal?.throwIfAborted();
    return result;
  }, options);
}

function buildSettings(
  options: DecodeOptions,
  halfSize: boolean,
): LibRawSettings {
  if (options.cameraProfile?.kind === "libraw-camera-matrix") {
    return {
      halfSize,
      outputBps: 16,
      outputColor: 0,
      gamm: [1, 1],
      noAutoBright: true,
      useCameraMatrix: 0,
      useCameraWb: true,
      userQual: options.thumbnail ? 0 : halfSize ? 1 : 2,
    };
  }
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
    pixelProvenance: {
      decoderPath: "embedded-preview",
      decoderRevision: "libraw-embedded-jpeg-v1",
      colorSpace: "unknown",
      transfer: "encoded",
      bitDepth: 8,
      cameraProfileStage: {
        kind: "unavailable",
        reason: "Embedded RAW previews contain rendered pixels.",
      },
    },
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
  options: DecodeOptions,
  maxEdge?: number,
): Promise<DecodedImage> {
  const profiled = options.cameraProfile?.kind === "libraw-camera-matrix";
  if (
    profiled &&
    (!(image.data instanceof Uint16Array) || image.bits !== 16 || image.colors !== 3)
  ) {
    throw new Error("The LibRaw camera-profile path did not return RGB16 pixels.");
  }
  const cameraProfile = profiled
    ? matrixCameraProfileFromLibRawMetadata(metadata)
    : null;
  const scale = maxEdge
    ? Math.min(1, maxEdge / Math.max(image.width, image.height))
    : 1;
  const width = Math.max(1, Math.round(image.width * scale));
  const height = Math.max(1, Math.round(image.height * scale));
  const rgb = scale === 1
    ? image.data
    : resizeRgbData(image.data, image.width, image.height, image.colors, width, height);
  options.signal?.throwIfAborted();
  const blob = options.sourcePixels
    ? undefined
    : await rgbDataToBlob(rgb, width, height, image.bits);
  options.signal?.throwIfAborted();
  const objectUrl = blob ? URL.createObjectURL(blob) : undefined;

  return {
    width,
    height,
    rgb,
    bits: image.bits,
    colors: image.colors,
    pixelProvenance: cameraProfile
      ? {
          decoderPath: "libraw",
          decoderRevision: "darkroom-libraw-linear-camera-v1",
          colorSpace: "camera-rgb",
          transfer: "linear",
          bitDepth: 16,
          cameraProfileStage: {
            kind: "available",
            stage: "before-develop-tone",
            profile: cameraProfile,
            camera: cameraProfile.compatibility,
          },
        }
      : {
          decoderPath: "libraw",
          decoderRevision: "darkroom-libraw-settings-v1",
          colorSpace: "srgb",
          transfer: "encoded",
          bitDepth: image.bits,
          cameraProfileStage: {
            kind: "unavailable",
            reason: "The default LibRaw path returns rendered RGB pixels.",
          },
        },
    metadata: { ...metadata, decoderProvenance: "libraw" },
    blob,
    objectUrl,
  };
}

function resizeRgbData(
  source: Uint8Array | Uint16Array,
  sourceWidth: number,
  sourceHeight: number,
  channels: number,
  width: number,
  height: number,
): Uint8Array | Uint16Array {
  const output = source instanceof Uint16Array
    ? new Uint16Array(width * height * channels)
    : new Uint8Array(width * height * channels);
  for (let y = 0; y < height; y += 1) {
    const sourceY = Math.min(sourceHeight - 1, Math.floor((y + 0.5) * sourceHeight / height));
    for (let x = 0; x < width; x += 1) {
      const sourceX = Math.min(sourceWidth - 1, Math.floor((x + 0.5) * sourceWidth / width));
      const sourceOffset = (sourceY * sourceWidth + sourceX) * channels;
      const targetOffset = (y * width + x) * channels;
      for (let channel = 0; channel < channels; channel += 1) {
        output[targetOffset + channel] = source[sourceOffset + channel] ?? 0;
      }
    }
  }
  return output;
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
    options.signal?.throwIfAborted();
    if (!image?.data?.length || image.width <= 0 || image.height <= 0) {
      return null;
    }

    return buildFromImageData(
      image,
      metadataRecord,
      options,
      halfSize ? options.maxEdge : undefined,
    );
  }, options);
}

export async function decodeEmbeddedThumbnail(
  input: Uint8Array,
  options: DecodeOptions = {},
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
  }, options);
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
      const embedded = await decodeEmbeddedThumbnail(input, options);
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

  const embeddedPreview = await decodeEmbeddedThumbnail(input, options);
  if (embeddedPreview) {
    return embeddedPreview;
  }

  const fullResolution = await decodeOpenedRaw(input, options, false);
  if (fullResolution) {
    return fullResolution;
  }

  throw new Error("Could not decode RAW image data");
}
