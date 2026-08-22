import type { DevelopImage } from "@/lib/cache/develop-image-cache";

const MAX_ANALYSIS_EDGE = 240;
const MAX_AUTO_ANGLE = 15;
const BIN_SIZE = 0.25;

function orientToStored(x: number, y: number, orientation: number) {
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

function foldLineAngle(angle: number): number {
  let folded = angle;
  while (folded > 45) folded -= 90;
  while (folded < -45) folded += 90;
  return folded;
}

function sampleLuminance(
  image: Pick<DevelopImage, "rgb" | "colors" | "sourceWidth" | "sourceHeight" | "orientation">,
  x: number,
  y: number,
): number {
  const oriented = orientToStored(x, y, image.orientation);
  const sourceX = Math.max(
    0,
    Math.min(image.sourceWidth - 1, Math.round(oriented.x * (image.sourceWidth - 1))),
  );
  const sourceY = Math.max(
    0,
    Math.min(image.sourceHeight - 1, Math.round(oriented.y * (image.sourceHeight - 1))),
  );
  const index = (sourceY * image.sourceWidth + sourceX) * image.colors;
  if (image.colors < 3) {
    return image.rgb[index] ?? 0;
  }
  return (
    (image.rgb[index] ?? 0) * 0.2126 +
    (image.rgb[index + 1] ?? 0) * 0.7152 +
    (image.rgb[index + 2] ?? 0) * 0.0722
  );
}

export function estimateStraightenAngle(
  image: Pick<
    DevelopImage,
    "rgb" | "colors" | "width" | "height" | "sourceWidth" | "sourceHeight" | "orientation"
  >,
): number {
  if (
    image.width < 3 ||
    image.height < 3 ||
    image.sourceWidth < 1 ||
    image.sourceHeight < 1 ||
    image.colors < 1
  ) {
    return 0;
  }

  const scale = Math.min(1, MAX_ANALYSIS_EDGE / Math.max(image.width, image.height));
  const width = Math.max(3, Math.round(image.width * scale));
  const height = Math.max(3, Math.round(image.height * scale));
  const luminance = new Float32Array(width * height);

  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      luminance[y * width + x] = sampleLuminance(
        image,
        x / (width - 1),
        y / (height - 1),
      );
    }
  }

  function projectionScore(angleDegrees: number, horizontal: boolean): number {
    const slope = Math.tan(angleDegrees * Math.PI / 180);
    const lineCount = horizontal ? height : width;
    const sampleCount = horizontal ? width : height;
    const sampleCenter = (sampleCount - 1) / 2;
    const margin = Math.ceil(Math.abs(slope) * sampleCenter) + 1;
    let previousAverage: number | null = null;
    let score = 0;
    let differences = 0;

    for (let line = margin; line < lineCount - margin; line += 1) {
      let sum = 0;
      for (let sample = 0; sample < sampleCount; sample += 1) {
        const offset = slope * (sample - sampleCenter);
        const x = horizontal ? sample : Math.round(line - offset);
        const y = horizontal ? Math.round(line + offset) : sample;
        sum += luminance[y * width + x];
      }
      const average = sum / sampleCount;
      if (previousAverage !== null) {
        const difference = average - previousAverage;
        score += difference * difference;
        differences += 1;
      }
      previousAverage = average;
    }

    return differences > 0 ? score / differences : 0;
  }

  const scores: number[] = [];
  let bestAngle = 0;
  let bestScore = 0;
  for (
    let angle = -MAX_AUTO_ANGLE;
    angle <= MAX_AUTO_ANGLE + Number.EPSILON;
    angle += BIN_SIZE
  ) {
    const score = Math.max(
      projectionScore(angle, true),
      projectionScore(angle, false),
    );
    scores.push(score);
    if (score > bestScore) {
      bestScore = score;
      bestAngle = angle;
    }
  }

  const averageScore = scores.reduce((sum, score) => sum + score, 0) / scores.length;
  if (bestScore === 0 || bestScore < averageScore * 1.08) return 0;

  return Math.round(-foldLineAngle(bestAngle) * 10) / 10;
}
