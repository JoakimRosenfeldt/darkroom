import type { DevelopImage } from "@/lib/cache/develop-image-cache";
import { clampCropRect } from "@/lib/develop/crop-geometry";
import { MAX_MATTE_EDGE } from "@/lib/develop/document";
import type {
  BasicSettings,
  CropSettings,
  DevelopDocument,
  DevelopSettings,
  LinearGradientMaskComponent,
  LocalMask,
  MaskComponent,
  MaskRasterAsset,
  RadialGradientMaskComponent,
  SourceSignature,
} from "@/lib/develop/types";
import {
  SOURCE_TRANSFORM_GLSL,
  sourceSignatureKey,
  sourceSignaturesEqual,
  transformOutputUv,
  type SourceTransformInput,
  type SourceRenderMode,
} from "@/lib/develop/source-transform";
import {
  MAX_EXPORT_EDGE,
  MAX_EXPORT_PIXELS,
  type ExportSizeOptions,
  type RawExportRenderResult,
} from "@/lib/export/types";
import { MIXER_COLORS } from "@/lib/develop/plugins/mixer";
import {
  createCurveLut,
  CURVE_LUT_SIZE,
} from "@/lib/develop/plugins/curve";

const VERTEX_SHADER = `#version 300 es
in vec2 a_position;
out vec2 v_uv;

void main() {
  v_uv = (a_position + 1.0) * 0.5;
  gl_Position = vec4(a_position, 0.0, 1.0);
}`;

const FRAGMENT_SHADER = `#version 300 es
precision highp float;
#ifdef INTEGER_TEXTURE
precision highp usampler2D;
uniform highp usampler2D u_image;
#else
precision highp sampler2D;
uniform sampler2D u_image;
#endif
precision highp sampler2DArray;

in vec2 v_uv;
out vec4 out_color;

uniform vec2 u_texel;
uniform vec2 u_source_texel;
uniform vec2 u_output_size;
uniform vec2 u_tile_origin;
uniform vec2 u_tile_size;
uniform vec4 u_source_tile;
uniform int u_orientation;
uniform float u_input_linear;
uniform float u_show_original;

uniform float u_crop_enabled;
uniform float u_crop_output;
uniform vec4 u_crop;
uniform float u_crop_angle;
uniform float u_perspective_x;
uniform float u_perspective_y;
uniform float u_distortion;

uniform float u_exposure;
uniform float u_contrast;
uniform float u_highlights;
uniform float u_shadows;
uniform float u_whites;
uniform float u_blacks;
uniform float u_temperature;
uniform float u_tint;
uniform float u_vibrance;
uniform float u_saturation;

uniform highp sampler2D u_curve;
uniform highp sampler2DArray u_masks;
uniform highp sampler2D u_overlay_mask;
uniform int u_mask_count;
uniform float u_local_basic[160];
uniform float u_overlay_enabled;
uniform float u_mixer[24];
uniform float u_vignette;
uniform float u_grain;
uniform float u_sharpening;
uniform float u_noise_reduction;

float luma(vec3 color) {
  return dot(color, vec3(0.2126, 0.7152, 0.0722));
}

vec3 encode_srgb(vec3 color) {
  vec3 low = color * 12.92;
  vec3 high = 1.055 * pow(max(color, vec3(0.0)), vec3(1.0 / 2.4)) - 0.055;
  return mix(high, low, lessThanEqual(color, vec3(0.0031308)));
}

vec3 linearize_srgb(vec3 color) {
  vec3 low = color / 12.92;
  vec3 high = pow(max((color + 0.055) / 1.055, vec3(0.0)), vec3(2.4));
  return mix(high, low, lessThanEqual(color, vec3(0.04045)));
}

vec3 adjust_exposure(vec3 color, float exposure) {
  vec3 linear = linearize_srgb(color);
  float gain = pow(2.0, exposure);
  return encode_srgb(linear * gain);
}

vec3 decode_transfer(vec3 color) {
  if (u_input_linear < 0.5) return color;
  return encode_srgb(color);
}

vec2 source_tile_uv(vec2 uv) {
  return clamp((uv - u_source_tile.xy) / u_source_tile.zw, vec2(0.0), vec2(1.0));
}

vec3 sample_image(vec2 uv) {
#ifdef INTEGER_TEXTURE
  ivec2 dimensions = textureSize(u_image, 0);
  vec2 tile_uv = source_tile_uv(uv);
  vec2 position = tile_uv * vec2(dimensions) - 0.5;
  ivec2 low = ivec2(floor(position));
  ivec2 high = low + 1;
  vec2 weight = fract(position);
  low = clamp(low, ivec2(0), dimensions - 1);
  high = clamp(high, ivec2(0), dimensions - 1);
  vec3 top = mix(
    vec3(texelFetch(u_image, ivec2(low.x, low.y), 0).rgb),
    vec3(texelFetch(u_image, ivec2(high.x, low.y), 0).rgb),
    weight.x
  );
  vec3 bottom = mix(
    vec3(texelFetch(u_image, ivec2(low.x, high.y), 0).rgb),
    vec3(texelFetch(u_image, ivec2(high.x, high.y), 0).rgb),
    weight.x
  );
  return decode_transfer(mix(top, bottom, weight.y) / 65535.0);
#else
  return decode_transfer(texture(u_image, source_tile_uv(uv)).rgb);
#endif
}

${SOURCE_TRANSFORM_GLSL}

float sample_mask(vec2 uv, int index) {
  vec2 clamped = clamp(uv, vec2(0.0), vec2(1.0));
  return texture(u_masks, vec3(clamped.x, 1.0 - clamped.y, float(index))).r;
}

vec3 adjust_basic(vec3 color, vec2 oriented_uv) {
  float exposure = u_exposure;
  float contrast = u_contrast;
  float highlights = u_highlights;
  float shadows = u_shadows;
  float whites = u_whites;
  float blacks = u_blacks;
  float temperature = u_temperature;
  float tint = u_tint;
  float vibrance = u_vibrance;
  float saturation_adjustment = u_saturation;
  for (int index = 0; index < 16; index++) {
    if (index >= u_mask_count) break;
    float coverage = sample_mask(oriented_uv, index);
    int base = index * 10;
    exposure += coverage * u_local_basic[base];
    contrast += coverage * u_local_basic[base + 1];
    highlights += coverage * u_local_basic[base + 2];
    shadows += coverage * u_local_basic[base + 3];
    whites += coverage * u_local_basic[base + 4];
    blacks += coverage * u_local_basic[base + 5];
    temperature += coverage * u_local_basic[base + 6];
    tint += coverage * u_local_basic[base + 7];
    vibrance += coverage * u_local_basic[base + 8];
    saturation_adjustment += coverage * u_local_basic[base + 9];
  }

  color = adjust_exposure(color, exposure);
  color *= vec3(
    1.0 + temperature * 0.00008 + tint * 0.00002,
    1.0 - abs(tint) * 0.00003,
    1.0 - temperature * 0.00008 - tint * 0.00002
  );

  float lum = luma(color);
  float shadow_mask = smoothstep(0.7, 0.0, lum);
  float highlight_mask = smoothstep(0.35, 1.0, lum);
  color += shadow_mask * shadows * 0.0015;
  color += highlight_mask * highlights * 0.0012;
  color += smoothstep(0.72, 1.0, lum) * whites * 0.0012;
  color += smoothstep(0.25, 0.0, lum) * blacks * 0.0012;
  color = (color - 0.5) * (1.0 + contrast * 0.0035) + 0.5;

  float average = (color.r + color.g + color.b) / 3.0;
  float saturation = max(max(color.r, color.g), color.b) - min(min(color.r, color.g), color.b);
  float vibrance_adjustment = vibrance * 0.0035 * (1.0 - saturation);
  color = mix(vec3(average), color, 1.0 + saturation_adjustment * 0.0035 + vibrance_adjustment);
  return color;
}

float sample_curve(float value, int channel) {
  float position = clamp(value, 0.0, 1.0) * ${CURVE_LUT_SIZE - 1}.0;
  int low = int(floor(position));
  int high = min(low + 1, ${CURVE_LUT_SIZE - 1});
  return mix(
    texelFetch(u_curve, ivec2(low, 0), 0)[channel],
    texelFetch(u_curve, ivec2(high, 0), 0)[channel],
    fract(position)
  );
}

vec3 adjust_curve(vec3 color) {
  vec3 master = vec3(
    sample_curve(color.r, 0),
    sample_curve(color.g, 0),
    sample_curve(color.b, 0)
  );
  return vec3(
    sample_curve(master.r, 1),
    sample_curve(master.g, 2),
    sample_curve(master.b, 3)
  );
}

vec3 rgb_to_hsl(vec3 c) {
  float maxc = max(max(c.r, c.g), c.b);
  float minc = min(min(c.r, c.g), c.b);
  float h = 0.0;
  float s = 0.0;
  float l = (maxc + minc) * 0.5;
  float d = maxc - minc;
  if (d > 0.0001) {
    s = d / (1.0 - abs(2.0 * l - 1.0));
    if (maxc == c.r) {
      h = mod((c.g - c.b) / d, 6.0);
    } else if (maxc == c.g) {
      h = (c.b - c.r) / d + 2.0;
    } else {
      h = (c.r - c.g) / d + 4.0;
    }
    h /= 6.0;
  }
  return vec3(h, s, l);
}

float hue_to_rgb(float p, float q, float t) {
  t = fract(t);
  if (t < 1.0 / 6.0) return p + (q - p) * 6.0 * t;
  if (t < 1.0 / 2.0) return q;
  if (t < 2.0 / 3.0) return p + (q - p) * (2.0 / 3.0 - t) * 6.0;
  return p;
}

vec3 hsl_to_rgb(vec3 hsl) {
  if (hsl.y <= 0.0001) return vec3(hsl.z);
  float q = hsl.z < 0.5 ? hsl.z * (1.0 + hsl.y) : hsl.z + hsl.y - hsl.z * hsl.y;
  float p = 2.0 * hsl.z - q;
  return vec3(
    hue_to_rgb(p, q, hsl.x + 1.0 / 3.0),
    hue_to_rgb(p, q, hsl.x),
    hue_to_rgb(p, q, hsl.x - 1.0 / 3.0)
  );
}

vec3 adjust_mixer(vec3 color) {
  const float centers[8] = float[8](
    0.0,
    0.0833333333,
    0.1666666667,
    0.3333333333,
    0.5,
    0.6666666667,
    0.75,
    0.8333333333
  );
  vec3 hsl = rgb_to_hsl(clamp(color, 0.0, 1.0));
  float source_hue = hsl.x;
  float hue_shift = 0.0;
  float saturation_scale = 1.0;
  float luminance_shift = 0.0;
  for (int i = 0; i < 8; i++) {
    float center = centers[i];
    float distance = min(abs(source_hue - center), 1.0 - abs(source_hue - center));
    float weight = smoothstep(0.18, 0.0, distance);
    int base = i * 3;
    hue_shift += u_mixer[base] * weight / 360.0;
    saturation_scale += u_mixer[base + 1] * weight * 0.01;
    luminance_shift += u_mixer[base + 2] * weight * 0.005;
  }
  hsl.x = fract(source_hue + hue_shift);
  hsl.y = clamp(hsl.y * saturation_scale, 0.0, 1.0);
  hsl.z = clamp(hsl.z + luminance_shift, 0.0, 1.0);
  return hsl_to_rgb(hsl);
}

float random(vec2 co) {
  return fract(sin(dot(co, vec2(12.9898, 78.233))) * 43758.5453);
}

vec3 adjust_effects(vec3 color, vec2 output_uv) {
  vec2 centered = output_uv - 0.5;
  float vignette = smoothstep(0.85, 0.15, length(centered));
  color *= mix(1.0, vignette, max(0.0, -u_vignette) * 0.012);
  color += (1.0 - vignette) * max(0.0, u_vignette) * 0.006;
  color += (random(u_tile_origin + gl_FragCoord.xy) - 0.5) * u_grain * 0.004;
  return color;
}

vec3 apply_tone(vec3 color, vec2 oriented_uv) {
  color = adjust_basic(color, oriented_uv);
  color = adjust_curve(color);
  return adjust_mixer(color);
}

vec3 sample_toned_output(vec2 output_uv) {
  vec2 bounded_output_uv = clamp(output_uv, vec2(0.0), vec2(1.0));
  vec2 oriented_uv = transform_oriented_uv(bounded_output_uv);
  vec2 min_uv = u_source_texel * 0.5;
  vec2 max_uv = 1.0 - min_uv;
  vec2 stored_uv = clamp(orient_uv(oriented_uv), min_uv, max_uv);
  return apply_tone(sample_image(stored_uv), oriented_uv);
}

void main() {
  vec2 min_uv = u_source_texel * 0.5;
  vec2 max_uv = 1.0 - min_uv;
  vec2 output_uv = (u_tile_origin + v_uv * u_tile_size) / u_output_size;
  vec2 oriented_uv = transform_oriented_uv(output_uv);
  vec2 uv = clamp(orient_uv(oriented_uv), min_uv, max_uv);

  vec3 center = sample_image(uv);
  if (u_show_original > 0.5) {
    out_color = vec4(center, 1.0);
    return;
  }

  vec3 color = apply_tone(center, oriented_uv);
  if (u_noise_reduction > 0.0 || u_sharpening > 0.0) {
    vec2 output_texel = 1.0 / u_output_size;
    vec3 neighbors =
      sample_toned_output(output_uv + vec2(output_texel.x, 0.0)) +
      sample_toned_output(output_uv - vec2(output_texel.x, 0.0)) +
      sample_toned_output(output_uv + vec2(0.0, output_texel.y)) +
      sample_toned_output(output_uv - vec2(0.0, output_texel.y));
    vec3 average = neighbors * 0.25;
    color = mix(color, average, u_noise_reduction * 0.003);
    color += (color - average) * u_sharpening * 0.015;
  }

  color = adjust_effects(color, output_uv);
  if (u_overlay_enabled > 0.5) {
    vec2 overlay_uv = clamp(oriented_uv, vec2(0.0), vec2(1.0));
    float overlay = texture(u_overlay_mask, vec2(overlay_uv.x, 1.0 - overlay_uv.y)).r;
    color = mix(color, vec3(1.0, 0.0, 0.0), overlay * 0.35);
  }
  out_color = vec4(clamp(color, 0.0, 1.0), 1.0);
}`;

