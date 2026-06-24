export interface ImageDimensions {
  width: number;
  height: number;
}

function readUint16BE(bytes: Uint8Array, offset: number): number {
  return (bytes[offset] << 8) | bytes[offset + 1];
}

function readUint32BE(bytes: Uint8Array, offset: number): number {
  return (
    (bytes[offset] << 24) |
    (bytes[offset + 1] << 16) |
    (bytes[offset + 2] << 8) |
    bytes[offset + 3]
  );
}

function parsePngDimensions(bytes: Uint8Array): ImageDimensions | null {
  if (
    bytes.length < 24 ||
    bytes[0] !== 0x89 ||
    bytes[1] !== 0x50 ||
    bytes[2] !== 0x4e ||
    bytes[3] !== 0x47
  ) {
    return null;
  }

  const width = readUint32BE(bytes, 16);
  const height = readUint32BE(bytes, 20);
  if (width <= 0 || height <= 0) {
    return null;
  }

  return { width, height };
}

function parseJpegDimensions(bytes: Uint8Array): ImageDimensions | null {
  if (bytes.length < 4 || bytes[0] !== 0xff || bytes[1] !== 0xd8) {
    return null;
  }

  let offset = 2;
  while (offset + 9 < bytes.length) {
    if (bytes[offset] !== 0xff) {
      offset += 1;
      continue;
    }

    while (bytes[offset] === 0xff) {
      offset += 1;
    }

    const marker = bytes[offset];
    offset += 1;

    if (marker === 0xd8 || marker === 0xd9) {
      continue;
    }

    if (offset + 1 >= bytes.length) {
      break;
    }

    const segmentLength = readUint16BE(bytes, offset);
    if (segmentLength < 2 || offset + segmentLength > bytes.length) {
      break;
    }

    const isStartOfFrame =
      marker === 0xc0 ||
      marker === 0xc1 ||
      marker === 0xc2 ||
      marker === 0xc3 ||
      marker === 0xc5 ||
      marker === 0xc6 ||
      marker === 0xc7 ||
      marker === 0xc9 ||
      marker === 0xca ||
      marker === 0xcb ||
      marker === 0xcd ||
      marker === 0xce ||
      marker === 0xcf;

    if (isStartOfFrame && offset + 7 <= bytes.length) {
      const height = readUint16BE(bytes, offset + 3);
      const width = readUint16BE(bytes, offset + 5);
      if (width > 0 && height > 0) {
        return { width, height };
      }
    }

    offset += segmentLength;
  }

  return null;
}

function parseWebpDimensions(bytes: Uint8Array): ImageDimensions | null {
  if (
    bytes.length < 30 ||
    bytes[0] !== 0x52 ||
    bytes[1] !== 0x49 ||
    bytes[2] !== 0x46 ||
    bytes[3] !== 0x46 ||
    bytes[8] !== 0x57 ||
    bytes[9] !== 0x45 ||
    bytes[10] !== 0x42 ||
    bytes[11] !== 0x50
  ) {
    return null;
  }

  const chunk = String.fromCharCode(bytes[12], bytes[13], bytes[14], bytes[15]);

  if (chunk === "VP8X" && bytes.length >= 30) {
    const width = 1 + (bytes[24] | (bytes[25] << 8) | (bytes[26] << 16));
    const height = 1 + (bytes[27] | (bytes[28] << 8) | (bytes[29] << 16));
    if (width > 0 && height > 0) {
      return { width, height };
    }
  }

  if (chunk === "VP8 " && bytes.length >= 30) {
    const width = bytes[26] | (bytes[27] << 8);
    const height = bytes[28] | (bytes[29] << 8);
    if (width > 0 && height > 0) {
      return { width, height };
    }
  }

  if (chunk === "VP8L" && bytes.length >= 25) {
    const bits =
      bytes[21] | (bytes[22] << 8) | (bytes[23] << 16) | (bytes[24] << 24);
    const width = (bits & 0x3fff) + 1;
    const height = ((bits >> 14) & 0x3fff) + 1;
    if (width > 0 && height > 0) {
      return { width, height };
    }
  }

  return null;
}

export function parseImageDimensions(
  name: string,
  bytes: Uint8Array,
): ImageDimensions | null {
  const lower = name.toLowerCase();

  if (lower.endsWith(".png")) {
    return parsePngDimensions(bytes);
  }

  if (lower.endsWith(".webp")) {
    return parseWebpDimensions(bytes);
  }

  if (lower.endsWith(".jpg") || lower.endsWith(".jpeg")) {
    return parseJpegDimensions(bytes);
  }

  return null;
}
