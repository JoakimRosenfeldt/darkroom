export function rgbDataToBlob(
  data: Uint8Array | Uint16Array,
  width: number,
  height: number,
  bits: number,
): Promise<Blob> {
  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  const context = canvas.getContext("2d");
  if (!context) {
    throw new Error("Could not create canvas context");
  }

  const imageData = context.createImageData(width, height);
  const pixels = imageData.data;

  if (bits === 8 && data instanceof Uint8Array) {
    const channels = data.length / (width * height);
    if (channels === 3) {
      for (let i = 0, j = 0; i < data.length; i += 3, j += 4) {
        pixels[j] = data[i];
        pixels[j + 1] = data[i + 1];
        pixels[j + 2] = data[i + 2];
        pixels[j + 3] = 255;
      }
    } else {
      pixels.set(data.subarray(0, pixels.length));
    }
  } else {
    const source = data instanceof Uint16Array ? data : new Uint16Array(data.buffer);
    const channels = source.length / (width * height);
    const max = 65535;

    for (let i = 0, j = 0; i < source.length; i += channels, j += 4) {
      pixels[j] = Math.round((source[i] / max) * 255);
      pixels[j + 1] = Math.round((source[i + 1] / max) * 255);
      pixels[j + 2] = Math.round((source[i + 2] / max) * 255);
      pixels[j + 3] = 255;
    }
  }

  context.putImageData(imageData, 0, 0);
  return new Promise((resolve, reject) => {
    canvas.toBlob((blob) => {
      if (!blob) {
        reject(new Error("Failed to encode image"));
        return;
      }
      resolve(blob);
    }, "image/jpeg", 0.92);
  });
}

export function formatMetadataValue(value: unknown): string {
  if (value === null || value === undefined) {
    return "—";
  }
  if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") {
    return String(value);
  }
  if (value instanceof Date) {
    return value.toLocaleString();
  }
  return JSON.stringify(value, null, 2);
}
