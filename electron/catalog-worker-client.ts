import path from "node:path";
import { randomUUID } from "node:crypto";
import { Worker, type WorkerOptions } from "node:worker_threads";
import type { CatalogFaultPoint } from "./catalog-fault-injection.ts";
import type { AssetId, OperationId } from "../lib/catalog/ids.ts";
import {
  parseCatalogWorkerResponse,
  type CatalogWorkerBackupResponse,
  type CatalogWorkerCloseResponse,
  type CatalogWorkerError,
  type CatalogWorkerIntegrityCheckResponse,
  type CatalogWorkerOpenResponse,
  type CatalogWorkerRequest,
  type CatalogWorkerResponse,
  type CatalogWorkerRuntimeInfo,
  type CatalogWorkerShutdownResponse,
  type CatalogWorkerTestTracerRecoverResponse,
  type CatalogWorkerTestTracerInspectResponse,
  type CatalogWorkerTestTracerRunResponse,
  type CatalogWorkerTransactionProbeResponse,
} from "./catalog-worker-protocol.ts";

export interface CatalogWorkerClientOptions {
  readonly workerPath: string;
  readonly requestTimeoutMs?: number;
}

export interface CatalogWorkerTestClientOptions extends CatalogWorkerClientOptions {
  readonly workerData?: unknown;
  readonly execArgv?: readonly string[];
}

export class CatalogWorkerTimeoutError extends Error {
  readonly requestId: string;

  constructor(requestId: string) {
    super(`Catalog worker request ${requestId} timed out.`);
    this.name = "CatalogWorkerTimeoutError";
    this.requestId = requestId;
  }
}

export class CatalogWorkerStoppedError extends Error {
  constructor(message = "Catalog worker stopped unexpectedly.") {
    super(message);
    this.name = "CatalogWorkerStoppedError";
  }
}

export class CatalogWorkerRequestError extends Error {
  readonly code: CatalogWorkerError["code"];
  readonly faultPoint: CatalogFaultPoint | null;

  constructor(response: CatalogWorkerError) {
    super(response.message);
    this.name = "CatalogWorkerRequestError";
    this.code = response.code;
    this.faultPoint = response.code === "injected-fault" ? response.faultPoint : null;
  }
}

export interface CatalogWorkerTestTracerInput {
  readonly operationId: OperationId;
  readonly itemId: AssetId;
  readonly sourcePath: string;
  readonly destinationPath: string;
}

interface PendingRequest {
  readonly resolve: (response: CatalogWorkerResponse) => void;
  readonly reject: (error: unknown) => void;
  readonly timer: ReturnType<typeof setTimeout>;
}

interface InternalWorkerOptions extends CatalogWorkerClientOptions {
  readonly workerData?: unknown;
  readonly execArgv?: readonly string[];
}

function requestId(): string {
  return randomUUID();
}

function timeoutValue(value: number | undefined): number {
  if (value === undefined) {
    return 5_000;
  }
  if (!Number.isInteger(value) || value <= 0) {
    throw new Error("Catalog worker timeout must be a positive integer.");
  }
  return value;
}

function responseError(response: CatalogWorkerError): Error {
  return new CatalogWorkerRequestError(response);
}

function requireKind<K extends CatalogWorkerResponse["kind"]>(
  response: CatalogWorkerResponse,
  kind: K,
): Extract<CatalogWorkerResponse, { kind: K }> {
  if (response.kind !== kind) {
    throw new Error(`Catalog worker returned ${response.kind} for ${kind}.`);
  }
  return response as Extract<CatalogWorkerResponse, { kind: K }>;
}

export class CatalogWorkerClient {
  private readonly worker: Worker;
  private readonly defaultTimeoutMs: number;
  private readonly pending = new Map<string, PendingRequest>();
  private readonly exited: Promise<number>;
  private resolveExited: ((code: number) => void) | null = null;
  private unusable = false;
  private hasExited = false;

