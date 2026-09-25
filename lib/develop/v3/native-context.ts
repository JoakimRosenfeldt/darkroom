import { invoke, isTauri } from "@tauri-apps/api/core";
import { translateNativeFragmentShader, packNativeUniforms, type NativeShader } from "./native-shader";

type BinaryRange = { offset: number; length: number };
type TextureUpload = { id: number; width: number; height: number; layers: number; format: string } & Partial<BinaryRange>;
type Pass = { shader: number; targets: number[]; textures: number[]; uniforms: BinaryRange };
type Program = { id: number; shader: NativeShader; values: Map<string, readonly number[]>; locations: Map<string, WebGLUniformLocation> };
type Read = { texture: number; format: "rgba8" | "rgba32f"; flipY?: boolean };
type ConvertedChunk =
  | { kind: "rgb16"; pixels: Uint16Array; width: number; height: number; layers: number; flipY: boolean }
  | { kind: "flip"; pixels: Uint8Array; rowBytes: number; height: number; layers: number };
const MAX_BATCH_BYTES = 512 * 1024 * 1024;

export type NativeGpuTransport = (bytes: Uint8Array<ArrayBuffer>) => Promise<ArrayBuffer>;
let workerTransport: NativeGpuTransport | null = null;

export function setNativeGpuTransport(transport: NativeGpuTransport): void {
  workerTransport = transport;
}

export function nativeGpuAvailable(): boolean {
  return workerTransport !== null || (typeof window !== "undefined" && isTauri());
}

function transport(bytes: Uint8Array<ArrayBuffer>): Promise<ArrayBuffer> {
  return workerTransport ? workerTransport(bytes) : invoke<ArrayBuffer>("darkroom_gpu", bytes);
}

// Records the renderer's existing passes without creating a browser GPU context.
export class NativeGpuContext {
  readonly CLAMP_TO_EDGE = 33071; readonly COLOR_ATTACHMENT0 = 36064;
  readonly COMPILE_STATUS = 35713; readonly DITHER = 3024; readonly FLOAT = 5126;
  readonly FRAGMENT_SHADER = 35632; readonly FRAMEBUFFER = 36160;
  readonly FRAMEBUFFER_COMPLETE = 36053; readonly HALF_FLOAT = 5131;
  readonly LINEAR = 9729; readonly LINK_STATUS = 35714; readonly MAX_TEXTURE_SIZE = 3379;
  readonly NEAREST = 9728; readonly NO_ERROR = 0; readonly R32F = 33326; readonly RED = 6403;
  readonly RGB16UI = 36215; readonly RGBA = 6408; readonly RGBA16F = 34842;
  readonly RGBA32F = 34836; readonly RGBA32UI = 36208; readonly RGBA8 = 32856;
  readonly RGBA_INTEGER = 36249; readonly RGB_INTEGER = 36248;
  readonly TEXTURE0 = 33984; readonly TEXTURE4 = 33988; readonly TEXTURE_2D = 3553;
  readonly TEXTURE_2D_ARRAY = 35866; readonly TEXTURE_MAG_FILTER = 10240;
  readonly TEXTURE_MIN_FILTER = 10241; readonly TEXTURE_WRAP_S = 10242; readonly TEXTURE_WRAP_T = 10243;
  readonly TRIANGLES = 4; readonly UNPACK_ALIGNMENT = 3317; readonly UNPACK_FLIP_Y_WEBGL = 37440;
  readonly UNSIGNED_BYTE = 5121; readonly UNSIGNED_INT = 5125; readonly UNSIGNED_SHORT = 5123;
  readonly VERTEX_SHADER = 35633;
  readonly #session = crypto.randomUUID();
  #nextId = 1;
  #unit = 0;
  #flipY = false;
  #maximumTextureSize = 8192;
  #width = 1;
  #height = 1;
  #outputSize = "";
  #current: Program | null = null;
  #framebuffer: WebGLFramebuffer | null = null;
  readonly #textureIds = new Map<WebGLTexture, number>();
  readonly #bindings = new Map<string, WebGLTexture | null>();
  readonly #attachments = new Map<WebGLFramebuffer, number[]>();
  readonly #shaderSources = new Map<WebGLShader, { type: number; source: string }>();
  readonly #programShaders = new Map<WebGLProgram, WebGLShader[]>();
  readonly #programs = new Map<WebGLProgram, Program>();
  readonly #locations = new WeakMap<WebGLUniformLocation, { program: Program; name: string }>();
  readonly #readbacks = new Map<number, Uint8Array<ArrayBuffer>>();
  #shaders: { id: number; source: string }[] = [];
  #uploads: TextureUpload[] = [];
  #deleted: number[] = [];
  #passes: Pass[] = [];
  #chunks: (Uint8Array | ConvertedChunk)[] = [];
  #byteLength = 0;
  #dummyArray: number | null = null;

