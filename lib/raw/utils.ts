export function rgbDataToBlob(
  data: Uint8Array | Uint16Array,
  width: number,
  height: number,
  bits: number,
  maxEdge?: number,
): Promise<Blob> {
  const scale = maxEdge
    ? Math.min(1, maxEdge / Math.max(width, height))
    : 1;
  const outputWidth = Math.max(1, Math.round(width * scale));
  const outputHeight = Math.max(1, Math.round(height * scale));
  const canvas = document.createElement("canvas");
  canvas.width = outputWidth;
  canvas.height = outputHeight;
  const context = canvas.getContext("2d");
  if (!context) {
    throw new Error("Could not create canvas context");
  }

  const imageData = context.createImageData(outputWidth, outputHeight);
  const pixels = imageData.data;
  const source = bits === 8 && data instanceof Uint8Array
    ? data
    : data instanceof Uint16Array
      ? data
      : new Uint16Array(data.buffer, data.byteOffset, data.byteLength / 2);
  const sourceMax = source instanceof Uint16Array ? 65_535 : 255;
  const channels = source.length / (width * height);
  const copiedChannels = channels === 4 ? 4 : 3;

  for (let y = 0; y < outputHeight; y += 1) {
    const sourceY = Math.max(0, (y + 0.5) * height / outputHeight - 0.5);
    const y0 = Math.floor(sourceY);
    const y1 = Math.min(height - 1, y0 + 1);
    const yWeight = sourceY - y0;
    for (let x = 0; x < outputWidth; x += 1) {
      const sourceX = Math.max(0, (x + 0.5) * width / outputWidth - 0.5);
      const x0 = Math.floor(sourceX);
      const x1 = Math.min(width - 1, x0 + 1);
      const xWeight = sourceX - x0;
      const topLeft = (y0 * width + x0) * channels;
      const topRight = (y0 * width + x1) * channels;
      const bottomLeft = (y1 * width + x0) * channels;
      const bottomRight = (y1 * width + x1) * channels;
      const target = (y * outputWidth + x) * 4;

      for (let channel = 0; channel < copiedChannels; channel += 1) {
        const top = source[topLeft + channel] * (1 - xWeight) +
          source[topRight + channel] * xWeight;
        const bottom = source[bottomLeft + channel] * (1 - xWeight) +
          source[bottomRight + channel] * xWeight;
        pixels[target + channel] = Math.round(
          ((top * (1 - yWeight) + bottom * yWeight) / sourceMax) * 255,
        );
      }
      if (copiedChannels === 3) pixels[target + 3] = 255;
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

export function orientedImageSize(
  width: number,
  height: number,
  flip: number,
): { width: number; height: number } {
  return flip === 5 || flip === 6
    ? { width: height, height: width }
    : { width, height };
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
