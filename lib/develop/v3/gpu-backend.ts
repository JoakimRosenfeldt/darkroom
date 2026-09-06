import {
  analyzeV3DisplayOutput,
  analyzeV3SceneHeadroom,
  analyzeV3ToneInput,
  prepareV3CpuRender,
  type CpuAnalysisTapResult,
  type CpuPointColorInput,
  type CpuRenderInput,
  type CpuRenderResult,
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
  type LensCalibration,
} from "@/lib/develop/v3/optics";
import { effectiveInputCalibration } from "@/lib/develop/v3/profiles";

const CURVE_LUT_SIZE = 1_024;
const MAX_CACHED_GEOMETRY_MAPS = 3;
const MAX_CACHED_TARGETS = 3;
const REFINED_PREVIEW_MAX_PIXELS = 64_000;
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
precision highp sampler2D;
uniform sampler2D uSource;
uniform sampler2D uMap;
uniform sampler2D uCurves;
uniform ivec2 uOutputSize;
uniform int uTransfer;
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
  vec3 decoded = texelFetch(uSource, pixel, 0).rgb;
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
  vec3 toneInput = sourceColor(mapping.xy);
  vec3 pointColorInput = curves(basicTone(toneInput));
  outColor = vec4(pointColorInput, 1.0);
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

vec3 sampleAt(vec2 offsetPixels) {
  return texture(uImage, clamp(vUv + offsetPixels / uImageSize, vec2(0.0), vec2(1.0))).rgb;
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
  vec4 source = texture(uImage, vUv);
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
    vec2 normalized = abs((gl_FragCoord.xy / uImageSize - 0.5) * 2.0);
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
  readonly spatial: WebGLProgram;
  readonly postCrop: WebGLProgram;
  readonly encode: WebGLProgram;
}

interface GpuTargets {
  readonly width: number;
  readonly height: number;
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
  readonly targets: Map<string, GpuTargets>;
  readonly geometryMaps: Map<string, GeometryMap>;
}

interface GpuRenderedFrame {
  readonly bitmap: ImageBitmap;
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
    !mask.enabled || Object.values(mask.adjustments).every((value) => value === 0)
  );
}

function mixerIsNeutral(document: DevelopDocumentV3): boolean {
  return Object.values(document.color.mixer).every((band) =>
    band.hue === 0 && band.saturation === 0 && band.luminance === 0
  );
}

function gradingIsNeutral(document: DevelopDocumentV3): boolean {
  const grading = document.color.grading;
  return [grading.shadows, grading.midtones, grading.highlights].every((wheel) =>
    wheel.saturation === 0 && wheel.luminance === 0
  );
}

