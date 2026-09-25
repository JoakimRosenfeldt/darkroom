export type NativeUniformType =
  | "float" | "int" | "uint" | "bool"
  | "vec2" | "vec3" | "vec4"
  | "ivec2" | "ivec3" | "ivec4"
  | "uvec2" | "uvec3" | "uvec4"
  | "mat2" | "mat3" | "mat4";

export interface NativeUniform {
  readonly name: string;
  readonly type: NativeUniformType;
  readonly offset: number;
  readonly count: number;
  readonly stride: number;
  readonly components: number;
}

export interface NativeShaderTexture {
  readonly name: string;
  readonly binding: number;
  readonly sampleType: "float" | "uint" | "sint";
  readonly dimension: "2d" | "2d-array";
}

export interface NativeShader {
  readonly source: string;
  readonly uniforms: readonly NativeUniform[];
  readonly textures: readonly NativeShaderTexture[];
  readonly samplerBinding: number;
  readonly uniformBufferSize: number;
}

function align(value: number, alignment: number): number {
  return Math.ceil(value / alignment) * alignment;
}

function uniformLayout(type: string): {
  readonly type: NativeUniformType;
  readonly alignment: number;
  readonly size: number;
  readonly components: number;
} {
  switch (type) {
    case "float": case "int": case "uint": case "bool":
      return { type, alignment: 4, size: 4, components: 1 };
    case "vec2": case "ivec2": case "uvec2":
      return { type, alignment: 8, size: 8, components: 2 };
    case "vec3": case "ivec3": case "uvec3":
      return { type, alignment: 16, size: 12, components: 3 };
    case "vec4": case "ivec4": case "uvec4":
      return { type, alignment: 16, size: 16, components: 4 };
    case "mat2": return { type, alignment: 16, size: 32, components: 4 };
    case "mat3": return { type, alignment: 16, size: 48, components: 9 };
    case "mat4": return { type, alignment: 16, size: 64, components: 16 };
    default: throw new Error(`Unsupported native shader uniform type: ${type}`);
  }
}

function preprocess(source: string): string {
  const defined = new Set<string>();
  const branches: { readonly parent: boolean; readonly condition: boolean; alternate: boolean }[] = [];
  const lines: string[] = [];
  let active = true;
  for (const line of source.split("\n")) {
    const directive = /^\s*#(\w+)\s*(.*?)\s*$/.exec(line);
    if (!directive) {
      if (active) lines.push(line);
      continue;
    }
    const [, kind, argument] = directive;
    switch (kind) {
      case "version": break;
      case "define":
        if (active) {
          defined.add(argument.split(/\s/, 1)[0]);
          lines.push(line);
        }
        break;
      case "ifdef": case "ifndef": {
        const condition = defined.has(argument) === (kind === "ifdef");
        branches.push({ parent: active, condition, alternate: false });
        active = active && condition;
        break;
      }
      case "else": {
        const branch = branches.at(-1);
        if (!branch || branch.alternate) throw new Error("Invalid native shader conditional.");
        branch.alternate = true;
        active = branch.parent && !branch.condition;
        break;
      }
      case "endif": {
        const branch = branches.pop();
        if (!branch) throw new Error("Invalid native shader conditional.");
        active = branch.parent;
        break;
      }
      default: throw new Error(`Unsupported native shader directive: #${kind}`);
    }
  }
  if (branches.length) throw new Error("Unclosed native shader conditional.");
  return lines.join("\n");
}

