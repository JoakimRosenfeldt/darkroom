import assert from "node:assert/strict";
import test from "node:test";
import { orientedImageSize, rgbDataToBlob } from "../lib/raw/utils.ts";

test("embedded RAW dimensions follow their orientation", () => {
  assert.deepEqual(orientedImageSize(6000, 4000, 0), {
    width: 6000,
    height: 4000,
  });
  assert.deepEqual(orientedImageSize(6000, 4000, 5), {
    width: 4000,
    height: 6000,
  });
});

test("RAW preview pixels are capped before their single JPEG encode", async () => {
  const canvases: Array<{
    width: number;
    height: number;
    encodes: number;
    pixels: number[];
  }> = [];
  const originalDocument = Object.getOwnPropertyDescriptor(globalThis, "document");

  Object.defineProperty(globalThis, "document", {
    configurable: true,
    value: {
      createElement: () => {
        const canvas = {
          width: 0,
          height: 0,
          encodes: 0,
          pixels: [] as number[],
          getContext: () => ({
            createImageData: (width: number, height: number) => ({
              data: new Uint8ClampedArray(width * height * 4),
            }),
            putImageData: (imageData: { data: Uint8ClampedArray }) => {
              canvas.pixels = Array.from(imageData.data);
            },
          }),
          toBlob: (callback: (blob: Blob) => void) => {
            canvas.encodes += 1;
            callback(new Blob());
          },
        };
        canvases.push(canvas);
        return canvas;
      },
    },
  });

  try {
    await rgbDataToBlob(Uint8Array.from({ length: 4 * 2 * 3 }, (_, index) => index), 4, 2, 8, 2);
  } finally {
    if (originalDocument) {
      Object.defineProperty(globalThis, "document", originalDocument);
    } else {
      delete (globalThis as { document?: unknown }).document;
    }
  }

  assert.deepEqual(
    canvases.map(({ width, height, encodes }) => ({ width, height, encodes })),
    [{ width: 2, height: 1, encodes: 1 }],
  );
  assert.deepEqual(canvases[0].pixels, [8, 9, 10, 255, 14, 15, 16, 255]);
});
