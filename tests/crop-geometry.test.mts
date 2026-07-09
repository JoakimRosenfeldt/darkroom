import assert from "node:assert/strict";
import test from "node:test";
import {
  applyCropDrag,
  fitCropToAspectRatio,
  parseAspectRatioInput,
} from "../lib/develop/crop-geometry.ts";

test("crop drags stay inside the source image", () => {
  const crop = applyCropDrag(
    { x: 0.7, y: 0.7, width: 0.25, height: 0.25 },
    "se",
    1,
    1,
    null,
  );

  assert.equal(crop.x + crop.width, 1);
  assert.equal(crop.y + crop.height, 1);
});

test("locked crops retain their selected aspect ratio", () => {
  const crop = fitCropToAspectRatio(
    { x: 0.1, y: 0.1, width: 0.6, height: 0.4 },
    16 / 9,
  );

  assert.ok(Math.abs(crop.width / crop.height - 16 / 9) < 0.000001);
});

test("custom aspect ratios reject invalid input", () => {
  assert.equal(parseAspectRatioInput("0", "4"), null);
  assert.equal(parseAspectRatioInput("4", "nope"), null);
  assert.equal(parseAspectRatioInput("4", "3"), 4 / 3);
});
