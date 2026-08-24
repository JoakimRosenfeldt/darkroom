import { createHash } from "node:crypto";
import path from "node:path";
import {
  parseAssetId,
  parseCatalogId,
  parseOperationId,
  parsePresetId,
  parseRootId,
  type AssetId,
  type CatalogId,
  type PresetId,
} from "../lib/catalog/ids.ts";
import {
  canonicalJson,
  parseFileObservation,
  parseImportPreset,
  parseJsonValue,
  sameFileObservation,
  type FrozenImportPlan,
  type ImportDestinationDecision,
  type ImportDuplicateDecision,
  type ImportPreset,
  type ImportSource,
} from "../lib/import/domain.ts";
import { parseCatalogLiveQueryResult } from "../lib/catalog/live.ts";
import {
  normalizeAutoImportRelativePath,
  type AutoImportQueueItem,
  type AutoImportRule,
} from "../lib/import/auto-import.ts";
import { parseRelativePath, parseSessionId, type SessionId } from "../lib/catalog/runtime.ts";
import type { CatalogLiveWorkerPort } from "./catalog-coordinator.ts";
import {
  CatalogImportAdapter,
  type CatalogImportAdapterOptions,
  type CatalogImportExternalSourceRegistrar,
} from "./catalog-import-adapter.ts";
import {
  ImportOperationService,
  type ExecuteFrozenPlanOptions,
  type ImportOperationExecution,
} from "./import-operation-service.ts";
import {
  createImportPlan,
  reviewImportPlan,
  type ImportPlanReviewInput,
} from "./import-plan-service.ts";
import type { CatalogAutoImportNativeFiles } from "./catalog-auto-import-native-files.ts";
import type { FingerprintResult } from "./catalog-fingerprint-service.ts";
import type {
  FileTransactionFileSystem,
  FileTransactionJournal,
} from "./file-transaction-service.ts";
import type { CatalogFaultInjector } from "./catalog-fault-injection.ts";

export interface CatalogAutoImportPresetResolver {
  readonly resolvePreset: (input: {
    readonly catalogId: CatalogId;
    readonly sessionId: SessionId;
    readonly presetId: PresetId;
  }) => Promise<unknown>;
}

export interface CatalogAutoImportExecutorOptions {
  readonly catalogId: CatalogId;
  readonly sessionId: SessionId;
  readonly worker: Pick<CatalogLiveWorkerPort, "liveQuery" | "liveApply">;
  readonly assertCurrentSession: () => void | Promise<void>;
  readonly nativeFiles: Pick<
    CatalogAutoImportNativeFiles,
    "observeSource" | "observeDestination" | "resolvePaths" | "destinationExists" | "fingerprint"
  >;
  readonly presetResolver: CatalogAutoImportPresetResolver;
  readonly externalSourceRegistrar: CatalogImportExternalSourceRegistrar;
  readonly journal: FileTransactionJournal;
  readonly fileSystem?: FileTransactionFileSystem;
  readonly faultInjector?: CatalogFaultInjector;
  readonly now?: () => number;
}

const MAX_RENAME_ATTEMPTS = 10_000;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function safeInteger(value: unknown, label: string, minimum = 0): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < minimum) {
    throw new Error(`${label} is invalid.`);
  }
  return value;
}

function requiredString(value: unknown, label: string): string {
  if (typeof value !== "string" || value.length === 0 || value.includes("\0")) {
    throw new Error(`${label} is invalid.`);
  }
  return value;
}

function renamedPath(relativePath: string, suffix: number): string {
  const parsed = path.posix.parse(relativePath);
  const basename = `${parsed.name} (${suffix})${parsed.ext}`;
  return parsed.dir === "" ? basename : `${parsed.dir}/${basename}`;
}

function xmpRelativePath(relativePath: string): string {
  const parsed = path.posix.parse(relativePath);
  const stem = parsed.dir === "" ? parsed.name : `${parsed.dir}/${parsed.name}`;
  return `${stem}.xmp`;
}

