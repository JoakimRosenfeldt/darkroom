import type { DevelopImage } from "@/lib/cache/develop-image-cache";
import type { DevelopSettings } from "@/lib/develop/types";
import { MIXER_COLORS } from "@/lib/develop/plugins/mixer";

const VERTEX_SHADER = `#version 300 es
in vec2 a_position;
out vec2 v_uv;

void main() {
  v_uv = (a_position + 1.0) * 0.5;
  gl_Position = vec4(a_position, 0.0, 1.0);
}`;

const FRAGMENT_SHADER = `#version 300 es
precision highp float;
precision highp sampler2D;

in vec2 v_uv;
out vec4 out_color;

uniform sampler2D u_image;
uniform vec2 u_texel;
uniform float u_show_original;

uniform float u_crop_enabled;
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

uniform float u_curve_shadows;
uniform float u_curve_midtones;
uniform float u_curve_highlights;
uniform float u_mixer[24];
uniform float u_vignette;
uniform float u_grain;
uniform float u_sharpening;
uniform float u_noise_reduction;

float luma(vec3 color) {
  return dot(color, vec3(0.2126, 0.7152, 0.0722));
}

vec2 transform_uv(vec2 uv) {
  uv = vec2(uv.x, 1.0 - uv.y);

  if (u_crop_enabled > 0.5) {
    vec2 crop_center = u_crop.xy + u_crop.zw * 0.5;
    vec2 p = uv - 0.5;
    float angle = radians(-u_crop_angle);
    mat2 rotation = mat2(cos(angle), -sin(angle), sin(angle), cos(angle));
    p = rotation * p;
    uv = crop_center + p * u_crop.zw;
  }

  vec2 centered = uv - 0.5;
  uv += vec2(centered.y * u_perspective_x, centered.x * u_perspective_y) * 0.002;
  uv += centered * dot(centered, centered) * u_distortion * 0.001;
  return uv;
}

vec3 adjust_basic(vec3 color) {
  color *= pow(2.0, u_exposure);
  color *= vec3(
    1.0 + u_temperature * 0.00008 + u_tint * 0.00002,
    1.0 - abs(u_tint) * 0.00003,
    1.0 - u_temperature * 0.00008 - u_tint * 0.00002
  );

  float lum = luma(color);
  float shadow_mask = smoothstep(0.7, 0.0, lum);
  float highlight_mask = smoothstep(0.35, 1.0, lum);
  color += shadow_mask * u_shadows * 0.005;
  color += highlight_mask * u_highlights * 0.004;
  color += smoothstep(0.72, 1.0, lum) * u_whites * 0.004;
  color += smoothstep(0.25, 0.0, lum) * u_blacks * 0.004;
  color = (color - 0.5) * (1.0 + u_contrast * 0.01) + 0.5;

  float average = (color.r + color.g + color.b) / 3.0;
  float saturation = max(max(color.r, color.g), color.b) - min(min(color.r, color.g), color.b);
  float vibrance = u_vibrance * 0.01 * (1.0 - saturation);
  color = mix(vec3(average), color, 1.0 + u_saturation * 0.01 + vibrance);
  return color;
}

vec3 adjust_curve(vec3 color) {
  float lum = luma(color);
  float lift =
    (1.0 - smoothstep(0.0, 0.45, lum)) * u_curve_shadows +
    (1.0 - abs(lum - 0.5) * 2.0) * u_curve_midtones +
    smoothstep(0.55, 1.0, lum) * u_curve_highlights;
  return color + lift * 0.004;
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
  vec3 hsl = rgb_to_hsl(clamp(color, 0.0, 1.0));
  for (int i = 0; i < 8; i++) {
    float center = float(i) / 8.0;
    float distance = min(abs(hsl.x - center), 1.0 - abs(hsl.x - center));
    float weight = smoothstep(0.18, 0.0, distance);
    int base = i * 3;
    hsl.x = fract(hsl.x + u_mixer[base] * weight / 360.0);
    hsl.y = clamp(hsl.y * (1.0 + u_mixer[base + 1] * weight * 0.01), 0.0, 1.0);
    hsl.z = clamp(hsl.z + u_mixer[base + 2] * weight * 0.005, 0.0, 1.0);
  }
  return hsl_to_rgb(hsl);
}

float random(vec2 co) {
  return fract(sin(dot(co, vec2(12.9898, 78.233))) * 43758.5453);
}

vec3 adjust_effects(vec3 color) {
  vec2 centered = v_uv - 0.5;
  float vignette = smoothstep(0.85, 0.15, length(centered));
  color *= mix(1.0, vignette, max(0.0, -u_vignette) * 0.012);
  color += (1.0 - vignette) * max(0.0, u_vignette) * 0.006;
  color += (random(gl_FragCoord.xy) - 0.5) * u_grain * 0.004;
  return color;
}

void main() {
  vec2 uv = transform_uv(v_uv);
  if (uv.x < 0.0 || uv.x > 1.0 || uv.y < 0.0 || uv.y > 1.0) {
    out_color = vec4(0.0, 0.0, 0.0, 1.0);
    return;
  }

  vec3 center = texture(u_image, uv).rgb;
  if (u_show_original > 0.5) {
    out_color = vec4(center, 1.0);
    return;
  }

  vec3 neighbors =
    texture(u_image, uv + vec2(u_texel.x, 0.0)).rgb +
    texture(u_image, uv - vec2(u_texel.x, 0.0)).rgb +
    texture(u_image, uv + vec2(0.0, u_texel.y)).rgb +
    texture(u_image, uv - vec2(0.0, u_texel.y)).rgb;
  vec3 average = neighbors * 0.25;
  center = mix(center, average, u_noise_reduction * 0.003);
  center += (center - average) * u_sharpening * 0.015;

  vec3 color = adjust_basic(center);
  color = adjust_curve(color);
  color = adjust_mixer(color);
  color = adjust_effects(color);
  out_color = vec4(clamp(color, 0.0, 1.0), 1.0);
}`;

