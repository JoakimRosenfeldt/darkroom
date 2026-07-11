import assert from "node:assert/strict";
import test from "node:test";
import {
  applyCropDrag,
  fitCropToAspectRatio,
  MIN_CROP_SIZE,
  parseAspectRatioInput,
  resolveAspectRatio,
  type CropHandle,
  type CropRect,
} from "../lib/develop/crop-geometry.ts";

const EPSILON = 0.000001;
const HANDLES: CropHandle[] = ["move", "n", "s", "e", "w", "ne", "nw", "se", "sw"];
const EXTREME_DELTAS = [[-2, -2], [2, 2], [0, -2], [0, 2]] as const;

function assertValidCrop(crop: CropRect) {
  assert.ok(crop.x >= -EPSILON);
  assert.ok(crop.y >= -EPSILON);
  assert.ok(crop.x + crop.width <= 1 + EPSILON);
  assert.ok(crop.y + crop.height <= 1 + EPSILON);
  assert.ok(crop.width >= MIN_CROP_SIZE - EPSILON);
  assert.ok(crop.height >= MIN_CROP_SIZE - EPSILON);
}

test("every crop handle stays inside the image and above the minimum size", () => {
  const start = { x: 0.25, y: 0.25, width: 0.5, height: 0.5 };

  for (const handle of HANDLES) {
    for (const [deltaX, deltaY] of EXTREME_DELTAS) {
      assertValidCrop(applyCropDrag(start, handle, deltaX, deltaY, null));
    }
  }
});

test("locked edge and corner drags retain their normalized ratio", () => {
  const ratio = 4 / 3;
  const start = { x: 0.2, y: 0.275, width: 0.6, height: 0.45 };

  for (const handle of HANDLES) {
    for (const [deltaX, deltaY] of EXTREME_DELTAS) {
      const crop = applyCropDrag(start, handle, deltaX, deltaY, ratio);
      assertValidCrop(crop);
      assert.ok(Math.abs(crop.width / crop.height - ratio) < EPSILON);
    }
  }
});

test("fitting a crop retains its ratio while shifting it inside the image", () => {
  const crop = fitCropToAspectRatio(
    { x: 0.8, y: 0.8, width: 0.2, height: 0.2 },
    16 / 9,
  );

  assertValidCrop(crop);
  assert.ok(Math.abs(crop.width / crop.height - 16 / 9) < EPSILON);
});

test("pixel aspect ratios are converted to normalized crop coordinates", () => {
  const preset = resolveAspectRatio("16:9", 4000, 3000, 1, 1);
  const original = resolveAspectRatio("original", 4000, 3000, 1, 1);
  const custom = resolveAspectRatio("custom", 2000, 3000, 3, 2);

  assert.ok(preset !== null);
  assert.ok(custom !== null);
  assert.ok(Math.abs(preset * 4000 / 3000 - 16 / 9) < EPSILON);
  assert.equal(original, 1);
  assert.ok(Math.abs(custom * 2000 / 3000 - 3 / 2) < EPSILON);
});

test("custom aspect ratios reject invalid input", () => {
  assert.equal(parseAspectRatioInput("0", "4"), null);
  assert.equal(parseAspectRatioInput("4", "nope"), null);
  assert.equal(parseAspectRatioInput("4", "3"), 4 / 3);
});
