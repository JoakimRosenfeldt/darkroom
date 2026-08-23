import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { constants } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import {
  createFormatCapabilityReport,
} from "../lib/formats/report.ts";
import type {
  CameraSupportRow,
  FormatCapabilityReport,
  NikonPixelProtocol,
  NikonRuntimePackageState,
  NikonRuntimeBackend,
  NikonRuntimeCapability,
} from "../lib/formats/types.ts";
import type { NefDecoderCommand } from "./nef-decoder-service.ts";

const NIKON_PROBE_VERSION = 1;
const NIKON_PIXEL_PROTOCOL: NikonPixelProtocol = "rgb16le-v1";
const MAX_PROBE_STDOUT_BYTES = 16 * 1024;
const MAX_PROBE_STDERR_BYTES = 16 * 1024;
const MAX_HELPER_BYTES = 256 * 1024 * 1024;
const HASH_CHUNK_BYTES = 1024 * 1024;
const DEFAULT_PROBE_TIMEOUT_MS = 5_000;

export interface NikonDecoderProbe {
  readonly version: 1;
  readonly helperVersion: string;
  readonly backend: NikonRuntimeBackend;
  readonly pixelProtocol: NikonPixelProtocol;
  readonly architecture: string;
}

export interface NikonRuntimeProbeInput {
  readonly helper: NefDecoderCommand | null;
  readonly packageState: NikonRuntimePackageState;
  readonly approvedChecksum?: string;
  readonly platform?: string;
  readonly architecture?: string;
  readonly timeoutMs?: number;
}

export interface FormatCapabilityServiceInput {
  readonly appVersion: string;
  readonly helper: NefDecoderCommand | null;
  readonly packageState: NikonRuntimePackageState;
  readonly approvedChecksum?: string;
  readonly platform?: string;
  readonly architecture?: string;
  readonly timeoutMs?: number;
  readonly cameraRows?: readonly CameraSupportRow[];
}

type ProbeFailureKind = "missing" | "invalid" | "response";

class ProbeFailure extends Error {
  readonly kind: ProbeFailureKind;