  private constructor(worker: Worker, requestTimeoutMs: number) {
    this.defaultTimeoutMs = requestTimeoutMs;
    this.worker = worker;
    this.exited = new Promise((resolve) => {
      this.resolveExited = resolve;
    });
    this.attachWorkerListeners();
  }

  static create(options: CatalogWorkerClientOptions): CatalogWorkerClient {
    return new CatalogWorkerClient(
      new Worker(options.workerPath),
      timeoutValue(options.requestTimeoutMs),
    );
  }

  static createForTests(options: InternalWorkerOptions): CatalogWorkerClient {
    const workerOptions: WorkerOptions = {
      workerData: options.workerData,
      execArgv: options.execArgv ? [...options.execArgv] : undefined,
    };
    return new CatalogWorkerClient(
      new Worker(options.workerPath, workerOptions),
      timeoutValue(options.requestTimeoutMs),
    );
  }

  private attachWorkerListeners(): void {
    this.worker.on("message", (value: unknown) => {
      let response: CatalogWorkerResponse;
      try {
        response = parseCatalogWorkerResponse(value);
      } catch (error) {
        this.failFatally(new CatalogWorkerStoppedError(
          error instanceof Error ? error.message : "Catalog worker returned an invalid response.",
        ));
        return;
      }
      if (response.requestId === null) {
        this.failFatally(
          response.kind === "error"
            ? responseError(response)
            : new CatalogWorkerStoppedError("Catalog worker returned an unaddressed response."),
        );
        return;
      }
      const pending = this.pending.get(response.requestId);
      if (!pending) {
        return;
      }
      this.pending.delete(response.requestId);
      clearTimeout(pending.timer);
      if (response.kind === "error") {
        pending.reject(responseError(response));
        return;
      }
      pending.resolve(response);
    });
    this.worker.on("error", (error: Error) => {
      this.failFatally(new CatalogWorkerStoppedError(error.message));
    });
    this.worker.on("exit", (code: number) => {
      this.unusable = true;
      this.hasExited = true;
      this.resolveExited?.(code);
      this.resolveExited = null;
      if (this.pending.size > 0) {
        this.failAll(new CatalogWorkerStoppedError(`Catalog worker exited with code ${code}.`));
      }
    });
  }

  private failAll(error: Error): void {
    this.unusable = true;
    for (const [id, pending] of this.pending) {
      this.pending.delete(id);
      clearTimeout(pending.timer);
      pending.reject(error);
    }
  }

  private failFatally(error: Error): void {
    this.failAll(error);
    if (!this.hasExited) {
      void this.worker.terminate().catch(() => undefined);
    }
  }

  private send(request: CatalogWorkerRequest, timeoutMs = this.defaultTimeoutMs): Promise<CatalogWorkerResponse> {
    if (this.unusable) {
      return Promise.reject(new CatalogWorkerStoppedError());
    }
    return new Promise<CatalogWorkerResponse>((resolve, reject) => {
      const timer = setTimeout(() => {
        const pending = this.pending.get(request.requestId);
        if (!pending) {
          return;
        }
        this.pending.delete(request.requestId);
        pending.reject(new CatalogWorkerTimeoutError(request.requestId));
      }, timeoutMs);
      this.pending.set(request.requestId, { resolve, reject, timer });
      try {
        this.worker.postMessage(request);
      } catch (error) {
        this.pending.delete(request.requestId);
        clearTimeout(timer);
        reject(error);
      }
    });
  }

  async runtimeInfo(): Promise<CatalogWorkerRuntimeInfo> {
    const response = await this.send({ kind: "runtime-info", requestId: requestId() });
    return requireKind(response, "runtime-info");
  }

  async open(databasePath: string): Promise<CatalogWorkerOpenResponse> {
    const normalizedPath = path.normalize(path.resolve(databasePath));
    const response = await this.send({
      kind: "open",
      requestId: requestId(),
      databasePath: normalizedPath,
    });
    return requireKind(response, "open");
  }

