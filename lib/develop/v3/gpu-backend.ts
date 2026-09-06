import {
  analyzeV3DisplayOutput,
  analyzeV3SceneHeadroom,
  analyzeV3ToneInput,
  activeStageHalo,
  prepareV3CpuRender,
  type CpuAnalysisTapResult,
  type CpuPointColorInput,
  type CpuRenderInput,
  type CpuRenderResult,
  type RenderRegion,
} from "@/lib/develop/v3/cpu-backend";
import type { DevelopDocumentV3 } from "@/lib/develop/v3/document";
import {
  IDENTITY_HOMOGRAPHY,
  geometryCacheIdentity,
  mapOutputToStored,
  resolveConstrainedCrop,
  type CanonicalGeometry,
} from "@/lib/develop/v3/geometry";
import {
  NEUTRAL_LENS_CALIBRATION,
  mapDistortedUv,
  type LensCalibration,
} from "@/lib/develop/v3/optics";
import {
  accumulateLocalAdjustments,
  localAdjustmentsAreNeutral,
} from "@/lib/develop/v3/local-adjustments";
import {
  manualMaskCoverage,
  pointInLocalGeometryFrame,
} from "@/lib/develop/v3/manual-edits";
import { maskSourceNodes } from "@/lib/develop/v3/masking";
import { NEUTRAL_MONOCHROME_PROFILE } from "@/lib/develop/v3/monochrome";
import {
  boundedPointColorSettings,
  MAX_POINT_COLOR_SAMPLES,
} from "@/lib/develop/v3/point-color";
import { effectiveInputCalibration } from "@/lib/develop/v3/profiles";

