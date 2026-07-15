import type { DevelopImage } from "@/lib/cache/develop-image-cache";
import { clampCropRect } from "@/lib/develop/crop-geometry";
import type { DevelopSettings } from "@/lib/develop/types";
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

in vec2 v_uv;
out vec4 out_color;

uniform vec2 u_texel;
uniform vec2 u_source_texel;
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

vec3 adjust_exposure(vec3 color) {
  vec3 linear = linearize_srgb(color);
  float gain = pow(2.0, u_exposure);
  vec3 exposed = linear * gain;
  if (u_exposure > 0.0) {
    exposed /= 1.0 + linear * (gain - 1.0);
  }
  return encode_srgb(exposed);
}

vec3 decode_transfer(vec3 color) {
  if (u_input_linear < 0.5) return color;
  return encode_srgb(color);
}

vec3 sample_image(vec2 uv) {
#ifdef INTEGER_TEXTURE
  ivec2 dimensions = textureSize(u_image, 0);
  vec2 position = uv * vec2(dimensions) - 0.5;
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
  return decode_transfer(texture(u_image, uv).rgb);
#endif
}

vec2 orient_uv(vec2 uv) {
  if (u_orientation == 2) return vec2(1.0 - uv.x, uv.y);
  if (u_orientation == 3) return vec2(1.0 - uv.x, 1.0 - uv.y);
  if (u_orientation == 4) return vec2(uv.x, 1.0 - uv.y);
  if (u_orientation == 5) return vec2(uv.y, uv.x);
  if (u_orientation == 6) return vec2(uv.y, 1.0 - uv.x);
  if (u_orientation == 7) return vec2(1.0 - uv.y, 1.0 - uv.x);
  if (u_orientation == 8) return vec2(1.0 - uv.y, uv.x);
  return uv;
}

vec2 transform_uv(vec2 uv) {
  uv = vec2(uv.x, 1.0 - uv.y);

  if (u_crop_enabled > 0.5) {
    vec2 crop_center = u_crop.xy + u_crop.zw * 0.5;
    if (u_crop_output > 0.5) {
      uv = u_crop.xy + uv * u_crop.zw;
    }

    vec2 p = (uv - crop_center) / u_texel;
    float angle = radians(-u_crop_angle);
    mat2 rotation = mat2(cos(angle), -sin(angle), sin(angle), cos(angle));
    p = rotation * p;
    uv = crop_center + p * u_texel;

  }
  vec2 centered = uv - 0.5;
  uv += vec2(centered.y * u_perspective_x, centered.x * u_perspective_y) * 0.002;
  uv += centered * dot(centered, centered) * u_distortion * 0.001;
  return orient_uv(uv);
}