const QUAD = new Float32Array([-1, -1, 1, -1, -1, 1, 1, 1]);

function compileShader(
  gl: WebGL2RenderingContext,
  type: number,
  source: string,
): WebGLShader {
  const shader = gl.createShader(type);
  if (!shader) {
    throw new Error("Could not create WebGL shader.");
  }
  gl.shaderSource(shader, source);
  gl.compileShader(shader);
  if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
    const message = gl.getShaderInfoLog(shader) ?? "Unknown shader error.";
    gl.deleteShader(shader);
    throw new Error(message);
  }
  return shader;
}

function createProgram(
  gl: WebGL2RenderingContext,
  integerTexture = false,
): WebGLProgram {
  const vertex = compileShader(gl, gl.VERTEX_SHADER, VERTEX_SHADER);
  const fragment = compileShader(
    gl,
    gl.FRAGMENT_SHADER,
    integerTexture
      ? FRAGMENT_SHADER.replace("#version 300 es\n", "#version 300 es\n#define INTEGER_TEXTURE\n")
      : FRAGMENT_SHADER,
  );
  const program = gl.createProgram();
  if (!program) {
    throw new Error("Could not create WebGL program.");
  }
  gl.bindAttribLocation(program, 0, "a_position");
  gl.attachShader(program, vertex);
  gl.attachShader(program, fragment);
  gl.linkProgram(program);
  gl.deleteShader(vertex);
  gl.deleteShader(fragment);
  if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
    const message = gl.getProgramInfoLog(program) ?? "Unknown WebGL link error.";
    gl.deleteProgram(program);
    throw new Error(message);
  }
  return program;
}

export type RenderDiagnostic =
  | {
      kind: "stale-ai";
      maskId: string;
      componentId: string;
      assetId: string;
      selector: "subject" | "sky";
      message: string;
    }
  | {
      kind: "missing-asset";
      maskId: string;
      componentId: string;
      assetId: string;
      message: string;
    }
  | {
      kind: "corrupt-asset";
      maskId: string;
      componentId: string;
      assetId: string;
      message: string;
    };

export interface RenderPreparation {
  diagnostics: readonly RenderDiagnostic[];
  matteWidth: number;
  matteHeight: number;
}

export interface RenderOptions {
  overlayMaskId?: string | null;
}

class MaskAssetError extends Error {
  readonly kind: "missing-asset" | "corrupt-asset";
  readonly assetId: string;

  constructor(
    kind: "missing-asset" | "corrupt-asset",
    assetId: string,
    message: string,
  ) {
    super(message);
    this.name = "MaskAssetError";
    this.kind = kind;
    this.assetId = assetId;
  }
}

class StaleRenderError extends Error {
  constructor() {
    super("Render work was superseded by a newer image or document.");
    this.name = "StaleRenderError";
  }
}

interface DecodedMaskAsset {
  width: number;
  height: number;
  pixels: Uint8Array;
}

type SourceRgb = Uint8Array | Uint16Array | Uint8ClampedArray;

interface SourceTile {
  x: number;
  y: number;
  width: number;
  height: number;
}

type OutputTile = SourceTile;

interface DrawRegion {
  outputWidth: number;
  outputHeight: number;
  tile: OutputTile;
}

interface CachedMask {
  key: string;
  adjustment: Uint8Array;
  inspection: Uint8Array;
}

interface PreparedMask {
  id: string;
  key: string;
  adjustment: Uint8Array;
  inspection: Uint8Array;
  adjustments: BasicSettings;
}

interface PreparedDocument {
  documentKey: string;
  sourceKey: string;
  masks: PreparedMask[];
  diagnostics: readonly RenderDiagnostic[];
  matteWidth: number;
  matteHeight: number;
}

const BASIC_FIELDS: readonly (keyof BasicSettings)[] = [
  "exposure",
  "contrast",
  "highlights",
  "shadows",
  "whites",
  "blacks",
  "temperature",
  "tint",
  "vibrance",
  "saturation",
];

const PNG_SIGNATURE = [
  0x89,
  0x50,
  0x4e,
  0x47,
  0x0d,
  0x0a,
  0x1a,
  0x0a,
] as const;

const MASK_ASSET_DECODE_CACHE = new Map<string, Promise<DecodedMaskAsset>>();
const MASK_ASSET_DECODE_CACHE_BYTES = new Map<string, number>();
let maskAssetDecodeCacheBytes = 0;
const MAX_MASK_ASSET_DECODE_CACHE_BYTES = 64 * 1024 * 1024;
const MAX_MASK_ASSET_DECODE_CACHE_ENTRIES = 32;
const MAX_MATTE_CACHE_BYTES = 64 * 1024 * 1024;
const MAX_MATTE_CACHE_ENTRIES = 8;
const EXPORT_TILE_EDGE = 2_048;

function copyBytes(bytes: Uint8Array): Uint8Array<ArrayBuffer> {
  const copy = new Uint8Array(new ArrayBuffer(bytes.byteLength));
  copy.set(bytes);
  return copy;
}

function readPngUint32(bytes: Uint8Array, offset: number): number {
  return bytes[offset]! * 0x1000000 +
    bytes[offset + 1]! * 0x10000 +
    bytes[offset + 2]! * 0x100 +
    bytes[offset + 3]!;
}