const CURVE_LUT_SIZE = 1_024;
const MAX_CACHED_GEOMETRY_MAPS = 3;
const MAX_CACHED_TARGETS = 3;
const MAX_CACHED_LOCAL_ADJUSTMENTS = 2;
const GPU_TILE_EDGE = 512;
const REFINED_PREVIEW_MAX_PIXELS = 64_000;
const MIXER_BANDS = [
  { id: "red", center: 0 },
  { id: "orange", center: 30 },
  { id: "yellow", center: 60 },
  { id: "green", center: 120 },
  { id: "aqua", center: 180 },
  { id: "blue", center: 240 },
  { id: "purple", center: 270 },
  { id: "magenta", center: 300 },
] as const;
const MONOCHROME_CHANNELS = [
  "red",
  "orange",
  "yellow",
  "green",
  "aqua",
  "blue",
  "purple",
  "magenta",
] as const;
const VERTEX_SHADER = `#version 300 es
precision highp float;
out vec2 vUv;
void main() {
  vec2 position = gl_VertexID == 0 ? vec2(-1.0, -1.0) :
    gl_VertexID == 1 ? vec2(3.0, -1.0) : vec2(-1.0, 3.0);
  vUv = position * 0.5 + 0.5;
  gl_Position = vec4(position, 0.0, 1.0);
}`;
const POINTWISE_SHADER = `#version 300 es
precision highp float;
#ifdef INTEGER_SOURCE
precision highp usampler2D;
uniform highp usampler2D uSource;
#else
precision highp sampler2D;
uniform sampler2D uSource;
#endif
uniform sampler2D uMap;
uniform sampler2D uCurves;
uniform ivec2 uOutputSize;
uniform int uTransfer;
uniform float uSourceMaximum;
uniform vec2 uSourceSize;
uniform float uCurvesIdentity;
uniform vec3 uWhiteBalance;
uniform vec3 uChannelScale;
uniform mat3 uCalibration;
uniform float uCalibrationExposure;
uniform float uExposure;
uniform float uContrast;
uniform float uHighlights;
uniform float uShadows;
uniform float uWhites;
uniform float uBlacks;
uniform float uVibrance;
uniform float uSaturation;
uniform float uDenoiseLuminance;
uniform float uDenoiseDetail;
uniform float uDenoiseContrast;
uniform float uDenoiseColor;
uniform float uDenoiseColorDetail;
uniform float uDenoiseColorSmoothness;
uniform sampler2D uLocalAdjustments;
uniform float uLocalEnabled;
uniform int uPointColorCount;
uniform float uPointColorEnabled[${MAX_POINT_COLOR_SAMPLES}];
uniform float uPointColorHue[${MAX_POINT_COLOR_SAMPLES}];
uniform float uPointColorSaturation[${MAX_POINT_COLOR_SAMPLES}];
uniform float uPointColorLuminance[${MAX_POINT_COLOR_SAMPLES}];
uniform float uPointColorHueRange[${MAX_POINT_COLOR_SAMPLES}];
uniform float uPointColorSaturationRange[${MAX_POINT_COLOR_SAMPLES}];
uniform float uPointColorLuminanceRange[${MAX_POINT_COLOR_SAMPLES}];
uniform float uPointColorFalloff[${MAX_POINT_COLOR_SAMPLES}];
uniform float uPointColorHueShift[${MAX_POINT_COLOR_SAMPLES}];
uniform float uPointColorSaturationShift[${MAX_POINT_COLOR_SAMPLES}];
uniform float uPointColorLuminanceShift[${MAX_POINT_COLOR_SAMPLES}];
uniform float uMixerHue[8];
uniform float uMixerSaturation[8];
uniform float uMixerLuminance[8];
uniform float uMixerEnabled;
uniform float uMonochromeEnabled;
uniform float uMonochromeMixer[8];
uniform float uGradingShadowsHue;
uniform float uGradingShadowsSaturation;
uniform float uGradingShadowsLuminance;
uniform float uGradingMidtonesHue;
uniform float uGradingMidtonesSaturation;
uniform float uGradingMidtonesLuminance;
uniform float uGradingHighlightsHue;
uniform float uGradingHighlightsSaturation;
uniform float uGradingHighlightsLuminance;
uniform float uGradingBalance;
uniform float uGradingBlending;
layout(location = 0) out vec4 outColor;
layout(location = 1) out vec4 outToneInput;
layout(location = 2) out vec4 outPointColorInput;

float luminance(vec3 color) {
  return dot(color, vec3(0.2126, 0.7152, 0.0722));
}

float boundedSmoothstep(float minimum, float maximum, float value) {
  if (minimum == maximum) return value < minimum ? 0.0 : 1.0;
  float position = clamp((value - minimum) / (maximum - minimum), 0.0, 1.0);
  return position * position * (3.0 - 2.0 * position);
}

float decodeSrgb(float value) {
  float bounded = clamp(value, 0.0, 1.0);
  return bounded <= 0.04045
    ? bounded / 12.92
    : pow((bounded + 0.055) / 1.055, 2.4);
}

vec3 decodedSourceTexel(ivec2 pixel) {
#ifdef INTEGER_SOURCE
  vec3 decoded = vec3(texelFetch(uSource, pixel, 0).rgb) / uSourceMaximum;
#else
  vec3 decoded = texelFetch(uSource, pixel, 0).rgb;
#endif
  if (uTransfer == 0) {
    decoded = vec3(
      decodeSrgb(decoded.r),
      decodeSrgb(decoded.g),
      decodeSrgb(decoded.b)
    );
  }
  return decoded;
}

vec3 sourceColor(vec2 uv) {
  ivec2 size = textureSize(uSource, 0);
  vec2 coordinate = clamp(
    uv * vec2(size) - 0.5,
    vec2(0.0),
    vec2(size - 1)
  );
  ivec2 low = ivec2(floor(coordinate));
  ivec2 high = min(low + 1, size - 1);
  vec2 fraction = coordinate - vec2(low);
  vec3 top = mix(
    decodedSourceTexel(ivec2(low.x, low.y)),
    decodedSourceTexel(ivec2(high.x, low.y)),
    fraction.x
  );
  vec3 bottom = mix(
    decodedSourceTexel(ivec2(low.x, high.y)),
    decodedSourceTexel(ivec2(high.x, high.y)),
    fraction.x
  );
  vec3 decoded = mix(top, bottom, fraction.y);
  vec3 balanced = decoded * uWhiteBalance * uChannelScale;
  return clamp(uCalibration * balanced * uCalibrationExposure, vec3(-16.0), vec3(16.0));
}

vec3 basicTone(vec3 color) {
  color *= exp2(clamp(uExposure, -10.0, 10.0));
  float sourceLuminance = luminance(color);
  float shadowMask = boundedSmoothstep(0.7, 0.0, sourceLuminance);
  float highlightMask = boundedSmoothstep(0.35, 1.0, sourceLuminance);
  float sharedAdjustment = shadowMask * uShadows * 0.0015 +
    highlightMask * uHighlights * 0.0012 +
    boundedSmoothstep(0.72, 1.0, sourceLuminance) * uWhites * 0.0012 +
    boundedSmoothstep(0.25, 0.0, sourceLuminance) * uBlacks * 0.0012;
  float contrast = 1.0 + clamp(uContrast, -100.0, 100.0) * 0.0035;
  color = (color + sharedAdjustment - 0.5) * contrast + 0.5;
  if (uSaturation != 0.0) {
    float gray = luminance(color);
    color = vec3(gray) + (color - gray) * max(0.0, 1.0 + uSaturation / 100.0);
  }
  if (uVibrance != 0.0) {
    float gray = luminance(color);
    float saturation = max(max(color.r, color.g), color.b) - min(min(color.r, color.g), color.b);
    float scale = max(0.0, 1.0 + uVibrance / 100.0 * (1.0 - clamp(saturation, 0.0, 1.0)));
    color = vec3(gray) + (color - gray) * scale;
  }
  return clamp(color, vec3(-16.0), vec3(16.0));
}

vec4 curveSample(float value) {
  float position = clamp(value, 0.0, 1.0) * float(${CURVE_LUT_SIZE - 1});
  int low = int(floor(position));
  int high = min(low + 1, ${CURVE_LUT_SIZE - 1});
  return mix(
    texelFetch(uCurves, ivec2(low, 0), 0),
    texelFetch(uCurves, ivec2(high, 0), 0),
    position - float(low)
  );
}

vec3 curves(vec3 color) {
  if (uCurvesIdentity > 0.5) return color;
  vec3 master = vec3(
    curveSample(color.r).r,
    curveSample(color.g).r,
    curveSample(color.b).r
  );
  return vec3(
    curveSample(master.r).g,
    curveSample(master.g).b,
    curveSample(master.b).a
  );
}

float wrapHue(float value) {
  return mod(mod(value, 360.0) + 360.0, 360.0);
}

float circularHueDistance(float left, float right) {
  return abs(mod(wrapHue(left) - wrapHue(right) + 540.0, 360.0) - 180.0);
}

vec3 rgbToHsl(vec3 color) {
  vec3 bounded = clamp(color, vec3(0.0), vec3(1.0));
  float maximum = max(max(bounded.r, bounded.g), bounded.b);
  float minimum = min(min(bounded.r, bounded.g), bounded.b);
  float luminance = (maximum + minimum) * 0.5;
  float delta = maximum - minimum;
  if (delta == 0.0) return vec3(0.0, 0.0, luminance);
  float saturation = delta / (1.0 - abs(2.0 * luminance - 1.0));
  float hue;
  if (maximum == bounded.r) hue = 60.0 * mod((bounded.g - bounded.b) / delta, 6.0);
  else if (maximum == bounded.g) hue = 60.0 * ((bounded.b - bounded.r) / delta + 2.0);
  else hue = 60.0 * ((bounded.r - bounded.g) / delta + 4.0);
  return vec3(wrapHue(hue), saturation, luminance);
}

vec3 hslToRgb(vec3 color) {
  float hue = wrapHue(color.x);
  float saturation = clamp(color.y, 0.0, 1.0);
  float luminance = clamp(color.z, 0.0, 1.0);
  float chroma = (1.0 - abs(2.0 * luminance - 1.0)) * saturation;
  float segment = hue / 60.0;
  float secondary = chroma * (1.0 - abs(mod(segment, 2.0) - 1.0));
  vec3 primary = vec3(0.0);
  if (segment < 1.0) primary = vec3(chroma, secondary, 0.0);
  else if (segment < 2.0) primary = vec3(secondary, chroma, 0.0);
  else if (segment < 3.0) primary = vec3(0.0, chroma, secondary);
  else if (segment < 4.0) primary = vec3(0.0, secondary, chroma);
  else if (segment < 5.0) primary = vec3(secondary, 0.0, chroma);
  else primary = vec3(chroma, 0.0, secondary);
  float offset = luminance - chroma * 0.5;
  return primary + vec3(offset);
}

float rangeWeight(float distance, float falloff) {
  float boundedDistance = clamp(distance, 0.0, 1.0);
  if (boundedDistance >= 1.0) return 0.0;
  float feather = clamp(falloff, 0.0, 1.0);
  float inner = 1.0 - feather;
  if (feather == 0.0 || boundedDistance <= inner) return 1.0;
  float position = (boundedDistance - inner) / feather;
  float smoothAmount = position * position * (3.0 - 2.0 * position);
  return 1.0 - smoothAmount;
}

vec3 applyPointColor(vec3 color) {
  if (uPointColorCount == 0) return color;
  vec3 hsl = rgbToHsl(color);
  bool changed = false;
  for (int index = 0; index < ${MAX_POINT_COLOR_SAMPLES}; index++) {
    if (index >= uPointColorCount) break;
    if (uPointColorEnabled[index] < 0.5) continue;
    float hueShift = clamp(uPointColorHueShift[index], -180.0, 180.0);
    float saturationShift = clamp(uPointColorSaturationShift[index], -1.0, 1.0);
    float luminanceShift = clamp(uPointColorLuminanceShift[index], -1.0, 1.0);
    if (hueShift == 0.0 && saturationShift == 0.0 && luminanceShift == 0.0) continue;
    float hueDistance = circularHueDistance(hsl.x, uPointColorHue[index]) /
      clamp(uPointColorHueRange[index], 1.0, 180.0);
    float saturationDistance = abs(hsl.y - clamp(uPointColorSaturation[index], 0.0, 1.0)) /
      clamp(uPointColorSaturationRange[index], 0.01, 1.0);
    float luminanceDistance = abs(hsl.z - clamp(uPointColorLuminance[index], 0.0, 1.0)) /
      clamp(uPointColorLuminanceRange[index], 0.01, 1.0);
    float weight = rangeWeight(hueDistance, uPointColorFalloff[index]) *
      rangeWeight(saturationDistance, uPointColorFalloff[index]) *
      rangeWeight(luminanceDistance, uPointColorFalloff[index]);
    if (weight == 0.0) continue;
    changed = true;
    hsl = vec3(
      wrapHue(hsl.x + hueShift * weight),
      clamp(hsl.y + saturationShift * weight, 0.0, 1.0),
      clamp(hsl.z + luminanceShift * weight, 0.0, 1.0)
    );
  }
  return changed ? hslToRgb(hsl) : color;
}

vec3 applyMixer(vec3 color) {
  if (uMixerEnabled < 0.5) return color;
  vec3 hsl = rgbToHsl(color);
  float hueShift = 0.0;
  float saturationScale = 1.0;
  float luminanceShift = 0.0;
  const float centers[8] = float[8](0.0, 30.0, 60.0, 120.0, 180.0, 240.0, 270.0, 300.0);
  for (int index = 0; index < 8; index++) {
    float distance = circularHueDistance(hsl.x, centers[index]);
    float weight = boundedSmoothstep(64.8, 0.0, distance);
    hueShift += uMixerHue[index] * weight;
    saturationScale += uMixerSaturation[index] * weight / 100.0;
    luminanceShift += uMixerLuminance[index] * weight * 0.005;
  }
  return hslToRgb(vec3(
    hsl.x + hueShift,
    hsl.y * saturationScale,
    hsl.z + luminanceShift
  ));
}

vec3 applyMonochrome(vec3 color) {
  if (uMonochromeEnabled < 0.5) return color;
  vec3 bounded = clamp(color, vec3(0.0), vec3(1.0));
  const float hues[8] = float[8](0.0, 30.0, 60.0, 120.0, 180.0, 240.0, 275.0, 315.0);
  vec3 hsl = rgbToHsl(bounded);
  float weighted = 0.0;
  float totalWeight = 0.0;
  for (int index = 0; index < 8; index++) {
    float weight = max(0.0, 1.0 - circularHueDistance(hsl.x, hues[index]) / 60.0);
    weighted += weight * clamp(uMonochromeMixer[index], -100.0, 100.0);
    totalWeight += weight;
  }
  float base = dot(bounded, vec3(0.2126, 0.7152, 0.0722));
  float adjustment = totalWeight > 0.0 ? weighted / totalWeight / 100.0 : 0.0;
  float luminance = clamp(base + adjustment * hsl.y * 0.5, 0.0, 1.0);
  return vec3(luminance);
}

float gradingSmoothstep(float minimum, float maximum, float value) {
  return boundedSmoothstep(minimum, maximum, value);
}

vec3 gradingTint(float hue) {
  return hslToRgb(vec3(hue, 1.0, 0.5));
}

vec3 applyGradingWheel(
  vec3 color,
  float hue,
  float saturationValue,
  float luminanceValue,
  float weight
) {
  float saturation = clamp(saturationValue, 0.0, 100.0);
  float luminance = clamp(luminanceValue, -100.0, 100.0);
  if (weight == 0.0 || (saturation == 0.0 && luminance == 0.0)) return color;
  vec3 tint = gradingTint(hue);
  vec3 result = color + (tint - vec3(0.5)) * (saturation / 100.0) * weight +
    vec3(luminance / 100.0 * 0.25 * weight);
  return clamp(result, vec3(0.0), vec3(1.0));
}

vec3 applyGrading(vec3 color) {
  float value = clamp(luminance(color), 0.0, 1.0);
  float balanceShift = clamp(uGradingBalance, -100.0, 100.0) / 500.0;
  float feather = 0.05 + clamp(uGradingBlending, 0.0, 100.0) / 400.0;
  float shadowPivot = clamp(0.35 + balanceShift, 0.1, 0.7);
  float highlightPivot = clamp(0.65 + balanceShift, 0.3, 0.9);
  float shadows = 1.0 - gradingSmoothstep(shadowPivot - feather, shadowPivot + feather, value);
  float highlights = gradingSmoothstep(highlightPivot - feather, highlightPivot + feather, value);
  float midtones = max(0.0, 1.0 - shadows - highlights);
  float total = shadows + midtones + highlights;
  if (total > 1.0) {
    shadows /= total;
    midtones /= total;
    highlights /= total;
  }
  vec3 result = applyGradingWheel(
    color,
    uGradingShadowsHue,
    uGradingShadowsSaturation,
    uGradingShadowsLuminance,
    shadows
  );
  result = applyGradingWheel(
    result,
    uGradingMidtonesHue,
    uGradingMidtonesSaturation,
    uGradingMidtonesLuminance,
    midtones
  );
  return applyGradingWheel(
    result,
    uGradingHighlightsHue,
    uGradingHighlightsSaturation,
    uGradingHighlightsLuminance,
    highlights
  );
}

vec3 denoise(vec2 uv) {
  vec3 center = sourceColor(uv);
  if (uDenoiseLuminance == 0.0 && uDenoiseColor == 0.0) return center;
  float radius = 1.0 + uDenoiseLuminance * 2.0;
  vec2 diagonal = vec2(radius * 0.70710678118) / uSourceSize;
  vec2 horizontal = vec2(radius / uSourceSize.x, 0.0);
  vec2 vertical = vec2(0.0, radius / uSourceSize.y);
  vec3 average = (
    sourceColor(uv) +
    sourceColor(uv + horizontal) + sourceColor(uv - horizontal) +
    sourceColor(uv + vertical) + sourceColor(uv - vertical) +
    sourceColor(uv + diagonal) + sourceColor(uv + vec2(-diagonal.x, diagonal.y)) +
    sourceColor(uv + vec2(diagonal.x, -diagonal.y)) + sourceColor(uv - diagonal)
  ) / 9.0;
  float centerLuminance = luminance(center);
  float averageLuminance = luminance(average);
  float edge = abs(centerLuminance - averageLuminance);
  float contrastThreshold = 0.005 + uDenoiseContrast / 500.0;
  float edgeProtection = clamp(edge / contrastThreshold, 0.0, 1.0);
  float luminanceMix = uDenoiseLuminance * (1.0 - edgeProtection * uDenoiseDetail);
  float targetLuminance = centerLuminance +
    (averageLuminance - centerLuminance) * luminanceMix;
  float luminanceDelta = targetLuminance - centerLuminance;
  float colorMix = uDenoiseColor * (0.5 + uDenoiseColorSmoothness * 0.5) *
    (1.0 - edgeProtection * uDenoiseColorDetail);
  vec3 centerChroma = center - vec3(centerLuminance);
  vec3 averageChroma = average - vec3(averageLuminance);
  return clamp(vec3(centerLuminance + luminanceDelta) +
    centerChroma + (averageChroma - centerChroma) * colorMix,
    vec3(0.0), vec3(16.0));
}

vec4 localLayer(int layer) {
  ivec2 pixel = ivec2(gl_FragCoord.xy);
  return texelFetch(
    uLocalAdjustments,
    ivec2(pixel.x * 5 + layer, uOutputSize.y - 1 - pixel.y),
    0
  );
}

vec3 applyLocalBasic(vec3 color, vec4 first, vec4 second, vec4 third) {
  float gain = exp2(clamp(first.r, -10.0, 10.0));
  color *= gain;
  color *= vec3(
    1.0 + second.b * 0.00008 + second.a * 0.00002,
    1.0 - abs(second.a) * 0.00003,
    1.0 - second.b * 0.00008 - second.a * 0.00002
  );
  float sourceLuminance = luminance(color);
  float sharedAdjustment = boundedSmoothstep(0.7, 0.0, sourceLuminance) * first.a * 0.0015 +
    boundedSmoothstep(0.35, 1.0, sourceLuminance) * first.b * 0.0012 +
    boundedSmoothstep(0.72, 1.0, sourceLuminance) * second.r * 0.0012 +
    boundedSmoothstep(0.25, 0.0, sourceLuminance) * second.g * 0.0012;
  float contrast = 1.0 + clamp(first.g, -100.0, 100.0) * 0.0035;
  color = (color + sharedAdjustment - 0.5) * contrast + 0.5;
  if (third.g != 0.0) {
    float gray = luminance(color);
    color = vec3(gray) + (color - gray) * max(0.0, 1.0 + third.g / 100.0);
  }
  if (third.r != 0.0) {
    float gray = luminance(color);
    float saturation = max(max(color.r, color.g), color.b) - min(min(color.r, color.g), color.b);
    float scale = max(0.0, 1.0 + third.r / 100.0 * (1.0 - clamp(saturation, 0.0, 1.0)));
    color = vec3(gray) + (color - gray) * scale;
  }
  return clamp(color, vec3(-16.0), vec3(16.0));
}

vec3 applyLocalEffects(vec3 color, vec4 presence, vec4 effects, vec4 colorize) {
  float sourceLuminance = luminance(color);
  float presenceAmount = (presence.b * 0.0015 + presence.a * 0.002) * (sourceLuminance - 0.5);
  color += vec3(presenceAmount);
  float detail = effects.r * 0.001 * (sourceLuminance - 0.5);
  color += vec3(detail);
  float smoothing = clamp((effects.g + effects.b) / 250.0, 0.0, 0.8);
  color += (vec3(sourceLuminance) - color) * smoothing;
  if (effects.a > 0.0) {
    float neutral = (color.r + color.b) * 0.5;
    float amount = effects.a / 100.0;
    color.r += (neutral - color.r) * amount;
    color.b += (neutral - color.b) * amount;
  }
  float colorizeAmount = colorize.a / 100.0;
  if (colorizeAmount > 0.0) {
    color += (colorize.rgb - color) * colorizeAmount;
  }
  return clamp(color, vec3(-16.0), vec3(16.0));
}

vec3 applyLocalAdjustments(vec3 color) {
  if (uLocalEnabled < 0.5) return color;
  vec4 basicFirst = localLayer(0);
  vec4 basicSecond = localLayer(1);
  vec4 basicThird = localLayer(2);
  vec4 presence = basicThird;
  vec4 effects = localLayer(3);
  vec4 colorize = localLayer(4);
  return applyLocalEffects(
    applyLocalBasic(color, basicFirst, basicSecond, basicThird),
    presence,
    effects,
    colorize
  );
}

void main() {
  ivec2 pixel = ivec2(gl_FragCoord.xy);
  ivec2 mapPixel = ivec2(pixel.x, uOutputSize.y - 1 - pixel.y);
  vec4 mapping = texelFetch(uMap, mapPixel, 0);
  if (mapping.a < 0.5) {
    outColor = vec4(0.0);
    outToneInput = vec4(0.0);
    outPointColorInput = vec4(0.0);
    return;
  }
  vec3 toneInput = denoise(mapping.xy);
  vec3 pointColorInput = curves(basicTone(toneInput));
  vec3 color = applyPointColor(pointColorInput);
  color = applyMixer(color);
  color = applyMonochrome(color);
  color = applyGrading(color);
  color = applyLocalAdjustments(color);
  outColor = vec4(color, 1.0);
  outToneInput = vec4(toneInput, 1.0);
  outPointColorInput = vec4(pointColorInput, 1.0);
}`;
const SPATIAL_SHADER = `#version 300 es
precision highp float;
uniform sampler2D uImage;
uniform vec2 uImageSize;
uniform int uMode;
uniform float uAmount;
uniform float uRadius;
uniform float uDetail;
uniform float uMasking;
in vec2 vUv;
out vec4 outColor;

float luminance(vec3 color) {
  return dot(color, vec3(0.2126, 0.7152, 0.0722));
}

vec3 texelAt(ivec2 pixel) {
  return texelFetch(uImage, pixel, 0).rgb;
}

vec3 sampleAt(vec2 offsetPixels) {
  vec2 center = gl_FragCoord.xy - vec2(0.5);
  vec2 coordinate = clamp(center + offsetPixels, vec2(0.0), uImageSize - vec2(1.0));
  ivec2 low = ivec2(floor(coordinate));
  ivec2 high = min(low + 1, ivec2(uImageSize) - 1);
  vec2 fraction = coordinate - vec2(low);
  vec3 top = mix(
    texelAt(ivec2(low.x, low.y)),
    texelAt(ivec2(high.x, low.y)),
    fraction.x
  );
  vec3 bottom = mix(
    texelAt(ivec2(low.x, high.y)),
    texelAt(ivec2(high.x, high.y)),
    fraction.x
  );
  return mix(top, bottom, fraction.y);
}

vec3 nineTap(float radius) {
  float diagonal = radius * 0.70710678118;
  return (
    sampleAt(vec2(0.0)) + sampleAt(vec2(radius, 0.0)) +
    sampleAt(vec2(-radius, 0.0)) + sampleAt(vec2(0.0, radius)) +
    sampleAt(vec2(0.0, -radius)) + sampleAt(vec2(diagonal, diagonal)) +
    sampleAt(vec2(-diagonal, diagonal)) + sampleAt(vec2(diagonal, -diagonal)) +
    sampleAt(vec2(-diagonal, -diagonal))
  ) / 9.0;
}

void main() {
  vec2 pixelCenter = gl_FragCoord.xy - vec2(0.5);
  vec4 source = texelFetch(uImage, ivec2(pixelCenter), 0);
  if (source.a == 0.0) {
    outColor = source;
    return;
  }
  vec3 center = source.rgb;
  vec3 average = nineTap(uRadius);
  vec3 result = center;
  if (uMode == 0) {
    result = center + (center - average) * uAmount * 0.6;
  } else if (uMode == 1) {
    float adjustment = (luminance(center) - luminance(average)) * uAmount * 0.8;
    result = center + adjustment;
  } else if (uMode == 2) {
    if (uAmount > 0.0) {
      float darkChannel = clamp(min(min(average.r, average.g), average.b), 0.0, 1.0);
      float transmission = clamp(1.0 - uAmount * darkChannel * 0.8, 0.2, 1.0);
      result = (center - (1.0 - transmission)) / transmission;
    } else {
      float haze = -uAmount * 0.35;
      result = center * (1.0 - haze) + haze;
    }
  } else {
    float edge = abs(luminance(center) - luminance(average));
    float threshold = uMasking * 0.08;
    float edgeWeight = threshold == 0.0 ? 1.0 : clamp((edge - threshold) / 0.04, 0.0, 1.0);
    result = center + (center - average) * uAmount * uDetail * edgeWeight;
  }
  outColor = vec4(clamp(result, vec3(0.0), vec3(16.0)), source.a);
}`;
const POST_CROP_SHADER = `#version 300 es
precision highp float;
uniform sampler2D uImage;
uniform vec2 uImageSize;
uniform vec2 uImageOrigin;
uniform float uVignette;
uniform float uMidpoint;
uniform float uRoundness;
uniform float uFeather;
uniform float uHighlights;
in vec2 vUv;
out vec4 outColor;

float luminance(vec3 color) {
  return dot(color, vec3(0.2126, 0.7152, 0.0722));
}

void main() {
  vec4 source = texture(uImage, vUv);
  vec3 color = source.rgb;
  if (source.a > 0.0 && uVignette != 0.0) {
    vec2 normalized = abs(((gl_FragCoord.xy + uImageOrigin) / uImageSize - 0.5) * 2.0);
    float boxDistance = max(normalized.x, normalized.y);
    float roundDistance = length(normalized) * 0.70710678118;
    float shapeMix = uRoundness * 0.005 + 0.5;
    float shape = mix(boxDistance, roundDistance, shapeMix);
    float midpoint = 0.15 + 0.65 * uMidpoint / 100.0;
    float feather = max(0.01, 0.03 + 0.72 * uFeather / 100.0);
    float edge = smoothstep(midpoint, midpoint + feather, shape);
    float protection = smoothstep(0.45, 1.0, luminance(color)) * uHighlights / 100.0;
    float mask = edge * (1.0 - protection);
    float darken = 1.0 - mask * max(0.0, -uVignette) * 0.008;
    float lighten = mask * max(0.0, uVignette) * 0.006;
    color = color * darken + lighten;
  }
  outColor = vec4(color, source.a);
}`;
const ENCODE_SHADER = `#version 300 es
precision highp float;
uniform sampler2D uImage;
in vec2 vUv;
out vec4 outColor;

float encodeSrgb(float value) {
  float bounded = clamp(value, 0.0, 1.0);
  return bounded <= 0.0031308
    ? bounded * 12.92
    : 1.055 * pow(bounded, 1.0 / 2.4) - 0.055;
}

void main() {
  vec4 source = texture(uImage, vUv);
  outColor = vec4(
    encodeSrgb(source.r),
    encodeSrgb(source.g),
    encodeSrgb(source.b),
    source.a
  );
}`;