  constructor(kind: ProbeFailureKind, message: string) {
    super(message);
    this.kind = kind;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function boundedString(value: unknown, label: string, maximum: number): string {
  if (typeof value !== "string" || value.length === 0 || value.length > maximum || value.includes("\u0000")) {
    throw new ProbeFailure("response", `Nikon probe ${label} is invalid.`);
  }
  return value;
}

function isNikonRuntimeBackend(value: unknown): value is NikonRuntimeBackend {
  return value === "nikon-sdk" || value === "darkroom-test-mock";
}

function isNikonPixelProtocol(value: unknown): value is NikonPixelProtocol {
  return value === NIKON_PIXEL_PROTOCOL;
}

export function parseNikonDecoderProbe(value: unknown): NikonDecoderProbe {
  if (!isRecord(value) || value.version !== NIKON_PROBE_VERSION) {
    throw new ProbeFailure("response", "Nikon probe protocol version is invalid.");
  }
  const backend = value.backend;
  const pixelProtocol = value.pixelProtocol;
  if (!isNikonRuntimeBackend(backend)) {
    throw new ProbeFailure("response", "Nikon probe backend is invalid.");
  }
  if (!isNikonPixelProtocol(pixelProtocol)) {
    throw new ProbeFailure("response", "Nikon probe pixel protocol is invalid.");
  }
  const architecture = boundedString(value.architecture, "architecture", 64);
  const helperVersion = boundedString(value.helperVersion, "helperVersion", 128);
  if (architecture.includes("\r") || architecture.includes("\n") || helperVersion.includes("\r") || helperVersion.includes("\n")) {
    throw new ProbeFailure("response", "Nikon probe contains a control character.");
  }
  return {
    version: 1,
    helperVersion,
    backend,
    pixelProtocol,
    architecture,
  };
}

function isCheckedInMock(command: NefDecoderCommand): boolean {
  return path.basename(command.executable) === "mock-decoder.mjs" ||
    (command.fixedArgs?.some((argument) => path.basename(argument) === "mock-decoder.mjs") ?? false);
}

function commandKind(command: NefDecoderCommand): "native" | "test-only" | "none" {
  if (command.kind === "native") return "native";
  if (command.kind === "test-only") return "test-only";
  return "none";
}

function commandPackageState(
  checkedInMock: boolean,
  requested: NikonRuntimePackageState,
): NikonRuntimePackageState {
  if (checkedInMock) return "test-only";
  return requested;
}

function helperEnvironment(command: NefDecoderCommand): NodeJS.ProcessEnv {
  return {
    NODE_ENV: process.env.NODE_ENV ?? "production",
    ...(process.platform === "win32" && process.env.SystemRoot
      ? { SystemRoot: process.env.SystemRoot }
      : {}),
    ...(process.platform === "win32" && process.env.WINDIR
      ? { WINDIR: process.env.WINDIR }
      : {}),
    ...command.env,
  };
}

interface ArtifactFingerprint {
  readonly contentHash: string;
  readonly identity: string;
}

interface HelperFingerprint {
  readonly checksum: string;
  readonly identity: string;
}

async function hashArtifact(
  filePath: string,
  label: string,
  requireExecutable: boolean,
): Promise<ArtifactFingerprint> {
  let link: Awaited<ReturnType<typeof fs.lstat>>;
  try {
    link = await fs.lstat(filePath);
  } catch (error) {
    if (isNodeErrorCode(error, "ENOENT")) {
      throw new ProbeFailure(requireExecutable ? "missing" : "invalid", `${label} is not installed.`);
    }
    throw new ProbeFailure("invalid", `${label} could not be inspected.`);
  }
  if (!link.isFile() || link.isSymbolicLink()) {
    throw new ProbeFailure("invalid", `${label} must be a regular non-symlink file.`);
  }
  if (requireExecutable && process.platform !== "win32") {
    await fs.access(filePath, constants.X_OK).catch(() => {
      throw new ProbeFailure("invalid", `${label} is not executable.`);
    });
  }

  let handle: Awaited<ReturnType<typeof fs.open>> | undefined;
  try {
    handle = await fs.open(filePath, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
    const opened = await handle.stat();
    if (
      !opened.isFile() ||
      opened.isSymbolicLink() ||
      opened.dev !== link.dev ||
      opened.ino !== link.ino ||
      opened.size > MAX_HELPER_BYTES
    ) {
      throw new ProbeFailure("invalid", `${label} file identity or size is invalid.`);
    }
    const digest = createHash("sha256");
    digest.update(`darkroom-nikon-probe-artifact-v1\u0000${label}\u0000`);
    const buffer = Buffer.allocUnsafe(HASH_CHUNK_BYTES);
    let offset = 0;
    while (offset < opened.size) {
      const result = await handle.read(buffer, 0, Math.min(buffer.byteLength, opened.size - offset), offset);
      if (result.bytesRead <= 0) {
        throw new ProbeFailure("invalid", `${label} changed while it was hashed.`);
      }
      digest.update(buffer.subarray(0, result.bytesRead));
      offset += result.bytesRead;
    }
    const after = await handle.stat();
    if (after.size !== opened.size || after.mtimeMs !== opened.mtimeMs || after.ctimeMs !== opened.ctimeMs) {
      throw new ProbeFailure("invalid", `${label} changed while it was hashed.`);
    }
    return {
      contentHash: digest.digest("hex"),
      identity: `${opened.dev}:${opened.ino}:${opened.size}:${opened.mtimeMs}:${opened.ctimeMs}`,
    };
  } catch (error) {
    if (error instanceof ProbeFailure) throw error;
    throw new ProbeFailure("invalid", `${label} could not be hashed.`);
  } finally {
    if (handle) await handle.close().catch(() => undefined);
  }
}

async function hashHelperCommand(command: NefDecoderCommand): Promise<HelperFingerprint> {
  if (!path.isAbsolute(command.executable)) {
    throw new ProbeFailure("invalid", "Nikon decoder executable path must be absolute.");
  }
  const digest = createHash("sha256");
  digest.update("darkroom-nikon-probe-command-v1\u0000");
  const identities: string[] = [];
  const executable = await hashArtifact(command.executable, "Nikon decoder", true);
  digest.update(`executable\u0000${executable.contentHash}\u0000`);
  identities.push(`executable:${executable.identity}`);
  for (const [index, argument] of (command.fixedArgs ?? []).entries()) {
    const stat = path.isAbsolute(argument) ? await fs.lstat(argument).catch(() => null) : null;
    if (stat?.isSymbolicLink()) {
      throw new ProbeFailure("invalid", "Nikon decoder fixed artifact must not be a symlink.");
    }
    if (stat?.isFile()) {
      const artifact = await hashArtifact(argument, `fixed argument ${index}`, false);
      digest.update(`artifact\u0000${index}\u0000${artifact.contentHash}\u0000`);
      identities.push(`argument:${index}:${artifact.identity}`);
    } else {
      digest.update(`argument\u0000${index}\u0000${argument}\u0000`);
      identities.push(`argument:${index}:${argument}`);
    }
  }
  for (const [key, value] of Object.entries(command.env ?? {}).sort(([left], [right]) => left.localeCompare(right))) {
    digest.update(`environment\u0000${key}\u0000${value}\u0000`);
    identities.push(`environment:${key}:${value}`);
  }
  return { checksum: digest.digest("hex"), identity: identities.join("|") };
}

function isNodeErrorCode(error: unknown, code: string): boolean {
  return typeof error === "object" && error !== null && "code" in error && Reflect.get(error, "code") === code;
}

function runProbe(command: NefDecoderCommand, timeoutMs: number): Promise<NikonDecoderProbe> {
  const args = [...(command.fixedArgs ?? [])];
  if (!args.includes("--probe")) args.push("--probe");
  return new Promise((resolve, reject) => {
    const child = spawn(command.executable, args, {
      shell: false,
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
      env: helperEnvironment(command),
    });
    let stdout = Buffer.alloc(0);
    let stderrBytes = 0;
    let timedOut = false;
    let oversized = false;
    let settled = false;
    let killDeadline: NodeJS.Timeout | undefined;
    const terminate = (): void => {
      child.kill();
      killDeadline ??= setTimeout(() => child.kill("SIGKILL"), 2_000);
    };
    const timeout = setTimeout(() => {
      timedOut = true;
      terminate();
    }, timeoutMs);

    const finish = (error: Error | null, value: NikonDecoderProbe | null = null): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      if (killDeadline) clearTimeout(killDeadline);
      if (error) reject(error);
      else if (value) resolve(value);
      else reject(new ProbeFailure("response", "Nikon probe returned no response."));
    };

    child.stdout.on("data", (chunk: Buffer) => {
      if (stdout.byteLength >= MAX_PROBE_STDOUT_BYTES) return;
      const next = Buffer.from(chunk);
      if (stdout.byteLength + next.byteLength > MAX_PROBE_STDOUT_BYTES) {
        oversized = true;
        terminate();
        return;
      }
      stdout = Buffer.concat([stdout, next]);
    });
    child.stderr.on("data", (chunk: Buffer) => {
      stderrBytes = Math.min(MAX_PROBE_STDERR_BYTES + 1, stderrBytes + Buffer.byteLength(chunk));
      if (stderrBytes > MAX_PROBE_STDERR_BYTES) {
        oversized = true;
        terminate();
      }
    });
    child.once("error", () => finish(new ProbeFailure("response", "Nikon probe could not start.")));
    child.once("close", (code) => {
      if (timedOut) {
        finish(new ProbeFailure("response", "Nikon probe timed out."));
      } else if (oversized) {
        finish(new ProbeFailure("response", "Nikon probe output is too large."));
      } else if (code !== 0) {
        finish(new ProbeFailure("response", "Nikon probe exited unsuccessfully."));
      } else {
        const text = stdout.toString("utf8").trim();
        if (text.length === 0) {
          finish(new ProbeFailure("response", "Nikon probe returned no response."));
          return;
        }
        try {
          finish(null, parseNikonDecoderProbe(JSON.parse(text) as unknown));
        } catch (error) {
          finish(error instanceof Error ? error : new ProbeFailure("response", "Nikon probe response is invalid."));
        }
      }
    });
  });
}

function runtimeFailure(
  status: "unavailable" | "misconfigured",
  kind: "native" | "test-only" | "none",
  packageState: NikonRuntimePackageState,
  reason: string,
  facts: Partial<Pick<NikonRuntimeCapability, "version" | "architecture" | "checksum" | "backend" | "pixelProtocol">> = {},
): NikonRuntimeCapability {
  return {
    status,
    kind,
    packageState,
    version: facts.version ?? null,
    architecture: facts.architecture ?? null,
    checksum: facts.checksum ?? null,
    backend: facts.backend ?? null,
    pixelProtocol: facts.pixelProtocol ?? null,
    reason,
  };
}

export async function probeNikonRuntime(input: NikonRuntimeProbeInput): Promise<NikonRuntimeCapability> {
  const expectedArchitecture = input.architecture ?? process.arch;
  const platform = input.platform ?? process.platform;
  if (input.helper === null) {
    return input.packageState === "unavailable"
      ? runtimeFailure("unavailable", "none", "unavailable", "No Nikon decoder helper is configured.")
      : runtimeFailure("misconfigured", "none", input.packageState, "No helper is configured for this package state.");
  }
  const kind = commandKind(input.helper);
  const checkedInMock = isCheckedInMock(input.helper);
  const packageState = commandPackageState(checkedInMock, input.packageState);
  const approvedChecksum = input.approvedChecksum ?? input.helper.expectedChecksum;
  const timeoutMs = input.timeoutMs ?? DEFAULT_PROBE_TIMEOUT_MS;
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 50 || timeoutMs > 60_000) {
    return runtimeFailure("misconfigured", kind, packageState, "Nikon decoder probe timeout is outside 50-60000ms.");
  }
  if (packageState === "unavailable") {
    return runtimeFailure("misconfigured", kind, packageState, "A configured Nikon helper cannot have unavailable package state.");
  }
  if (!checkedInMock && input.helper.packageState !== undefined && input.helper.packageState !== input.packageState) {
    return runtimeFailure("misconfigured", kind, packageState, "Nikon helper package state does not match the probe request.");
  }
  if (packageState === "packaged" && platform !== "darwin") {
    return runtimeFailure("misconfigured", kind, packageState, "Packaged Nikon runtime is unsupported on this platform.");
  }
  if (packageState === "packaged" && kind !== "native") {
    return runtimeFailure("misconfigured", kind, packageState, "Only a native command may be packaged.");
  }
  if (packageState === "packaged" && !approvedChecksum) {
    return runtimeFailure("misconfigured", kind, packageState, "Packaged Nikon runtime has no approved checksum.");
  }
  if (approvedChecksum !== undefined && !/^[0-9a-f]{64}$/.test(approvedChecksum)) {
    return runtimeFailure("misconfigured", kind, packageState, "Approved Nikon checksum is invalid.");
  }
  let checksum: string;
  let identity: string;
  try {
    const fingerprint = await hashHelperCommand(input.helper);
    checksum = fingerprint.checksum;
    identity = fingerprint.identity;
  } catch (error) {
    if (error instanceof ProbeFailure && error.kind === "missing") {
      return runtimeFailure("unavailable", kind, packageState, error.message);
    }
    return runtimeFailure("misconfigured", kind, packageState, error instanceof Error ? error.message : "Nikon decoder is invalid.");
  }
  if (approvedChecksum !== undefined && approvedChecksum !== checksum) {
    return runtimeFailure("misconfigured", kind, packageState, "Nikon decoder checksum does not match its approved manifest.", { checksum });
  }

  let probe: NikonDecoderProbe;
  try {
    probe = await runProbe(input.helper, timeoutMs);
  } catch (error) {
    return runtimeFailure(
      "misconfigured",
      kind,
      packageState,
      error instanceof Error ? error.message : "Nikon decoder probe failed.",
      { checksum },
    );
  }
  try {
    const afterProbe = await hashHelperCommand(input.helper);
    if (afterProbe.checksum !== checksum || afterProbe.identity !== identity) {
      return runtimeFailure("misconfigured", kind, packageState, "Nikon decoder changed during its probe.", { checksum });
    }
  } catch (error) {
    return runtimeFailure("misconfigured", kind, packageState, error instanceof Error ? error.message : "Nikon decoder changed during its probe.", { checksum });
  }
  const expectedBackend: NikonRuntimeBackend = checkedInMock || kind !== "native" ? "darkroom-test-mock" : "nikon-sdk";
  const facts = {
    version: probe.helperVersion,
    architecture: probe.architecture,
    checksum,
    backend: probe.backend,
    pixelProtocol: probe.pixelProtocol,
  } satisfies Partial<Pick<NikonRuntimeCapability, "version" | "architecture" | "checksum" | "backend" | "pixelProtocol">>;
  if (probe.architecture !== expectedArchitecture) {
    return runtimeFailure("misconfigured", kind, packageState, "Nikon decoder architecture does not match the host.", facts);
  }
  if (probe.backend !== expectedBackend) {
    return runtimeFailure("misconfigured", kind, packageState, "Nikon decoder backend does not match its command kind.", facts);
  }
  if (probe.pixelProtocol !== NIKON_PIXEL_PROTOCOL) {
    return runtimeFailure("misconfigured", kind, packageState, "Nikon decoder pixel protocol is not supported.", facts);
  }
  if (packageState === "packaged" && kind === "native" && !checkedInMock) {
    return {
      status: "available",
      kind: "native",
      packageState,
      ...facts,
      reason: "Qualified Nikon native runtime passed its versioned probe.",
    };
  }
  if (packageState === "development" && kind === "native" && !checkedInMock) {
    return {
      status: "misconfigured",
      kind: "native",
      packageState,
      ...facts,
      reason: "Development Nikon runtime is not release-qualified.",
    };
  }
  return {
    status: "test-only",
    kind: "test-only",
    packageState: checkedInMock ? "test-only" : packageState,
    ...facts,
    reason: "Nikon helper passed its probe but is test-only and cannot claim native support.",
  };
}

export async function createRuntimeFormatCapabilityReport(
  input: FormatCapabilityServiceInput,
): Promise<FormatCapabilityReport> {
  const platform = input.platform ?? process.platform;
  const architecture = input.architecture ?? process.arch;
  const nikon = await probeNikonRuntime({
    helper: input.helper,
    packageState: input.packageState,
    approvedChecksum: input.approvedChecksum,
    platform,
    architecture,
    timeoutMs: input.timeoutMs,
  });
  return createFormatCapabilityReport({
    appVersion: input.appVersion,
    platform,
    architecture,
    nikon,
    cameraRows: input.cameraRows,
  });
}

export function getPackagedNikonDecoderCommand(
  resourcesPath: string,
  platform = process.platform,
  approvedChecksum?: string,
): NefDecoderCommand | null {
  if (platform !== "darwin") return null;
  if (!path.isAbsolute(resourcesPath)) throw new Error("Electron resourcesPath must be absolute.");
  return {
    executable: path.join(resourcesPath, "nikon-nef-decoder", "MacOS", "nikon-nef-decoder"),
    kind: "native",
    packageState: "packaged",
    ...(approvedChecksum === undefined ? {} : { expectedChecksum: approvedChecksum }),
  };
}
