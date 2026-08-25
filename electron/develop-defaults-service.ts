import { randomUUID } from "node:crypto";
import type { CatalogWorkerClient } from "./catalog-worker-client.ts";
import type { CameraProfileService } from "./camera-profile-service.ts";
import type { DevelopDefaultsStore } from "./develop-defaults-store.ts";
import type { DevelopPresetStore } from "./develop-preset-store.ts";
import type { CatalogLiveEntrySnapshot } from "../lib/catalog/live.ts";
import { parseOperationId } from "../lib/catalog/ids.ts";
import {
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
import { IDENTITY_MATRIX_3, persistedInputProfileFromMatrix } from "../lib/develop/v3/profiles.ts";
import { cameraProfileIsCompatible } from "../lib/camera-profiles/matrix.ts";
import type { DevelopPresetRecord } from "../lib/develop/presets/schema.ts";

interface VerifiedEntry {
  readonly entry: CatalogLiveEntrySnapshot;
  readonly iso: number | null;
}

interface DevelopDefaultsServiceOptions {
  readonly store: DevelopDefaultsStore;
  readonly presets: DevelopPresetStore;
  readonly worker: CatalogWorkerClient;
  readonly cameraProfiles: CameraProfileService;
  readonly verifyEntry: (request: DevelopDefaultsEntryRequest) => Promise<VerifiedEntry>;
}

function normalize(value: string): string {
  return value.trim().toLocaleLowerCase();
}

function profileIdPart(value: string): string {
  const part = normalize(value).replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 80);
  if (!part) throw new Error("Verified camera identity cannot form an input profile ID.");
  return part;
}

function expectedLibRawProfile(make: string, model: string): { readonly id: string; readonly revision: string } {
  return { id: `darkroom.libraw-matrix.${profileIdPart(make)}.${profileIdPart(model)}`, revision: "libraw-rgb-cam-v1" };
}

function sameKnownText(actual: string | null, fact: { readonly kind: "known"; readonly value: string } | { readonly kind: "unknown" }): boolean {
  return actual === null ? fact.kind === "unknown" : fact.kind === "known" && normalize(actual) === normalize(fact.value);
}

function verifyFacts(input: DevelopDefaultFacts, verified: VerifiedEntry): DevelopDefaultFacts {
  const asset = verified.entry;
  const camera = asset.cameraMake !== null && asset.cameraModel !== null
    ? { make: asset.cameraMake, model: asset.cameraModel }
    : null;
  if (camera) {
    if (input.camera.kind !== "known" || normalize(input.camera.make) !== normalize(camera.make) || normalize(input.camera.model) !== normalize(camera.model)) {
      throw new Error("Develop default camera facts do not match the active catalog entry.");
    }
  } else if (input.camera.kind !== "unknown") {
    throw new Error("Develop default camera facts claim unavailable catalog metadata.");
  }
  const isoFact = input.iso.kind === "known" ? { kind: "known" as const, value: String(input.iso.value) } : { kind: "unknown" as const };
  if (!sameKnownText(verified.iso === null ? null : String(verified.iso), isoFact)) {
    throw new Error("Develop default ISO facts do not match verified source metadata.");
  }
  const allowedDecoderIds = asset.formatId === "nef"
    ? new Set(["libraw-wasm", "nikon-sdk", "nikon-test-only", "embedded-raw-preview"])
    : new Set(["browser-image-decoder"]);
  if (input.decoder.kind !== "known" || !allowedDecoderIds.has(input.decoder.value)) {
    throw new Error("Develop default decoder facts do not match the active source format.");
  }
  if (input.inputProfile.kind === "known") {
    if (!camera || input.decoder.value !== "libraw-wasm") {
      throw new Error("A before-tone input profile needs a verified LibRaw camera source.");
    }
    const expected = expectedLibRawProfile(camera.make, camera.model);
    if (input.inputProfile.profileId !== expected.id || input.inputProfile.profileRevision !== expected.revision) {
      throw new Error("Develop default input profile facts do not match the verified camera source.");
    }
  }
  return structuredClone(input);
}

export class DevelopDefaultsService {
  readonly #options: DevelopDefaultsServiceOptions;

  constructor(options: DevelopDefaultsServiceOptions) {
    this.#options = options;
  }

  list(): Promise<readonly DevelopDefaultRule[]> {
    return this.#options.store.list();
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
    await this.#options.verifyEntry(request);
    return this.#options.worker.getInstalledDevelopDefault(request.catalogId, request.entryId);
  }

  async install(value: unknown): Promise<DevelopDefaultsProductionResult> {
    const request: DevelopDefaultsInstallRequest = parseDevelopDefaultsInstallRequest(value);
    const verified = await this.#options.verifyEntry(request);
    const facts = verifyFacts(request.facts, verified);
    const existing = await this.#options.worker.getInstalledDevelopDefault(request.catalogId, request.entryId);
    const loaded = await this.#options.worker.loadDevelopHistory({ catalogId: request.catalogId, entryId: request.entryId, revisionId: null });
    if (loaded.kind !== "loaded") throw new Error("Develop Head needs recovery before defaults can run.");
    if (existing) return { kind: "already-installed", head: loaded.value, installed: existing };
    if (loaded.value.ordinal !== 0 || verified.entry.metadata.rawXmp !== null || verified.entry.metadata.xmpState === "preserved") {
      return { kind: "not-pristine", head: loaded.value, installed: null };
    }
    const match = await this.#match(facts);
    if (match.kind !== "matched") return { kind: "no-match", head: loaded.value, installed: null };
    const registry = this.#options.cameraProfiles.list();
    const camera = facts.camera;
    const sourceId = verified.entry.sourceId;
    if (!sourceId) throw new Error("Develop default entry has no verified SourceId.");
    const hasBeforeToneProfile = camera.kind === "known" &&
      facts.decoder.kind === "known" && facts.decoder.value === "libraw-wasm" &&
      facts.inputProfile.kind === "known" && facts.inputProfile.stage === "before-develop-tone";
    const cameraProfile = hasBeforeToneProfile && camera.kind === "known"
      ? {
          kind: "available-before-tone" as const,
          decoderDefault: {
            registryRevision: registry.revision,
            selection: { kind: "decoder-default" as const },
            calibration: { matrixToLinearSrgb: IDENTITY_MATRIX_3, channelScale: [1, 1, 1] as const, exposureOffsetEv: 0 },
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