export function translateNativeFragmentShader(source: string): NativeShader {
  const uniforms: NativeUniform[] = [];
  const textures: NativeShaderTexture[] = [];
  const declarations: string[] = [];
  const members: string[] = [];
  const aliases: string[] = [];
  let bytes = 0;
  let body = preprocess(source).replace(/^\s*precision\s+\w+\s+\w+\s*;\s*$/gm, "");
  body = body.replace(
    /^\s*uniform\s+(?:(?:highp|mediump|lowp)\s+)?(\w+)\s+(\w+)(?:\[(\d+)\])?\s*;\s*$/gm,
    (_declaration: string, type: string, name: string, arrayCount: string | undefined): string => {
      const sampler = /^([iu]?)sampler(2D|2DArray)$/.exec(type);
      if (sampler) {
        if (arrayCount) throw new Error("Native shader sampler arrays are unsupported.");
        const binding = textures.length + 1;
        const textureName = `nativeTexture${binding}`;
        textures.push({
          name, binding,
          sampleType: sampler[1] === "u" ? "uint" : sampler[1] === "i" ? "sint" : "float",
          dimension: sampler[2] === "2DArray" ? "2d-array" : "2d",
        });
        declarations.push(`layout(set = 0, binding = ${binding}) uniform ${sampler[1]}texture${sampler[2]} ${textureName};`);
        aliases.push(`#define ${name} ${type}(${textureName}, nativeSampler)`);
        return "";
      }
      const layout = uniformLayout(type);
      const count = arrayCount === undefined ? 1 : Number(arrayCount);
      if (!Number.isSafeInteger(count) || count < 1) throw new Error("Invalid native shader uniform array size.");
      const offset = align(bytes, arrayCount === undefined ? layout.alignment : 16);
      const stride = arrayCount === undefined ? layout.size : align(layout.size, 16);
      uniforms.push({ name, type: layout.type, offset, count, stride, components: layout.components });
      bytes = offset + stride * count;
      if (type === "bool" && arrayCount) throw new Error("Native shader boolean arrays are unsupported.");
      members.push(`  ${type === "bool" ? "int" : type} ${name}${arrayCount === undefined ? "" : `[${count}]`};`);
      aliases.push(`#define ${name} ${type === "bool" ? `(nativeUniforms.${name} != 0)` : `nativeUniforms.${name}`}`);
      return "";
    },
  );
  let nextInput = 0;
  let nextOutput = 0;
  body = body.replace(/^\s*(in|out)\s+(\w+)\s+(\w+)\s*;/gm,
    (_declaration: string, direction: string, type: string, name: string) => {
      if (direction === "in" && body.match(new RegExp(`\\b${name}\\b`, "g"))?.length === 1) return "";
      return `layout(location = ${direction === "in" ? nextInput++ : nextOutput++}) ${direction} ${type} ${name};`;
    });
  const samplerBinding = textures.length + 1;
  if (!members.length) members.push("  float nativeUnused;");
  return {
    source: [
      "#version 450",
      "layout(std140, set = 0, binding = 0) uniform NativeUniforms {",
      ...members,
      "} nativeUniforms;",
      ...declarations,
      `layout(set = 0, binding = ${samplerBinding}) uniform sampler nativeSampler;`,
      ...aliases,
      body,
    ].join("\n"),
    uniforms,
    textures,
    samplerBinding,
    uniformBufferSize: Math.max(16, align(bytes, 16)),
  };
}

export function writeNativeUniform(
  buffer: Uint8Array,
  uniform: NativeUniform,
  values: ArrayLike<number>,
  arrayOffset = 0,
): void {
  const view = new DataView(buffer.buffer, buffer.byteOffset, buffer.byteLength);
  const matrixColumns = uniform.type.startsWith("mat") ? Math.sqrt(uniform.components) : 0;
  const integer = uniform.type === "bool" || uniform.type === "int" || uniform.type.startsWith("ivec");
  const unsigned = uniform.type === "uint" || uniform.type.startsWith("uvec");
  if (!Number.isSafeInteger(arrayOffset) || arrayOffset < 0 || arrayOffset >= uniform.count ||
    values.length > (uniform.count - arrayOffset) * uniform.components) {
    throw new Error(`Invalid native shader uniform value: ${uniform.name}`);
  }
  for (let index = 0; index < values.length; index += 1) {
    const element = Math.floor(index / uniform.components) + arrayOffset;
    const component = index % uniform.components;
    const componentOffset = matrixColumns
      ? Math.floor(component / matrixColumns) * 16 + component % matrixColumns * 4
      : component * 4;
    const offset = uniform.offset + element * uniform.stride + componentOffset;
    if (integer) view.setInt32(offset, values[index], true);
    else if (unsigned) view.setUint32(offset, values[index], true);
    else view.setFloat32(offset, values[index], true);
  }
}

export function packNativeUniforms(
  shader: NativeShader,
  values: ReadonlyMap<string, readonly number[]>,
): Uint8Array {
  const buffer = new Uint8Array(shader.uniformBufferSize);
  for (const uniform of shader.uniforms) {
    const value = values.get(uniform.name) ?? values.get(`${uniform.name}[0]`);
    if (value) writeNativeUniform(buffer, uniform, value);
  }
  return buffer;
}