type GpuSupport =
  | { readonly kind: "supported" }
  | { readonly kind: "unsupported"; readonly reason: string };

interface GpuPrograms {
  readonly pointwise: WebGLProgram;
  readonly pointwiseInteger: WebGLProgram;
  readonly spatial: WebGLProgram;
  readonly postCrop: WebGLProgram;
  readonly encode: WebGLProgram;
}

interface GpuTargets {
  readonly width: number;
  readonly height: number;
  readonly precision: "half" | "float";
  readonly pointwise: WebGLTexture;
  readonly toneInput: WebGLTexture;
  readonly pointColorInput: WebGLTexture;
  readonly scratch: WebGLTexture;
  readonly postCrop: WebGLTexture;
  readonly framebuffer: WebGLFramebuffer;
}

interface GeometryMap {
  readonly key: string;
  readonly texture: WebGLTexture;
}

interface GpuState {
  readonly canvas: OffscreenCanvas;
  readonly gl: WebGL2RenderingContext;
  readonly programs: GpuPrograms;
  readonly source: WebGLTexture;
  readonly sourceIsInteger: boolean;
  readonly targets: Map<string, GpuTargets>;
  readonly geometryMaps: Map<string, GeometryMap>;
  readonly localAdjustments: Map<string, WebGLTexture>;
}

interface GpuRenderedFrame {
  readonly bitmap: ImageBitmap | null;
  readonly pixels: Uint8Array | null;
  readonly pointColorInput: CpuPointColorInput | null;
  readonly analysis: readonly CpuAnalysisTapResult[];
}

export type V3GpuPreviewRenderResult =
  | (
      Omit<Extract<CpuRenderResult, { readonly kind: "rendered" }>, "pixels"> &
      { readonly bitmap: ImageBitmap }
    )
  | Exclude<CpuRenderResult, { readonly kind: "rendered" }>;

function clamp(value: number, minimum: number, maximum: number): number {
  return Math.max(minimum, Math.min(maximum, Number.isFinite(value) ? value : 0));
}

function inactiveLocalEdits(document: DevelopDocumentV3): boolean {
  return document.local.masks.every((mask) =>
    !mask.enabled || localAdjustmentsAreNeutral(mask.adjustments)
  );
}

function integerSource(input: CpuRenderInput): boolean {
  return input.image.bits > 8 && input.image.rgb instanceof Uint16Array;
}

function homographyIsIdentity(matrix: readonly number[]): boolean {
  return matrix.every((value, index) => value === IDENTITY_HOMOGRAPHY[index]);
}

