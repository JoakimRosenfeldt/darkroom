import type { DecodeOptions, DecodedImage } from "./types";
import { metadataToRecord, rgbDataToBlob } from "./utils";

let librawModule: typeof import("libraw-wasm") | null = null;

async function getLibRaw() {
  if (!librawModule) {
    librawModule = await import("libraw-wasm");
  }
  const LibRaw = librawModule.default;
  return new LibRaw();
}

export async function decodeWithLibRaw(
  input: Uint8Array,
  options: DecodeOptions = {},
): Promise<DecodedImage> {
  const raw = await getLibRaw();

  await raw.open(input as BufferSource, {
    halfSize: options.thumbnail ?? false,
    outputBps: 8,
    useCameraWb: true,
    userQual: options.thumbnail ? 0 : 3,
  });

  const metadata = await raw.metadata(true);
  if (!metadata) {
    throw new Error("Could not read RAW metadata");
  }

  if (options.thumbnail) {
    const thumbnail = await raw.thumbnailData();
    if (thumbnail?.data && thumbnail.width > 0 && thumbnail.height > 0) {
      const blob = new Blob([thumbnail.data as BlobPart], { type: "image/jpeg" });
      const objectUrl = URL.createObjectURL(blob);
      return {
        width: thumbnail.width,
        height: thumbnail.height,
        rgb: thumbnail.data,
        bits: 8,
        colors: 3,
        metadata: metadataToRecord(metadata as Record<string, unknown>),
        blob,
        objectUrl,
      };
    }
  }

  const image = await raw.imageData();
  if (!image?.data) {
    throw new Error("Could not decode RAW image data");
  }

  const blob = await rgbDataToBlob(image.data, image.width, image.height, image.bits);
  const objectUrl = URL.createObjectURL(blob);

  return {
    width: image.width,
    height: image.height,
    rgb: image.data,
    bits: image.bits,
    colors: image.colors,
    metadata: metadataToRecord(metadata as Record<string, unknown>),
    blob,
    objectUrl,
  };
}
