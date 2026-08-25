import path from "node:path";
import { randomUUID } from "node:crypto";
import { Worker, type WorkerOptions } from "node:worker_threads";
import type { CatalogFaultPoint } from "./catalog-fault-injection.ts";
import type { AssetId, CatalogId, OperationId } from "../lib/catalog/ids.ts";
import type {
  CatalogLiveApplyInput,
  CatalogLiveApplyResult,
  CatalogLiveCreateInput,
  CatalogLiveQueryInput,
  CatalogLiveState,
} from "../lib/catalog/live.ts";
import type {
  DevelopHistoryCommitInput,
  DevelopHistoryCommitResult,
  DevelopHistoryListInput,
  DevelopHistoryLoadInput,
  DevelopHistoryLoadResult,
  DevelopHistoryRef,
  DevelopHistoryRefMutationInput,
  DevelopHistoryRevision,
} from "../lib/develop/history.ts";
import type { EntryId } from "../lib/catalog/ids.ts";
import type { DevelopBatchCommand, DevelopBatchCommandResult } from "../lib/develop/batch/domain.ts";
import type {
  CatalogV3ActivationResult,
  CatalogV3AlbumAssetPage,
  CatalogV3AlbumAssetPageInput,
  CatalogV3AlbumPageInput,
  CatalogV3AlbumSnapshotResult,
  CatalogV3AssetBatchInput,
  CatalogV3AssetBatchResult,
  CatalogV3AssetPage,
  CatalogV3AssetPageInput,
  CatalogV3FinishCopyResult,
  CatalogV3InstallInput,
  CatalogV3InstallResult,
  CatalogV3RelationsBatchInput,
  CatalogV3RelationsBatchResult,
  CatalogV3SealForInstallResult,
  CatalogV3Summary,
  CatalogV3ValidationResult,
} from "../lib/catalog/v3.ts";
import {
  parseCatalogWorkerResponse,
  type CatalogWorkerBackupResponse,
  type CatalogWorkerCloneCatalogResponse,
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
  type CatalogWorkerVacuumIntoResponse,
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

function requireCatalogIdentity<T extends { readonly catalogId: CatalogId }>(
  result: T,
  catalogId: CatalogId,
  operation: string,
): T {
  if (result.catalogId !== catalogId) {
    throw new Error(`Catalog worker ${operation} returned a mismatched catalogId.`);
  }
  return result;
}

function requireMigrationIdentity<T extends { readonly catalogId: CatalogId; readonly migrationId: string }>(
  result: T,
  catalogId: CatalogId,
  migrationId: string,
  operation: string,
): T {
  requireCatalogIdentity(result, catalogId, operation);
  if (result.migrationId !== migrationId) {
    throw new Error(`Catalog worker ${operation} returned a mismatched migrationId.`);
  }
  return result;
}

function requireSnapshotRevision<T extends { readonly revision: number }>(
  result: T,
  expectedRevision: number | null,
  operation: string,
): T {
  if (expectedRevision !== null && result.revision !== expectedRevision) {
    throw new Error(`Catalog worker ${operation} returned a mismatched revision.`);
  }
  return result;
}

function requirePositionPage(
  items: readonly { readonly position: number }[],
  cursor: number | null,
  limit: number,
  nextCursor: number | null,
  operation: string,
): void {
  if (items.length > limit) {
    throw new Error(`Catalog worker ${operation} returned too many items.`);
  }
  const first = items[0];
  if (first !== undefined && first.position !== (cursor ?? -1) + 1) {
    throw new Error(`Catalog worker ${operation} returned a mismatched cursor.`);
  }
  if (nextCursor !== null && items.length !== limit) {
    throw new Error(`Catalog worker ${operation} returned an inconsistent nextCursor.`);
  }
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

  async vacuumInto(destinationPath: string): Promise<CatalogWorkerVacuumIntoResponse> {
    const normalizedPath = path.normalize(path.resolve(destinationPath));
    const response = await this.send({
      kind: "vacuum-into",
      requestId: requestId(),
      destinationPath: normalizedPath,
    });
    return requireKind(response, "vacuum-into");
  }

  async cloneCatalog(input: {
    readonly sourcePath: string;
    readonly destinationPath: string;
    readonly catalogId: CatalogId;
    readonly displayName: string;
    readonly appVersion: string;
  }): Promise<CatalogWorkerCloneCatalogResponse> {
    const response = await this.send({
      kind: "clone-catalog",
      requestId: requestId(),
      sourcePath: path.normalize(path.resolve(input.sourcePath)),
      destinationPath: path.normalize(path.resolve(input.destinationPath)),
      catalogId: input.catalogId,
      displayName: input.displayName,
      appVersion: input.appVersion,
    });
    return requireKind(response, "clone-catalog");
  }

  async integrityCheck(): Promise<CatalogWorkerIntegrityCheckResponse> {
    const response = await this.send({ kind: "integrity-check", requestId: requestId() });
    return requireKind(response, "integrity-check");
  }

  async loadDevelopHistory(input: DevelopHistoryLoadInput): Promise<DevelopHistoryLoadResult> {
    return requireKind(await this.send({ kind: "develop-history-load", requestId: requestId(), input }), "develop-history-load").result;
  }

  async listDevelopHistory(input: DevelopHistoryListInput): Promise<readonly DevelopHistoryRevision[]> {
    return requireKind(await this.send({ kind: "develop-history-list", requestId: requestId(), input }), "develop-history-list").result;
  }

  async commitDevelopHistory(input: DevelopHistoryCommitInput): Promise<DevelopHistoryCommitResult> {
    return requireKind(await this.send({ kind: "develop-history-commit", requestId: requestId(), input }), "develop-history-commit").result;
  }

  async listDevelopHistoryRefs(catalogId: CatalogId, entryId: EntryId): Promise<readonly DevelopHistoryRef[]> {
    return requireKind(await this.send({ kind: "develop-history-refs", requestId: requestId(), catalogId, entryId }), "develop-history-refs").result;
  }

  async mutateDevelopHistoryRef(input: DevelopHistoryRefMutationInput): Promise<readonly DevelopHistoryRef[]> {
    return requireKind(await this.send({ kind: "develop-history-ref-mutate", requestId: requestId(), input }), "develop-history-ref-mutate").result;
  }

  async developBatch(command: DevelopBatchCommand): Promise<DevelopBatchCommandResult> {
    return requireKind(await this.send({ kind: "develop-batch", requestId: requestId(), command }), "develop-batch").result;
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

  async installV3(input: CatalogV3InstallInput): Promise<CatalogV3InstallResult> {
    const response = await this.send({ kind: "v3-install", requestId: requestId(), input });
    return requireMigrationIdentity(
      requireKind(response, "v3-install").result,
      input.catalogId,
      input.migration.migrationId,
      "v3-install",
    );
  }

  async writeV3AssetBatch(input: CatalogV3AssetBatchInput): Promise<CatalogV3AssetBatchResult> {
    const response = await this.send({ kind: "v3-assets", requestId: requestId(), input });
    return requireMigrationIdentity(
      requireKind(response, "v3-assets").result,
      input.catalogId,
      input.migrationId,
      "v3-assets",
    );
  }

  async writeV3RelationsBatch(input: CatalogV3RelationsBatchInput): Promise<CatalogV3RelationsBatchResult> {
    const response = await this.send({ kind: "v3-relations", requestId: requestId(), input });
    return requireMigrationIdentity(
      requireKind(response, "v3-relations").result,
      input.catalogId,
      input.migrationId,
      "v3-relations",
    );
  }

  async finishV3Copy(catalogId: CatalogV3InstallInput["catalogId"], migrationId: string): Promise<CatalogV3FinishCopyResult> {
    const response = await this.send({
      kind: "v3-finish-copy",
      requestId: requestId(),
      catalogId,
      migrationId,
    });
    return requireMigrationIdentity(
      requireKind(response, "v3-finish-copy").result,
      catalogId,
      migrationId,
      "v3-finish-copy",
    );
  }

  async validateV3(catalogId: CatalogV3InstallInput["catalogId"], migrationId: string): Promise<CatalogV3ValidationResult> {
    const response = await this.send({
      kind: "v3-validate",
      requestId: requestId(),
      catalogId,
      migrationId,
    });
    return requireMigrationIdentity(
      requireKind(response, "v3-validate").result,
      catalogId,
      migrationId,
      "v3-validate",
    );
  }

  async prepareV3Activation(catalogId: CatalogV3InstallInput["catalogId"], migrationId: string): Promise<CatalogV3ActivationResult> {
    const response = await this.send({
      kind: "v3-prepare-activation",
      requestId: requestId(),
      catalogId,
      migrationId,
    });
    return requireMigrationIdentity(
      requireKind(response, "v3-prepare-activation").result,
      catalogId,
      migrationId,
      "v3-prepare-activation",
    );
  }

  async sealV3ForInstall(catalogId: CatalogV3InstallInput["catalogId"], migrationId: string): Promise<CatalogV3SealForInstallResult> {
    const response = await this.send({
      kind: "v3-seal-for-install",
      requestId: requestId(),
      catalogId,
      migrationId,
    });
    return requireMigrationIdentity(
      requireKind(response, "v3-seal-for-install").result,
      catalogId,
      migrationId,
      "v3-seal-for-install",
    );
  }

  async v3Summary(catalogId: CatalogV3InstallInput["catalogId"]): Promise<CatalogV3Summary> {
    const response = await this.send({ kind: "v3-summary", requestId: requestId(), catalogId });
    return requireCatalogIdentity(requireKind(response, "v3-summary").result, catalogId, "v3-summary");
  }

  async v3AssetsPage(input: CatalogV3AssetPageInput): Promise<CatalogV3AssetPage> {
    const response = await this.send({ kind: "v3-assets-page", requestId: requestId(), input });
    const result = requireSnapshotRevision(
      requireCatalogIdentity(requireKind(response, "v3-assets-page").result, input.catalogId, "v3-assets-page"),
      input.expectedRevision,
      "v3-assets-page",
    );
    if (result.assets.length > input.limit || (result.nextCursor !== null && result.assets.length !== input.limit)) {
      throw new Error("Catalog worker v3-assets-page returned inconsistent page bounds.");
    }
    return result;
  }

  async v3Albums(input: CatalogV3AlbumPageInput): Promise<CatalogV3AlbumSnapshotResult> {
    const response = await this.send({ kind: "v3-albums", requestId: requestId(), input });
    const result = requireSnapshotRevision(
      requireCatalogIdentity(requireKind(response, "v3-albums").result, input.catalogId, "v3-albums"),
      input.expectedRevision,
      "v3-albums",
    );
    requirePositionPage(result.albums, input.cursor, input.limit, result.nextCursor, "v3-albums");
    return result;
  }

  async v3AlbumAssetsPage(input: CatalogV3AlbumAssetPageInput): Promise<CatalogV3AlbumAssetPage> {
    const response = await this.send({ kind: "v3-album-assets-page", requestId: requestId(), input });
    const result = requireCatalogIdentity(
      requireKind(response, "v3-album-assets-page").result,
      input.catalogId,
      "v3-album-assets-page",
    );
    if (result.albumId !== input.albumId) {
      throw new Error("Catalog worker v3-album-assets-page returned a mismatched albumId.");
    }
    requireSnapshotRevision(result, input.expectedRevision, "v3-album-assets-page");
    requirePositionPage(result.assets, input.cursor, input.limit, result.nextCursor, "v3-album-assets-page");
    return result;
  }

  async liveCreate(input: CatalogLiveCreateInput): Promise<CatalogLiveApplyResult> {
    const response = await this.send({ kind: "live-create", requestId: requestId(), input });
    return requireCatalogIdentity(requireKind(response, "live-create").result, input.catalogId, "live-create");
  }

  async liveQuery(input: CatalogLiveQueryInput): Promise<CatalogLiveState> {
    const response = await this.send({ kind: "live-query", requestId: requestId(), input });
    const result = requireKind(response, "live-query").result;
    if (result.catalog.catalogId !== input.catalogId) {
      throw new Error("Catalog worker live-query returned a mismatched catalogId.");
    }
    if (input.expectedRevision !== null && result.catalog.revision !== input.expectedRevision) {
      throw new Error("Catalog worker live-query returned a mismatched revision.");
    }
    return result;
  }

  async liveApply(input: CatalogLiveApplyInput): Promise<CatalogLiveApplyResult> {
    const response = await this.send({ kind: "live-apply", requestId: requestId(), input });
    const result = requireCatalogIdentity(requireKind(response, "live-apply").result, input.catalogId, "live-apply");
    if (result.changed && result.revision <= input.expectedRevision) {
      throw new Error("Catalog worker live-apply returned an invalid revision.");
    }
    return result;
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