vec3 adjust_basic(vec3 color) {
  color = adjust_exposure(color);
  color *= vec3(
    1.0 + u_temperature * 0.00008 + u_tint * 0.00002,
    1.0 - abs(u_tint) * 0.00003,
    1.0 - u_temperature * 0.00008 - u_tint * 0.00002
  );

  float lum = luma(color);
  float shadow_mask = smoothstep(0.7, 0.0, lum);
  float highlight_mask = smoothstep(0.35, 1.0, lum);
  color += shadow_mask * u_shadows * 0.0015;
  color += highlight_mask * u_highlights * 0.0012;
  color += smoothstep(0.72, 1.0, lum) * u_whites * 0.0012;
  color += smoothstep(0.25, 0.0, lum) * u_blacks * 0.0012;
  color = (color - 0.5) * (1.0 + u_contrast * 0.0035) + 0.5;

  float average = (color.r + color.g + color.b) / 3.0;
  float saturation = max(max(color.r, color.g), color.b) - min(min(color.r, color.g), color.b);
  float vibrance = u_vibrance * 0.0035 * (1.0 - saturation);
  color = mix(vec3(average), color, 1.0 + u_saturation * 0.0035 + vibrance);
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

vec3 adjust_effects(vec3 color, vec2 uv) {
  vec2 centered = v_uv - 0.5;
  float vignette = smoothstep(0.85, 0.15, length(centered));
  color *= mix(1.0, vignette, max(0.0, -u_vignette) * 0.012);
  color += (1.0 - vignette) * max(0.0, u_vignette) * 0.006;
  color += (random(gl_FragCoord.xy) - 0.5) * u_grain * 0.004;
  return color;
}

void main() {
  vec2 min_uv = u_source_texel * 0.5;
  vec2 max_uv = 1.0 - min_uv;
  vec2 uv = clamp(transform_uv(v_uv), min_uv, max_uv);

  vec3 center = sample_image(uv);
  if (u_show_original > 0.5) {
    out_color = vec4(center, 1.0);
    return;
  }

  if (u_noise_reduction > 0.0 || u_sharpening > 0.0) {
    vec3 neighbors =
      sample_image(clamp(uv + vec2(u_source_texel.x, 0.0), min_uv, max_uv)) +
      sample_image(clamp(uv - vec2(u_source_texel.x, 0.0), min_uv, max_uv)) +
      sample_image(clamp(uv + vec2(0.0, u_source_texel.y), min_uv, max_uv)) +
      sample_image(clamp(uv - vec2(0.0, u_source_texel.y), min_uv, max_uv));
    vec3 average = neighbors * 0.25;
    center = mix(center, average, u_noise_reduction * 0.003);
    center += (center - average) * u_sharpening * 0.015;
  }

  vec3 color = adjust_basic(center);
  color = adjust_curve(color);
  color = adjust_mixer(color);
  color = adjust_effects(color, uv);
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
  private textureWidth = 1;
  private textureHeight = 1;
  private displayWidth = 1;
  private displayHeight = 1;
  private integerTexture = false;
  private inputLinear = false;
  private orientation = 1;

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

  async setImage(image: DevelopImage): Promise<void> {
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

    const maxTextureSize = gl.getParameter(gl.MAX_TEXTURE_SIZE) as number;
    if (sourceWidth > maxTextureSize || sourceHeight > maxTextureSize) {
      throw new Error(
        `Image exceeds this device's ${maxTextureSize}px texture limit.`,
      );
    }

    const texture = gl.createTexture();
    if (!texture) {
      throw new Error("Could not create WebGL texture.");
    }

    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, texture);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    this.integerTexture = false;

    if (nativePixels) {
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
      this.integerTexture = gl.getError() === gl.NO_ERROR;
      if (!this.integerTexture) {
        const rgba = new Uint8Array(sourceWidth * sourceHeight * 4);
        for (let source = 0, target = 0; source < image.rgb.length; source += 3, target += 4) {
          rgba[target] = image.rgb[source] >> 8;
          rgba[target + 1] = image.rgb[source + 1] >> 8;
          rgba[target + 2] = image.rgb[source + 2] >> 8;
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
          throw new Error("Could not upload Nikon decoder pixels.");
        }
      }
      image.metadata.rendererPrecision = this.integerTexture
        ? "rgb16ui"
        : "rgba8-fallback";
      this.textureWidth = sourceWidth;
      this.textureHeight = sourceHeight;
    } else {
      if (!image.blob) {
        gl.deleteTexture(texture);
        throw new Error("Image preview is unavailable.");
      }
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
      const bitmap = await createImageBitmap(image.blob);
      try {
        gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, bitmap);
        this.textureWidth = bitmap.width;
        this.textureHeight = bitmap.height;
      } finally {
        bitmap.close();
      }
    }

    this.displayWidth = image.width;
    this.displayHeight = image.height;
    this.orientation = nativePixels ? orientation : 1;
    this.inputLinear = nativePixels && image.metadata.transferFunction === "linear";
    this.activeProgram = this.integerTexture ? this.integerProgram : this.program;

    if (this.texture) {
      gl.deleteTexture(this.texture);
    }
    this.texture = texture;
  }

  resize(width: number, height: number): void {
    const nextWidth = Math.max(1, Math.floor(width));
    const nextHeight = Math.max(1, Math.floor(height));
    if (this.canvas.width !== nextWidth || this.canvas.height !== nextHeight) {
      this.canvas.width = nextWidth;
      this.canvas.height = nextHeight;
    }
  }

  render(
    settings: DevelopSettings,
    showOriginal: boolean,
    mode: "source" | "crop-preview" | "export" = "source",
  ): void {
    const gl = this.gl;
    if (!this.texture) {
      return;
    }

    gl.viewport(0, 0, this.canvas.width, this.canvas.height);
    gl.clearColor(0, 0, 0, 0);
    gl.clear(gl.COLOR_BUFFER_BIT);
    const crop = clampCropRect(settings.crop);
    if (mode === "source") {
      this.applyContainViewport();
    } else if (mode === "crop-preview") {
      this.applyContainViewport(
        this.displayWidth * crop.width / (this.displayHeight * crop.height),
      );
    }
    gl.useProgram(this.activeProgram);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, this.texture);
    this.uniform1i("u_image", 0);
    this.uniform2f("u_texel", 1 / this.displayWidth, 1 / this.displayHeight);
    this.uniform2f("u_source_texel", 1 / this.textureWidth, 1 / this.textureHeight);
    this.uniform1i("u_orientation", this.orientation);
    this.uniform1f("u_input_linear", this.inputLinear ? 1 : 0);
    this.uniform1f("u_show_original", showOriginal ? 1 : 0);

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
    if (this.texture) {
      this.gl.deleteTexture(this.texture);
      this.texture = null;
    }
    this.gl.deleteBuffer(this.geometry);
    this.gl.deleteTexture(this.curveTexture);
    this.gl.deleteProgram(this.program);
    this.gl.deleteProgram(this.integerProgram);
  }

  toBlob(type = "image/jpeg", quality = 0.92): Promise<Blob> {
    return new Promise((resolve, reject) => {
      this.canvas.toBlob(
        (blob) => {
          if (!blob) {
            reject(new Error("Could not export edited image."));
            return;
          }
          resolve(blob);
        },
        type,
        quality,
      );
    });
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

const MAX_EXPORT_PIXELS = 50_000_000;

function exportSize(image: DevelopImage, settings: DevelopSettings): {
  width: number;
  height: number;
} {
  const crop = settings.crop;
  if (!crop.enabled) {
    return { width: image.width, height: image.height };
  }
  const rect = clampCropRect(crop);
  return {
    width: Math.max(1, Math.round(image.width * rect.width)),
    height: Math.max(1, Math.round(image.height * rect.height)),
  };
}

export async function exportDevelopJpeg(
  image: DevelopImage,
  settings: DevelopSettings,
): Promise<Blob> {
  const { width, height } = exportSize(image, settings);
  if (width * height > MAX_EXPORT_PIXELS) {
    throw new Error("This edit exceeds the 50 megapixel export limit.");
  }

  const canvas = document.createElement("canvas");
  const renderer = new DevelopRenderer(canvas, true);
  try {
    await renderer.setImage(image);
    renderer.resize(width, height);
    renderer.render(settings, false, "export");
    return await renderer.toBlob();
  } finally {
    renderer.dispose();
  }
}