function denoiseGeometryIsIdentity(input: CpuRenderInput): boolean {
  const geometry = input.document.geometry;
  const orientation = geometry.orientation;
  return input.source.orientation === 1 &&
    orientation.quarterTurns === 0 &&
    !orientation.flipHorizontal &&
    !orientation.flipVertical &&
    orientation.fineAngleDegrees === 0 &&
    homographyIsIdentity(geometry.manualPerspective.matrix) &&
    !geometry.upright.enabled &&
    !geometry.crop.enabled &&
    input.document.optics.manualDistortion === 0;
}

function localMaskSourcesGpuSupported(document: DevelopDocumentV3): boolean {
  return document.local.masks.every((mask) => {
    if (!mask.enabled || localAdjustmentsAreNeutral(mask.adjustments)) return true;
    return maskSourceNodes(mask.expression).every((node) => {
      switch (node.source.kind) {
        case "brush":
          return node.source.autoMask.kind === "off";
        case "linear-gradient":
        case "radial-gradient":
        case "depth-range":
        case "ai-matte":
          return true;
        case "luminance-range":
        case "color-range":
          return false;
        default: {
          const exhaustive: never = node.source;
          return exhaustive;
        }
      }
    });
  });
}

export function v3GpuPreviewSupport(input: CpuRenderInput): GpuSupport {
  if (typeof OffscreenCanvas === "undefined") {
    return { kind: "unsupported", reason: "OffscreenCanvas is unavailable." };
  }
  if (input.image.bits < 8 || input.image.bits > 16) {
    return { kind: "unsupported", reason: "The GPU source format supports 8 to 16 bits." };
  }
  if (input.image.bits === 8 && input.image.rgb instanceof Uint16Array) {
    return { kind: "unsupported", reason: "An 8-bit source cannot use the integer GPU upload." };
  }
  if (input.image.bits > 8 && (
    !(input.image.rgb instanceof Uint16Array) || input.image.colors !== 3
  )) {
    return { kind: "unsupported", reason: "High-bit GPU sources require 3-channel Uint16 pixels." };
  }
  if (
    input.source.color.kind !== "uncharacterized" &&
    input.source.color.transfer.kind === "gamma"
  ) {
    return {
      kind: "unsupported",
      reason: "Gamma transfer sources use the CPU reference path.",
    };
  }
  if (input.document.compatibility.legacyV2) {
    return { kind: "unsupported", reason: "Frozen v2 rendering uses the CPU reference path." };
  }
  if (!inactiveLocalEdits(input.document)) {
    if (!localMaskSourcesGpuSupported(input.document)) {
      return { kind: "unsupported", reason: "This local mask source uses analysis unavailable to the GPU path." };
    }
  }
  if (input.document.cleanup.components.some((component) => component.enabled)) {
    return { kind: "unsupported", reason: "Active Cleanup components use the CPU reference path." };
  }
  const denoise = input.document.detail.noiseReduction;
  if (denoise.noiseReduction !== 0 || denoise.colorNoiseReduction !== 0) {
    if (!denoiseGeometryIsIdentity(input)) {
      return { kind: "unsupported", reason: "Denoise requires identity source geometry on the GPU." };
    }
  }
  if (
    input.document.color.monochrome.enabled &&
    input.document.color.monochrome.profileId !== NEUTRAL_MONOCHROME_PROFILE.id
  ) {
    return { kind: "unsupported", reason: "Only the built-in neutral monochrome profile is supported on the GPU." };
  }
  if (input.document.optics.defringe.amount !== 0) {
    return { kind: "unsupported", reason: "Active defringe uses the CPU reference path." };
  }
  if (input.document.effects.postCrop.grain !== 0) {
    return { kind: "unsupported", reason: "Active grain uses the CPU reference path." };
  }
  return { kind: "supported" };
}

function shader(gl: WebGL2RenderingContext, type: number, source: string): WebGLShader {
  const value = gl.createShader(type);
  if (!value) throw new Error("Could not create a GPU shader.");
  gl.shaderSource(value, source);
  gl.compileShader(value);
  if (!gl.getShaderParameter(value, gl.COMPILE_STATUS)) {
    const message = gl.getShaderInfoLog(value) ?? "GPU shader compilation failed.";
    gl.deleteShader(value);
    throw new Error(message);
  }
  return value;
}

function program(
  gl: WebGL2RenderingContext,
  fragmentSource: string,
  integerSourceProgram = false,
): WebGLProgram {
  const vertex = shader(gl, gl.VERTEX_SHADER, VERTEX_SHADER);
  const source = integerSourceProgram
    ? fragmentSource.replace("#version 300 es\n", "#version 300 es\n#define INTEGER_SOURCE\n")
    : fragmentSource;
  const fragment = shader(gl, gl.FRAGMENT_SHADER, source);
  const value = gl.createProgram();
  if (!value) throw new Error("Could not create a GPU program.");
  gl.attachShader(value, vertex);
  gl.attachShader(value, fragment);
  gl.linkProgram(value);
  gl.deleteShader(vertex);
  gl.deleteShader(fragment);
  if (!gl.getProgramParameter(value, gl.LINK_STATUS)) {
    const message = gl.getProgramInfoLog(value) ?? "GPU program linking failed.";
    gl.deleteProgram(value);
    throw new Error(message);
  }
  return value;
}

function texture(
  gl: WebGL2RenderingContext,
  input: {
    readonly width: number;
    readonly height: number;
    readonly internalFormat: number;
    readonly format: number;
    readonly type: number;
    readonly pixels: ArrayBufferView | null;
    readonly filter: number;
  },
): WebGLTexture {
  const value = gl.createTexture();
  if (!value) throw new Error("Could not create a GPU texture.");
  gl.bindTexture(gl.TEXTURE_2D, value);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, input.filter);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, input.filter);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
  gl.texImage2D(
    gl.TEXTURE_2D,
    0,
    input.internalFormat,
    input.width,
    input.height,
    0,
    input.format,
    input.type,
    input.pixels,
  );
  const error = gl.getError();
  if (error !== gl.NO_ERROR) {
    gl.deleteTexture(value);
    throw new Error(`Could not allocate GPU texture (WebGL error ${error}).`);
  }
  return value;
}

function sourcePixels(input: CpuRenderInput): Uint8Array {
  const source = input.image.rgb;
  const target = new Uint8Array(input.image.sourceWidth * input.image.sourceHeight * 4);
  for (let pixel = 0; pixel < input.image.sourceWidth * input.image.sourceHeight; pixel += 1) {
    const sourceOffset = pixel * input.image.colors;
    const targetOffset = pixel * 4;
    target[targetOffset] = source[sourceOffset] ?? 0;
    target[targetOffset + 1] = source[sourceOffset + 1] ?? 0;
    target[targetOffset + 2] = source[sourceOffset + 2] ?? 0;
    target[targetOffset + 3] = input.image.colors === 4
      ? source[sourceOffset + 3] ?? 255
      : 255;
  }
  return target;
}

function sourceTexture(gl: WebGL2RenderingContext, input: CpuRenderInput): WebGLTexture {
  gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, true);
  gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1);
  try {
    if (integerSource(input)) {
      const source = input.image.rgb;
      if (!(source instanceof Uint16Array)) {
        throw new Error("The GPU source is not a Uint16Array.");
      }
      return texture(gl, {
        width: input.image.sourceWidth,
        height: input.image.sourceHeight,
        internalFormat: gl.RGB16UI,
        format: gl.RGB_INTEGER,
        type: gl.UNSIGNED_SHORT,
        pixels: source,
        filter: gl.NEAREST,
      });
    }
    return texture(gl, {
      width: input.image.sourceWidth,
      height: input.image.sourceHeight,
      internalFormat: gl.RGBA8,
      format: gl.RGBA,
      type: gl.UNSIGNED_BYTE,
      pixels: sourcePixels(input),
      filter: gl.NEAREST,
    });
  } finally {
    gl.pixelStorei(gl.UNPACK_ALIGNMENT, 4);
    gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false);
  }
}

function floatTarget(
  gl: WebGL2RenderingContext,
  width: number,
  height: number,
  precision: "half" | "float",
): WebGLTexture {
  return texture(gl, {
    width,
    height,
    internalFormat: precision === "float" ? gl.RGBA32F : gl.RGBA16F,
    format: gl.RGBA,
    type: precision === "float" ? gl.FLOAT : gl.HALF_FLOAT,
    pixels: null,
    filter: gl.LINEAR,
  });
}

function createTargets(
  gl: WebGL2RenderingContext,
  width: number,
  height: number,
  precision: "half" | "float",
): GpuTargets {
  const framebuffer = gl.createFramebuffer();
  if (!framebuffer) throw new Error("Could not create a GPU framebuffer.");
  return {
    width,
    height,
    precision,
    pointwise: floatTarget(gl, width, height, precision),
    toneInput: floatTarget(gl, width, height, precision),
    pointColorInput: floatTarget(gl, width, height, precision),
    scratch: floatTarget(gl, width, height, precision),
    postCrop: floatTarget(gl, width, height, precision),
    framebuffer,
  };
}

function deleteTargets(gl: WebGL2RenderingContext, targets: GpuTargets): void {
  gl.deleteTexture(targets.pointwise);
  gl.deleteTexture(targets.toneInput);
  gl.deleteTexture(targets.pointColorInput);
  gl.deleteTexture(targets.scratch);
  gl.deleteTexture(targets.postCrop);
  gl.deleteFramebuffer(targets.framebuffer);
}

function manualLensCalibration(document: DevelopDocumentV3): LensCalibration {
  return document.optics.manualDistortion === 0
    ? NEUTRAL_LENS_CALIBRATION
    : {
        distortion: {
          k1: clamp(document.optics.manualDistortion / 100, -1, 1),
          k2: 0,
          k3: 0,
        },
        illumination: { v1: 0, v2: 0 },
        lateralChromaticAberration: { red: 0, blue: 0 },
      };
}

function orientedDimensions(input: CpuRenderInput): { readonly width: number; readonly height: number } {
  return input.source.orientation >= 5
    ? { width: input.source.dimensions.height, height: input.source.dimensions.width }
    : input.source.dimensions;
}

function geometryStages(input: CpuRenderInput): {
  readonly user: CanonicalGeometry;
  readonly optics: CanonicalGeometry;
} {
  const oriented = orientedDimensions(input);
  return {
    user: {
      frame: "canonical-v3",
      sourceWidth: oriented.width,
      sourceHeight: oriented.height,
      exifOrientation: 1,
      optics: {
        calibration: NEUTRAL_LENS_CALIBRATION,
        amounts: { distortion: 0, illumination: 0, lateralChromaticAberration: 0 },
      },
      orientation: input.document.geometry.orientation,
      manualPerspective: input.document.geometry.manualPerspective.matrix,
      upright: input.document.geometry.upright,
      constrainCrop: input.document.geometry.constrainCrop,
      crop: input.document.geometry.crop,
    },
    optics: {
      frame: "canonical-v3",
      sourceWidth: input.source.dimensions.width,
      sourceHeight: input.source.dimensions.height,
      exifOrientation: input.source.orientation,
      optics: {
        calibration: manualLensCalibration(input.document),
        amounts: {
          distortion: input.document.optics.manualDistortion === 0 ? 0 : 1,
          illumination: 0,
          lateralChromaticAberration: 0,
        },
      },
      orientation: {
        quarterTurns: 0,
        flipHorizontal: false,
        flipVertical: false,
        fineAngleDegrees: 0,
      },
      manualPerspective: IDENTITY_HOMOGRAPHY,
      upright: { enabled: false, matrix: IDENTITY_HOMOGRAPHY, revision: "none" },
      constrainCrop: false,
      crop: { enabled: false, x: 0, y: 0, width: 1, height: 1 },
    },
  };
}