function underDestination(relativePath: string, basePath: string): string {
  const normalizedBase = normalizeAutoImportRelativePath(parseRelativePath(basePath));
  const normalizedRelative = normalizeAutoImportRelativePath(parseRelativePath(relativePath));
  return `${normalizedBase}/${normalizedRelative}`;
}

function presetHash(preset: ImportPreset): string {
  const canonical = canonicalJson({
    catalogId: preset.catalogId,
    presetId: preset.presetId,
    name: preset.name,
    version: preset.version,
    template: { pattern: preset.template.pattern },
    payload: preset.payload,
    updatedAt: preset.updatedAt,
  });
  return createHash("sha256").update(canonical, "utf8").digest("hex");
}

function parsePresetSnapshot(
  value: unknown,
  catalogId: CatalogId,
  expectedPresetId: PresetId,
): ImportPreset {
  if (!isRecord(value)) throw new Error("Auto Import preset is unavailable.");
  const presetId = parsePresetId(value.presetId);
  if (presetId !== expectedPresetId) throw new Error("Auto Import preset does not match the frozen rule.");
  const returnedCatalogId = value.catalogId === undefined
    ? catalogId
    : parseCatalogId(value.catalogId);
  if (returnedCatalogId !== catalogId) throw new Error("Auto Import preset belongs to another catalog.");
  const version = value.version ?? value.revision;
  const name = requiredString(value.name, "Auto Import preset name");
  const updatedAt = safeInteger(value.updatedAt, "Auto Import preset updatedAt");
  const livePayload = value.payload;
  const nested = isRecord(livePayload) &&
    livePayload.version === 1 &&
    "template" in livePayload &&
    "payload" in livePayload &&
    "isDefault" in livePayload;
  const preset = parseImportPreset({
    catalogId,
    presetId,
    name,
    version: safeInteger(version, "Auto Import preset version"),
    template: nested ? livePayload.template : value.template,
    payload: nested ? livePayload.payload : parseJsonValue(livePayload, "Auto Import preset payload"),
    updatedAt,
  });
  if (preset.name.length === 0) throw new Error("Auto Import preset name is invalid.");
  return preset;
}

function parseImportSource(value: unknown): ImportSource {
  if (!isRecord(value)) throw new Error("Auto Import source observation is unavailable.");
  const xmpState = value.xmpState;
  if (xmpState !== "absent" && xmpState !== "present" && xmpState !== "unreadable") {
    throw new Error("Auto Import source XMP state is invalid.");
  }
  return {
    rootId: parseRootId(value.rootId),
    relativePath: parseRelativePath(value.relativePath),
    observation: parseFileObservation(value.observation),
    xmpState,
    formatId: requiredString(value.formatId, "Auto Import source format"),
  };
}

function nativeFailure(result: FingerprintResult, label: string): never {
  if (result.status === "cancelled") throw new Error(`${label} was cancelled.`);
  throw new Error(`${label} could not be fully checked.`);
}

function destinationDecision(
  relativePath: string,
  occupied: boolean,
  policy: AutoImportRule["destinationConflictPolicy"],
  exists: (relativePath: string) => Promise<boolean>,
): Promise<ImportDestinationDecision | null> {
  if (!occupied) return Promise.resolve(null);
  if (policy === "replace") throw new Error("Auto Import Replace conflicts are unavailable.");
  if (policy === "skip") return Promise.resolve({ kind: "skip" });
  return (async () => {
    for (let suffix = 1; suffix <= MAX_RENAME_ATTEMPTS; suffix += 1) {
      const candidate = renamedPath(relativePath, suffix);
      if (!(await exists(candidate))) return { kind: "rename", destinationRelativePath: candidate };
    }
    throw new Error("Auto Import could not resolve a destination name.");
  })();
}

export class CatalogAutoImportExecutor {
  private readonly catalogId: CatalogId;
  private readonly sessionId: SessionId;
  private readonly worker: Pick<CatalogLiveWorkerPort, "liveQuery" | "liveApply">;
  private readonly assertCurrentSession: () => void | Promise<void>;
  private readonly nativeFiles: CatalogAutoImportExecutorOptions["nativeFiles"];
  private readonly presetResolver: CatalogAutoImportPresetResolver;
  private readonly now: () => number;
  private readonly service: ImportOperationService;

