export interface ImageDimensions {
  width: number;
  height: number;
}

function readUint16BE(bytes: Uint8Array, offset: number): number {
  return (bytes[offset] << 8) | bytes[offset + 1];
}

function jpegOrientation(bytes: Uint8Array, start: number, end: number): number {
  if (end - start < 14 ||
    bytes[start] !== 0x45 || bytes[start + 1] !== 0x78 ||
    bytes[start + 2] !== 0x69 || bytes[start + 3] !== 0x66 ||
    bytes[start + 4] !== 0 || bytes[start + 5] !== 0) return 1;

  const tiff = start + 6;
  const little = bytes[tiff] === 0x49 && bytes[tiff + 1] === 0x49;
  const big = bytes[tiff] === 0x4d && bytes[tiff + 1] === 0x4d;
  if (!little && !big) return 1;
  const read16 = (offset: number) => little
    ? bytes[offset] | (bytes[offset + 1] << 8)
    : readUint16BE(bytes, offset);
  const read32 = (offset: number) => little
    ? (bytes[offset] | (bytes[offset + 1] << 8) | (bytes[offset + 2] << 16) | (bytes[offset + 3] << 24)) >>> 0
    : readUint32BE(bytes, offset) >>> 0;
  if (read16(tiff + 2) !== 42) return 1;
  const ifd = tiff + read32(tiff + 4);
  if (ifd + 2 > end) return 1;
  const count = read16(ifd);
  for (let index = 0; index < count && ifd + 2 + (index + 1) * 12 <= end; index += 1) {
    const field = ifd + 2 + index * 12;
    if (read16(field) === 0x0112 && read16(field + 2) === 3 && read32(field + 4) === 1) {
      return read16(field + 8);
    }
  }
  return 1;
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
  let orientation = 1;
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

    if (marker === 0xe1 && orientation === 1) {
      orientation = jpegOrientation(bytes, offset + 2, offset + segmentLength);
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
        return orientation >= 5 && orientation <= 8
          ? { width: height, height: width }
          : { width, height };
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