function outputPointForRegion(
  input: CpuRenderInput,
  region: RenderRegion,
  x: number,
  y: number,
): { readonly x: number; readonly y: number } {
  const dimensions = input.request.plan.qualityAndDimensions.outputDimensions;
  const point = {
    x: (region.x + x + 0.5) / dimensions.width,
    y: 1 - (region.y + y + 0.5) / dimensions.height,
  };
  const quality = input.request.plan.qualityAndDimensions;
  if (quality.kind !== "loupe") return point;
  return {
    x: quality.sourceCenter.x + (point.x - 0.5) / quality.zoom,
    y: quality.sourceCenter.y + (point.y - 0.5) / quality.zoom,
  };
}

function geometryMapPixels(
  input: CpuRenderInput,
  region: RenderRegion,
): Float32Array {
  const dimensions = { width: region.width, height: region.height };
  const stages = geometryStages(input);
  const userCrop = resolveConstrainedCrop(stages.user);
  const opticsCrop = resolveConstrainedCrop(stages.optics);
  const pixels = new Float32Array(dimensions.width * dimensions.height * 4);
  for (let y = 0; y < dimensions.height; y += 1) {
    for (let x = 0; x < dimensions.width; x += 1) {
      const output = outputPointForRegion(input, region, x, y);
      const user = mapOutputToStored(output, stages.user, userCrop);
      if (user.kind !== "mapped" || !user.insideDestination) continue;
      const optics = mapOutputToStored({
        x: clamp(user.point.x, 0, 1),
        y: clamp(user.point.y, 0, 1),
      }, stages.optics, opticsCrop);
      if (optics.kind !== "mapped" || !optics.insideDestination) continue;
      const offset = (y * dimensions.width + x) * 4;
      pixels[offset] = optics.point.x;
      pixels[offset + 1] = optics.point.y;
      pixels[offset + 2] = 0;
      pixels[offset + 3] = 1;
    }
  }
  return pixels;
}

function geometryMapKey(input: CpuRenderInput, region: RenderRegion): string {
  const stages = geometryStages(input);
  return [
    region.x,
    region.y,
    region.width,
    region.height,
    geometryCacheIdentity(stages.user),
    geometryCacheIdentity(stages.optics),
  ].join("\u001f");
}

function gpuRegionWithinLimits(
  state: GpuState,
  input: CpuRenderInput,
  region: RenderRegion,
): boolean {
  const maximum = state.gl.getParameter(state.gl.MAX_TEXTURE_SIZE) as number;
  if (
    input.image.sourceWidth > maximum ||
    input.image.sourceHeight > maximum ||
    region.width > maximum ||
    region.height > maximum
  ) return false;
  const hasLocalAdjustments = input.document.local.masks.some((mask) =>
    mask.enabled && !localAdjustmentsAreNeutral(mask.adjustments)
  );
  return !hasLocalAdjustments || region.width * 5 <= maximum;
}

function localAdjustmentCacheKey(input: CpuRenderInput, region: RenderRegion): string {
  const stages = geometryStages(input);
  return JSON.stringify({
    region,
    dimensions: input.request.plan.qualityAndDimensions.outputDimensions,
    source: input.source.signature,
    geometry: [
      geometryCacheIdentity(stages.user),
      geometryCacheIdentity(stages.optics),
    ],
    local: input.document.local,
  });
}

function localAdjustmentTexture(
  state: GpuState,
  input: CpuRenderInput,
  region: RenderRegion,
): WebGLTexture | null {
  const masks = input.document.local.masks.filter((mask) =>
    mask.enabled && !localAdjustmentsAreNeutral(mask.adjustments)
  );
  if (masks.length === 0) return null;
  const key = localAdjustmentCacheKey(input, region);
  const cached = state.localAdjustments.get(key);
  if (cached) {
    state.localAdjustments.delete(key);
    state.localAdjustments.set(key, cached);
    return cached;
  }
  const gl = state.gl;
  const dimensions = { width: region.width, height: region.height };
  const stages = geometryStages(input);
  const userCrop = resolveConstrainedCrop(stages.user);
  const oriented = orientedDimensions(input);
  const assets = {
    sourceSignature: input.source.signature,
    maskMatte: (assetId: string) => input.assets?.maskMatte?.(assetId),
    depthMap: (assetId: string) => input.assets?.depthMap?.(assetId),
  };
  const pixels = new Float32Array(dimensions.width * dimensions.height * 5 * 4);
  const write = (
    pixel: number,
    layer: number,
    values: readonly [number, number, number, number],
  ): void => {
    const offset = (pixel * 5 + layer) * 4;
    pixels[offset] = values[0];
    pixels[offset + 1] = values[1];
    pixels[offset + 2] = values[2];
    pixels[offset + 3] = values[3];
  };
  for (let y = 0; y < dimensions.height; y += 1) {
    for (let x = 0; x < dimensions.width; x += 1) {
      const output = outputPointForRegion(input, region, x, y);
      const userMapped = mapOutputToStored(output, stages.user, userCrop);
      if (userMapped.kind !== "mapped" || !userMapped.insideDestination) continue;
      const canonical = mapDistortedUv(
        userMapped.point,
        stages.optics.optics.calibration.distortion,
        stages.optics.optics.amounts.distortion,
      );
      const legacy = input.document.local.geometryFrame === "legacy-oriented-v2";
      if (!legacy && (
        canonical.x < 0 || canonical.x > 1 ||
        canonical.y < 0 || canonical.y > 1
      )) continue;
      const localPoint = legacy
        ? { x: clamp(canonical.x, 0, 1), y: clamp(canonical.y, 0, 1) }
        : canonical;
      const contributions = [];
      for (const mask of masks) {
        const coverage = manualMaskCoverage(
          mask,
          pointInLocalGeometryFrame(input.document.local.geometryFrame, localPoint),
          oriented,
          assets,
        );
        if (coverage > 0) contributions.push({ values: mask.adjustments, coverage });
      }
      if (contributions.length === 0) continue;
      const adjustments = accumulateLocalAdjustments({ contributions });
      const pixel = y * dimensions.width + x;
      write(pixel, 0, [
        adjustments.basic.exposure,
        adjustments.basic.contrast,
        adjustments.basic.highlights,
        adjustments.basic.shadows,
      ]);
      write(pixel, 1, [
        adjustments.basic.whites,
        adjustments.basic.blacks,
        adjustments.basic.temperature,
        adjustments.basic.tint,
      ]);
      write(pixel, 2, [
        adjustments.basic.vibrance,
        adjustments.basic.saturation,
        adjustments.texture,
        adjustments.clarity,
      ]);
      write(pixel, 3, [
        adjustments.sharpness,
        adjustments.noise,
        adjustments.moire,
        adjustments.defringe,
      ]);
      write(pixel, 4, [
        adjustments.colorize.color[0],
        adjustments.colorize.color[1],
        adjustments.colorize.color[2],
        adjustments.colorize.amount,
      ]);
    }
  }
  const value = texture(gl, {
    width: dimensions.width * 5,
    height: dimensions.height,
    internalFormat: gl.RGBA32F,
    format: gl.RGBA,
    type: gl.FLOAT,
    pixels,
    filter: gl.NEAREST,
  });
  state.localAdjustments.set(key, value);
  while (state.localAdjustments.size > MAX_CACHED_LOCAL_ADJUSTMENTS) {
    const oldestKey = state.localAdjustments.keys().next().value;
    if (oldestKey === undefined) break;
    const oldest = state.localAdjustments.get(oldestKey);
    state.localAdjustments.delete(oldestKey);
    if (oldest) gl.deleteTexture(oldest);
  }
  return value;
}

function curveValue(
  value: number,
  points: DevelopDocumentV3["tone"]["curves"]["rgb"],
): number {
  const bounded = clamp(value, 0, 1);
  const first = points[0];
  if (!first || bounded <= first.x) return first?.y ?? bounded;
  for (let index = 1; index < points.length; index += 1) {
    const left = points[index - 1];
    const right = points[index];
    if (!left || !right || bounded > right.x) continue;
    const width = right.x - left.x;
    const amount = width <= 0 ? 0 : (bounded - left.x) / width;
    return left.y + (right.y - left.y) * amount;
  }
  return points.at(-1)?.y ?? bounded;
}

function curveTexture(gl: WebGL2RenderingContext, document: DevelopDocumentV3): WebGLTexture {
  const values = new Float32Array(CURVE_LUT_SIZE * 4);
  for (let index = 0; index < CURVE_LUT_SIZE; index += 1) {
    const value = index / (CURVE_LUT_SIZE - 1);
    const offset = index * 4;
    values[offset] = curveValue(value, document.tone.curves.rgb);
    values[offset + 1] = curveValue(value, document.tone.curves.red);
    values[offset + 2] = curveValue(value, document.tone.curves.green);
    values[offset + 3] = curveValue(value, document.tone.curves.blue);
  }
  return texture(gl, {
    width: CURVE_LUT_SIZE,
    height: 1,
    internalFormat: gl.RGBA32F,
    format: gl.RGBA,
    type: gl.FLOAT,
    pixels: values,
    filter: gl.NEAREST,
  });
}

function curvesAreIdentity(document: DevelopDocumentV3): boolean {
  return [
    document.tone.curves.rgb,
    document.tone.curves.red,
    document.tone.curves.green,
    document.tone.curves.blue,
  ].every((points) => points.every((point) => point.x === point.y));
}

function bindTexture(
  gl: WebGL2RenderingContext,
  programValue: WebGLProgram,
  name: string,
  unit: number,
  value: WebGLTexture,
): void {
  gl.activeTexture(gl.TEXTURE0 + unit);
  gl.bindTexture(gl.TEXTURE_2D, value);
  gl.uniform1i(gl.getUniformLocation(programValue, name), unit);
}

function attach(
  gl: WebGL2RenderingContext,
  targets: GpuTargets,
  textures: readonly WebGLTexture[],
): void {
  gl.bindFramebuffer(gl.FRAMEBUFFER, targets.framebuffer);
  for (let index = 0; index < 3; index += 1) {
    gl.framebufferTexture2D(
      gl.FRAMEBUFFER,
      gl.COLOR_ATTACHMENT0 + index,
      gl.TEXTURE_2D,
      textures[index] ?? null,
      0,
    );
  }
  gl.drawBuffers(textures.map((_, index) => gl.COLOR_ATTACHMENT0 + index));
  if (gl.checkFramebufferStatus(gl.FRAMEBUFFER) !== gl.FRAMEBUFFER_COMPLETE) {
    throw new Error("The GPU preview framebuffer is incomplete.");
  }
}

