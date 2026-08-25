import {
  COORDINATE_FRAME_REVISION,
  DEVELOP_PROCESS_VERSION,
  SEMANTIC_STAGE_IDS,
  SEMANTIC_STAGE_REGISTRY_VERSION,
  V3_SEMANTIC_STAGES,
  capabilityIsAvailable,
  type CapabilityTier,
  type DevelopCapabilityId,
  type DevelopCapabilityReport,
  type DevelopDiagnostic,
  type SemanticStageDefinition,
  type SemanticStageId,
  type SourceRecord,
} from "../process";
import {
  acceptedAssetRevision,
  type DevelopAssetRef,
} from "./assets";
import type {
  BlockingDevelopDiagnostic,
  RenderRequest,
  RenderOutputIntent,
  RenderPlanIdentityInputs,
  RenderQualityRequest,
} from "../render-contract";
import type { DevelopDocumentV3 } from "./document";
import { canonicalV3DocumentHashInput } from "./document";
import { validateRenderQualityRequest } from "./source";
import { referencedMaskArtifacts } from "./masking";

export const V3_COMPILER_VERSION = "darkroom-v3-compiler-1";

export type CompilerValidationIssue =
  | {
      readonly kind: "duplicate-stage-ownership";
      readonly stageId: SemanticStageId;
      readonly owners: readonly string[];
    }
  | { readonly kind: "missing-stage"; readonly stageId: SemanticStageId }
  | {
      readonly kind: "missing-dependency";
      readonly stageId: SemanticStageId;
      readonly dependency: SemanticStageId;
    }
  | { readonly kind: "dependency-cycle"; readonly stages: readonly SemanticStageId[] }
  | {
      readonly kind: "fixed-order-mismatch";
      readonly stageId: SemanticStageId;
      readonly expectedOrder: number;
      readonly foundOrder: number;
    }
  | { readonly kind: "request-mismatch"; readonly reason: string };

export type CompiledStageParameters =
  | { readonly kind: "decode-and-orientation"; readonly source: SourceRecord }
  | {
      readonly kind: "wb-and-input-profile";
      readonly whiteBalance: DevelopDocumentV3["color"]["whiteBalance"];
      readonly inputProfile: DevelopDocumentV3["color"]["inputProfile"];
    }
  | { readonly kind: "optics"; readonly optics: DevelopDocumentV3["optics"] }
  | {
      readonly kind: "standard-denoise";
      readonly settings: DevelopDocumentV3["detail"]["noiseReduction"];
    }
  | {
      readonly kind: "canonical-geometry";
      readonly geometry: DevelopDocumentV3["geometry"];
    }
  | {
      readonly kind: "source-repair";
      readonly cleanup: DevelopDocumentV3["cleanup"];
    }
  | {
      readonly kind: "basic-tone";
      readonly basic: DevelopDocumentV3["tone"]["basic"];
      readonly global: DevelopDocumentV3["color"]["global"];
      readonly hdr: DevelopDocumentV3["hdr"];
    }
  | {
      readonly kind: "curve-and-color";
      readonly curves: DevelopDocumentV3["tone"]["curves"];
      readonly pointColor: DevelopDocumentV3["color"]["pointColor"];
      readonly mixer: DevelopDocumentV3["color"]["mixer"];
      readonly monochrome: DevelopDocumentV3["color"]["monochrome"];
      readonly grading: DevelopDocumentV3["color"]["grading"];
    }
  | {
      readonly kind: "local-adjustments";
      readonly local: DevelopDocumentV3["local"];
    }
  | { readonly kind: "presence"; readonly settings: DevelopDocumentV3["presence"] }
  | {
      readonly kind: "creative-spatial-effect";
      readonly lensBlur: DevelopDocumentV3["lensBlur"];
    }
  | {
      readonly kind: "develop-sharpening";
      readonly settings: DevelopDocumentV3["detail"]["sharpening"];
    }
  | {
      readonly kind: "post-crop-effects";
      readonly settings: DevelopDocumentV3["effects"]["postCrop"];
    }
  | {
      readonly kind: "resize-and-tile-assembly";
      readonly quality: RenderQualityRequest;
    }
  | {
      readonly kind: "output-or-proof-transform";
      readonly requested: RenderOutputIntent;
      readonly effective: RenderOutputIntent;
    }
  | {
      readonly kind: "analysis-overlays-and-encode";
      readonly requestedTaps: RenderRequest["requestedTaps"];
    };