  public constructor(options: CatalogAutoImportExecutorOptions) {
    this.catalogId = parseCatalogId(options.catalogId);
    this.sessionId = parseSessionId(options.sessionId);
    this.worker = options.worker;
    this.assertCurrentSession = options.assertCurrentSession;
    this.nativeFiles = options.nativeFiles;
    this.presetResolver = options.presetResolver;
    this.now = options.now ?? Date.now;
    const adapterOptions: CatalogImportAdapterOptions = {
      catalogId: this.catalogId,
      sessionId: this.sessionId,
      worker: this.worker,
      assertCurrentSession: (binding) => this.assertBinding(binding.catalogId, binding.sessionId),
      source: (request) => this.nativeFiles.observeSource(request),
      destinationObservation: (request) => this.nativeFiles.observeDestination(request),
      paths: (request) => this.nativeFiles.resolvePaths(request),
      externalSourceRegistrar: options.externalSourceRegistrar,
      journal: options.journal,
      ...(options.fileSystem === undefined ? {} : { fileSystem: options.fileSystem }),
      ...(options.faultInjector === undefined ? {} : { faultInjector: options.faultInjector }),
      now: this.now,
    };
    const adapter = new CatalogImportAdapter(adapterOptions);
    this.service = new ImportOperationService({
      ...adapter.dependencies(),
      autoImport: {
        createPlan: (item, rule) => this.createFrozenPlan(item, rule),
      },
      now: this.now,
    });
  }

  public async executeAutoImport(
    item: AutoImportQueueItem,
    rule: AutoImportRule,
    options: ExecuteFrozenPlanOptions = {},
  ): Promise<ImportOperationExecution> {
    await this.assertCurrentSession();
    if (item.catalogId !== this.catalogId || rule.catalogId !== this.catalogId) {
      throw new Error("Auto Import item does not belong to the active catalog.");
    }
    if (item.ruleId !== rule.ruleId || item.placement !== "copy" || rule.placement !== "copy") {
      throw new Error("Auto Import item and rule do not match.");
    }
    const result = await this.service.executeAutoImport(item, rule, options);
    await this.assertCurrentSession();
    return result;
  }

  private async createFrozenPlan(item: AutoImportQueueItem, rule: AutoImportRule): Promise<FrozenImportPlan> {
    await this.assertCurrentSession();
    const presetValue = await this.presetResolver.resolvePreset({
      catalogId: this.catalogId,
      sessionId: this.sessionId,
      presetId: parsePresetId(rule.presetId),
    });
    await this.assertCurrentSession();
    const preset = parsePresetSnapshot(presetValue, this.catalogId, parsePresetId(rule.presetId));
    if (preset.version !== rule.presetVersion || presetHash(preset) !== rule.presetSha256) {
      throw new Error("Auto Import preset does not match the frozen rule.");
    }
    const source = await this.observeSource(item, rule);
    const duplicate = await this.duplicateDecision(source, rule);
    const draft = createImportPlan({
      operationId: parseOperationId(item.queueId),
      catalogId: this.catalogId,
      destinationRootId: parseRootId(rule.destinationRootId),
      preset,
      sources: [{ source, action: "copy" }],
      now: this.now(),
    });
    const destinationBase = normalizeAutoImportRelativePath(parseRelativePath(rule.destinationRelativePath));
    const destinationPrefixedDraft = {
      ...draft,
      items: draft.items.map((item) => ({
        ...item,
        destinationRelativePath: underDestination(item.destinationRelativePath, destinationBase),
        xmpDestinationRelativePath: item.xmpDestinationRelativePath === null
          ? null
          : underDestination(xmpRelativePath(item.destinationRelativePath), destinationBase),
      })),
    };
    const draftItem = destinationPrefixedDraft.items[0];
    if (draftItem === undefined) throw new Error("Auto Import plan is empty.");
    const duplicateSkipped = duplicate?.kind === "skip-incoming";
    const destination = duplicateSkipped
      ? null
      : await this.destinationDecision(draftItem.destinationRelativePath, rule);
    const duplicateDecisions = duplicate === null
      ? undefined
      : new Map<AssetId, ImportDuplicateDecision>([[draftItem.itemId, duplicate]]);
    const destinationDecisions = destination === null
      ? undefined
      : new Map<AssetId, ImportDestinationDecision>([[draftItem.itemId, destination]]);
    const reviewInput: ImportPlanReviewInput = {
      ...(duplicateDecisions === undefined ? {} : { duplicateDecisions }),
      ...(destinationDecisions === undefined ? {} : { destinationDecisions }),
    };
    const review = reviewImportPlan(destinationPrefixedDraft, reviewInput);
    if (!review.canFreeze) throw new Error("Auto Import plan has blocking conflicts.");
    return this.service.freeze({ draft: destinationPrefixedDraft, review });
  }