function draw(gl: WebGL2RenderingContext): void {
  gl.drawArrays(gl.TRIANGLES, 0, 3);
}

function matrixForWebGl(matrix: readonly number[]): Float32Array {
  return new Float32Array([
    matrix[0] ?? 1, matrix[3] ?? 0, matrix[6] ?? 0,
    matrix[1] ?? 0, matrix[4] ?? 1, matrix[7] ?? 0,
    matrix[2] ?? 0, matrix[5] ?? 0, matrix[8] ?? 1,
  ]);
}

function renderPointwise(
  state: GpuState,
  input: CpuRenderInput,
  targets: GpuTargets,
  map: WebGLTexture,
  localAdjustments: WebGLTexture | null,
): void {
  const gl = state.gl;
  const programValue = state.sourceIsInteger
    ? state.programs.pointwiseInteger
    : state.programs.pointwise;
  const curves = curveTexture(gl, input.document);
  attach(gl, targets, [targets.pointwise, targets.toneInput, targets.pointColorInput]);
  gl.useProgram(programValue);
  bindTexture(gl, programValue, "uSource", 0, state.source);
  bindTexture(gl, programValue, "uMap", 1, map);
  bindTexture(gl, programValue, "uCurves", 2, curves);
  bindTexture(
    gl,
    programValue,
    "uLocalAdjustments",
    3,
    localAdjustments ?? targets.postCrop,
  );
  gl.uniform1f(
    gl.getUniformLocation(programValue, "uLocalEnabled"),
    localAdjustments ? 1 : 0,
  );
  const dimensions = { width: targets.width, height: targets.height };
  gl.uniform2i(gl.getUniformLocation(programValue, "uOutputSize"), dimensions.width, dimensions.height);
  gl.uniform1f(
    gl.getUniformLocation(programValue, "uSourceMaximum"),
    2 ** clamp(input.image.bits, 8, 16) - 1,
  );
  gl.uniform2f(
    gl.getUniformLocation(programValue, "uSourceSize"),
    input.image.sourceWidth,
    input.image.sourceHeight,
  );
  gl.uniform1f(
    gl.getUniformLocation(programValue, "uCurvesIdentity"),
    curvesAreIdentity(input.document) ? 1 : 0,
  );
  gl.uniform1i(
    gl.getUniformLocation(programValue, "uTransfer"),
    input.source.color.kind !== "uncharacterized" && input.source.color.transfer.kind === "linear"
      ? 1
      : 0,
  );
  const whiteBalance = input.document.color.whiteBalance.resolved.gains;
  gl.uniform3f(gl.getUniformLocation(programValue, "uWhiteBalance"), ...whiteBalance);
  const calibration = effectiveInputCalibration(
    input.source,
    input.document.color.inputProfile,
  );
  gl.uniform3f(gl.getUniformLocation(programValue, "uChannelScale"), ...calibration.channelScale);
  gl.uniformMatrix3fv(
    gl.getUniformLocation(programValue, "uCalibration"),
    false,
    matrixForWebGl(calibration.matrixToLinearSrgb),
  );
  gl.uniform1f(
    gl.getUniformLocation(programValue, "uCalibrationExposure"),
    2 ** clamp(calibration.exposureOffsetEv, -8, 8),
  );
  const basic = input.document.tone.basic;
  gl.uniform1f(gl.getUniformLocation(programValue, "uExposure"), basic.exposure);
  gl.uniform1f(gl.getUniformLocation(programValue, "uContrast"), basic.contrast);
  gl.uniform1f(gl.getUniformLocation(programValue, "uHighlights"), basic.highlights);
  gl.uniform1f(gl.getUniformLocation(programValue, "uShadows"), basic.shadows);
  gl.uniform1f(gl.getUniformLocation(programValue, "uWhites"), basic.whites);
  gl.uniform1f(gl.getUniformLocation(programValue, "uBlacks"), basic.blacks);
  gl.uniform1f(
    gl.getUniformLocation(programValue, "uVibrance"),
    input.document.color.global.vibrance,
  );
  gl.uniform1f(
    gl.getUniformLocation(programValue, "uSaturation"),
    input.document.color.global.saturation,
  );
  const denoise = input.document.detail.noiseReduction;
  gl.uniform1f(
    gl.getUniformLocation(programValue, "uDenoiseLuminance"),
    clamp(denoise.noiseReduction, 0, 100) / 100,
  );
  gl.uniform1f(
    gl.getUniformLocation(programValue, "uDenoiseDetail"),
    clamp(denoise.noiseDetail, 0, 100) / 100,
  );
  gl.uniform1f(
    gl.getUniformLocation(programValue, "uDenoiseContrast"),
    clamp(denoise.noiseContrast, 0, 100),
  );
  gl.uniform1f(
    gl.getUniformLocation(programValue, "uDenoiseColor"),
    clamp(denoise.colorNoiseReduction, 0, 100) / 100,
  );
  gl.uniform1f(
    gl.getUniformLocation(programValue, "uDenoiseColorDetail"),
    clamp(denoise.colorNoiseDetail, 0, 100) / 100,
  );
  gl.uniform1f(
    gl.getUniformLocation(programValue, "uDenoiseColorSmoothness"),
    clamp(denoise.colorNoiseSmoothness, 0, 100) / 100,
  );

  const pointColor = boundedPointColorSettings(input.document.color.pointColor).adjustments;
  const pointColorEnabled = new Float32Array(MAX_POINT_COLOR_SAMPLES);
  const pointColorHue = new Float32Array(MAX_POINT_COLOR_SAMPLES);
  const pointColorSaturation = new Float32Array(MAX_POINT_COLOR_SAMPLES);
  const pointColorLuminance = new Float32Array(MAX_POINT_COLOR_SAMPLES);
  const pointColorHueRange = new Float32Array(MAX_POINT_COLOR_SAMPLES);
  const pointColorSaturationRange = new Float32Array(MAX_POINT_COLOR_SAMPLES);
  const pointColorLuminanceRange = new Float32Array(MAX_POINT_COLOR_SAMPLES);
  const pointColorFalloff = new Float32Array(MAX_POINT_COLOR_SAMPLES);
  const pointColorHueShift = new Float32Array(MAX_POINT_COLOR_SAMPLES);
  const pointColorSaturationShift = new Float32Array(MAX_POINT_COLOR_SAMPLES);
  const pointColorLuminanceShift = new Float32Array(MAX_POINT_COLOR_SAMPLES);
  pointColor.forEach((adjustment, index) => {
    pointColorEnabled[index] = adjustment.enabled ? 1 : 0;
    pointColorHue[index] = adjustment.sourceHueDegrees;
    pointColorSaturation[index] = adjustment.sourceSaturation;
    pointColorLuminance[index] = adjustment.sourceLuminance;
    pointColorHueRange[index] = adjustment.hueRangeDegrees;
    pointColorSaturationRange[index] = adjustment.saturationRange;
    pointColorLuminanceRange[index] = adjustment.luminanceRange;
    pointColorFalloff[index] = adjustment.falloff;
    pointColorHueShift[index] = adjustment.hueShiftDegrees;
    pointColorSaturationShift[index] = adjustment.saturationShift;
    pointColorLuminanceShift[index] = adjustment.luminanceShift;
  });
  gl.uniform1i(gl.getUniformLocation(programValue, "uPointColorCount"), pointColor.length);
  gl.uniform1fv(gl.getUniformLocation(programValue, "uPointColorEnabled[0]"), pointColorEnabled);
  gl.uniform1fv(gl.getUniformLocation(programValue, "uPointColorHue[0]"), pointColorHue);
  gl.uniform1fv(gl.getUniformLocation(programValue, "uPointColorSaturation[0]"), pointColorSaturation);
  gl.uniform1fv(gl.getUniformLocation(programValue, "uPointColorLuminance[0]"), pointColorLuminance);
  gl.uniform1fv(gl.getUniformLocation(programValue, "uPointColorHueRange[0]"), pointColorHueRange);
  gl.uniform1fv(gl.getUniformLocation(programValue, "uPointColorSaturationRange[0]"), pointColorSaturationRange);
  gl.uniform1fv(gl.getUniformLocation(programValue, "uPointColorLuminanceRange[0]"), pointColorLuminanceRange);
  gl.uniform1fv(gl.getUniformLocation(programValue, "uPointColorFalloff[0]"), pointColorFalloff);
  gl.uniform1fv(gl.getUniformLocation(programValue, "uPointColorHueShift[0]"), pointColorHueShift);
  gl.uniform1fv(gl.getUniformLocation(programValue, "uPointColorSaturationShift[0]"), pointColorSaturationShift);
  gl.uniform1fv(gl.getUniformLocation(programValue, "uPointColorLuminanceShift[0]"), pointColorLuminanceShift);

  const mixerHue = new Float32Array(8);
  const mixerSaturation = new Float32Array(8);
  const mixerLuminance = new Float32Array(8);
  MIXER_BANDS.forEach(({ id }, index) => {
    const band = input.document.color.mixer[id];
    mixerHue[index] = band.hue;
    mixerSaturation[index] = band.saturation;
    mixerLuminance[index] = band.luminance;
  });
  gl.uniform1fv(gl.getUniformLocation(programValue, "uMixerHue[0]"), mixerHue);
  gl.uniform1fv(gl.getUniformLocation(programValue, "uMixerSaturation[0]"), mixerSaturation);
  gl.uniform1fv(gl.getUniformLocation(programValue, "uMixerLuminance[0]"), mixerLuminance);
  gl.uniform1f(
    gl.getUniformLocation(programValue, "uMixerEnabled"),
    MIXER_BANDS.some(({ id }) => {
      const band = input.document.color.mixer[id];
      return band.hue !== 0 || band.saturation !== 0 || band.luminance !== 0;
    }) ? 1 : 0,
  );

  const monochrome = input.document.color.monochrome;
  const monochromeMixer = new Float32Array(8);
  MONOCHROME_CHANNELS.forEach((channel, index) => {
    monochromeMixer[index] = monochrome.mixer[channel];
  });
  gl.uniform1f(
    gl.getUniformLocation(programValue, "uMonochromeEnabled"),
    monochrome.enabled ? 1 : 0,
  );
  gl.uniform1fv(gl.getUniformLocation(programValue, "uMonochromeMixer[0]"), monochromeMixer);

  const grading = input.document.color.grading;
  const gradingWheel = (
    prefix: string,
    wheel: { readonly hueDegrees: number; readonly saturation: number; readonly luminance: number },
  ): void => {
    gl.uniform1f(gl.getUniformLocation(programValue, `${prefix}Hue`), wheel.hueDegrees);
    gl.uniform1f(gl.getUniformLocation(programValue, `${prefix}Saturation`), wheel.saturation);
    gl.uniform1f(gl.getUniformLocation(programValue, `${prefix}Luminance`), wheel.luminance);
  };
  gradingWheel("uGradingShadows", grading.shadows);
  gradingWheel("uGradingMidtones", grading.midtones);
  gradingWheel("uGradingHighlights", grading.highlights);
  gl.uniform1f(gl.getUniformLocation(programValue, "uGradingBalance"), grading.balance);
  gl.uniform1f(gl.getUniformLocation(programValue, "uGradingBlending"), grading.blending);
  draw(gl);
  gl.deleteTexture(curves);
}