const QUAD = new Float32Array([-1, -1, 1, -1, -1, 1, 1, 1]);
const MAX_PREVIEW_PIXELS = 4_000_000;
const MAX_EXPORT_PIXELS = 40_000_000;

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

function createProgram(gl: WebGL2RenderingContext): WebGLProgram {
  const vertex = compileShader(gl, gl.VERTEX_SHADER, VERTEX_SHADER);
  const fragment = compileShader(gl, gl.FRAGMENT_SHADER, FRAGMENT_SHADER);
  const program = gl.createProgram();
  if (!program) {
    throw new Error("Could not create WebGL program.");
  }
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

function previewSize(
  image: DevelopImage,
  maxTextureSize: number,
): { width: number; height: number } {
  const scale = Math.min(
    1,
    Math.sqrt(MAX_PREVIEW_PIXELS / (image.width * image.height)),
    maxTextureSize / Math.max(image.width, image.height),
  );
  return {
    width: Math.max(1, Math.floor(image.width * scale)),
    height: Math.max(1, Math.floor(image.height * scale)),
  };
}

function toFloatRgba(
  image: DevelopImage,
  width: number,
  height: number,
): Float32Array {
  const source =
    image.rgb instanceof Uint16Array
      ? image.rgb
      : new Uint16Array(
          image.rgb.buffer,
          image.rgb.byteOffset,
          Math.floor(image.rgb.byteLength / Uint16Array.BYTES_PER_ELEMENT),
        );
  const channels = Math.max(1, image.colors);
  const maxValue = image.bits > 8 ? 65535 : 255;
  const output = new Float32Array(width * height * 4);

  for (let y = 0; y < height; y += 1) {
    const sourceY = Math.min(image.height - 1, Math.floor((y * image.height) / height));
    for (let x = 0; x < width; x += 1) {
      const sourceX = Math.min(image.width - 1, Math.floor((x * image.width) / width));
      const sourceIndex = (sourceY * image.width + sourceX) * channels;
      const outputIndex = (y * width + x) * 4;
      output[outputIndex] = source[sourceIndex] / maxValue;
      output[outputIndex + 1] = source[sourceIndex + 1] / maxValue;
      output[outputIndex + 2] = source[sourceIndex + 2] / maxValue;
      output[outputIndex + 3] = 1;
    }
  }

  return output;
}

export class DevelopRenderer {
  private readonly canvas: HTMLCanvasElement;
  private readonly gl: WebGL2RenderingContext;
  private readonly program: WebGLProgram;
  private texture: WebGLTexture | null = null;
  private textureWidth = 1;
  private textureHeight = 1;
  private readonly uniformLocations = new Map<string, WebGLUniformLocation | null>();

  constructor(
    canvas: HTMLCanvasElement,
    { preserveDrawingBuffer = false }: { preserveDrawingBuffer?: boolean } = {},
  ) {
    const gl = canvas.getContext("webgl2", { preserveDrawingBuffer });
    if (!gl) {
      throw new Error("WebGL2 is not available.");
    }

    this.canvas = canvas;
    this.gl = gl;
    this.program = createProgram(gl);
    this.configureGeometry();
  }

  private configureGeometry(): void {
    const gl = this.gl;
    gl.useProgram(this.program);
    const buffer = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, buffer);
    gl.bufferData(gl.ARRAY_BUFFER, QUAD, gl.STATIC_DRAW);
    const location = gl.getAttribLocation(this.program, "a_position");
    gl.enableVertexAttribArray(location);
    gl.vertexAttribPointer(location, 2, gl.FLOAT, false, 0, 0);
  }

  async setImage(
    image: DevelopImage,
    { useRawPixels = true }: { useRawPixels?: boolean } = {},
  ): Promise<void> {
    const gl = this.gl;
    const texture = gl.createTexture();
    if (!texture) {
      throw new Error("Could not create WebGL texture.");
    }

    try {
      gl.bindTexture(gl.TEXTURE_2D, texture);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);

      if (useRawPixels && image.bits > 8 && image.rgb.length > 0) {
        const size = previewSize(image, gl.getParameter(gl.MAX_TEXTURE_SIZE));
        const floatLinear = gl.getExtension("OES_texture_float_linear");
        if (!floatLinear) {
          gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
          gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
        }
        gl.texImage2D(
          gl.TEXTURE_2D,
          0,
          gl.RGBA32F,
          size.width,
          size.height,
          0,
          gl.RGBA,
          gl.FLOAT,
          toFloatRgba(image, size.width, size.height),
        );
        this.textureWidth = size.width;
        this.textureHeight = size.height;
      } else {
        const maxTextureSize = gl.getParameter(gl.MAX_TEXTURE_SIZE);
        if (image.width > maxTextureSize || image.height > maxTextureSize) {
          throw new Error("Image exceeds this GPU's maximum export texture size.");
        }
        const bitmap = await createImageBitmap(image.blob);
        try {
          gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, bitmap);
        } finally {
          bitmap.close();
        }
        this.textureWidth = image.width;
        this.textureHeight = image.height;
      }
    } catch (error) {
      gl.deleteTexture(texture);
      throw error;
    }

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
    contain = true,
  ): void {
    const gl = this.gl;
    if (!this.texture) {
      return;
    }

    gl.viewport(0, 0, this.canvas.width, this.canvas.height);
    gl.clearColor(0, 0, 0, 1);
    gl.clear(gl.COLOR_BUFFER_BIT);
    if (contain) {
      this.applyContainViewport();
    }
    gl.useProgram(this.program);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, this.texture);
    this.uniform1i("u_image", 0);
    this.uniform2f("u_texel", 1 / this.textureWidth, 1 / this.textureHeight);
    this.uniform1f("u_show_original", showOriginal ? 1 : 0);

    this.uniform1f("u_crop_enabled", settings.crop.enabled ? 1 : 0);
    this.uniform4f(
      "u_crop",
      settings.crop.x,
      settings.crop.y,
      settings.crop.width,
      settings.crop.height,
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

    this.uniform1f("u_curve_shadows", settings.curve.shadows);
    this.uniform1f("u_curve_midtones", settings.curve.midtones);
    this.uniform1f("u_curve_highlights", settings.curve.highlights);
    this.uniformMixer(settings);
    this.uniform1f("u_vignette", settings.effects.vignette);
    this.uniform1f("u_grain", settings.effects.grain);
    this.uniform1f("u_sharpening", settings.effects.sharpening);
    this.uniform1f("u_noise_reduction", settings.effects.noiseReduction);

    gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
  }

  private applyContainViewport(): void {
    const canvasRatio = this.canvas.width / this.canvas.height;
    const imageRatio = this.textureWidth / this.textureHeight;
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
    this.gl.deleteProgram(this.program);
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

  async exportJpeg(
    image: DevelopImage,
    settings: DevelopSettings,
  ): Promise<Blob> {
    if (image.width * image.height > MAX_EXPORT_PIXELS) {
      throw new Error("Image is too large to export safely on this device.");
    }

    const canvas = document.createElement("canvas");
    canvas.width = image.width;
    canvas.height = image.height;
    const renderer = new DevelopRenderer(canvas, { preserveDrawingBuffer: true });
    try {
      await renderer.setImage(image, { useRawPixels: false });
      renderer.render(settings, false, false);
      renderer.gl.finish();
      return await renderer.toBlob();
    } finally {
      renderer.dispose();
    }
  }

  private uniformMixer(settings: DevelopSettings): void {
    const values = new Float32Array(24);
    for (const [index, color] of MIXER_COLORS.entries()) {
      const base = index * 3;
      values[base] = settings.mixer[color].hue;
      values[base + 1] = settings.mixer[color].saturation;
      values[base + 2] = settings.mixer[color].luminance;
    }
    this.gl.uniform1fv(this.uniformLocation("u_mixer"), values);
  }

  private uniform1i(name: string, value: number): void {
    this.gl.uniform1i(this.uniformLocation(name), value);
  }

  private uniform1f(name: string, value: number): void {
    this.gl.uniform1f(this.uniformLocation(name), value);
  }

  private uniform2f(name: string, x: number, y: number): void {
    this.gl.uniform2f(this.uniformLocation(name), x, y);
  }

  private uniform4f(
    name: string,
    x: number,
    y: number,
    z: number,
    w: number,
  ): void {
    this.gl.uniform4f(this.uniformLocation(name), x, y, z, w);
  }

  private uniformLocation(name: string): WebGLUniformLocation | null {
    if (!this.uniformLocations.has(name)) {
      this.uniformLocations.set(name, this.gl.getUniformLocation(this.program, name));
    }
    return this.uniformLocations.get(name) ?? null;
  }
}