  private async observeSource(item: AutoImportQueueItem, rule: AutoImportRule): Promise<ImportSource> {
    const observed = parseImportSource(await this.nativeFiles.observeSource({
      catalogId: this.catalogId,
      sessionId: this.sessionId,
      rootId: parseRootId(rule.ingressRootId),
      relativePath: normalizeAutoImportRelativePath(item.relativePath),
    }));
    if (
      observed.rootId !== rule.ingressRootId ||
      observed.relativePath !== normalizeAutoImportRelativePath(item.relativePath) ||
      !sameFileObservation(observed.observation, item.observation)
    ) {
      throw new Error("Auto Import source observation is stale.");
    }
    return observed;
  }

  private async duplicateDecision(
    source: ImportSource,
    rule: AutoImportRule,
  ): Promise<ImportDuplicateDecision | null> {
    if (rule.duplicatePolicy === "use-existing-location") {
      throw new Error("Auto Import use-existing-location duplicates are unavailable.");
    }
    if (rule.duplicatePolicy === "continue-unchecked") return { kind: "continue-unchecked" };
    if (rule.duplicatePolicy === "keep-both") return { kind: "keep-both" };
    const incoming = await this.nativeFiles.fingerprint(source.rootId, source.relativePath);
    if (incoming.status !== "valid" || incoming.sha256 === null || incoming.observation === null) {
      nativeFailure(incoming, "Auto Import duplicate check");
    }
    if (!sameFileObservation(source.observation, incoming.observation)) {
      throw new Error("Auto Import source changed during duplicate review.");
    }
    const stateValue = await this.worker.liveQuery({ catalogId: this.catalogId, expectedRevision: null });
    const state = parseCatalogLiveQueryResult(stateValue);
    const candidates = state.assets.filter((asset) =>
      asset.catalogId === this.catalogId &&
      asset.health === "present" &&
      asset.observation?.byteLength === source.observation.size &&
      !(asset.rootId === source.rootId && asset.relativePath === source.relativePath),
    );
    for (const candidate of candidates) {
      const result = await this.nativeFiles.fingerprint(candidate.rootId, candidate.relativePath);
      if (result.status !== "valid" || result.sha256 === null) {
        nativeFailure(result, "Auto Import duplicate check");
      }
      if (result.sha256 === incoming.sha256) {
        if (rule.duplicatePolicy === "skip-incoming") return { kind: "skip-incoming" };
        return { kind: "use-existing-location", existingAssetId: parseAssetId(candidate.assetId) };
      }
    }
    return null;
  }

  private async destinationDecision(
    relativePath: string,
    rule: AutoImportRule,
  ): Promise<ImportDestinationDecision | null> {
    const normalized = normalizeAutoImportRelativePath(parseRelativePath(relativePath));
    const occupied = await this.nativeFiles.destinationExists(rule.destinationRootId, normalized);
    return destinationDecision(
      normalized,
      occupied,
      rule.destinationConflictPolicy,
      (candidate) => this.nativeFiles.destinationExists(rule.destinationRootId, candidate),
    );
  }

  private assertBinding(catalogId: CatalogId, sessionId: SessionId): void {
    if (parseCatalogId(catalogId) !== this.catalogId || parseSessionId(sessionId) !== this.sessionId) {
      throw new Error("Auto Import request does not belong to the active session.");
    }
  }
}