function decodeAssetBase64(asset: MaskRasterAsset): Uint8Array {
  let binary: string;
  try {
    binary = atob(asset.pngBase64);
  } catch {
    throw new MaskAssetError("corrupt-asset", asset.id, "The embedded mask is not valid Base64.");
  }
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index);
  }
  if (bytes.byteLength !== asset.byteLength) {
    throw new MaskAssetError(
      "corrupt-asset",
      asset.id,
      `Mask asset ${asset.id} has ${bytes.byteLength} bytes, expected ${asset.byteLength}.`,
    );
  }
  if (bytes.length < 33 || !PNG_SIGNATURE.every((value, index) => bytes[index] === value)) {
    throw new MaskAssetError("corrupt-asset", asset.id, `Mask asset ${asset.id} is not a PNG.`);
  }
  if (
    bytes[12] !== 0x49 ||
    bytes[13] !== 0x48 ||
    bytes[14] !== 0x44 ||
    bytes[15] !== 0x52
  ) {
    throw new MaskAssetError("corrupt-asset", asset.id, `Mask asset ${asset.id} has no PNG IHDR.`);
  }
  const width = readPngUint32(bytes, 16);
  const height = readPngUint32(bytes, 20);
  if (width !== asset.width || height !== asset.height) {
    throw new MaskAssetError(
      "corrupt-asset",
      asset.id,
      `Mask asset ${asset.id} dimensions do not match its metadata.`,
    );
  }
  return bytes;
}

function hexDigest(buffer: ArrayBuffer): string {
  return [...new Uint8Array(buffer)]
    .map((value) => value.toString(16).padStart(2, "0"))
    .join("");
}

async function decodeMaskAsset(asset: MaskRasterAsset): Promise<DecodedMaskAsset> {
  const bytes = decodeAssetBase64(asset);
  if (typeof crypto === "undefined" || !crypto.subtle) {
    throw new MaskAssetError("corrupt-asset", asset.id, "Mask verification is unavailable in this environment.");
  }
  const verifiedBytes = copyBytes(bytes);
  const digest = await crypto.subtle.digest("SHA-256", verifiedBytes);
  if (hexDigest(digest) !== asset.sha256) {
    throw new MaskAssetError("corrupt-asset", asset.id, `Mask asset ${asset.id} failed SHA-256 verification.`);
  }
  if (typeof createImageBitmap !== "function" || typeof document === "undefined") {
    throw new MaskAssetError("corrupt-asset", asset.id, "Mask PNG decoding is unavailable in this environment.");
  }

  let bitmap: ImageBitmap;
  try {
    bitmap = await createImageBitmap(new Blob([verifiedBytes], { type: asset.mimeType }));
  } catch {
    throw new MaskAssetError("corrupt-asset", asset.id, `Mask asset ${asset.id} could not be decoded.`);
  }
  try {
    if (bitmap.width !== asset.width || bitmap.height !== asset.height) {
      throw new MaskAssetError("corrupt-asset", asset.id, `Mask asset ${asset.id} decoded at the wrong size.`);
    }
    const canvas = document.createElement("canvas");
    canvas.width = bitmap.width;
    canvas.height = bitmap.height;
    const context = canvas.getContext("2d", { willReadFrequently: true });
    if (!context) {
      throw new MaskAssetError("corrupt-asset", asset.id, "Could not create a mask decoding context.");
    }
    context.drawImage(bitmap, 0, 0);
    const rgba = context.getImageData(0, 0, bitmap.width, bitmap.height).data;
    const pixels = new Uint8Array(bitmap.width * bitmap.height);
    for (let index = 0; index < pixels.length; index += 1) {
      pixels[index] = rgba[index * 4]!;
    }
    return { width: bitmap.width, height: bitmap.height, pixels };
  } finally {
    bitmap.close();
  }
}

function touchMaskAssetDecodeCache(key: string, promise: Promise<DecodedMaskAsset>): void {
  MASK_ASSET_DECODE_CACHE.delete(key);
  MASK_ASSET_DECODE_CACHE.set(key, promise);
}

function removeMaskAssetDecodeCacheEntry(key: string): void {
  const bytes = MASK_ASSET_DECODE_CACHE_BYTES.get(key) ?? 0;
  maskAssetDecodeCacheBytes -= bytes;
  MASK_ASSET_DECODE_CACHE.delete(key);
  MASK_ASSET_DECODE_CACHE_BYTES.delete(key);
}

function trimMaskAssetDecodeCache(): void {
  while (
    MASK_ASSET_DECODE_CACHE.size > 0 &&
    (MASK_ASSET_DECODE_CACHE.size > MAX_MASK_ASSET_DECODE_CACHE_ENTRIES ||
      maskAssetDecodeCacheBytes > MAX_MASK_ASSET_DECODE_CACHE_BYTES)
  ) {
    const oldestKey = MASK_ASSET_DECODE_CACHE.keys().next().value;
    if (typeof oldestKey !== "string") {
      break;
    }
    removeMaskAssetDecodeCacheEntry(oldestKey);
  }
}

function cachedMaskAsset(asset: MaskRasterAsset): Promise<DecodedMaskAsset> {
  const key = `${asset.id}:${asset.sha256}:${asset.byteLength}:${asset.width}x${asset.height}`;
  const current = MASK_ASSET_DECODE_CACHE.get(key);
  if (current) {
    touchMaskAssetDecodeCache(key, current);
    return current;
  }
  const decoded = decodeMaskAsset(asset);
  const expectedBytes = asset.width * asset.height;
  MASK_ASSET_DECODE_CACHE_BYTES.set(key, expectedBytes);
  maskAssetDecodeCacheBytes += expectedBytes;
  trimMaskAssetDecodeCache();
  MASK_ASSET_DECODE_CACHE.set(key, decoded);
  trimMaskAssetDecodeCache();
  decoded.then(
    (asset) => {
      if (MASK_ASSET_DECODE_CACHE.get(key) !== decoded) {
        return;
      }
      const reservedBytes = MASK_ASSET_DECODE_CACHE_BYTES.get(key) ?? 0;
      const bytes = asset.pixels.byteLength;
      MASK_ASSET_DECODE_CACHE_BYTES.set(key, bytes);
      maskAssetDecodeCacheBytes += bytes - reservedBytes;
      touchMaskAssetDecodeCache(key, decoded);
      trimMaskAssetDecodeCache();
    },
    () => {
      if (MASK_ASSET_DECODE_CACHE.get(key) === decoded) {
        removeMaskAssetDecodeCacheEntry(key);
      }
    },
  );
  return decoded;
}

function clampedCropSettings(crop: CropSettings): CropSettings {
  return { ...crop, ...clampCropRect(crop) };
}

function smoothStep(edge0: number, edge1: number, value: number): number {
  if (edge0 === edge1) {
    return value < edge0 ? 0 : 1;
  }
  const t = Math.max(0, Math.min(1, (value - edge0) / (edge1 - edge0)));
  return t * t * (3 - 2 * t);
}

function sourceOver(destination: number, source: number): number {
  return Math.min(255, source + Math.round(destination * (255 - source) / 255));
}

function composeComponent(
  destination: Uint8Array,
  source: Uint8Array,
  operation: "add" | "subtract",
): void {
  for (let index = 0; index < destination.length; index += 1) {
    const sourceAlpha = source[index]!;
    destination[index] = operation === "add"
      ? sourceOver(destination[index]!, sourceAlpha)
      : Math.round(destination[index]! * (255 - sourceAlpha) / 255);
  }
}

function paintBrushStamp(
  output: Uint8Array,
  centerX: number,
  centerY: number,
  radius: number,
  feather: number,
  alpha: number,
  width: number,
  height: number,
): void {
  const left = Math.max(0, Math.floor(centerX - radius));
  const right = Math.min(width - 1, Math.ceil(centerX + radius));
  const top = Math.max(0, Math.floor(centerY - radius));
  const bottom = Math.min(height - 1, Math.ceil(centerY + radius));
  const innerRadius = radius * (1 - feather);
  for (let y = top; y <= bottom; y += 1) {
    for (let x = left; x <= right; x += 1) {
      const distance = Math.hypot(x - centerX, y - centerY);
      const edge = distance <= innerRadius
        ? 1
        : 1 - smoothStep(innerRadius, radius, distance);
      const source = Math.round(Math.max(0, Math.min(1, edge * alpha)) * 255);
      if (source === 0) continue;
      const index = y * width + x;
      output[index] = sourceOver(output[index]!, source);
    }
  }
}

function rasterizeBrush(
  component: Extract<MaskComponent, { kind: "brush" }>,
  width: number,
  height: number,
): Uint8Array {
  const output = new Uint8Array(width * height);
  for (const stroke of component.strokes) {
    const radius = Math.max(0.5, (stroke.size ?? component.size) * Math.max(width, height) * 0.5);
    const feather = stroke.feather ?? component.feather;
    const alpha = (stroke.flow ?? component.flow) * (stroke.density ?? component.density);
    if (alpha <= 0) continue;
    const first = stroke.points[0]!;
    paintBrushStamp(
      output,
      first.x * (width - 1),
      first.y * (height - 1),
      radius,
      feather,
      alpha,
      width,
      height,
    );
    for (let index = 1; index < stroke.points.length; index += 1) {
      const start = stroke.points[index - 1]!;
      const end = stroke.points[index]!;
      const startX = start.x * (width - 1);
      const startY = start.y * (height - 1);
      const endX = end.x * (width - 1);
      const endY = end.y * (height - 1);
      const distance = Math.hypot(endX - startX, endY - startY);
      const steps = Math.max(1, Math.ceil(distance / Math.max(1, radius * 0.5)));
      for (let step = 1; step <= steps; step += 1) {
        const amount = step / steps;
        paintBrushStamp(
          output,
          startX + (endX - startX) * amount,
          startY + (endY - startY) * amount,
          radius,
          feather,
          alpha,
          width,
          height,
        );
      }
    }
  }
  return output;
}

function rasterizeLinearGradient(
  component: LinearGradientMaskComponent,
  width: number,
  height: number,
): Uint8Array {
  const output = new Uint8Array(width * height);
  const dx = (component.end.x - component.start.x) * Math.max(1, width - 1);
  const dy = (component.end.y - component.start.y) * Math.max(1, height - 1);
  const lengthSquared = dx * dx + dy * dy;
  if (lengthSquared < 0.000001) {
    return output;
  }
  const startX = component.start.x * Math.max(1, width - 1);
  const startY = component.start.y * Math.max(1, height - 1);
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const t = ((x - startX) * dx + (y - startY) * dy) / lengthSquared;
      output[y * width + x] = Math.round((1 - smoothStep(0, 1, t)) * 255);
    }
  }
  return output;
}

