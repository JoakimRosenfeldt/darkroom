import type {
  AiInferenceSourceImage,
  AiInferenceSourcePixels,
  PreparedAiImage,
} from "@/lib/ai/worker-types";

const MAX_INFERENCE_EDGE = 2_048;

function invalidImage(message: string): never {
  throw new Error(`AI source image is invalid: ${message}`);
}

function positiveInteger(value: number, label: string): number {
  return Number.isInteger(value) && value > 0
    ? value
    : invalidImage(`${label} must be a positive integer.`);
}

function sourceCoordinates(
  x: number,
  y: number,
  orientation: number,
): { x: number; y: number } {
  switch (orientation) {
    case 2:
      return { x: 1 - x, y };
    case 3:
      return { x: 1 - x, y: 1 - y };
    case 4:
      return { x, y: 1 - y };
    case 5:
      return { x: y, y: x };
    case 6:
      return { x: y, y: 1 - x };
    case 7:
      return { x: 1 - y, y: 1 - x };
    case 8:
      return { x: 1 - y, y: x };
    default:
      return { x, y };
  }
}

function toByte(value: number, bits: number): number {
  if (bits > 8) {
    return Math.max(0, Math.min(255, Math.round(value * 255 / 65_535)));
  }
  return Math.max(0, Math.min(255, Math.round(value)));
}

function readPixel(
  pixels: AiInferenceSourcePixels,
  index: number,
  channel: number,
  channels: number,
  bits: number,
): number {
  return toByte(pixels[index * channels + channel] ?? 0, bits);
}

function sampleChannel(
  pixels: AiInferenceSourcePixels,
  sourceWidth: number,
  sourceHeight: number,
  channels: number,
  bits: number,
  x: number,
  y: number,
  orientation: number,
  channel: number,
): number {
  const oriented = sourceCoordinates(x, y, orientation);
  const sourceX = Math.max(0, Math.min(sourceWidth - 1, oriented.x * sourceWidth - 0.5));
  const sourceY = Math.max(0, Math.min(sourceHeight - 1, oriented.y * sourceHeight - 0.5));
  const x0 = Math.floor(sourceX);
  const y0 = Math.floor(sourceY);
  const x1 = Math.min(sourceWidth - 1, x0 + 1);
  const y1 = Math.min(sourceHeight - 1, y0 + 1);
  const xWeight = sourceX - x0;
  const yWeight = sourceY - y0;
  const topLeft = readPixel(pixels, y0 * sourceWidth + x0, channel, channels, bits);
  const topRight = readPixel(pixels, y0 * sourceWidth + x1, channel, channels, bits);
  const bottomLeft = readPixel(pixels, y1 * sourceWidth + x0, channel, channels, bits);
  const bottomRight = readPixel(pixels, y1 * sourceWidth + x1, channel, channels, bits);
  const top = topLeft * (1 - xWeight) + topRight * xWeight;
  const bottom = bottomLeft * (1 - xWeight) + bottomRight * xWeight;
  return top * (1 - yWeight) + bottom * yWeight;
}

export function prepareAiInferenceImage(
  image: AiInferenceSourceImage,
  checkCancelled: () => void,
): PreparedAiImage {
  const pixels = image.pixels;
  const sourceWidth = image.sourceWidth;
  const sourceHeight = image.sourceHeight;
  const orientation = image.orientation;
  const channels = image.colors;
  const bits = image.bits;

  positiveInteger(sourceWidth, "source width");
  positiveInteger(sourceHeight, "source height");
  positiveInteger(image.width, "oriented width");
  positiveInteger(image.height, "oriented height");
  if (!Number.isInteger(orientation) || orientation < 1 || orientation > 8) {
    invalidImage("orientation must be between 1 and 8.");
  }
  if (!Number.isInteger(channels) || channels < 3 || channels > 4) {
    invalidImage("only RGB and RGBA pixels are supported.");
  }
  if (bits !== 8 && bits !== 16) {
    invalidImage("only 8-bit and 16-bit pixels are supported.");
  }
  const expectedLength = sourceWidth * sourceHeight * channels;
  if (!Number.isSafeInteger(expectedLength) || pixels.length !== expectedLength) {
    invalidImage("pixel data does not match its declared dimensions.");
  }

  const rotated = orientation >= 5;
  const orientedWidth = rotated ? sourceHeight : sourceWidth;
  const orientedHeight = rotated ? sourceWidth : sourceHeight;
  if (image.width !== orientedWidth || image.height !== orientedHeight) {
    invalidImage("oriented dimensions do not match the source orientation.");
  }

  const scale = Math.min(1, MAX_INFERENCE_EDGE / Math.max(orientedWidth, orientedHeight));
  const width = Math.max(1, Math.round(orientedWidth * scale));
  const height = Math.max(1, Math.round(orientedHeight * scale));
  const rgb = new Uint8Array(width * height * 3);

  for (let y = 0; y < height; y += 1) {
    if (y % 16 === 0) {
      checkCancelled();
    }
    const orientedY = (y + 0.5) / height;
    for (let x = 0; x < width; x += 1) {
      const orientedX = (x + 0.5) / width;
      const target = (y * width + x) * 3;
      rgb[target] = Math.round(sampleChannel(
        pixels,
        sourceWidth,
        sourceHeight,
        channels,
        bits,
        orientedX,
        orientedY,
        orientation,
        0,
      ));
      rgb[target + 1] = Math.round(sampleChannel(
        pixels,
        sourceWidth,
        sourceHeight,
        channels,
        bits,
        orientedX,
        orientedY,
        orientation,
        1,
      ));
      rgb[target + 2] = Math.round(sampleChannel(
        pixels,
        sourceWidth,
        sourceHeight,
        channels,
        bits,
        orientedX,
        orientedY,
        orientation,
        2,
      ));
    }
  }

  return { width, height, rgb: rgb.buffer };
}