  async initialize(): Promise<void> {
    const metadata = new TextEncoder().encode(JSON.stringify({ session: this.#session, info: true }));
    const request = new Uint8Array(4 + metadata.length);
    new DataView(request.buffer).setUint32(0, metadata.length, true);
    request.set(metadata, 4);
    const info: unknown = JSON.parse(new TextDecoder().decode(await transport(request)));
    if (!info || typeof info !== "object" || !("maxTextureDimension" in info) ||
      typeof info.maxTextureDimension !== "number" || !Number.isSafeInteger(info.maxTextureDimension) || info.maxTextureDimension < 1) {
      throw new Error("Native GPU capabilities are invalid.");
    }
    this.#maximumTextureSize = info.maxTextureDimension;
  }

  #append(data: ArrayBufferView | ConvertedChunk): BinaryRange {
    const chunk = "kind" in data ? data : new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
    const length = chunk instanceof Uint8Array ? chunk.byteLength
      : chunk.kind === "rgb16" ? chunk.width * chunk.height * chunk.layers * 8 : chunk.pixels.byteLength;
    const padding = (4 - this.#byteLength % 4) % 4;
    if (this.#byteLength + padding + length > MAX_BATCH_BYTES) throw new Error("Native GPU upload exceeds the batch memory limit.");
    if (padding) { this.#chunks.push(new Uint8Array(padding)); this.#byteLength += padding; }
    const range = { offset: this.#byteLength, length };
    this.#chunks.push(chunk);
    this.#byteLength += length;
    return range;
  }

  #id(texture: WebGLTexture): number {
    const id = this.#textureIds.get(texture);
    if (id === undefined) throw new Error("Native GPU texture is unavailable.");
    return id;
  }

  createShader(type: number): WebGLShader { const shader = {}; this.#shaderSources.set(shader, { type, source: "" }); return shader; }
  shaderSource(shader: WebGLShader, source: string): void { const value = this.#shaderSources.get(shader); if (value) value.source = source; }
  compileShader(..._args: unknown[]): void { void _args;}
  getShaderParameter(..._args: unknown[]): boolean { void _args; return true; }
  getShaderInfoLog(..._args: unknown[]): string { void _args; return ""; }
  deleteShader(..._args: unknown[]): void { void _args;}
  createProgram(): WebGLProgram { const value = {}; this.#programShaders.set(value, []); return value; }
  attachShader(program: WebGLProgram, shader: WebGLShader): void { this.#programShaders.get(program)?.push(shader); }
  linkProgram(program: WebGLProgram): void {
    const source = this.#programShaders.get(program)?.map((value) => this.#shaderSources.get(value)).find((value) => value?.type === this.FRAGMENT_SHADER)?.source;
    if (!source) throw new Error("Native fragment shader is unavailable.");
    const shader = translateNativeFragmentShader(source);
    const id = this.#nextId++;
    this.#programs.set(program, { id, shader, values: new Map(), locations: new Map() });
    this.#shaders.push({ id, source: shader.source });
  }
  getProgramParameter(..._args: unknown[]): boolean { void _args; return true; }
  getProgramInfoLog(..._args: unknown[]): string { void _args; return ""; }
  deleteProgram(program: WebGLProgram): void { this.#programs.delete(program); }
  useProgram(program: WebGLProgram | null): void { this.#current = program ? this.#programs.get(program) ?? null : null; }
  getUniformLocation(program: WebGLProgram, name: string): WebGLUniformLocation {
    const value = this.#programs.get(program);
    if (!value) throw new Error("Native GPU program is unavailable.");
    const cached = value.locations.get(name);
    if (cached) return cached;
    const location = {};
    value.locations.set(name, location);
    this.#locations.set(location, { program: value, name: name.replace(/\[0\]$/, "") });
    return location;
  }
  #uniform(location: WebGLUniformLocation | null, values: readonly number[]): void {
    const value = location && this.#locations.get(location);
    if (value) value.program.values.set(value.name, values);
  }
  uniform1i(location: WebGLUniformLocation | null, value: number): void { this.#uniform(location, [value]); }
  uniform1f(location: WebGLUniformLocation | null, value: number): void { this.#uniform(location, [value]); }
  uniform2i(location: WebGLUniformLocation | null, x: number, y: number): void { this.#uniform(location, [x, y]); }
  uniform2f(location: WebGLUniformLocation | null, x: number, y: number): void { this.#uniform(location, [x, y]); }
  uniform3f(location: WebGLUniformLocation | null, x: number, y: number, z: number): void { this.#uniform(location, [x, y, z]); }
  uniform1fv(location: WebGLUniformLocation | null, values: Float32List): void { this.#uniform(location, Array.from(values)); }
  uniform4fv(location: WebGLUniformLocation | null, values: Float32List): void { this.#uniform(location, Array.from(values)); }
  uniformMatrix3fv(location: WebGLUniformLocation | null, transpose: boolean, values: Float32List): void {
    if (transpose) throw new Error("Native matrices must use column order.");
    this.#uniform(location, Array.from(values));
  }
  createTexture(): WebGLTexture { const texture = {}; this.#textureIds.set(texture, this.#nextId++); return texture; }
  deleteTexture(texture: WebGLTexture | null): void { if (texture) { this.#deleted.push(this.#id(texture)); this.#textureIds.delete(texture); } }
  activeTexture(unit: number): void { this.#unit = unit - this.TEXTURE0; }
  bindTexture(target: number, texture: WebGLTexture | null): void { this.#bindings.set(`${this.#unit}:${target}`, texture); }
  texParameteri(..._args: unknown[]): void { void _args;}
  pixelStorei(parameter: number, value: number | boolean): void { if (parameter === this.UNPACK_FLIP_Y_WEBGL) this.#flipY = Boolean(value); }
  texImage2D(target: number, level: number, format: number, width: number, height: number, border: number, _external: number, _type: number, pixels: ArrayBufferView | null): void {
    this.texImage3D(target, level, format, width, height, 1, border, _external, _type, pixels);
  }
  texImage3D(target: number, _level: number, format: number, width: number, height: number, layers: number, _border: number, _external: number, _type: number, pixels: ArrayBufferView | null): void {
    const texture = this.#bindings.get(`${this.#unit}:${target}`);
    if (!texture) throw new Error("Native upload has no texture.");
    const formats = new Map([[this.RGBA8, "rgba8unorm"], [this.RGB16UI, "rgba16uint"], [this.RGBA32UI, "rgba32uint"], [this.RGBA32F, "rgba32float"], [this.RGBA16F, "rgba16float"], [this.R32F, "r32float"]]);
    const name = formats.get(format);
    if (!name) throw new Error("Unsupported native texture format.");
    const range = format === this.RGB16UI && pixels instanceof Uint16Array
      ? this.#append({ kind: "rgb16", pixels, width, height, layers, flipY: this.#flipY })
      : this.#flipY && pixels
        ? this.#append({ kind: "flip", pixels: new Uint8Array(pixels.buffer, pixels.byteOffset, pixels.byteLength), rowBytes: pixels.byteLength / (height * layers), height, layers })
        : pixels ? this.#append(pixels) : {};
    this.#uploads.push({ id: this.#id(texture), width, height, layers, format: name, ...range });
  }
  createFramebuffer(): WebGLFramebuffer { const framebuffer = {}; this.#attachments.set(framebuffer, []); return framebuffer; }
  bindFramebuffer(_target: number, framebuffer: WebGLFramebuffer | null): void { this.#framebuffer = framebuffer; }
  framebufferTexture2D(_target: number, attachment: number, _textureTarget: number, texture: WebGLTexture | null): void {
    const attachments = this.#framebuffer && this.#attachments.get(this.#framebuffer);
    if (attachments && texture) attachments[attachment - this.COLOR_ATTACHMENT0] = this.#id(texture);
  }
  deleteFramebuffer(framebuffer: WebGLFramebuffer | null): void { if (framebuffer) this.#attachments.delete(framebuffer); }
  drawBuffers(..._args: unknown[]): void { void _args;}
  checkFramebufferStatus(..._args: unknown[]): number { void _args; return this.FRAMEBUFFER_COMPLETE; }
  viewport(_x: number, _y: number, width: number, height: number): void { this.#width = width; this.#height = height; }
  disable(..._args: unknown[]): void { void _args;}
  getError(..._args: unknown[]): number { void _args; return 0; }
  getParameter(..._args: unknown[]): number { void _args; return this.#maximumTextureSize; }
  getExtension(..._args: unknown[]): { loseContext: () => void } { void _args; return { loseContext: () => { void this.release(); } }; }
  isContextLost(..._args: unknown[]): boolean { void _args; return false; }
  drawArrays(..._args: unknown[]): void { void _args;
    const program = this.#current;
    if (!program) throw new Error("Native draw has no program.");
    const targets = this.#framebuffer ? this.#attachments.get(this.#framebuffer) : [0];
    if (!targets?.length) throw new Error("Native draw has no target.");
    const size = `${this.#width}x${this.#height}`;
    if (!this.#framebuffer && this.#outputSize !== size) {
      this.#uploads.push({ id: 0, width: this.#width, height: this.#height, layers: 1, format: "rgba8unorm" });
      this.#outputSize = size;
    }
    const textures = program.shader.textures.map((sampler) => {
      const unit = program.values.get(sampler.name)?.[0] ?? 0;
      const texture = this.#bindings.get(`${unit}:${sampler.dimension === "2d-array" ? this.TEXTURE_2D_ARRAY : this.TEXTURE_2D}`);
      if (texture) return this.#id(texture);
      if (sampler.dimension !== "2d-array") throw new Error(`Native sampler ${sampler.name} has no texture.`);
      if (this.#dummyArray === null) {
        this.#dummyArray = this.#nextId++;
        this.#uploads.push({ id: this.#dummyArray, width: 1, height: 1, layers: 1, format: "r32float", ...this.#append(new Float32Array(1)) });
      }
      return this.#dummyArray;
    });
    this.#passes.push({ shader: program.id, targets: [...targets], textures, uniforms: this.#append(packNativeUniforms(program.shader, program.values)) });
  }

  async submit(floatTextures: readonly WebGLTexture[]): Promise<number> {
    const started = performance.now();
    const reads: Read[] = [{ texture: 0, format: "rgba8", flipY: true }, ...floatTextures.map((texture) => ({ texture: this.#id(texture), format: "rgba32f" as const }))];
    const metadata = new TextEncoder().encode(JSON.stringify({ session: this.#session, shaders: this.#shaders, textures: this.#uploads, deleteTextures: this.#deleted, passes: this.#passes, reads, includeTiming: true }));
    // JSON whitespace aligns typed pixel views inside the final packet.
    const metadataLength = Math.ceil(metadata.length / 4) * 4;
    if (4 + metadataLength + this.#byteLength > MAX_BATCH_BYTES) throw new Error("Native GPU upload exceeds the batch memory limit.");
    const request = new Uint8Array(4 + metadataLength + this.#byteLength);
    new DataView(request.buffer).setUint32(0, metadataLength, true);
    request.set(metadata, 4);
    request.fill(32, 4 + metadata.length, 4 + metadataLength);
    let offset = 4 + metadataLength;
    for (const chunk of this.#chunks) {
      if (chunk instanceof Uint8Array) {
        request.set(chunk, offset);
        offset += chunk.byteLength;
      } else if (chunk.kind === "rgb16") {
        const rgba = new Uint16Array(request.buffer, offset, chunk.width * chunk.height * chunk.layers * 4);
        for (let layer = 0; layer < chunk.layers; layer++) for (let y = 0; y < chunk.height; y++) {
          const sourceRow = (layer * chunk.height + (chunk.flipY ? chunk.height - y - 1 : y)) * chunk.width;
          for (let x = 0; x < chunk.width; x++) {
            const source = (sourceRow + x) * 3;
            const destination = ((layer * chunk.height + y) * chunk.width + x) * 4;
            rgba[destination] = chunk.pixels[source]; rgba[destination + 1] = chunk.pixels[source + 1]; rgba[destination + 2] = chunk.pixels[source + 2]; rgba[destination + 3] = 65535;
          }
        }
        offset += rgba.byteLength;
      } else {
        for (let layer = 0; layer < chunk.layers; layer++) for (let y = 0; y < chunk.height; y++) {
          const start = (layer * chunk.height + chunk.height - y - 1) * chunk.rowBytes;
          request.set(chunk.pixels.subarray(start, start + chunk.rowBytes), offset + (layer * chunk.height + y) * chunk.rowBytes);
        }
        offset += chunk.pixels.byteLength;
      }
    }
    this.#shaders = []; this.#uploads = []; this.#deleted = []; this.#passes = []; this.#chunks = []; this.#byteLength = 0;
    const preparationMs = performance.now() - started;
    const response = await transport(request);
    this.#readbacks.clear();
    offset = 0;
    for (const read of reads) {
      const length = this.#width * this.#height * (read.format === "rgba8" ? 4 : 16);
      this.#readbacks.set(read.texture, new Uint8Array(response, offset, length));
      offset += length;
    }
    if (offset === response.byteLength) return performance.now() - started;
    if (offset + 8 !== response.byteLength) throw new Error("Native GPU readback size does not match the frame.");
    const durationMs = new DataView(response).getFloat64(offset, true);
    if (!Number.isFinite(durationMs) || durationMs < 0) throw new Error("Native GPU frame duration is invalid.");
    return durationMs + preparationMs;
  }
  readback(texture: WebGLTexture | null): Uint8Array<ArrayBuffer> {
    const bytes = this.#readbacks.get(texture ? this.#id(texture) : 0);
    if (!bytes) throw new Error("Native GPU readback is unavailable.");
    return bytes;
  }
  readPixels(_x: number, _y: number, _width: number, _height: number, _format: number, _type: number, target: ArrayBufferView): void {
    const id = this.#framebuffer ? this.#attachments.get(this.#framebuffer)?.[0] : 0;
    const bytes = id === undefined ? undefined : this.#readbacks.get(id);
    if (!bytes || bytes.byteLength !== target.byteLength) throw new Error("Native GPU readback is unavailable.");
    new Uint8Array(target.buffer, target.byteOffset, target.byteLength).set(bytes);
  }
  async release(): Promise<void> {
    const metadata = new TextEncoder().encode(JSON.stringify({ session: this.#session, release: true }));
    const request = new Uint8Array(4 + metadata.length);
    new DataView(request.buffer).setUint32(0, metadata.length, true); request.set(metadata, 4);
    try { await transport(request); } catch { /* A failed device has already released its resources. */ }
  }
}