function renderSpatialPass(
  state: GpuState,
  targets: GpuTargets,
  source: WebGLTexture,
  destination: WebGLTexture,
  input: {
    readonly mode: 0 | 1 | 2 | 3;
    readonly amount: number;
    readonly radius: number;
    readonly detail?: number;
    readonly masking?: number;
  },
): void {
  const gl = state.gl;
  const programValue = state.programs.spatial;
  attach(gl, targets, [destination]);
  gl.useProgram(programValue);
  bindTexture(gl, programValue, "uImage", 0, source);
  gl.uniform2f(gl.getUniformLocation(programValue, "uImageSize"), targets.width, targets.height);
  gl.uniform1i(gl.getUniformLocation(programValue, "uMode"), input.mode);
  gl.uniform1f(gl.getUniformLocation(programValue, "uAmount"), input.amount);
  gl.uniform1f(gl.getUniformLocation(programValue, "uRadius"), input.radius);
  gl.uniform1f(gl.getUniformLocation(programValue, "uDetail"), input.detail ?? 0);
  gl.uniform1f(gl.getUniformLocation(programValue, "uMasking"), input.masking ?? 0);
  draw(gl);
}

function renderSpatial(
  state: GpuState,
  input: CpuRenderInput,
  targets: GpuTargets,
): WebGLTexture {
  const sourceDimensions = orientedDimensions(input);
  const outputDimensions = input.request.plan.qualityAndDimensions.outputDimensions;
  const sourceScale = Math.max(
    sourceDimensions.width / outputDimensions.width,
    sourceDimensions.height / outputDimensions.height,
  );
  let current = targets.pointwise;
  let scratch = targets.scratch;
  const run = (pass: Parameters<typeof renderSpatialPass>[4]): void => {
    renderSpatialPass(state, targets, current, scratch, pass);
    const previous = current;
    current = scratch;
    scratch = previous;
  };
  const presence = input.document.presence;
  if (presence.texture !== 0) {
    run({
      mode: 0,
      amount: clamp(presence.texture, -100, 100) / 100,
      radius: clamp(2 / clamp(sourceScale, 1 / 64, 64), 0.25, 512),
    });
  }
  if (presence.clarity !== 0) {
    run({
      mode: 1,
      amount: clamp(presence.clarity, -100, 100) / 100,
      radius: clamp(16 / clamp(sourceScale, 1 / 64, 64), 0.25, 512),
    });
  }
  if (presence.dehaze !== 0) {
    run({
      mode: 2,
      amount: clamp(presence.dehaze, -100, 100) / 100,
      radius: clamp(32 / clamp(sourceScale, 1 / 64, 64), 0.25, 512),
    });
  }
  const sharpening = input.document.detail.sharpening;
  if (sharpening.sharpening !== 0) {
    run({
      mode: 3,
      amount: clamp(sharpening.sharpening, 0, 100) / 100,
      radius: clamp(
        clamp(sharpening.sharpenRadius, 0.5, 3) /
          clamp(sourceScale, 1 / 64, 64),
        0.25,
        192,
      ),
      detail: 0.5 + clamp(sharpening.sharpenDetail, 0, 100) / 100 * 1.5,
      masking: clamp(sharpening.sharpenMasking, 0, 100) / 100,
    });
  }
  return current;
}

function renderPostCrop(
  state: GpuState,
  input: CpuRenderInput,
  targets: GpuTargets,
  source: WebGLTexture,
  region: RenderRegion,
): void {
  const gl = state.gl;
  const programValue = state.programs.postCrop;
  attach(gl, targets, [targets.postCrop]);
  gl.useProgram(programValue);
  bindTexture(gl, programValue, "uImage", 0, source);
  const dimensions = input.request.plan.qualityAndDimensions.outputDimensions;
  gl.uniform2f(gl.getUniformLocation(programValue, "uImageSize"), dimensions.width, dimensions.height);
  gl.uniform2f(
    gl.getUniformLocation(programValue, "uImageOrigin"),
    region.x,
    dimensions.height - region.y - region.height,
  );
  const postCrop = input.document.effects.postCrop;
  gl.uniform1f(gl.getUniformLocation(programValue, "uVignette"), postCrop.vignette);
  gl.uniform1f(gl.getUniformLocation(programValue, "uMidpoint"), postCrop.vignetteMidpoint);
  gl.uniform1f(gl.getUniformLocation(programValue, "uRoundness"), postCrop.vignetteRoundness);
  gl.uniform1f(gl.getUniformLocation(programValue, "uFeather"), postCrop.vignetteFeather);
  gl.uniform1f(gl.getUniformLocation(programValue, "uHighlights"), postCrop.vignetteHighlights);
  draw(gl);
}

function renderEncoded(state: GpuState, targets: GpuTargets): void {
  const gl = state.gl;
  const programValue = state.programs.encode;
  gl.bindFramebuffer(gl.FRAMEBUFFER, null);
  gl.useProgram(programValue);
  bindTexture(gl, programValue, "uImage", 0, targets.postCrop);
  draw(gl);
}

function flippedRgba8(source: Uint8Array, width: number, height: number): Uint8Array {
  const target = new Uint8Array(source.length);
  const rowLength = width * 4;
  for (let y = 0; y < height; y += 1) {
    target.set(
      source.subarray((height - 1 - y) * rowLength, (height - y) * rowLength),
      y * rowLength,
    );
  }
  return target;
}

function readOutputPixels(
  gl: WebGL2RenderingContext,
  width: number,
  height: number,
): Uint8Array {
  const rawPixels = new Uint8Array(width * height * 4);
  gl.bindFramebuffer(gl.FRAMEBUFFER, null);
  gl.readPixels(0, 0, width, height, gl.RGBA, gl.UNSIGNED_BYTE, rawPixels);
  return flippedRgba8(rawPixels, width, height);
}

function pointColorInput(
  source: Float32Array,
  width: number,
  height: number,
): CpuPointColorInput {
  const pixels = new Float32Array(width * height * 3);
  for (let y = 0; y < height; y += 1) {
    const sourceY = height - 1 - y;
    for (let x = 0; x < width; x += 1) {
      const sourceOffset = (sourceY * width + x) * 4;
      const targetOffset = (y * width + x) * 3;
      pixels[targetOffset] = source[sourceOffset] ?? 0;
      pixels[targetOffset + 1] = source[sourceOffset + 1] ?? 0;
      pixels[targetOffset + 2] = source[sourceOffset + 2] ?? 0;
    }
  }
  return { dimensions: { width, height }, pixels };
}

function readFloatTexture(
  gl: WebGL2RenderingContext,
  targets: GpuTargets,
  value: WebGLTexture,
): Float32Array {
  attach(gl, targets, [value]);
  const pixels = new Float32Array(targets.width * targets.height * 4);
  gl.readPixels(0, 0, targets.width, targets.height, gl.RGBA, gl.FLOAT, pixels);
  return pixels;
}

function requestedAnalysis(
  input: CpuRenderInput,
  toneInput: Float32Array | null,
  scene: Float32Array | null,
  pixels: Uint8Array | null,
): readonly CpuAnalysisTapResult[] {
  const dimensions = input.request.plan.qualityAndDimensions.outputDimensions;
  const results: CpuAnalysisTapResult[] = [];
  for (const tap of input.request.requestedTaps) {
    switch (tap) {
      case "tone-input":
        if (!toneInput) break;
        results.push(analyzeV3ToneInput({
          width: dimensions.width,
          height: dimensions.height,
          channels: 4,
          data: toneInput,
        }));
        break;
      case "display-output":
        if (!pixels) break;
        results.push(analyzeV3DisplayOutput(pixels, dimensions));
        break;
      case "scene-headroom":
        if (!scene) break;
        results.push(analyzeV3SceneHeadroom({
          width: dimensions.width,
          height: dimensions.height,
          channels: 4,
          data: scene,
        }));
        break;
      case "wb-sample":
      case "proof-output":
        results.push({
          tap,
          state: {
            kind: "unavailable",
            reason: tap === "wb-sample"
              ? "WB sampling requires an explicit canonical sample region."
              : "The GPU preview backend has no verified proof transform.",
          },
        });
        break;
      default: {
        const exhaustive: never = tap;
        return exhaustive;
      }
    }
  }
  return results;
}

function fullOutputRegion(input: CpuRenderInput): RenderRegion {
  const dimensions = input.request.plan.qualityAndDimensions.outputDimensions;
  return { x: 0, y: 0, width: dimensions.width, height: dimensions.height };
}

function validRenderRegion(
  region: RenderRegion,
  dimensions: { readonly width: number; readonly height: number },
): boolean {
  return [region.x, region.y, region.width, region.height].every(Number.isSafeInteger) &&
    region.x >= 0 && region.y >= 0 && region.width >= 1 && region.height >= 1 &&
    region.x + region.width <= dimensions.width &&
    region.y + region.height <= dimensions.height;
}

function expandedGpuRegion(
  core: RenderRegion,
  dimensions: { readonly width: number; readonly height: number },
  halo: number,
): RenderRegion {
  const x = Math.max(0, core.x - halo);
  const y = Math.max(0, core.y - halo);
  const right = Math.min(dimensions.width, core.x + core.width + halo);
  const bottom = Math.min(dimensions.height, core.y + core.height + halo);
  return { x, y, width: right - x, height: bottom - y };
}

function copyCorePixels(
  destination: Uint8Array,
  source: Uint8Array,
  renderedRegion: RenderRegion,
  core: RenderRegion,
  outputWidth: number,
  targetOrigin: { readonly x: number; readonly y: number } = { x: 0, y: 0 },
): void {
  const sourceX = core.x - renderedRegion.x;
  const sourceY = core.y - renderedRegion.y;
  for (let y = 0; y < core.height; y += 1) {
    const sourceOffset = ((sourceY + y) * renderedRegion.width + sourceX) * 4;
    const targetOffset = ((targetOrigin.y + y) * outputWidth + targetOrigin.x) * 4;
    destination.set(
      source.subarray(sourceOffset, sourceOffset + core.width * 4),
      targetOffset,
    );
  }
}

export class V3GpuPreviewRenderer {
  #state: GpuState | null = null;
  #unavailable = false;

  dispose(): void {
    const state = this.#state;
    if (!state) return;
    for (const targets of state.targets.values()) deleteTargets(state.gl, targets);
    for (const map of state.geometryMaps.values()) {
      state.gl.deleteTexture(map.texture);
    }
    state.gl.deleteTexture(state.source);
    state.gl.deleteProgram(state.programs.pointwise);
    state.gl.deleteProgram(state.programs.pointwiseInteger);
    state.gl.deleteProgram(state.programs.spatial);
    state.gl.deleteProgram(state.programs.postCrop);
    state.gl.deleteProgram(state.programs.encode);
    for (const value of state.localAdjustments.values()) {
      state.gl.deleteTexture(value);
    }
    this.#state = null;
  }