function rasterizeRadialGradient(
  component: RadialGradientMaskComponent,
  width: number,
  height: number,
): Uint8Array {
  const output = new Uint8Array(width * height);
  const radiusX = component.radiusX * Math.max(1, width - 1);
  const radiusY = component.radiusY * Math.max(1, height - 1);
  if (radiusX <= 0 || radiusY <= 0) {
    return output;
  }
  const angle = (component.rotation * Math.PI) / 180;
  const cos = Math.cos(angle);
  const sin = Math.sin(angle);
  const centerX = component.center.x * Math.max(1, width - 1);
  const centerY = component.center.y * Math.max(1, height - 1);
  const inner = 1 - component.feather;
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const dx = x - centerX;
      const dy = y - centerY;
      const rotatedX = cos * dx + sin * dy;
      const rotatedY = -sin * dx + cos * dy;
      const distance = Math.hypot(rotatedX / radiusX, rotatedY / radiusY);
      output[y * width + x] = Math.round((1 - smoothStep(inner, 1, distance)) * 255);
    }
  }
  return output;
}

function sampleDecodedMask(
  asset: DecodedMaskAsset,
  x: number,
  y: number,
  threshold: number,
): number {
  const sourceX = Math.max(0, Math.min(asset.width - 1, x * (asset.width - 1)));
  const sourceY = Math.max(0, Math.min(asset.height - 1, y * (asset.height - 1)));
  const lowX = Math.floor(sourceX);
  const lowY = Math.floor(sourceY);
  const highX = Math.min(asset.width - 1, lowX + 1);
  const highY = Math.min(asset.height - 1, lowY + 1);
  const weightX = sourceX - lowX;
  const weightY = sourceY - lowY;
  const top = asset.pixels[lowY * asset.width + lowX]! * (1 - weightX) +
    asset.pixels[lowY * asset.width + highX]! * weightX;
  const bottom = asset.pixels[highY * asset.width + lowX]! * (1 - weightX) +
    asset.pixels[highY * asset.width + highX]! * weightX;
  const value = (top * (1 - weightY) + bottom * weightY) / 255;
  return value < threshold ? 0 : value;
}

function rasterizeAi(
  component: Extract<MaskComponent, { kind: "ai" }>,
  asset: DecodedMaskAsset | undefined,
  width: number,
  height: number,
): Uint8Array {
  const output = new Uint8Array(width * height);
  if (!asset) {
    return output;
  }
  for (let y = 0; y < height; y += 1) {
    // PNG rows are top-down; masking coordinates are bottom-up.
    const assetY = 1 - y / Math.max(1, height - 1);
    for (let x = 0; x < width; x += 1) {
      output[y * width + x] = Math.round(
        sampleDecodedMask(asset, x / Math.max(1, width - 1), assetY, component.inference.threshold) * 255,
      );
    }
  }
  return output;
}

function rasterizeComponent(
  component: MaskComponent,
  width: number,
  height: number,
  assets: ReadonlyMap<string, DecodedMaskAsset>,
): Uint8Array {
  switch (component.kind) {
    case "brush":
      return rasterizeBrush(component, width, height);
    case "linear-gradient":
      return rasterizeLinearGradient(component, width, height);
    case "radial-gradient":
      return rasterizeRadialGradient(component, width, height);
    case "ai":
      return rasterizeAi(component, assets.get(component.assetId), width, height);
    default: {
      const exhaustive: never = component;
      return exhaustive;
    }
  }
}

function isStaleAi(
  component: Extract<MaskComponent, { kind: "ai" }>,
  sourceSignature: SourceSignature,
): boolean {
  return !sourceSignaturesEqual(component.source, sourceSignature);
}

function rasterizeMask(
  mask: LocalMask,
  width: number,
  height: number,
  assets: ReadonlyMap<string, DecodedMaskAsset>,
  sourceSignature: SourceSignature,
): { adjustment: Uint8Array; inspection: Uint8Array } {
  const adjustment = new Uint8Array(width * height);
  const inspection = new Uint8Array(width * height);
  let hasAdjustmentComponent = false;
  for (const component of mask.components) {
    const coverage = rasterizeComponent(component, width, height, assets);
    composeComponent(inspection, coverage, component.operation);
    const canAdjust = component.kind !== "ai" ||
      (!isStaleAi(component, sourceSignature) && assets.has(component.assetId));
    if (canAdjust) {
      hasAdjustmentComponent = true;
      composeComponent(adjustment, coverage, component.operation);
    }
  }
  if (mask.inverted && hasAdjustmentComponent) {
    for (let index = 0; index < adjustment.length; index += 1) {
      adjustment[index] = 255 - adjustment[index]!;
      inspection[index] = 255 - inspection[index]!;
    }
  }
  if (!mask.enabled) {
    adjustment.fill(0);
  }
  return { adjustment, inspection };
}

export class DevelopRenderer {
  private readonly canvas: HTMLCanvasElement;
  private readonly gl: WebGL2RenderingContext;
  private readonly program: WebGLProgram;
  private readonly integerProgram: WebGLProgram;
  private activeProgram: WebGLProgram;
  private readonly geometry: WebGLBuffer;
  private readonly curveTexture: WebGLTexture;
  private curveSettings: DevelopSettings["curve"] | null = null;
  private texture: WebGLTexture | null = null;
  private sourceBitmap: ImageBitmap | null = null;
  private sourceRgb: SourceRgb | null = null;
  private sourceTiled = false;
  private maxTextureSize = 1;
  private sourceTile: SourceTile = { x: 0, y: 0, width: 1, height: 1 };
  private sourceScratchCanvas: HTMLCanvasElement | null = null;
  private sourceScratchContext: CanvasRenderingContext2D | null = null;
  private maskTexture: WebGLTexture | null = null;
  private overlayTexture: WebGLTexture | null = null;
  private overlayKey: string | null = null;
  private maskTextureWidth = 0;
  private maskTextureHeight = 0;
  private maskTextureLayers = 0;
  private uploadedMaskKeys: string[] = [];
  private textureWidth = 1;
  private textureHeight = 1;
  private displayWidth = 1;
  private displayHeight = 1;
  private integerTexture = false;
  private inputLinear = false;
  private orientation = 1;
  private operation = 0;
  private disposed = false;
  private prepared: PreparedDocument | null = null;
  private readonly matteCache = new Map<string, CachedMask>();
  private matteCacheBytes = 0;

  constructor(canvas: HTMLCanvasElement, preserveDrawingBuffer = false) {
    const gl = canvas.getContext("webgl2", { preserveDrawingBuffer });
    if (!gl) {
      throw new Error("WebGL2 is not available.");
    }

    this.canvas = canvas;
    this.gl = gl;
    this.program = createProgram(gl);
    this.integerProgram = createProgram(gl, true);
    this.activeProgram = this.program;
    const curveTexture = gl.createTexture();
    if (!curveTexture) {
      gl.deleteProgram(this.program);
      gl.deleteProgram(this.integerProgram);
      throw new Error("Could not create curve texture.");
    }
    this.curveTexture = curveTexture;
    gl.activeTexture(gl.TEXTURE1);
    gl.bindTexture(gl.TEXTURE_2D, curveTexture);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
    gl.texImage2D(
      gl.TEXTURE_2D,
      0,
      gl.RGBA32F,
      CURVE_LUT_SIZE,
      1,
      0,
      gl.RGBA,
      gl.FLOAT,
      null,
    );
    gl.activeTexture(gl.TEXTURE0);
    const geometry = gl.createBuffer();
    if (!geometry) {
      gl.deleteTexture(this.curveTexture);
      gl.deleteProgram(this.program);
      gl.deleteProgram(this.integerProgram);
      throw new Error("Could not create WebGL geometry.");
    }
    this.geometry = geometry;
    this.configureGeometry();
  }