export interface CompiledSemanticStage {
  readonly definition: SemanticStageDefinition;
  readonly parameters: CompiledStageParameters;
}

export interface CompiledV3Plan {
  readonly compilerVersion: typeof V3_COMPILER_VERSION;
  readonly canonicalDocumentHashInput: string;
  readonly stages: readonly CompiledSemanticStage[];
  readonly planIdentity: RenderPlanIdentityInputs;
  readonly diagnostics: readonly DevelopDiagnostic[];
}

export type CompileV3Result =
  | { readonly kind: "compiled"; readonly plan: CompiledV3Plan }
  | {
      readonly kind: "blocked";
      readonly diagnostics: readonly [
        BlockingDevelopDiagnostic,
        ...BlockingDevelopDiagnostic[],
      ];
    }
  | {
      readonly kind: "invalid";
      readonly issues: readonly [CompilerValidationIssue, ...CompilerValidationIssue[]];
    };

function nonEmptyIssues(
  issues: readonly CompilerValidationIssue[],
): readonly [CompilerValidationIssue, ...CompilerValidationIssue[]] | null {
  const first = issues[0];
  return first ? [first, ...issues.slice(1)] : null;
}

function nonEmptyDiagnostics(
  diagnostics: readonly BlockingDevelopDiagnostic[],
): readonly [BlockingDevelopDiagnostic, ...BlockingDevelopDiagnostic[]] | null {
  const first = diagnostics[0];
  return first ? [first, ...diagnostics.slice(1)] : null;
}

export function validateSemanticCompilerStages(
  definitions: readonly SemanticStageDefinition[],
): readonly CompilerValidationIssue[] {
  const issues: CompilerValidationIssue[] = [];
  const definitionsById = new Map<SemanticStageId, SemanticStageDefinition[]>();
  for (const definition of definitions) {
    const existing = definitionsById.get(definition.id) ?? [];
    definitionsById.set(definition.id, [...existing, definition]);
  }
  for (const stageId of SEMANTIC_STAGE_IDS) {
    const matches = definitionsById.get(stageId) ?? [];
    if (matches.length === 0) {
      issues.push({ kind: "missing-stage", stageId });
      continue;
    }
    if (matches.length > 1) {
      issues.push({
        kind: "duplicate-stage-ownership",
        stageId,
        owners: matches.map((definition) => definition.owner),
      });
    }
    const definition = matches[0];
    const expectedOrder = SEMANTIC_STAGE_IDS.indexOf(stageId) + 1;
    if (definition && definition.order !== expectedOrder) {
      issues.push({
        kind: "fixed-order-mismatch",
        stageId,
        expectedOrder,
        foundOrder: definition.order,
      });
    }
  }
  for (const definition of definitions) {
    for (const dependency of definition.dependsOn) {
      if (!definitionsById.has(dependency)) {
        issues.push({
          kind: "missing-dependency",
          stageId: definition.id,
          dependency,
        });
      }
    }
  }

  const visited = new Set<SemanticStageId>();
  const visiting = new Set<SemanticStageId>();
  const path: SemanticStageId[] = [];
  const visit = (stageId: SemanticStageId): void => {
    if (visited.has(stageId)) return;
    if (visiting.has(stageId)) {
      const start = path.indexOf(stageId);
      issues.push({
        kind: "dependency-cycle",
        stages: start >= 0 ? [...path.slice(start), stageId] : [stageId],
      });
      return;
    }
    visiting.add(stageId);
    path.push(stageId);
    const definition = definitionsById.get(stageId)?.[0];
    for (const dependency of definition?.dependsOn ?? []) visit(dependency);
    path.pop();
    visiting.delete(stageId);
    visited.add(stageId);
  };
  for (const stageId of SEMANTIC_STAGE_IDS) visit(stageId);
  return issues;
}

