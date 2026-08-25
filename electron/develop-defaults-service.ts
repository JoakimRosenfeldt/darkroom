import { randomUUID } from "node:crypto";
import type { CatalogWorkerClient } from "./catalog-worker-client.ts";
import type { CameraProfileService } from "./camera-profile-service.ts";
import type { DevelopDefaultsStore } from "./develop-defaults-store.ts";
import type { DevelopPresetStore } from "./develop-preset-store.ts";
import type { CatalogLiveEntrySnapshot } from "../lib/catalog/live.ts";
import { parseOperationId } from "../lib/catalog/ids.ts";
import {
  parseDevelopDefaultsCancelRequest,
  parseDevelopDefaultRuleEnabledRequest,
  parseDevelopDefaultRuleDeleteRequest,
  parseDevelopDefaultsEntryRequest,
  parseDevelopDefaultsInstallRequest,
  parseDevelopDefaultsPreviewRequest,
  type DevelopDefaultsEntryRequest,
  type DevelopDefaultsInstallRequest,
  type DevelopDefaultsPreviewResult,
  type DevelopDefaultsProductionResult,
} from "../lib/develop/defaults/api.ts";
import { prepareDevelopDefaultCandidate } from "../lib/develop/defaults/creation.ts";
import { matchDevelopDefault, type DevelopDefaultFacts } from "../lib/develop/defaults/matcher.ts";
import { parseDevelopDefaultRule, type DevelopDefaultRule } from "../lib/develop/defaults/schema.ts";
import { createDevelopRevisionId } from "../lib/develop/history.ts";
import { createDefaultV3DevelopDocument } from "../lib/develop/v3/document.ts";
import { persistedInputProfileFromMatrix } from "../lib/develop/v3/profiles.ts";
import { cameraProfileIsCompatible } from "../lib/camera-profiles/matrix.ts";
import type { MatrixCameraProfile } from "../lib/camera-profiles/matrix.ts";
import type { DevelopPresetRecord } from "../lib/develop/presets/schema.ts";

interface VerifiedEntry {
  readonly entry: CatalogLiveEntrySnapshot;
  readonly facts: DevelopDefaultFacts;
  readonly decoderProfile: MatrixCameraProfile | null;
  readonly installAvailable: boolean;
}

interface DevelopDefaultsServiceOptions {
  readonly store: DevelopDefaultsStore;
  readonly presets: DevelopPresetStore;
  readonly worker: CatalogWorkerClient;
  readonly cameraProfiles: CameraProfileService;
  readonly assertEntry: (request: DevelopDefaultsEntryRequest) => Promise<void>;
  readonly verifyEntry: (request: DevelopDefaultsEntryRequest) => Promise<VerifiedEntry>;
  readonly recheckEntry: (request: DevelopDefaultsEntryRequest, verified: VerifiedEntry) => Promise<void>;
}

interface ActiveDefaultInstall {
  readonly binding: string;
  readonly generation: number;
  cancelled: boolean;
}

interface PendingDefaultCancellation {
  readonly binding: string;
  readonly expiresAt: number;
}

const MAX_ACTIVE_DEFAULT_INSTALLS = 1_024;
const MAX_PENDING_DEFAULT_CANCELLATIONS = 1_024;
const PENDING_DEFAULT_CANCELLATION_TTL_MS = 60_000;

function normalize(value: string): string {
  return value.trim().toLocaleLowerCase();
}

function installBinding(request: DevelopDefaultsEntryRequest): string {
  return `${request.catalogId}:${request.sessionId}:${request.entryId}`;
}

function factsMatch(input: DevelopDefaultFacts, verified: DevelopDefaultFacts): boolean {
  const camera = input.camera.kind === verified.camera.kind && (
    input.camera.kind === "unknown" || verified.camera.kind === "unknown" ||
    (normalize(input.camera.make) === normalize(verified.camera.make) && normalize(input.camera.model) === normalize(verified.camera.model))
  );
  const decoder = input.decoder.kind === verified.decoder.kind && (
    input.decoder.kind === "unknown" || verified.decoder.kind === "unknown" || input.decoder.value === verified.decoder.value
  );
  const profile = input.inputProfile.kind === verified.inputProfile.kind && (
    input.inputProfile.kind === "unknown" || verified.inputProfile.kind === "unknown" ||
    (input.inputProfile.profileId === verified.inputProfile.profileId && input.inputProfile.profileRevision === verified.inputProfile.profileRevision)
  );
  const iso = input.iso.kind === verified.iso.kind && (
    input.iso.kind === "unknown" || verified.iso.kind === "unknown" || input.iso.value === verified.iso.value
  );
  return camera && decoder && profile && iso;
}

export class DevelopDefaultsService {
  readonly #options: DevelopDefaultsServiceOptions;
  readonly #activeInstalls = new Map<string, ActiveDefaultInstall>();
  readonly #pendingCancellations = new Map<string, PendingDefaultCancellation>();
  #nextInstallGeneration = 0;