export function v3GpuPreviewSupport(input: CpuRenderInput): GpuSupport {
  if (typeof OffscreenCanvas === "undefined") {
    return { kind: "unsupported", reason: "OffscreenCanvas is unavailable." };
  }
  if (input.image.bits !== 8 || input.image.rgb instanceof Uint16Array) {
    return { kind: "unsupported", reason: "High-bit GPU source upload is unavailable." };
  }
  if (input.document.compatibility.legacyV2) {
    return { kind: "unsupported", reason: "Frozen v2 rendering uses the CPU reference path." };
  }
  if (!inactiveLocalEdits(input.document)) {
    return { kind: "unsupported", reason: "Active local adjustments use the CPU reference path." };
  }
  if (input.document.cleanup.components.some((component) => component.enabled)) {
    return { kind: "unsupported", reason: "Active Cleanup components use the CPU reference path." };
  }
  const denoise = input.document.detail.noiseReduction;
  if (denoise.noiseReduction !== 0 || denoise.colorNoiseReduction !== 0) {
    return { kind: "unsupported", reason: "Active denoise uses the CPU reference path." };
  }
  if (input.document.color.pointColor.adjustments.some((adjustment) => adjustment.enabled)) {
    return { kind: "unsupported", reason: "Active Point Color uses the CPU reference path." };
  }
  if (!mixerIsNeutral(input.document)) {
    return { kind: "unsupported", reason: "Active Color Mixer uses the CPU reference path." };
  }
  if (input.document.color.monochrome.enabled || !gradingIsNeutral(input.document)) {
    return { kind: "unsupported", reason: "Active color effects use the CPU reference path." };
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

function program(gl: WebGL2RenderingContext, fragmentSource: string): WebGLProgram {
  const vertex = shader(gl, gl.VERTEX_SHADER, VERTEX_SHADER);
  const fragment = shader(gl, gl.FRAGMENT_SHADER, fragmentSource);
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
  const value = texture(gl, {
    width: input.image.sourceWidth,
    height: input.image.sourceHeight,
    internalFormat: gl.RGBA8,
    format: gl.RGBA,
    type: gl.UNSIGNED_BYTE,
    pixels: sourcePixels(input),
    filter: gl.NEAREST,
  });
  gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false);
  return value;
}

function floatTarget(gl: WebGL2RenderingContext, width: number, height: number): WebGLTexture {
  return texture(gl, {
    width,
    height,
    internalFormat: gl.RGBA16F,
    format: gl.RGBA,
    type: gl.HALF_FLOAT,
    pixels: null,
    filter: gl.LINEAR,
  });
}

function createTargets(gl: WebGL2RenderingContext, width: number, height: number): GpuTargets {
  const framebuffer = gl.createFramebuffer();
  if (!framebuffer) throw new Error("Could not create a GPU framebuffer.");
  return {
    width,
    height,
    pointwise: floatTarget(gl, width, height),
    toneInput: floatTarget(gl, width, height),
    pointColorInput: floatTarget(gl, width, height),
    scratch: floatTarget(gl, width, height),
    postCrop: floatTarget(gl, width, height),
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

function geometryMapPixels(input: CpuRenderInput): Float32Array {
  const dimensions = input.request.plan.qualityAndDimensions.outputDimensions;
  const stages = geometryStages(input);
  const userCrop = resolveConstrainedCrop(stages.user);
  const opticsCrop = resolveConstrainedCrop(stages.optics);
  const pixels = new Float32Array(dimensions.width * dimensions.height * 4);
  for (let y = 0; y < dimensions.height; y += 1) {
    for (let x = 0; x < dimensions.width; x += 1) {
      const output = {
        x: (x + 0.5) / dimensions.width,
        y: 1 - (y + 0.5) / dimensions.height,
      };
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

function geometryMapKey(input: CpuRenderInput): string {
  const dimensions = input.request.plan.qualityAndDimensions.outputDimensions;
  const stages = geometryStages(input);
  return [
    dimensions.width,
    dimensions.height,
    geometryCacheIdentity(stages.user),
    geometryCacheIdentity(stages.optics),
  ].join("\u001f");
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
): void {
  const gl = state.gl;
  const programValue = state.programs.pointwise;
  const curves = curveTexture(gl, input.document);
  attach(gl, targets, [targets.pointwise, targets.toneInput, targets.pointColorInput]);
  gl.useProgram(programValue);
  bindTexture(gl, programValue, "uSource", 0, state.source);
  bindTexture(gl, programValue, "uMap", 1, map);
  bindTexture(gl, programValue, "uCurves", 2, curves);
  const dimensions = input.request.plan.qualityAndDimensions.outputDimensions;
  gl.uniform2i(gl.getUniformLocation(programValue, "uOutputSize"), dimensions.width, dimensions.height);
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
  const sourceScale = Math.max(
    sourceDimensions.width / targets.width,
    sourceDimensions.height / targets.height,
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
): void {
  const gl = state.gl;
  const programValue = state.programs.postCrop;
  attach(gl, targets, [targets.postCrop]);
  gl.useProgram(programValue);
  bindTexture(gl, programValue, "uImage", 0, source);
  gl.uniform2f(gl.getUniformLocation(programValue, "uImageSize"), targets.width, targets.height);
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
  toneInput: Float32Array,
  scene: Float32Array,
  pixels: Uint8Array,
): readonly CpuAnalysisTapResult[] {
  const dimensions = input.request.plan.qualityAndDimensions.outputDimensions;
  const results: CpuAnalysisTapResult[] = [];
  for (const tap of input.request.requestedTaps) {
    switch (tap) {
      case "tone-input":
        results.push(analyzeV3ToneInput({
          width: dimensions.width,
          height: dimensions.height,
          channels: 4,
          data: toneInput,
        }));
        break;
      case "display-output":
        results.push(analyzeV3DisplayOutput(pixels, dimensions));
        break;
      case "scene-headroom":
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
    state.gl.deleteProgram(state.programs.spatial);
    state.gl.deleteProgram(state.programs.postCrop);
    state.gl.deleteProgram(state.programs.encode);
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
      const frame = this.#renderFrame(input, options.includeAnalysis);
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
    const state: GpuState = {
      canvas,
      gl,
      programs: {
        pointwise: program(gl, POINTWISE_SHADER),
        spatial: program(gl, SPATIAL_SHADER),
        postCrop: program(gl, POST_CROP_SHADER),
        encode: program(gl, ENCODE_SHADER),
      },
      source: sourceTexture(gl, input),
      targets: new Map(),
      geometryMaps: new Map(),
    };
    this.#state = state;
    return state;
  }

  #targets(state: GpuState, width: number, height: number): GpuTargets {
    const key = `${width}x${height}`;
    const current = state.targets.get(key);
    if (current) {
      state.targets.delete(key);
      state.targets.set(key, current);
      state.canvas.width = width;
      state.canvas.height = height;
      state.gl.viewport(0, 0, width, height);
      return current;
    }
    const targets = createTargets(state.gl, width, height);
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

  #geometryMap(state: GpuState, input: CpuRenderInput): WebGLTexture {
    const key = geometryMapKey(input);
    const current = state.geometryMaps.get(key);
    if (current) {
      state.geometryMaps.delete(key);
      state.geometryMaps.set(key, current);
      return current.texture;
    }
    const dimensions = input.request.plan.qualityAndDimensions.outputDimensions;
    const value = texture(state.gl, {
      width: dimensions.width,
      height: dimensions.height,
      internalFormat: state.gl.RGBA32F,
      format: state.gl.RGBA,
      type: state.gl.FLOAT,
      pixels: geometryMapPixels(input),
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
  ): GpuRenderedFrame {
    const state = this.#state ?? this.#initialize(input);
    if (state.gl.isContextLost()) throw new Error("The GPU preview context was lost.");
    const dimensions = input.request.plan.qualityAndDimensions.outputDimensions;
    const targets = this.#targets(state, dimensions.width, dimensions.height);
    const map = this.#geometryMap(state, input);
    renderPointwise(state, input, targets, map);
    const spatial = renderSpatial(state, input, targets);
    renderPostCrop(state, input, targets, spatial);
    renderEncoded(state, targets);
    if (!includeAnalysis) {
      return {
        bitmap: state.canvas.transferToImageBitmap(),
        pointColorInput: null,
        analysis: [],
      };
    }

    const rawPixels = new Uint8Array(dimensions.width * dimensions.height * 4);
    state.gl.bindFramebuffer(state.gl.FRAMEBUFFER, null);
    state.gl.readPixels(
      0,
      0,
      dimensions.width,
      dimensions.height,
      state.gl.RGBA,
      state.gl.UNSIGNED_BYTE,
      rawPixels,
    );
    const pixels = flippedRgba8(rawPixels, dimensions.width, dimensions.height);
    const toneInput = readFloatTexture(state.gl, targets, targets.toneInput);
    const scene = readFloatTexture(state.gl, targets, targets.postCrop);
    const pointInput = readFloatTexture(state.gl, targets, targets.pointColorInput);
    const analysis = requestedAnalysis(input, toneInput, scene, pixels);
    return {
      bitmap: state.canvas.transferToImageBitmap(),
      pointColorInput: pointColorInput(pointInput, dimensions.width, dimensions.height),
      analysis,
    };
  }
}