  private configureGeometry(): void {
    const gl = this.gl;
    gl.useProgram(this.activeProgram);
    gl.bindBuffer(gl.ARRAY_BUFFER, this.geometry);
    gl.bufferData(gl.ARRAY_BUFFER, QUAD, gl.STATIC_DRAW);
    gl.enableVertexAttribArray(0);
    gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);
  }

  private supportsIntegerTexture(): boolean {
    const gl = this.gl;
    const probe = gl.createTexture();
    if (!probe) {
      return false;
    }
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, probe);
    while (gl.getError() !== gl.NO_ERROR) {
      // Clear errors left by a previous upload before probing the format.
    }
    gl.texImage2D(
      gl.TEXTURE_2D,
      0,
      gl.RGB16UI,
      1,
      1,
      0,
      gl.RGB_INTEGER,
      gl.UNSIGNED_SHORT,
      new Uint16Array(3),
    );
    const supported = gl.getError() === gl.NO_ERROR;
    gl.deleteTexture(probe);
    return supported;
  }

  private disposeSourceBitmap(): void {
    this.sourceBitmap?.close();
    this.sourceBitmap = null;
    this.sourceRgb = null;
    this.sourceTiled = false;
    this.sourceTile = { x: 0, y: 0, width: 1, height: 1 };
  }

  private clearMatteCache(): void {
    this.matteCache.clear();
    this.matteCacheBytes = 0;
  }

  async setImage(image: DevelopImage): Promise<void> {
    if (this.disposed) {
      throw new Error("Renderer has been disposed.");
    }
    const operation = ++this.operation;
    this.prepared = null;
    this.clearMaskTextures();
    this.disposeSourceBitmap();
    this.clearMatteCache();
    const gl = this.gl;
    const nativePixels = image.metadata.decoderProvenance === "nikon-sdk" &&
      image.rgb instanceof Uint16Array;
    const metadataWidth = Number(image.metadata.sourceWidth);
    const metadataHeight = Number(image.metadata.sourceHeight);
    const sourceWidth = Number.isInteger(metadataWidth) && metadataWidth > 0
      ? metadataWidth
      : image.sourceWidth;
    const sourceHeight = Number.isInteger(metadataHeight) && metadataHeight > 0
      ? metadataHeight
      : image.sourceHeight;
    const orientation = image.orientation;
    const rotated = orientation >= 5 && orientation <= 8;

    if (
      nativePixels &&
      (!Number.isInteger(sourceWidth) ||
        !Number.isInteger(sourceHeight) ||
        sourceWidth <= 0 ||
        sourceHeight <= 0 ||
        image.colors !== 3 ||
        image.bits !== 16 ||
        image.rgb.length !== sourceWidth * sourceHeight * 3 ||
        orientation < 1 ||
        orientation > 8 ||
        image.width !== (rotated ? sourceHeight : sourceWidth) ||
        image.height !== (rotated ? sourceWidth : sourceHeight))
    ) {
      throw new Error("Nikon decoder returned invalid pixel dimensions.");
    }

    const maxTextureParameter = gl.getParameter(gl.MAX_TEXTURE_SIZE);
    const maxTextureSize = typeof maxTextureParameter === "number"
      ? maxTextureParameter
      : 0;
    if (maxTextureSize < 1) {
      throw new Error("Could not determine the WebGL texture limit.");
    }
    let bitmap: ImageBitmap | null = null;
    let uploadedWidth = sourceWidth;
    let uploadedHeight = sourceHeight;
    if (!nativePixels) {
      if (!image.blob) {
        throw new Error("Image preview is unavailable.");
      }
      bitmap = await createImageBitmap(image.blob);
      uploadedWidth = bitmap.width;
      uploadedHeight = bitmap.height;
    }

    const sourceTiled = uploadedWidth > maxTextureSize || uploadedHeight > maxTextureSize;
    let texture: WebGLTexture | null = null;
    let integerTexture = nativePixels && sourceTiled
      ? this.supportsIntegerTexture()
      : false;
    if (!sourceTiled) {
      texture = gl.createTexture();
      if (!texture) {
        bitmap?.close();
        throw new Error("Could not create WebGL texture.");
      }
      gl.activeTexture(gl.TEXTURE0);
      gl.bindTexture(gl.TEXTURE_2D, texture);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    }

    if (nativePixels) {
      if (sourceTiled) {
        image.metadata.rendererPrecision = integerTexture
          ? "rgb16ui"
          : "rgba8-fallback";
      } else {
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
        gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1);
        while (gl.getError() !== gl.NO_ERROR) {
          // Clear errors so only the RGB16UI upload determines fallback behavior.
        }
        gl.texImage2D(
          gl.TEXTURE_2D,
          0,
          gl.RGB16UI,
          sourceWidth,
          sourceHeight,
          0,
          gl.RGB_INTEGER,
          gl.UNSIGNED_SHORT,
          image.rgb,
        );
        integerTexture = gl.getError() === gl.NO_ERROR;
        if (!integerTexture) {
          const rgba = new Uint8Array(sourceWidth * sourceHeight * 4);
          for (let source = 0, target = 0; source < image.rgb.length; source += 3, target += 4) {
            rgba[target] = image.rgb[source]! >> 8;
            rgba[target + 1] = image.rgb[source + 1]! >> 8;
            rgba[target + 2] = image.rgb[source + 2]! >> 8;
            rgba[target + 3] = 255;
          }
          gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
          gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
          gl.texImage2D(
            gl.TEXTURE_2D,
            0,
            gl.RGBA,
            sourceWidth,
            sourceHeight,
            0,
            gl.RGBA,
            gl.UNSIGNED_BYTE,
            rgba,
          );
          if (gl.getError() !== gl.NO_ERROR) {
            gl.deleteTexture(texture);
            bitmap?.close();
            throw new Error("Could not upload Nikon decoder pixels.");
          }
        }
        image.metadata.rendererPrecision = integerTexture
          ? "rgb16ui"
          : "rgba8-fallback";
      }
    } else if (!sourceTiled && texture && bitmap) {
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, bitmap);
    }

    if (operation !== this.operation || this.disposed) {
      if (texture) {
        gl.deleteTexture(texture);
      }
      bitmap?.close();
      return;
    }

    this.displayWidth = image.width;
    this.displayHeight = image.height;
    this.orientation = nativePixels ? orientation : 1;
    this.inputLinear = nativePixels && image.metadata.transferFunction === "linear";
    this.textureWidth = uploadedWidth;
    this.textureHeight = uploadedHeight;
    this.integerTexture = integerTexture;
    this.activeProgram = integerTexture ? this.integerProgram : this.program;
    this.maxTextureSize = maxTextureSize;
    this.sourceTiled = sourceTiled;
    this.sourceRgb = sourceTiled && nativePixels ? image.rgb : null;
    this.sourceBitmap = sourceTiled && !nativePixels ? bitmap : null;
    this.sourceTile = { x: 0, y: 0, width: uploadedWidth, height: uploadedHeight };

    if (this.texture) {
      gl.deleteTexture(this.texture);
    }
    this.texture = texture;
    if (!sourceTiled) {
      bitmap?.close();
    }
  }

  resize(width: number, height: number): void {
    const nextWidth = Math.max(1, Math.floor(width));
    const nextHeight = Math.max(1, Math.floor(height));
    if (this.canvas.width !== nextWidth || this.canvas.height !== nextHeight) {
      this.canvas.width = nextWidth;
      this.canvas.height = nextHeight;
    }
  }

  private sourceTransformInput(
    crop: DevelopSettings["crop"],
    mode: SourceRenderMode,
  ): SourceTransformInput {
    return {
      displayWidth: this.displayWidth,
      displayHeight: this.displayHeight,
      textureWidth: this.textureWidth,
      textureHeight: this.textureHeight,
      orientation: this.orientation,
      crop,
      mode,
    };
  }

  private sourceTileForOutput(
    settings: DevelopSettings,
    outputWidth: number,
    outputHeight: number,
    tile: OutputTile,
    mode: SourceRenderMode,
  ): SourceTile {
    if (!this.sourceTiled) {
      return { x: 0, y: 0, width: this.textureWidth, height: this.textureHeight };
    }

    const crop = clampedCropSettings(settings.crop);
    const input = this.sourceTransformInput(crop, mode);
    const sampleLeft = Math.max(0, tile.x - 1);
    const sampleTop = Math.max(0, tile.y - 1);
    const sampleRight = Math.min(outputWidth, tile.x + tile.width + 1);
    const sampleBottom = Math.min(outputHeight, tile.y + tile.height + 1);
    let minX = 1;
    let minY = 1;
    let maxX = 0;
    let maxY = 0;
    const samples = 4;
    for (let row = 0; row <= samples; row += 1) {
      for (let column = 0; column <= samples; column += 1) {
        const outputUv = {
          x: (sampleLeft + (sampleRight - sampleLeft) * column / samples) / outputWidth,
          y: (sampleTop + (sampleBottom - sampleTop) * row / samples) / outputHeight,
        };
        const stored = transformOutputUv(outputUv, input).stored;
        minX = Math.min(minX, stored.x);
        minY = Math.min(minY, stored.y);
        maxX = Math.max(maxX, stored.x);
        maxY = Math.max(maxY, stored.y);
      }
    }

    const lensMargin =
      (Math.abs(crop.perspectiveX) + Math.abs(crop.perspectiveY)) * 0.001 +
      Math.abs(crop.distortion) * 0.00025;
    minX = Math.max(0, minX - lensMargin);
    minY = Math.max(0, minY - lensMargin);
    maxX = Math.min(1, maxX + lensMargin);
    maxY = Math.min(1, maxY + lensMargin);
    const interpolationHalo = 1;
    const left = Math.max(0, Math.floor(minX * this.textureWidth) - interpolationHalo);
    const top = Math.max(0, Math.floor(minY * this.textureHeight) - interpolationHalo);
    const right = Math.min(
      this.textureWidth,
      Math.ceil(maxX * this.textureWidth) + interpolationHalo,
    );
    const bottom = Math.min(
      this.textureHeight,
      Math.ceil(maxY * this.textureHeight) + interpolationHalo,
    );
    return {
      x: left,
      y: top,
      width: Math.max(1, right - left),
      height: Math.max(1, bottom - top),
    };
  }

  private uploadSourceTile(tile: SourceTile): void {
    const gl = this.gl;
    if (!this.sourceTiled) {
      this.sourceTile = tile;
      return;
    }
    if (tile.width > this.maxTextureSize || tile.height > this.maxTextureSize) {
      throw new Error(
        `A render tile needs a ${tile.width}x${tile.height} source region, above this device's ${this.maxTextureSize}px texture limit.`,
      );
    }

    if (!this.texture) {
      const texture = gl.createTexture();
      if (!texture) {
        throw new Error("Could not create WebGL texture.");
      }
      this.texture = texture;
    }
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, this.texture);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    gl.texParameteri(
      gl.TEXTURE_2D,
      gl.TEXTURE_MIN_FILTER,
      this.integerTexture ? gl.NEAREST : gl.LINEAR,
    );
    gl.texParameteri(
      gl.TEXTURE_2D,
      gl.TEXTURE_MAG_FILTER,
      this.integerTexture ? gl.NEAREST : gl.LINEAR,
    );
    gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1);
    while (gl.getError() !== gl.NO_ERROR) {
      // Clear errors from a previous tile before checking this upload.
    }

    if (this.sourceRgb) {
      if (!(this.sourceRgb instanceof Uint16Array)) {
        throw new Error("The tiled native source has an unsupported pixel format.");
      }
      const source = this.sourceRgb;
      if (this.integerTexture) {
        const pixels = new Uint16Array(tile.width * tile.height * 3);
        for (let row = 0; row < tile.height; row += 1) {
          const sourceStart = ((tile.y + row) * this.textureWidth + tile.x) * 3;
          const targetStart = row * tile.width * 3;
          pixels.set(source.subarray(sourceStart, sourceStart + tile.width * 3), targetStart);
        }
        gl.texImage2D(
          gl.TEXTURE_2D,
          0,
          gl.RGB16UI,
          tile.width,
          tile.height,
          0,
          gl.RGB_INTEGER,
          gl.UNSIGNED_SHORT,
          pixels,
        );
      } else {
        const pixels = new Uint8Array(tile.width * tile.height * 4);
        for (let row = 0; row < tile.height; row += 1) {
          const sourceStart = ((tile.y + row) * this.textureWidth + tile.x) * 3;
          const targetStart = row * tile.width * 4;
          for (let column = 0; column < tile.width; column += 1) {
            const sourceIndex = sourceStart + column * 3;
            const targetIndex = targetStart + column * 4;
            pixels[targetIndex] = source[sourceIndex]! >> 8;
            pixels[targetIndex + 1] = source[sourceIndex + 1]! >> 8;
            pixels[targetIndex + 2] = source[sourceIndex + 2]! >> 8;
            pixels[targetIndex + 3] = 255;
          }
        }
        gl.texImage2D(
          gl.TEXTURE_2D,
          0,
          gl.RGBA,
          tile.width,
          tile.height,
          0,
          gl.RGBA,
          gl.UNSIGNED_BYTE,
          pixels,
        );
      }
    } else if (this.sourceBitmap) {
      let canvas = this.sourceScratchCanvas;
      if (!canvas) {
        canvas = document.createElement("canvas");
        this.sourceScratchCanvas = canvas;
      }
      if (canvas.width !== tile.width || canvas.height !== tile.height) {
        canvas.width = tile.width;
        canvas.height = tile.height;
        this.sourceScratchContext = null;
      }
      const context = this.sourceScratchContext ?? canvas.getContext("2d", { willReadFrequently: true });
      if (!context) {
        throw new Error("Could not create a source tile context.");
      }
      this.sourceScratchContext = context;
      context.imageSmoothingEnabled = false;
      context.clearRect(0, 0, tile.width, tile.height);
      context.drawImage(
        this.sourceBitmap,
        tile.x,
        tile.y,
        tile.width,
        tile.height,
        0,
        0,
        tile.width,
        tile.height,
      );
      const pixels = context.getImageData(0, 0, tile.width, tile.height).data;
      gl.texImage2D(
        gl.TEXTURE_2D,
        0,
        gl.RGBA,
        tile.width,
        tile.height,
        0,
        gl.RGBA,
        gl.UNSIGNED_BYTE,
        pixels,
      );
    } else {
      throw new Error("The tiled source pixels are unavailable.");
    }
    if (gl.getError() !== gl.NO_ERROR) {
      throw new Error("Could not upload a tiled source region.");
    }
    this.sourceTile = tile;
  }

  private exportTileEdge(): number {
    return Math.max(1, Math.min(EXPORT_TILE_EDGE, this.maxTextureSize));
  }

  async prepare(
    document: DevelopDocument,
    sourceSignature: SourceSignature,
    policy: "preview" | "export" = "preview",
  ): Promise<RenderPreparation> {
    if (this.disposed) {
      throw new Error("Renderer has been disposed.");
    }
    if (!this.texture && !this.sourceTiled) {
      throw new Error("Renderer image is not ready.");
    }
    const matte = this.matteDimensions();
    const documentKey = JSON.stringify(document);
    const sourceKey = sourceSignatureKey(sourceSignature);
    const existing = this.prepared;
    if (
      existing &&
      existing.documentKey === documentKey &&
      existing.sourceKey === sourceKey &&
      existing.matteWidth === matte.width &&
      existing.matteHeight === matte.height
    ) {
      if (policy === "export") {
        const invalidAsset = existing.diagnostics.find(
          (diagnostic) => diagnostic.kind === "missing-asset" || diagnostic.kind === "corrupt-asset",
        );
        if (invalidAsset) {
          throw new MaskAssetError(
            invalidAsset.kind,
            invalidAsset.assetId,
            invalidAsset.message,
          );
        }
      }
      return {
        diagnostics: existing.diagnostics,
        matteWidth: existing.matteWidth,
        matteHeight: existing.matteHeight,
      };
    }

    const operation = ++this.operation;
    const decodedAssets = new Map<string, DecodedMaskAsset>();
    const assetErrors = new Map<string, MaskAssetError>();
    const assetPromises = new Map<string, Promise<DecodedMaskAsset>>();
    for (const mask of document.settings.masking.masks) {
      for (const component of mask.components) {
        if (component.kind !== "ai") continue;
        const asset = document.maskAssets[component.assetId];
        if (!asset) {
          assetErrors.set(
            component.assetId,
            new MaskAssetError(
              "missing-asset",
              component.assetId,
              `Mask component ${component.id} references missing asset ${component.assetId}.`,
            ),
          );
          continue;
        }
        if (!assetPromises.has(component.assetId)) {
          assetPromises.set(component.assetId, cachedMaskAsset(asset));
        }
      }
    }

    for (const [assetId, promise] of assetPromises) {
      try {
        decodedAssets.set(assetId, await promise);
      } catch (error) {
        const assetError = error instanceof MaskAssetError
          ? error
          : new MaskAssetError("corrupt-asset", assetId, `Mask asset ${assetId} could not be verified.`);
        assetErrors.set(assetId, assetError);
      }
    }
    if (operation !== this.operation || this.disposed) {
      throw new StaleRenderError();
    }

    const diagnostics: RenderDiagnostic[] = [];
    for (const mask of document.settings.masking.masks) {
      for (const component of mask.components) {
        if (component.kind !== "ai") continue;
        if (isStaleAi(component, sourceSignature)) {
          diagnostics.push({
            kind: "stale-ai",
            maskId: mask.id,
            componentId: component.id,
            assetId: component.assetId,
            selector: component.selector,
            message: `The ${component.selector} mask is stale for the current source file.`,
          });
        }
        const assetError = assetErrors.get(component.assetId);
        if (!assetError) continue;
        if (policy === "export") {
          throw assetError;
        }
        diagnostics.push({
          kind: assetError.kind,
          maskId: mask.id,
          componentId: component.id,
          assetId: component.assetId,
          message: assetError.message,
        });
      }
    }

    const masks: PreparedMask[] = [];
    for (const mask of document.settings.masking.masks) {
      const assetKey = mask.components
        .filter((component) => component.kind === "ai")
        .map((component) => {
          const asset = document.maskAssets[component.assetId];
          const stale = component.kind === "ai" && isStaleAi(component, sourceSignature);
          return `${component.id}:${component.assetId}:${asset?.sha256 ?? "missing"}:${stale}`;
        })
        .join("|");
      const geometryKey = JSON.stringify({
        enabled: mask.enabled,
        inverted: mask.inverted,
        components: mask.components.map((component) => component.kind === "brush"
          ? {
              kind: component.kind,
              id: component.id,
              operation: component.operation,
              strokes: component.strokes,
            }
          : component),
      });
      const key = `${mask.id}:${geometryKey}:${matte.width}x${matte.height}:${assetKey}`;
      const cached = this.getCachedMatte(key);
      const raster = cached ?? rasterizeMask(
        mask,
        matte.width,
        matte.height,
        decodedAssets,
        sourceSignature,
      );
      if (!cached) {
        this.cacheMatte({ key, ...raster });
      }
      masks.push({
        id: mask.id,
        key,
        adjustment: raster.adjustment,
        inspection: raster.inspection,
        adjustments: mask.adjustments,
      });
    }

    if (operation !== this.operation || this.disposed) {
      throw new StaleRenderError();
    }
    this.uploadMaskTextures(masks, matte.width, matte.height);
    this.prepared = {
      documentKey,
      sourceKey,
      masks,
      diagnostics,
      matteWidth: matte.width,
      matteHeight: matte.height,
    };
    return {
      diagnostics,
      matteWidth: matte.width,
      matteHeight: matte.height,
    };
  }

  async render(
    document: DevelopDocument,
    sourceSignature: SourceSignature,
    showOriginal: boolean,
    mode: SourceRenderMode = "source",
    options: RenderOptions = {},
  ): Promise<RenderPreparation> {
    const preparation = await this.prepare(
      document,
      sourceSignature,
      mode === "export" ? "export" : "preview",
    );
    if (!this.texture || !this.prepared) {
      if (this.sourceTiled && this.prepared) {
        const tile = {
          x: 0,
          y: 0,
          width: this.canvas.width,
          height: this.canvas.height,
        } satisfies OutputTile;
        const sourceTile = this.sourceTileForOutput(
          document.settings,
          this.canvas.width,
          this.canvas.height,
          tile,
          mode,
        );
        this.uploadSourceTile(sourceTile);
      } else {
        throw new Error("Renderer image is not ready.");
      }
    }
    if (!this.prepared) {
      throw new Error("Renderer image is not ready.");
    }
    this.draw(
      document.settings,
      showOriginal,
      mode,
      options,
      {
        outputWidth: this.canvas.width,
        outputHeight: this.canvas.height,
        tile: { x: 0, y: 0, width: this.canvas.width, height: this.canvas.height },
      },
    );
    return preparation;
  }

  async renderExport(
    document: DevelopDocument,
    sourceSignature: SourceSignature,
    width: number,
    height: number,
  ): Promise<Uint8Array> {
    await this.prepare(document, sourceSignature, "export");
    const output = new Uint8Array(width * height * 4);
    const pending: OutputTile[] = [];
    const tileEdge = this.exportTileEdge();
    for (let y = 0; y < height; y += tileEdge) {
      for (let x = 0; x < width; x += tileEdge) {
        pending.push({
          x,
          y,
          width: Math.min(tileEdge, width - x),
          height: Math.min(tileEdge, height - y),
        });
      }
    }

    while (pending.length > 0) {
      const tile = pending.pop();
      if (!tile) {
        break;
      }
      const sourceTile = this.sourceTileForOutput(document.settings, width, height, tile, "export");
      if (
        this.sourceTiled &&
        (sourceTile.width > this.maxTextureSize || sourceTile.height > this.maxTextureSize)
      ) {
        if (tile.width === 1 && tile.height === 1) {
          throw new Error("A source pixel could not fit within the WebGL texture limit.");
        }
        if (tile.width >= tile.height && tile.width > 1) {
          const firstWidth = Math.floor(tile.width / 2);
          pending.push(
            { ...tile, width: firstWidth },
            { ...tile, x: tile.x + firstWidth, width: tile.width - firstWidth },
          );
        } else {
          const firstHeight = Math.floor(tile.height / 2);
          pending.push(
            { ...tile, height: firstHeight },
            { ...tile, y: tile.y + firstHeight, height: tile.height - firstHeight },
          );
        }
        continue;
      }

      this.resize(tile.width, tile.height);
      this.uploadSourceTile(sourceTile);
      this.draw(
        document.settings,
        false,
        "export",
        {},
        { outputWidth: width, outputHeight: height, tile },
      );
      const tilePixels = this.readPixels();
      const top = height - tile.y - tile.height;
      const tileRowLength = tile.width * 4;
      const outputRowLength = width * 4;
      for (let row = 0; row < tile.height; row += 1) {
        output.set(
          tilePixels.subarray(row * tileRowLength, (row + 1) * tileRowLength),
          (top + row) * outputRowLength + tile.x * 4,
        );
      }
    }
    return output;
  }

  private draw(
    settings: DevelopSettings,
    showOriginal: boolean,
    mode: SourceRenderMode,
    options: RenderOptions,
    region: DrawRegion,
  ): void {
    const gl = this.gl;
    if (!this.texture) {
      return;
    }

    gl.viewport(0, 0, this.canvas.width, this.canvas.height);
    gl.clearColor(0, 0, 0, 0);
    gl.clear(gl.COLOR_BUFFER_BIT);
    const crop = clampedCropSettings(settings.crop);
    if (mode === "source") {
      this.applyContainViewport();
    } else if (mode === "crop-preview") {
      this.applyContainViewport(
        this.displayWidth * crop.width / (this.displayHeight * crop.height),
      );
    }
    this.configureGeometry();
    gl.useProgram(this.activeProgram);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, this.texture);
    this.uniform1i("u_image", 0);
    this.uniform2f("u_texel", 1 / this.displayWidth, 1 / this.displayHeight);
    this.uniform2f("u_source_texel", 1 / this.textureWidth, 1 / this.textureHeight);
    this.uniform2f("u_output_size", region.outputWidth, region.outputHeight);
    this.uniform2f("u_tile_origin", region.tile.x, region.tile.y);
    this.uniform2f("u_tile_size", region.tile.width, region.tile.height);
    this.uniform4f(
      "u_source_tile",
      this.sourceTile.x / this.textureWidth,
      this.sourceTile.y / this.textureHeight,
      this.sourceTile.width / this.textureWidth,
      this.sourceTile.height / this.textureHeight,
    );
    this.uniform1i("u_orientation", this.orientation);
    this.uniform1f("u_input_linear", this.inputLinear ? 1 : 0);
    this.uniform1f("u_show_original", showOriginal ? 1 : 0);

    gl.activeTexture(gl.TEXTURE2);
    gl.bindTexture(gl.TEXTURE_2D_ARRAY, this.maskTexture);
    this.uniform1i("u_masks", 2);
    this.uniform1i("u_mask_count", this.prepared?.masks.length ?? 0);
    this.uniformLocalBasic(this.prepared?.masks ?? []);

    const overlay = mode === "export"
      ? false
      : this.uploadOverlayTexture(options.overlayMaskId ?? null);
    gl.activeTexture(gl.TEXTURE3);
    gl.bindTexture(gl.TEXTURE_2D, this.overlayTexture);
    this.uniform1i("u_overlay_mask", 3);
    this.uniform1f("u_overlay_enabled", overlay ? 1 : 0);

    this.uniform1f("u_crop_enabled", settings.crop.enabled ? 1 : 0);
    this.uniform1f("u_crop_output", mode === "source" ? 0 : 1);
    this.uniform4f(
      "u_crop",
      crop.x,
      crop.y,
      crop.width,
      crop.height,
    );
    this.uniform1f("u_crop_angle", settings.crop.angle);
    this.uniform1f("u_perspective_x", settings.crop.perspectiveX);
    this.uniform1f("u_perspective_y", settings.crop.perspectiveY);
    this.uniform1f("u_distortion", settings.crop.distortion);

    this.uniform1f("u_exposure", settings.basic.exposure);
    this.uniform1f("u_contrast", settings.basic.contrast);
    this.uniform1f("u_highlights", settings.basic.highlights);
    this.uniform1f("u_shadows", settings.basic.shadows);
    this.uniform1f("u_whites", settings.basic.whites);
    this.uniform1f("u_blacks", settings.basic.blacks);
    this.uniform1f("u_temperature", settings.basic.temperature);
    this.uniform1f("u_tint", settings.basic.tint);
    this.uniform1f("u_vibrance", settings.basic.vibrance);
    this.uniform1f("u_saturation", settings.basic.saturation);

    this.uniformCurve(settings);
    this.uniformMixer(settings);
    this.uniform1f("u_vignette", settings.effects.vignette);
    this.uniform1f("u_grain", settings.effects.grain);
    this.uniform1f("u_sharpening", settings.effects.sharpening);
    this.uniform1f("u_noise_reduction", settings.effects.noiseReduction);

    gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
  }

  private matteDimensions(): { width: number; height: number } {
    const sourceWidth = Math.max(1, this.displayWidth);
    const sourceHeight = Math.max(1, this.displayHeight);
    const scale = Math.min(1, MAX_MATTE_EDGE / Math.max(sourceWidth, sourceHeight));
    return {
      width: Math.max(1, Math.round(sourceWidth * scale)),
      height: Math.max(1, Math.round(sourceHeight * scale)),
    };
  }

  private getCachedMatte(key: string): CachedMask | undefined {
    const cached = this.matteCache.get(key);
    if (!cached) {
      return undefined;
    }
    this.matteCache.delete(key);
    this.matteCache.set(key, cached);
    return cached;
  }

  private cacheMatte(matte: CachedMask): void {
    const bytes = matte.adjustment.byteLength + matte.inspection.byteLength;
    if (bytes > MAX_MATTE_CACHE_BYTES) {
      return;
    }
    const existing = this.matteCache.get(matte.key);
    if (existing) {
      this.matteCacheBytes -= existing.adjustment.byteLength + existing.inspection.byteLength;
      this.matteCache.delete(matte.key);
    }
    while (
      this.matteCache.size > 0 &&
      (this.matteCache.size >= MAX_MATTE_CACHE_ENTRIES ||
        this.matteCacheBytes + bytes > MAX_MATTE_CACHE_BYTES)
    ) {
      const oldestKey = this.matteCache.keys().next().value;
      if (typeof oldestKey !== "string") {
        break;
      }
      const oldest = this.matteCache.get(oldestKey);
      if (oldest) {
        this.matteCacheBytes -= oldest.adjustment.byteLength + oldest.inspection.byteLength;
      }
      this.matteCache.delete(oldestKey);
    }
    this.matteCache.set(matte.key, matte);
    this.matteCacheBytes += bytes;
  }

  private uploadMaskTextures(
    masks: readonly PreparedMask[],
    width: number,
    height: number,
  ): void {
    const gl = this.gl;
    if (masks.length === 0) {
      this.clearMaskArrayTexture();
      return;
    }
    const maxLayersParameter = gl.getParameter(gl.MAX_ARRAY_TEXTURE_LAYERS);
    const maxLayers = typeof maxLayersParameter === "number" ? maxLayersParameter : 0;
    if (maxLayers < masks.length) {
      throw new Error(`This device supports ${maxLayers} mask layers, but the edit needs ${masks.length}.`);
    }

    const needsNewTexture = this.maskTexture === null ||
      this.maskTextureWidth !== width ||
      this.maskTextureHeight !== height ||
      this.maskTextureLayers !== masks.length;
    if (needsNewTexture) {
      this.clearMaskArrayTexture();
      const texture = gl.createTexture();
      if (!texture) {
        throw new Error("Could not create mask texture array.");
      }
      this.maskTexture = texture;
      this.maskTextureWidth = width;
      this.maskTextureHeight = height;
      this.maskTextureLayers = masks.length;
      this.uploadedMaskKeys = [];
      gl.activeTexture(gl.TEXTURE2);
      gl.bindTexture(gl.TEXTURE_2D_ARRAY, texture);
      gl.texParameteri(gl.TEXTURE_2D_ARRAY, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
      gl.texParameteri(gl.TEXTURE_2D_ARRAY, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
      gl.texParameteri(gl.TEXTURE_2D_ARRAY, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
      gl.texParameteri(gl.TEXTURE_2D_ARRAY, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
      gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1);
      gl.texImage3D(
        gl.TEXTURE_2D_ARRAY,
        0,
        gl.R8,
        width,
        height,
        masks.length,
        0,
        gl.RED,
        gl.UNSIGNED_BYTE,
        null,
      );
    }

    gl.activeTexture(gl.TEXTURE2);
    gl.bindTexture(gl.TEXTURE_2D_ARRAY, this.maskTexture);
    for (const [index, mask] of masks.entries()) {
      if (this.uploadedMaskKeys[index] === mask.key) continue;
      gl.texSubImage3D(
        gl.TEXTURE_2D_ARRAY,
        0,
        0,
        0,
        index,
        width,
        height,
        1,
        gl.RED,
        gl.UNSIGNED_BYTE,
        mask.adjustment,
      );
      this.uploadedMaskKeys[index] = mask.key;
    }
    if (gl.getError() !== gl.NO_ERROR) {
      throw new Error("Could not upload mask texture data.");
    }
  }

  private uploadOverlayTexture(maskId: string | null): boolean {
    const mask = maskId && this.prepared
      ? this.prepared.masks.find((item) => item.id === maskId)
      : undefined;
    if (!mask || !this.prepared) {
      return false;
    }
    const width = this.prepared.matteWidth;
    const height = this.prepared.matteHeight;
    if (!this.overlayTexture) {
      const texture = this.gl.createTexture();
      if (!texture) {
        throw new Error("Could not create mask overlay texture.");
      }
      this.overlayTexture = texture;
      this.gl.activeTexture(this.gl.TEXTURE3);
      this.gl.bindTexture(this.gl.TEXTURE_2D, texture);
      this.gl.texParameteri(this.gl.TEXTURE_2D, this.gl.TEXTURE_WRAP_S, this.gl.CLAMP_TO_EDGE);
      this.gl.texParameteri(this.gl.TEXTURE_2D, this.gl.TEXTURE_WRAP_T, this.gl.CLAMP_TO_EDGE);
      this.gl.texParameteri(this.gl.TEXTURE_2D, this.gl.TEXTURE_MIN_FILTER, this.gl.LINEAR);
      this.gl.texParameteri(this.gl.TEXTURE_2D, this.gl.TEXTURE_MAG_FILTER, this.gl.LINEAR);
      this.gl.pixelStorei(this.gl.UNPACK_ALIGNMENT, 1);
      this.overlayKey = null;
    }
    this.gl.activeTexture(this.gl.TEXTURE3);
    this.gl.bindTexture(this.gl.TEXTURE_2D, this.overlayTexture);
    if (this.overlayKey !== `${width}x${height}:${mask.key}`) {
      if (this.overlayKey === null) {
        this.gl.texImage2D(
          this.gl.TEXTURE_2D,
          0,
          this.gl.R8,
          width,
          height,
          0,
          this.gl.RED,
          this.gl.UNSIGNED_BYTE,
          mask.inspection,
        );
      } else {
        this.gl.texSubImage2D(
          this.gl.TEXTURE_2D,
          0,
          0,
          0,
          width,
          height,
          this.gl.RED,
          this.gl.UNSIGNED_BYTE,
          mask.inspection,
        );
      }
      this.overlayKey = `${width}x${height}:${mask.key}`;
    }
    return true;
  }

  private uniformLocalBasic(masks: readonly PreparedMask[]): void {
    const values = new Float32Array(160);
    for (const [index, mask] of masks.entries()) {
      const base = index * BASIC_FIELDS.length;
      for (const [fieldIndex, field] of BASIC_FIELDS.entries()) {
        values[base + fieldIndex] = mask.adjustments[field];
      }
    }
    this.gl.uniform1fv(this.gl.getUniformLocation(this.activeProgram, "u_local_basic"), values);
  }

  private applyContainViewport(
    imageRatio = this.displayWidth / this.displayHeight,
  ): void {
    const canvasRatio = this.canvas.width / this.canvas.height;
    let width = this.canvas.width;
    let height = this.canvas.height;

    if (imageRatio > canvasRatio) {
      height = width / imageRatio;
    } else {
      width = height * imageRatio;
    }

    this.gl.viewport(
      Math.round((this.canvas.width - width) / 2),
      Math.round((this.canvas.height - height) / 2),
      Math.round(width),
      Math.round(height),
    );
  }

  dispose(): void {
    if (this.disposed) {
      return;
    }
    this.disposed = true;
    this.operation += 1;
    this.disposeSourceBitmap();
    this.clearMatteCache();
    if (this.texture) {
      this.gl.deleteTexture(this.texture);
      this.texture = null;
    }
    this.clearMaskTextures();
    this.gl.deleteBuffer(this.geometry);
    this.gl.deleteTexture(this.curveTexture);
    this.gl.deleteProgram(this.program);
    this.gl.deleteProgram(this.integerProgram);
  }

  readPixels(): Uint8Array {
    const width = this.canvas.width;
    const height = this.canvas.height;
    if (width < 1 || height < 1) {
      throw new Error("Could not read an empty export.");
    }

    const pixels = new Uint8Array(width * height * 4);
    this.gl.readPixels(0, 0, width, height, this.gl.RGBA, this.gl.UNSIGNED_BYTE, pixels);
    const error = this.gl.getError();
    if (error !== this.gl.NO_ERROR) {
      throw new Error("Could not read edited image pixels.");
    }

    // WebGL's readback starts at the bottom row; encoders expect top-to-bottom rows.
    const row = new Uint8Array(width * 4);
    const rowLength = row.length;
    for (let y = 0; y < Math.floor(height / 2); y += 1) {
      const topOffset = y * rowLength;
      const bottomOffset = (height - y - 1) * rowLength;
      row.set(pixels.subarray(topOffset, topOffset + rowLength));
      pixels.copyWithin(topOffset, bottomOffset, bottomOffset + rowLength);
      pixels.set(row, bottomOffset);
    }

    return pixels;
  }

  private clearMaskArrayTexture(): void {
    if (this.maskTexture) {
      this.gl.deleteTexture(this.maskTexture);
      this.maskTexture = null;
    }
    this.maskTextureWidth = 0;
    this.maskTextureHeight = 0;
    this.maskTextureLayers = 0;
    this.uploadedMaskKeys = [];
  }

  private clearMaskTextures(): void {
    this.clearMaskArrayTexture();
    if (this.overlayTexture) {
      this.gl.deleteTexture(this.overlayTexture);
      this.overlayTexture = null;
    }
    this.overlayKey = null;
  }

  private uniformMixer(settings: DevelopSettings): void {
    const values = new Float32Array(24);
    for (const [index, color] of MIXER_COLORS.entries()) {
      const base = index * 3;
      values[base] = settings.mixer[color].hue;
      values[base + 1] = settings.mixer[color].saturation;
      values[base + 2] = settings.mixer[color].luminance;
    }
    const location = this.gl.getUniformLocation(this.activeProgram, "u_mixer");
    this.gl.uniform1fv(location, values);
  }

  private uniformCurve(settings: DevelopSettings): void {
    const gl = this.gl;
    gl.activeTexture(gl.TEXTURE1);
    gl.bindTexture(gl.TEXTURE_2D, this.curveTexture);
    if (settings.curve !== this.curveSettings) {
      gl.texSubImage2D(
        gl.TEXTURE_2D,
        0,
        0,
        0,
        CURVE_LUT_SIZE,
        1,
        gl.RGBA,
        gl.FLOAT,
        createCurveLut(settings.curve),
      );
      this.curveSettings = settings.curve;
    }
    this.uniform1i("u_curve", 1);
    gl.activeTexture(gl.TEXTURE0);
  }

  private uniform1i(name: string, value: number): void {
    this.gl.uniform1i(this.gl.getUniformLocation(this.activeProgram, name), value);
  }

  private uniform1f(name: string, value: number): void {
    this.gl.uniform1f(this.gl.getUniformLocation(this.activeProgram, name), value);
  }

  private uniform2f(name: string, x: number, y: number): void {
    this.gl.uniform2f(this.gl.getUniformLocation(this.activeProgram, name), x, y);
  }

  private uniform4f(
    name: string,
    x: number,
    y: number,
    z: number,
    w: number,
  ): void {
    this.gl.uniform4f(this.gl.getUniformLocation(this.activeProgram, name), x, y, z, w);
  }
}

function assertExportDimensions(width: number, height: number): void {
  if (width > MAX_EXPORT_EDGE || height > MAX_EXPORT_EDGE) {
    throw new Error("Export dimensions are too large.");
  }
  if (width * height > MAX_EXPORT_PIXELS) {
    throw new Error("This edit exceeds the 50 megapixel export limit.");
  }
}

function exportSize(
  image: DevelopImage,
  settings: DevelopSettings,
  size: ExportSizeOptions,
): {
  width: number;
  height: number;
} {
  const crop = settings.crop;
  let source = { width: image.width, height: image.height };
  if (crop.enabled) {
    const rect = clampCropRect(crop);
    source = {
      width: Math.max(1, Math.round(image.width * rect.width)),
      height: Math.max(1, Math.round(image.height * rect.height)),
    };
  }
  if (size.mode === "original") {
    return source;
  }
  const neverUpscale = size.neverUpscale ?? true;
  if (size.mode === "long-edge" || size.mode === "longEdge") {
    const edge = size.longEdge ?? size.pixels;
    if (typeof edge !== "number" || !Number.isInteger(edge) || edge < 1) {
      throw new Error("Long edge must be a positive whole number.");
    }
    if (edge > MAX_EXPORT_EDGE) {
      throw new Error("Long edge is too large.");
    }
    const sourceEdge = Math.max(source.width, source.height);
    if (neverUpscale && edge >= sourceEdge) {
      return source;
    }
    const ratio = edge / sourceEdge;
    return {
      width: Math.max(1, Math.round(source.width * ratio)),
      height: Math.max(1, Math.round(source.height * ratio)),
    };
  }
  if (size.mode !== "fit") {
    throw new Error("Unsupported export size mode.");
  }
  if (
    !Number.isInteger(size.width) || size.width < 1 ||
    !Number.isInteger(size.height) || size.height < 1
  ) {
    throw new Error("Fit dimensions must be positive whole numbers.");
  }
  if (size.width > MAX_EXPORT_EDGE || size.height > MAX_EXPORT_EDGE) {
    throw new Error("Fit dimensions are too large.");
  }
  if (neverUpscale && source.width <= size.width && source.height <= size.height) {
    return source;
  }
  const ratio = Math.min(size.width / source.width, size.height / source.height);
  return {
    width: Math.max(1, Math.round(source.width * ratio)),
    height: Math.max(1, Math.round(source.height * ratio)),
  };
}

export type RenderDevelopExportResult = RawExportRenderResult;

/**
 * Render a developed image at its final export resolution and return raw RGBA.
 * Pass a renderer to reuse its WebGL context across a batch.
 */
export async function renderDevelopExport(
  image: DevelopImage,
  developDocument: DevelopDocument,
  sourceSignature: SourceSignature,
  size: ExportSizeOptions = { mode: "original" },
  renderer?: DevelopRenderer,
): Promise<RenderDevelopExportResult> {
  const { width, height } = exportSize(image, developDocument.settings, size);
  assertExportDimensions(width, height);

  const ownsRenderer = !renderer;
  const activeRenderer = renderer ?? new DevelopRenderer(
    document.createElement("canvas"),
    true,
  );
  try {
    await activeRenderer.setImage(image);
    const pixels = await activeRenderer.renderExport(
      developDocument,
      sourceSignature,
      width,
      height,
    );
    const embeddedPreview = image.metadata.decoderProvenance === "embedded";
    return {
      pixels,
      width,
      height,
      provenance: embeddedPreview ? "embedded-preview" : "decoded",
      embeddedPreview,
      ...(embeddedPreview
        ? { warning: "RAW export uses its embedded preview." }
        : {}),
    };
  } finally {
    if (ownsRenderer) {
      activeRenderer.dispose();
    }
  }
}