  async render(
    input: CpuRenderInput,
    options: { readonly includeAnalysis: boolean },
  ): Promise<V3GpuPreviewRenderResult | null> {
    if (this.#unavailable || v3GpuPreviewSupport(input).kind !== "supported") return null;
    const preparation = await prepareV3CpuRender(input);
    if (preparation.kind !== "ready") return preparation;
    try {
      const frame = this.#renderFrame(
        input,
        options.includeAnalysis,
        fullOutputRegion(input),
        "half",
        false,
      );
      if (!frame.bitmap) throw new Error("The GPU preview bitmap is unavailable.");
      return {
        kind: "rendered",
        planFingerprint: preparation.planFingerprint,
        frameIdentity: preparation.frameIdentity,
        dimensions: input.request.plan.qualityAndDimensions.outputDimensions,
        bitmap: frame.bitmap,
        pointColorInput: frame.pointColorInput,
        diagnostics: preparation.diagnostics,
        analysis: frame.analysis,
      };
    } catch (error) {
      console.warn(
        "[Darkroom] GPU preview unavailable; using the CPU fallback.",
        error,
      );
      this.dispose();
      this.#unavailable = true;
      return null;
    }
  }

  async renderRegion(
    input: CpuRenderInput,
    core: RenderRegion,
  ): Promise<CpuRenderResult | null> {
    if (this.#unavailable || v3GpuPreviewSupport(input).kind !== "supported") return null;
    const preparation = await prepareV3CpuRender(input);
    if (preparation.kind !== "ready") return null;
    const dimensions = input.request.plan.qualityAndDimensions.outputDimensions;
    if (!validRenderRegion(core, dimensions)) return null;
    try {
      const pixels = this.#renderCore(input, core, "float");
      return {
        kind: "rendered",
        planFingerprint: preparation.planFingerprint,
        frameIdentity: preparation.frameIdentity,
        dimensions: { width: core.width, height: core.height },
        pixels: { kind: "rgba8", pixels },
        pointColorInput: null,
        diagnostics: preparation.diagnostics,
        analysis: [],
      };
    } catch (error) {
      console.warn(
        "[Darkroom] GPU region rendering unavailable; using the CPU fallback.",
        error,
      );
      this.dispose();
      this.#unavailable = true;
      return null;
    }
  }

  async renderExport(input: CpuRenderInput): Promise<CpuRenderResult | null> {
    if (
      this.#unavailable ||
      input.request.plan.qualityAndDimensions.kind !== "export" ||
      input.request.requestedTaps.length > 0 ||
      v3GpuPreviewSupport(input).kind !== "supported"
    ) return null;
    const preparation = await prepareV3CpuRender(input);
    if (preparation.kind !== "ready") return null;
    const core = fullOutputRegion(input);
    try {
      const pixels = this.#renderCore(input, core, "float");
      return {
        kind: "rendered",
        planFingerprint: preparation.planFingerprint,
        frameIdentity: preparation.frameIdentity,
        dimensions: { width: core.width, height: core.height },
        pixels: { kind: "rgba8", pixels },
        pointColorInput: null,
        diagnostics: preparation.diagnostics,
        analysis: [],
      };
    } catch (error) {
      console.warn(
        "[Darkroom] GPU export rendering unavailable; using the CPU fallback.",
        error,
      );
      this.dispose();
      this.#unavailable = true;
      return null;
    }
  }

  #renderCore(
    input: CpuRenderInput,
    core: RenderRegion,
    precision: "half" | "float",
  ): Uint8Array {
    const dimensions = input.request.plan.qualityAndDimensions.outputDimensions;
    const pixels = new Uint8Array(core.width * core.height * 4);
    const halo = activeStageHalo(input);
    for (let y = core.y; y < core.y + core.height; y += GPU_TILE_EDGE) {
      for (let x = core.x; x < core.x + core.width; x += GPU_TILE_EDGE) {
        const tileCore = {
          x,
          y,
          width: Math.min(GPU_TILE_EDGE, core.x + core.width - x),
          height: Math.min(GPU_TILE_EDGE, core.y + core.height - y),
        };
        const renderedRegion = expandedGpuRegion(tileCore, dimensions, halo);
        const frame = this.#renderFrame(
          input,
          false,
          renderedRegion,
          precision,
          true,
        );
        const tilePixels = frame.pixels;
        frame.bitmap?.close();
        if (!tilePixels) throw new Error("The GPU tile readback is unavailable.");
        copyCorePixels(
          pixels,
          tilePixels,
          renderedRegion,
          tileCore,
          core.width,
          { x: tileCore.x - core.x, y: tileCore.y - core.y },
        );
      }
    }
    return pixels;
  }

  #initialize(input: CpuRenderInput): GpuState {
    const canvas = new OffscreenCanvas(1, 1);
    const gl = canvas.getContext("webgl2", {
      alpha: true,
      antialias: false,
      depth: false,
      preserveDrawingBuffer: true,
      premultipliedAlpha: false,
    });
    if (!gl || !gl.getExtension("EXT_color_buffer_float")) {
      throw new Error("Float WebGL rendering is unavailable.");
    }
    if (!gl.getExtension("OES_texture_float_linear")) {
      throw new Error("Linear float texture sampling is unavailable.");
    }
    const maximumTextureSize = gl.getParameter(gl.MAX_TEXTURE_SIZE) as number;
    if (
      input.image.sourceWidth > maximumTextureSize ||
      input.image.sourceHeight > maximumTextureSize
    ) {
      throw new Error("The GPU source exceeds the maximum texture size.");
    }
    const state: GpuState = {
      canvas,
      gl,
      programs: {
        pointwise: program(gl, POINTWISE_SHADER),
        pointwiseInteger: program(gl, POINTWISE_SHADER, true),
        spatial: program(gl, SPATIAL_SHADER),
        postCrop: program(gl, POST_CROP_SHADER),
        encode: program(gl, ENCODE_SHADER),
      },
      source: sourceTexture(gl, input),
      sourceIsInteger: integerSource(input),
      targets: new Map(),
      geometryMaps: new Map(),
      localAdjustments: new Map(),
    };
    this.#state = state;
    return state;
  }

  #targets(
    state: GpuState,
    width: number,
    height: number,
    precision: "half" | "float",
  ): GpuTargets {
    const key = `${precision}:${width}x${height}`;
    const current = state.targets.get(key);
    if (current) {
      state.targets.delete(key);
      state.targets.set(key, current);
      state.canvas.width = width;
      state.canvas.height = height;
      state.gl.viewport(0, 0, width, height);
      return current;
    }
    const targets = createTargets(state.gl, width, height, precision);
    state.targets.set(key, targets);
    for (const [cachedKey, cachedTargets] of state.targets) {
      if (
        cachedKey !== key &&
        width * height > REFINED_PREVIEW_MAX_PIXELS &&
        cachedTargets.width * cachedTargets.height > REFINED_PREVIEW_MAX_PIXELS
      ) {
        state.targets.delete(cachedKey);
        deleteTargets(state.gl, cachedTargets);
      }
    }
    while (state.targets.size > MAX_CACHED_TARGETS) {
      const oldestKey = state.targets.keys().next().value;
      if (oldestKey === undefined) break;
      const oldest = state.targets.get(oldestKey);
      state.targets.delete(oldestKey);
      if (oldest) deleteTargets(state.gl, oldest);
    }
    state.canvas.width = width;
    state.canvas.height = height;
    state.gl.viewport(0, 0, width, height);
    return targets;
  }

  #geometryMap(
    state: GpuState,
    input: CpuRenderInput,
    region: RenderRegion,
  ): WebGLTexture {
    const key = geometryMapKey(input, region);
    const current = state.geometryMaps.get(key);
    if (current) {
      state.geometryMaps.delete(key);
      state.geometryMaps.set(key, current);
      return current.texture;
    }
    const value = texture(state.gl, {
      width: region.width,
      height: region.height,
      internalFormat: state.gl.RGBA32F,
      format: state.gl.RGBA,
      type: state.gl.FLOAT,
      pixels: geometryMapPixels(input, region),
      filter: state.gl.NEAREST,
    });
    state.geometryMaps.set(key, { key, texture: value });
    while (state.geometryMaps.size > MAX_CACHED_GEOMETRY_MAPS) {
      const oldestKey = state.geometryMaps.keys().next().value;
      if (oldestKey === undefined) break;
      const oldest = state.geometryMaps.get(oldestKey);
      state.geometryMaps.delete(oldestKey);
      if (oldest) state.gl.deleteTexture(oldest.texture);
    }
    return value;
  }

  #renderFrame(
    input: CpuRenderInput,
    includeAnalysis: boolean,
    region: RenderRegion,
    precision: "half" | "float",
    readPixels: boolean,
  ): GpuRenderedFrame {
    const state = this.#state ?? this.#initialize(input);
    if (state.gl.isContextLost()) throw new Error("The GPU preview context was lost.");
    if (state.sourceIsInteger !== integerSource(input)) {
      throw new Error("The GPU preview source precision changed after initialization.");
    }
    if (!gpuRegionWithinLimits(state, input, region)) {
      throw new Error("The GPU render region exceeds the maximum texture size.");
    }
    const dimensions = { width: region.width, height: region.height };
    const targets = this.#targets(state, dimensions.width, dimensions.height, precision);
    const map = this.#geometryMap(state, input, region);
    const localAdjustments = localAdjustmentTexture(state, input, region);
    renderPointwise(state, input, targets, map, localAdjustments);
    const spatial = renderSpatial(state, input, targets);
    renderPostCrop(state, input, targets, spatial, region);
    renderEncoded(state, targets);
    if (!includeAnalysis) {
      const pixels = readPixels
        ? readOutputPixels(state.gl, dimensions.width, dimensions.height)
        : null;
      const wantsPointColor = !readPixels &&
        input.includePointColor !== false &&
        input.request.plan.qualityAndDimensions.kind !== "export";
      const pointInput = wantsPointColor
        ? readFloatTexture(state.gl, targets, targets.pointColorInput)
        : null;
      return {
        bitmap: readPixels ? null : state.canvas.transferToImageBitmap(),
        pixels,
        pointColorInput: pointInput
          ? pointColorInput(pointInput, dimensions.width, dimensions.height)
          : null,
        analysis: [],
      };
    }

    const wantsToneInput = input.request.requestedTaps.includes("tone-input");
    const wantsDisplayOutput = input.request.requestedTaps.includes("display-output");
    const wantsSceneHeadroom = input.request.requestedTaps.includes("scene-headroom");
    const pixels = wantsDisplayOutput || readPixels
      ? readOutputPixels(state.gl, dimensions.width, dimensions.height)
      : null;
    const toneInput = wantsToneInput
      ? readFloatTexture(state.gl, targets, targets.toneInput)
      : null;
    const scene = wantsSceneHeadroom
      ? readFloatTexture(state.gl, targets, targets.postCrop)
      : null;
    const pointInput = input.includePointColor === false ||
      input.request.plan.qualityAndDimensions.kind === "export"
      ? null
      : readFloatTexture(state.gl, targets, targets.pointColorInput);
    const analysis = requestedAnalysis(input, toneInput, scene, pixels);
    return {
      bitmap: readPixels ? null : state.canvas.transferToImageBitmap(),
      pixels: readPixels ? pixels : null,
      pointColorInput: pointInput
        ? pointColorInput(pointInput, dimensions.width, dimensions.height)
        : null,
      analysis,
    };
  }
}