  async transactionProbe(timeoutMs?: number): Promise<CatalogWorkerTransactionProbeResponse> {
    const response = await this.send(
      { kind: "transaction-probe", requestId: requestId() },
      timeoutMs === undefined ? this.defaultTimeoutMs : timeoutValue(timeoutMs),
    );
    return requireKind(response, "transaction-probe");
  }

  async backup(destinationPath: string): Promise<CatalogWorkerBackupResponse> {
    const normalizedPath = path.normalize(path.resolve(destinationPath));
    const response = await this.send({
      kind: "backup",
      requestId: requestId(),
      destinationPath: normalizedPath,
    });
    return requireKind(response, "backup");
  }

  async integrityCheck(): Promise<CatalogWorkerIntegrityCheckResponse> {
    const response = await this.send({ kind: "integrity-check", requestId: requestId() });
    return requireKind(response, "integrity-check");
  }

  async close(): Promise<CatalogWorkerCloseResponse> {
    const response = await this.send({ kind: "close", requestId: requestId() });
    return requireKind(response, "close");
  }

  async runTestTracer(
    input: CatalogWorkerTestTracerInput,
  ): Promise<CatalogWorkerTestTracerRunResponse> {
    const response = await this.send({
      kind: "test-tracer-run",
      requestId: requestId(),
      operationId: input.operationId,
      itemId: input.itemId,
      sourcePath: path.normalize(path.resolve(input.sourcePath)),
      destinationPath: path.normalize(path.resolve(input.destinationPath)),
    });
    return requireKind(response, "test-tracer-run");
  }

  async recoverTestTracer(
    input: Pick<CatalogWorkerTestTracerInput, "operationId" | "itemId">,
  ): Promise<CatalogWorkerTestTracerRecoverResponse> {
    const response = await this.send({
      kind: "test-tracer-recover",
      requestId: requestId(),
      operationId: input.operationId,
      itemId: input.itemId,
    });
    return requireKind(response, "test-tracer-recover");
  }

  async inspectTestTracer(
    input: Pick<CatalogWorkerTestTracerInput, "operationId" | "itemId">,
  ): Promise<CatalogWorkerTestTracerInspectResponse> {
    const response = await this.send({
      kind: "test-tracer-inspect",
      requestId: requestId(),
      operationId: input.operationId,
      itemId: input.itemId,
    });
    return requireKind(response, "test-tracer-inspect");
  }

  async shutdown(timeoutMs = this.defaultTimeoutMs): Promise<void> {
    const boundedTimeoutMs = timeoutValue(timeoutMs);
    if (this.hasExited) {
      return;
    }
    if (this.unusable) {
      await this.forceTerminate();
      return;
    }
    let shutdownResponse: CatalogWorkerShutdownResponse;
    try {
      const response = await this.send(
        { kind: "shutdown", requestId: requestId() },
        boundedTimeoutMs,
      );
      shutdownResponse = requireKind(response, "shutdown");
    } catch (error) {
      await this.forceTerminate();
      throw error;
    }
    void shutdownResponse;
    let exitTimer: ReturnType<typeof setTimeout> | undefined;
    const exited = await Promise.race([
      this.exited.then(() => true),
      new Promise<false>((resolve) => {
        exitTimer = setTimeout(() => resolve(false), boundedTimeoutMs);
      }),
    ]);
    if (exitTimer) {
      clearTimeout(exitTimer);
    }
    if (!exited) {
      await this.forceTerminate();
    }
  }

  async forceTerminate(): Promise<void> {
    if (this.hasExited) {
      return;
    }
    this.failAll(new CatalogWorkerStoppedError("Catalog worker was terminated."));
    await this.worker.terminate();
  }
}

export function createCatalogWorkerClient(
  options: CatalogWorkerClientOptions,
): CatalogWorkerClient {
  return CatalogWorkerClient.create(options);
}

export function createCatalogWorkerTestClient(
  options: CatalogWorkerTestClientOptions,
): CatalogWorkerClient {
  return CatalogWorkerClient.createForTests(options);
}
