import type { DecodeOptions, DecodedImage, ImageProfile } from "../types";

const STANDARD_EXTENSIONS = [".jpg", ".jpeg", ".png", ".webp"];

async function blobToDecodedImage(
  blob: Blob,
  metadata: Record<string, unknown>,
  includePixels: boolean,
): Promise<DecodedImage> {
  const bitmap = await createImageBitmap(blob);

  if (!includePixels) {
    const width = bitmap.width;
    const height = bitmap.height;
    bitmap.close();

    return {
      width,
      height,
      rgb: new Uint8Array(0),
      bits: 8,
      colors: 4,
      metadata,
      blob,
      objectUrl: URL.createObjectURL(blob),
    };
  }

  const canvas = document.createElement("canvas");
  canvas.width = bitmap.width;
  canvas.height = bitmap.height;
  const context = canvas.getContext("2d");
  if (!context) {
    bitmap.close();
    throw new Error("Could not create canvas context");
  }
  context.drawImage(bitmap, 0, 0);
  bitmap.close();

  const imageData = context.getImageData(0, 0, canvas.width, canvas.height);
  const outputBlob = await new Promise<Blob>((resolve, reject) => {
    canvas.toBlob((result) => {
      if (!result) {
        reject(new Error("Failed to encode standard image"));
        return;
      }
      resolve(result);
    }, "image/jpeg", 0.92);
  });

  return {
    width: canvas.width,
    height: canvas.height,
    rgb: imageData.data,
    bits: 8,
    colors: 4,
    metadata,
    blob: outputBlob,
    objectUrl: URL.createObjectURL(outputBlob),
  };
}

async function resizeBlob(blob: Blob, maxEdge: number): Promise<Blob> {
  const bitmap = await createImageBitmap(blob);
  const scale = Math.min(1, maxEdge / Math.max(bitmap.width, bitmap.height));
  const width = Math.max(1, Math.round(bitmap.width * scale));
  const height = Math.max(1, Math.round(bitmap.height * scale));

  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  const context = canvas.getContext("2d");
  if (!context) {
    bitmap.close();
    throw new Error("Could not create canvas context");
  }

  context.drawImage(bitmap, 0, 0, width, height);
  bitmap.close();

  return new Promise((resolve, reject) => {
    canvas.toBlob((result) => {
      if (!result) {
        reject(new Error("Failed to resize image"));
        return;
      }
      resolve(result);
    }, "image/jpeg", 0.9);
  });
}

export const standardImageProfile: ImageProfile = {
  id: "standard",
  extensions: STANDARD_EXTENSIONS,
  detect: (file) =>
    STANDARD_EXTENSIONS.some((extension) =>
      file.name.toLowerCase().endsWith(extension),
    ),
  decode: async (input, options?: DecodeOptions): Promise<DecodedImage> => {
    const mimeType = detectMimeType(input);
    let blob = new Blob([input as BlobPart], { type: mimeType });

    if (options?.thumbnail && options.maxEdge) {
      blob = await resizeBlob(blob, options.maxEdge);
    }

    return blobToDecodedImage(
      blob,
      {
        format: mimeType,
        source: "standard",
      },
      Boolean(options?.thumbnail),
    );
  },
};

function detectMimeType(input: Uint8Array): string {
  if (input[0] === 0xff && input[1] === 0xd8) {
    return "image/jpeg";
  }
  if (
    input[0] === 0x89 &&
    input[1] === 0x50 &&
    input[2] === 0x4e &&
    input[3] === 0x47
  ) {
    return "image/png";
  }
  if (
    input[0] === 0x52 &&
    input[1] === 0x49 &&
    input[2] === 0x46 &&
    input[3] === 0x46
  ) {
    return "image/webp";
  }
  return "application/octet-stream";
}