function capabilityAvailable(
  report: DevelopCapabilityReport,
  id: DevelopCapabilityId,
): boolean {
  return capabilityIsAvailable(report.capabilities[id]);
}

function signaturesEqual(
  left: SourceRecord["signature"],
  right: SourceRecord["signature"],
): boolean {
  return left.entryId === right.entryId &&
    left.catalogId === right.catalogId &&
    left.assetRevision === right.assetRevision &&
    left.relativePath === right.relativePath &&
    left.size === right.size &&
    left.lastModified === right.lastModified;
}

function assetKey(asset: ReturnType<typeof acceptedAssetRevision>): string {
  return [
    asset.assetId,
    asset.kind,
    asset.sha256,
    asset.producerRevision,
    asset.coordinateFrameRevision,
    asset.colorStageId,
  ].join("\u001f");
}

function documentAssets(document: DevelopDocumentV3): readonly DevelopAssetRef[] {
  const assets: DevelopAssetRef[] = document.local.masks.flatMap((mask) =>
    referencedMaskArtifacts(mask.expression)
  );
  for (const component of document.cleanup.components) {
    if (
      component.kind === "repair" &&
      component.source.kind === "accepted-patch"
    ) {
      assets.push(component.source.asset);
    }
  }
  if (document.lensBlur.kind === "enabled") assets.push(document.lensBlur.depthAsset);
  const unique = new Map<string, DevelopAssetRef>();
  for (const asset of assets) unique.set(asset.assetId, asset);
  return [...unique.values()].sort((left, right) => left.assetId.localeCompare(right.assetId));
}

function requestIssues(
  document: DevelopDocumentV3,
  source: SourceRecord,
  request: RenderRequest,
): CompilerValidationIssue[] {
  const issues: CompilerValidationIssue[] = [];
  if (request.plan.processVersion !== DEVELOP_PROCESS_VERSION) {
    issues.push({ kind: "request-mismatch", reason: "A v3 compiler requires a v3 plan." });
    return issues;
  }
  if (request.plan.backend.kind !== "v3") {
    issues.push({ kind: "request-mismatch", reason: "A v3 compiler requires a v3 backend." });
  }
  if (request.plan.compilerVersion !== V3_COMPILER_VERSION) {
    issues.push({ kind: "request-mismatch", reason: "Compiler version does not match the request." });
  }
  if (
    request.plan.stageRegistryVersion !== SEMANTIC_STAGE_REGISTRY_VERSION ||
    request.plan.coordinateFrameRevision !== COORDINATE_FRAME_REVISION
  ) {
    issues.push({ kind: "request-mismatch", reason: "Stage or coordinate revision does not match." });
  }
  if (!signaturesEqual(source.signature, request.plan.sourceSignature)) {
    issues.push({ kind: "request-mismatch", reason: "Source signature does not match the plan." });
  }
  const qualityError = validateRenderQualityRequest(request.plan.qualityAndDimensions);
  if (qualityError) {
    issues.push({ kind: "request-mismatch", reason: qualityError });
  }
  const expectedAssets = documentAssets(document).map(acceptedAssetRevision).map(assetKey);
  const requestedAssets = request.plan.acceptedAssetRevisions.map(assetKey).sort();
  if (
    expectedAssets.length !== requestedAssets.length ||
    expectedAssets.some((key, index) => key !== requestedAssets[index])
  ) {
    issues.push({ kind: "request-mismatch", reason: "Accepted assets do not match the document." });
  }
  if (new Set(request.requestedTaps).size !== request.requestedTaps.length) {
    issues.push({ kind: "request-mismatch", reason: "Analysis tap requests must be unique." });
  }
  return issues;
}