  constructor(options: DevelopDefaultsServiceOptions) {
    this.#options = options;
  }

  list(): Promise<readonly DevelopDefaultRule[]> {
    return this.#options.store.list();
  }

  async referencedPresets(): Promise<readonly DevelopPresetRecord[]> {
    const rules = await this.#options.store.list();
    const records = new Map<string, DevelopPresetRecord>();
    for (const rule of rules) {
      const key = `${rule.preset.presetId}:${rule.preset.presetRevision}`;
      if (records.has(key)) continue;
      const preset = await this.#options.presets.getRevision(rule.preset.presetId, rule.preset.presetRevision);
      if (preset) records.set(key, preset);
    }
    return [...records.values()];
  }

  create(value: unknown): Promise<DevelopDefaultRule> {
    return this.#options.store.create(parseDevelopDefaultRule(value));
  }

  update(value: unknown): Promise<DevelopDefaultRule> {
    return this.#options.store.update(parseDevelopDefaultRule(value));
  }

  async setEnabled(value: unknown): Promise<DevelopDefaultRule> {
    const request = parseDevelopDefaultRuleEnabledRequest(value);
    const current = (await this.#options.store.list()).find((rule) => rule.ruleId === request.ruleId);
    if (!current || current.revision !== request.expectedRevision) throw new Error("Develop default rule revision is stale.");
    return this.#options.store.setEnabled(request.ruleId, request.enabled, request.updatedAt);
  }

  async delete(value: unknown): Promise<void> {
    const request = parseDevelopDefaultRuleDeleteRequest(value);
    const current = (await this.#options.store.list()).find((rule) => rule.ruleId === request.ruleId);
    if (!current || current.revision !== request.expectedRevision) throw new Error("Develop default rule revision is stale.");
    await this.#options.store.delete(request.ruleId);
  }

  async preview(value: unknown): Promise<DevelopDefaultsPreviewResult> {
    const request = parseDevelopDefaultsPreviewRequest(value);
    const match = await this.#match(request.facts);
    return match.kind === "matched"
      ? {
          kind: "matched",
          winner: {
            ruleId: match.match.rule.ruleId,
            ruleRevision: match.match.rule.revision,
            ruleName: match.match.rule.name,
          },
          traces: match.traces,
        }
      : { kind: "no-match", winner: null, traces: match.traces };
  }

  async installed(value: unknown) {
    const request = parseDevelopDefaultsEntryRequest(value);
    await this.#options.assertEntry(request);
    return this.#options.worker.getInstalledDevelopDefault(request.catalogId, request.entryId);
  }

  cancel(value: unknown): void {
    const request = parseDevelopDefaultsCancelRequest(value);
    const binding = installBinding(request);
    const active = this.#activeInstalls.get(request.requestId);
    if (active) {
      if (active.binding !== binding) throw new Error("Develop default cancellation does not match its active request.");
      active.cancelled = true;
      return;
    }
    const now = Date.now();
    for (const [requestId, pending] of this.#pendingCancellations) {
      if (pending.expiresAt <= now) this.#pendingCancellations.delete(requestId);
    }
    const existing = this.#pendingCancellations.get(request.requestId);
    if (existing && existing.binding !== binding) {
      throw new Error("Develop default cancellation request ID is already bound to another entry.");
    }
    if (!existing && this.#pendingCancellations.size >= MAX_PENDING_DEFAULT_CANCELLATIONS) {
      const oldest = this.#pendingCancellations.keys().next().value;
      if (oldest !== undefined) this.#pendingCancellations.delete(oldest);
    }
    this.#pendingCancellations.set(request.requestId, {
      binding,
      expiresAt: now + PENDING_DEFAULT_CANCELLATION_TTL_MS,
    });
  }