function capabilityDiagnostics(input: {
  readonly document: DevelopDocumentV3;
  readonly source: SourceRecord;
  readonly plan: RenderPlanIdentityInputs;
  readonly report: DevelopCapabilityReport;
}): {
  readonly notices: DevelopDiagnostic[];
  readonly blocking: BlockingDevelopDiagnostic[];
  readonly effectiveOutput: RenderOutputIntent;
} {
  const notices: DevelopDiagnostic[] = [];
  const blocking: BlockingDevelopDiagnostic[] = [];
  if (input.source.decoder.kind === "embedded-preview") {
    notices.push({
      kind: "embedded-preview-source",
      category: "source",
      dimensions: input.source.decoder.previewDimensions,
    });
  } else if (input.source.decoder.kind === "reduced-source") {
    notices.push({
      kind: "reduced-source",
      category: "source",
      dimensions: input.source.decoder.sourceDimensions,
    });
  }
  if (!capabilityAvailable(input.report, "high-bit-intermediate-render")) {
    notices.push({
      kind: "rgba8-render-fallback",
      category: "precision",
      capabilityTier: input.report.tier.id,
    });
  }
  const selectedInputProfile = input.document.color.inputProfile.selection.kind === "selected";
  if (
    input.source.inputProfile.kind === "unavailable" ||
    input.document.color.inputProfile.selection.kind === "unavailable" ||
    (selectedInputProfile && (
      !capabilityAvailable(input.report, "input-profile-transform") ||
      !capabilityAvailable(input.report, "camera-profile-dataset")
    ))
  ) {
    blocking.push({
      kind: "input-profile-unavailable",
      category: "color",
      reason: input.source.inputProfile.kind === "unavailable"
        ? input.source.inputProfile.reason
        : input.document.color.inputProfile.selection.kind === "unavailable"
          ? input.document.color.inputProfile.selection.reason
          : "The stored camera profile cannot run without a verified transform and licensed profile dataset.",
    });
  }
  if (
    input.document.optics.profile.kind !== "off" &&
    !capabilityAvailable(input.report, "lens-profile-dataset")
  ) {
    notices.push({
      kind: "lens-profile-unavailable",
      category: "optics",
      reason: "No verified lens profile dataset is available. Optics stays neutral.",
    });
  }

  const output = input.plan.colorIntent;
  let effectiveOutput: RenderOutputIntent = output;
  if (output.kind === "preview-sdr" && output.proofView.kind === "enabled") {
    if (!capabilityAvailable(input.report, "proof-transform")) {
      blocking.push({
        kind: "proof-transform-unavailable",
        category: "proof",
        profileId: output.proofView.profile.id,
      });
    }
  }
  if (
    output.kind === "export-sdr" &&
    output.bitDepth === 16 &&
    !capabilityAvailable(input.report, "typed-high-bit-export")
  ) {
    blocking.push({
      kind: "high-bit-output-blocked",
      category: "output",
      requestedBits: output.bitDepth,
    });
  }
  if (output.kind === "export-hdr" && !capabilityAvailable(input.report, "hdr-output-encode")) {
    if (output.unsupported.kind === "convert-to-sdr") {
      effectiveOutput = output.unsupported.fallback;
      notices.push({
        kind: "rgba8-render-fallback",
        category: "precision",
        capabilityTier: input.report.tier.id,
      });
    } else {
      blocking.push({
        kind: "hdr-output-blocked",
        category: "output",
        requestedTransfer: output.transfer,
      });
    }
  }
  return { notices, blocking, effectiveOutput };
}

function stageParameters(input: {
  readonly id: SemanticStageId;
  readonly document: DevelopDocumentV3;
  readonly source: SourceRecord;
  readonly request: RenderRequest;
  readonly effectiveOutput: RenderOutputIntent;
}): CompiledStageParameters {
  const document = input.document;
  switch (input.id) {
    case "decode-and-orientation":
      return { kind: input.id, source: input.source };
    case "wb-and-input-profile":
      return {
        kind: input.id,
        whiteBalance: document.color.whiteBalance,
        inputProfile: document.color.inputProfile,
      };
    case "optics": return { kind: input.id, optics: document.optics };
    case "standard-denoise":
      return { kind: input.id, settings: document.detail.noiseReduction };
    case "canonical-geometry": return { kind: input.id, geometry: document.geometry };
    case "source-repair": return { kind: input.id, cleanup: document.cleanup };
    case "basic-tone":
      return {
        kind: input.id,
        basic: document.tone.basic,
        global: document.color.global,
        hdr: document.hdr,
      };
    case "curve-and-color":
      return {
        kind: input.id,
        curves: document.tone.curves,
        pointColor: document.color.pointColor,
        mixer: document.color.mixer,
        monochrome: document.color.monochrome,
        grading: document.color.grading,
      };
    case "local-adjustments": return { kind: input.id, local: document.local };
    case "presence": return { kind: input.id, settings: document.presence };
    case "creative-spatial-effect": return { kind: input.id, lensBlur: document.lensBlur };
    case "develop-sharpening":
      return { kind: input.id, settings: document.detail.sharpening };
    case "post-crop-effects":
      return { kind: input.id, settings: document.effects.postCrop };
    case "resize-and-tile-assembly":
      return { kind: input.id, quality: input.request.plan.qualityAndDimensions };
    case "output-or-proof-transform":
      return {
        kind: input.id,
        requested: input.request.plan.colorIntent,
        effective: input.effectiveOutput,
      };
    case "analysis-overlays-and-encode":
      return { kind: input.id, requestedTaps: input.request.requestedTaps };
    default: {
      const exhaustive: never = input.id;
      return exhaustive;
    }
  }
}

export function compileV3DevelopPlan(input: {
  readonly document: DevelopDocumentV3;
  readonly source: SourceRecord;
  readonly request: RenderRequest;
  readonly capabilities: DevelopCapabilityReport;
  readonly stageDefinitions?: readonly SemanticStageDefinition[];
}): CompileV3Result {
  const definitions = input.stageDefinitions ?? V3_SEMANTIC_STAGES;
  const tierIssues: CompilerValidationIssue[] = capabilityTierMatchesPlan(
    input.capabilities.tier,
    input.request.plan,
  )
    ? []
    : [{
        kind: "request-mismatch",
        reason: "Capability tier does not match the plan identity.",
      }];
  const issues = [
    ...validateSemanticCompilerStages(definitions),
    ...requestIssues(input.document, input.source, input.request),
    ...tierIssues,
  ];
  const invalidIssues = nonEmptyIssues(issues);
  if (invalidIssues) return { kind: "invalid", issues: invalidIssues };
  const capability = capabilityDiagnostics({
    document: input.document,
    source: input.source,
    plan: input.request.plan,
    report: input.capabilities,
  });
  const blocked = nonEmptyDiagnostics(capability.blocking);
  if (blocked) return { kind: "blocked", diagnostics: blocked };
  const definitionsById = new Map(definitions.map((definition) => [definition.id, definition]));
  const stages: CompiledSemanticStage[] = [];
  for (const id of SEMANTIC_STAGE_IDS) {
    const definition = definitionsById.get(id);
    if (!definition) {
      return {
        kind: "invalid",
        issues: [{ kind: "missing-stage", stageId: id }],
      };
    }
    stages.push({
      definition,
      parameters: stageParameters({
        id,
        document: input.document,
        source: input.source,
        request: input.request,
        effectiveOutput: capability.effectiveOutput,
      }),
    });
  }
  return {
    kind: "compiled",
    plan: {
      compilerVersion: V3_COMPILER_VERSION,
      canonicalDocumentHashInput: canonicalV3DocumentHashInput(input.document),
      stages,
      planIdentity: input.request.plan,
      diagnostics: capability.notices,
    },
  };
}

export function capabilityTierMatchesPlan(
  tier: CapabilityTier,
  plan: RenderPlanIdentityInputs,
): boolean {
  return tier.kind === plan.capabilityTier.kind && tier.id === plan.capabilityTier.id;
}