  async install(value: unknown): Promise<DevelopDefaultsProductionResult> {
    const request: DevelopDefaultsInstallRequest = parseDevelopDefaultsInstallRequest(value);
    const binding = installBinding(request);
    if (this.#activeInstalls.has(request.requestId)) {
      throw new Error("Develop default request ID is already active.");
    }
    if (this.#activeInstalls.size >= MAX_ACTIVE_DEFAULT_INSTALLS) {
      throw new Error("Too many Develop default installations are active.");
    }
    const now = Date.now();
    for (const [requestId, pending] of this.#pendingCancellations) {
      if (pending.expiresAt <= now) this.#pendingCancellations.delete(requestId);
    }
    const pending = this.#pendingCancellations.get(request.requestId);
    if (pending && pending.binding !== binding) {
      throw new Error("Develop default request ID is already bound to another entry.");
    }
    this.#pendingCancellations.delete(request.requestId);
    const active: ActiveDefaultInstall = {
      binding,
      generation: ++this.#nextInstallGeneration,
      cancelled: pending !== undefined,
    };
    this.#activeInstalls.set(request.requestId, active);
    const assertCurrent = (): void => {
      if (this.#activeInstalls.get(request.requestId) !== active || active.cancelled) {
        throw new Error("Develop default installation was cancelled because the active photo changed.");
      }
    };
    try {
      const verified = await this.#options.verifyEntry(request);
      assertCurrent();
      const facts = verified.facts;
      const existing = await this.#options.worker.getInstalledDevelopDefault(request.catalogId, request.entryId);
      assertCurrent();
      const loaded = await this.#options.worker.loadDevelopHistory({ catalogId: request.catalogId, entryId: request.entryId, revisionId: null });
      assertCurrent();
      if (loaded.kind !== "loaded") throw new Error("Develop Head needs recovery before defaults can run.");
      if (existing) return { kind: "already-installed", head: loaded.value, installed: existing };
      if (loaded.value.ordinal !== 0 || verified.entry.metadata.developJson !== null || verified.entry.metadata.rawXmp !== null || verified.entry.metadata.xmpState === "preserved") {
        return { kind: "not-pristine", head: loaded.value, installed: null };
      }
      if (!verified.installAvailable) return { kind: "no-match", head: loaded.value, installed: null };
      if (!factsMatch(request.facts, facts)) {
        throw new Error("Develop default facts do not match main-verified source provenance.");
      }
      const match = await this.#match(facts);
      assertCurrent();
      if (match.kind !== "matched") return { kind: "no-match", head: loaded.value, installed: null };
      const registry = this.#options.cameraProfiles.list();
      const camera = facts.camera;
      const sourceId = verified.entry.sourceId;
      if (!sourceId) throw new Error("Develop default entry has no verified SourceId.");
      const cameraProfile = verified.decoderProfile && camera.kind === "known"
      ? {
          kind: "available-before-tone" as const,
          decoderDefault: {
            registryRevision: registry.revision,
            selection: { kind: "decoder-default" as const },
            calibration: {
              matrixToLinearSrgb: verified.decoderProfile.matrixToLinearSrgb,
              channelScale: verified.decoderProfile.channelScale,
              exposureOffsetEv: verified.decoderProfile.exposureOffsetEv,
            },
          },
          compatibleProfiles: registry.profiles.flatMap((record) =>
            record.kind === "ready" && cameraProfileIsCompatible(record.profile, { make: camera.make, model: camera.model })
              ? [persistedInputProfileFromMatrix(record.profile, registry.revision)]
              : []
          ),
        }
        : {
          kind: "unavailable" as const,
          reason: camera.kind === "unknown"
            ? "Camera identity is unavailable."
            : "The decoded source has no verified before-tone input profile stage.",
        };
      const candidate = prepareDevelopDefaultCandidate({
        match: match.match,
        initialDocument: createDefaultV3DevelopDocument(),
        context: { sourceId, cameraProfile },
      });
      if (candidate.kind !== "matched-default-candidate") {
        throw new Error("Matched Develop default did not produce a matched candidate.");
      }
      const createdAt = Date.now();
      await this.#options.recheckEntry(request, verified);
      assertCurrent();
      const result = await this.#options.worker.installDevelopDefault({
        catalogId: request.catalogId,
        entryId: request.entryId,
        expectedParentRevisionId: loaded.value.revisionId,
        revisionId: createDevelopRevisionId(),
        operationId: parseOperationId(randomUUID()),
        label: `Apply default ${candidate.rule.name}`,
        document: candidate.document,
        installed: {
          ruleId: candidate.baseline.ruleId,
          ruleRevision: candidate.baseline.ruleRevision,
          presetId: candidate.baseline.presetId,
          presetRevision: candidate.baseline.presetRevision,
          selectedFields: candidate.baseline.selectedFields,
          baselineDocument: candidate.document,
          appliedFields: candidate.baseline.report.applied,
          skipped: candidate.baseline.report.skipped,
          unsupported: candidate.baseline.report.unsupported,
          createdAt,
        },
      });
      return result.kind === "not-pristine"
        ? result
        : { kind: result.kind, head: result.head, installed: result.installed };
    } finally {
      if (this.#activeInstalls.get(request.requestId) === active) {
        this.#activeInstalls.delete(request.requestId);
      }
    }
  }

  async #match(facts: DevelopDefaultFacts) {
    const rules = await this.#options.store.list();
    const revisions = new Map<string, DevelopPresetRecord>();
    for (const rule of rules) {
      const key = `${rule.preset.presetId}:${rule.preset.presetRevision}`;
      if (revisions.has(key)) continue;
      const preset = await this.#options.presets.getRevision(rule.preset.presetId, rule.preset.presetRevision);
      if (preset) revisions.set(key, preset);
    }
    return matchDevelopDefault({
      hydration: { kind: "new-document" },
      facts,
      rules,
      presets: { getPresetRevision: (presetId, revision) => revisions.get(`${presetId}:${revision}`) ?? null },
    });
  }
}
