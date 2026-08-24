import {
  BASELINE_CAPABILITY_REPORT,
  capabilityIsAvailable,
  type ColorProfileReference,
  type DevelopCapabilityReport,
  type DevelopDiagnostic,
} from "../process";
import {
  type ExportOutputIntent,
  type HdrExportOutputIntent,
  type PreviewOutputIntent,
  type ProofViewIntent,
  type SdrExportOutputIntent,
} from "../render-contract";
import type { HdrHeadroomResult } from "./analysis";

export const HDR_MERGE_POLICY = "unsupported";
export const MAX_HDR_EVIDENCE_ITEMS = 32;

export type HdrSourceMetadata =
  | {
      readonly kind: "sdr";
      readonly transfer: "srgb" | "gamma";
    }
  | {
      readonly kind: "hdr-verified";
      readonly transfer: "pq" | "hlg";
      readonly peakNits: number;
      readonly metadataRevision: string;
      readonly evidence: readonly [string, ...string[]];
    }
  | {
      readonly kind: "unverified";
      readonly declaredTransfer: string;
      readonly reason: string;
    };

export type DisplayCapability =
  | {
      readonly kind: "sdr-only";
      readonly capabilityTier: "baseline-sdr-rgba8";
      readonly reason: string;
    }
  | {
      readonly kind: "hdr-verified";
      readonly transfer: "pq" | "hlg";
      readonly peakNits: number;
      readonly evidence: readonly [string, ...string[]];
    };

export const CURRENT_DISPLAY_CAPABILITY = {
  kind: "sdr-only",
  capabilityTier: "baseline-sdr-rgba8",
  reason: "No Electron HDR display probe has passed.",
} as const satisfies DisplayCapability;

export interface OutputViewState {
  readonly hdrPreview: "prefer-hdr" | "force-sdr";
  readonly proofView: ProofViewIntent;
  readonly showHeadroom: boolean;
}

export type ProofPolicy =
  | { readonly kind: "disabled" }
  | {
      readonly kind: "unavailable";
      readonly diagnostic: Extract<
        DevelopDiagnostic,
        { readonly kind: "proof-transform-unavailable" }
      >;
    }
  | {
      readonly kind: "enabled";
      readonly view: Extract<ProofViewIntent, { readonly kind: "enabled" }>;
    };

export type PreviewOutputPolicy = {
  readonly kind: "render-sdr";
  readonly intent: PreviewOutputIntent;
  readonly transform: {
    readonly id: "scene-linear-to-srgb-v1";
    readonly preservesSceneHeadroom: true;
  };
  readonly reason: "requested-sdr" | "display-unavailable" | "pipeline-unavailable";
  readonly proof: ProofPolicy;
  readonly diagnostics: readonly DevelopDiagnostic[];
};

export type HeadroomPolicy =
  | {
      readonly kind: "available";
      readonly analysis: Extract<HdrHeadroomResult, { readonly kind: "available" }>;
    }
  | {
      readonly kind: "unavailable";
      readonly reason:
        | "source-unverified"
        | "high-bit-pipeline-unavailable"
        | "tap-unavailable";
      readonly message: string;
    };

export type ExportOutputPolicy =
  | {
      readonly kind: "allowed-sdr";
      readonly intent: SdrExportOutputIntent;
      readonly diagnostics: readonly DevelopDiagnostic[];
    }
  | {
      readonly kind: "allowed-hdr";
      readonly intent: HdrExportOutputIntent;
      readonly diagnostics: readonly DevelopDiagnostic[];
    }
  | {
      readonly kind: "converted-to-sdr";
      readonly requested: HdrExportOutputIntent;
      readonly intent: SdrExportOutputIntent;
      readonly diagnostics: readonly [DevelopDiagnostic, ...DevelopDiagnostic[]];
    }
  | {
      readonly kind: "blocked";
      readonly intent: ExportOutputIntent;
      readonly diagnostics: readonly [DevelopDiagnostic, ...DevelopDiagnostic[]];
    };

export type ProofProfileExportRequest =
  | { readonly kind: "not-requested" }
  | {
      readonly kind: "reuse-proof-profile";
      readonly proofView: Extract<ProofViewIntent, { readonly kind: "enabled" }>;
    };

export type ProofProfileExportSelection =
  | { readonly kind: "none" }
  | {
      readonly kind: "selected";
      readonly profile: ColorProfileReference;
    }
  | { readonly kind: "unavailable"; readonly reason: string };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function boundedText(value: unknown, label: string, maximum = 256): string {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value.length > maximum ||
    value.includes("\0")
  ) {
    throw new Error(`${label} is invalid.`);
  }
  return value;
}

function boundedNumber(
  value: unknown,
  label: string,
  minimum: number,
  maximum: number,
): number {
  if (
    typeof value !== "number" ||
    !Number.isFinite(value) ||
    value < minimum ||
    value > maximum
  ) {
    throw new Error(`${label} is invalid.`);
  }
  return value;
}

export function parseHdrSourceMetadata(value: unknown): HdrSourceMetadata {
  if (!isRecord(value)) throw new Error("HDR source metadata is invalid.");
  if (value.kind === "sdr") {
    if (value.transfer !== "srgb" && value.transfer !== "gamma") {
      throw new Error("SDR source transfer is invalid.");
    }
    return { kind: "sdr", transfer: value.transfer };
  }
  if (value.kind === "unverified") {
    return {
      kind: "unverified",
      declaredTransfer: boundedText(value.declaredTransfer, "Declared transfer"),
      reason: boundedText(value.reason, "HDR metadata reason", 1_024),
    };
  }
  if (value.kind === "hdr-verified") {
    if (value.transfer !== "pq" && value.transfer !== "hlg") {
      throw new Error("HDR source transfer is invalid.");
    }
    if (
      !Array.isArray(value.evidence) ||
      value.evidence.length === 0 ||
      value.evidence.length > MAX_HDR_EVIDENCE_ITEMS
    ) {
      throw new Error("HDR source evidence is missing.");
    }
    const evidence = value.evidence.map((item) =>
      boundedText(item, "HDR source evidence", 1_024)
    );
    const first = evidence[0];
    if (!first) throw new Error("HDR source evidence is missing.");
    return {
      kind: "hdr-verified",
      transfer: value.transfer,
      peakNits: boundedNumber(value.peakNits, "HDR source peak", 80, 10_000),
      metadataRevision: boundedText(value.metadataRevision, "HDR metadata revision"),
      evidence: [first, ...evidence.slice(1)],
    };
  }
  throw new Error("HDR source kind is invalid.");
}

function profileIsBounded(profile: ColorProfileReference): boolean {
  return profile.id.length > 0 && profile.id.length <= 256 &&
    profile.revision.length > 0 && profile.revision.length <= 256;
}

export function resolveProofPolicy(
  view: ProofViewIntent,
  report: DevelopCapabilityReport = BASELINE_CAPABILITY_REPORT,
): ProofPolicy {
  if (view.kind === "disabled") return { kind: "disabled" };
  const decision = report.capabilities["proof-transform"];
  if (!profileIsBounded(view.profile) || !capabilityIsAvailable(decision)) {
    return {
      kind: "unavailable",
      diagnostic: {
        kind: "proof-transform-unavailable",
        category: "proof",
        profileId: view.profile.id,
      },
    };
  }
  return { kind: "enabled", view };
}

export function resolvePreviewOutputPolicy(input: {
  readonly view: OutputViewState;
  readonly displayProfile: ColorProfileReference;
  readonly display: DisplayCapability;
  readonly report?: DevelopCapabilityReport;
}): PreviewOutputPolicy {
  const report = input.report ?? BASELINE_CAPABILITY_REPORT;
  const proof = resolveProofPolicy(input.view.proofView, report);
  const diagnostics: DevelopDiagnostic[] = [];
  if (proof.kind === "unavailable") diagnostics.push(proof.diagnostic);
  let reason: PreviewOutputPolicy["reason"] = "requested-sdr";
  if (input.view.hdrPreview === "prefer-hdr") {
    reason = input.display.kind === "sdr-only"
      ? "display-unavailable"
      : "pipeline-unavailable";
  }
  diagnostics.push({
    kind: "sdr-display-transform",
    category: "display",
    retainedTap: "scene-headroom",
  });
  return {
    kind: "render-sdr",
    intent: {
      kind: "preview-sdr",
      displayProfile: input.displayProfile,
      transfer: "srgb",
      proofView: proof.kind === "enabled" ? proof.view : { kind: "disabled" },
    },
    transform: {
      id: "scene-linear-to-srgb-v1",
      preservesSceneHeadroom: true,
    },
    reason,
    proof,
    diagnostics,
  };
}

export function resolveHeadroomPolicy(input: {
  readonly source: HdrSourceMetadata;
  readonly analysis: HdrHeadroomResult;
  readonly report?: DevelopCapabilityReport;
}): HeadroomPolicy {
  const report = input.report ?? BASELINE_CAPABILITY_REPORT;
  if (input.source.kind !== "hdr-verified") {
    return {
      kind: "unavailable",
      reason: "source-unverified",
      message: "The source has no verified HDR metadata.",
    };
  }
  if (!capabilityIsAvailable(report.capabilities["high-bit-intermediate-render"])) {
    return {
      kind: "unavailable",
      reason: "high-bit-pipeline-unavailable",
      message: "The active render tier cannot retain verified scene headroom.",
    };
  }
  if (input.analysis.kind === "unavailable") {
    return {
      kind: "unavailable",
      reason: "tap-unavailable",
      message: input.analysis.reason,
    };
  }
  return { kind: "available", analysis: input.analysis };
}

function highBitOutputAvailable(report: DevelopCapabilityReport): boolean {
  return capabilityIsAvailable(report.capabilities["high-bit-intermediate-render"]) &&
    capabilityIsAvailable(report.capabilities["high-bit-readback"]) &&
    capabilityIsAvailable(report.capabilities["typed-high-bit-export"]);
}

function highBitDiagnostic(bitDepth: 10 | 12 | 16): Extract<
  DevelopDiagnostic,
  { readonly kind: "high-bit-output-blocked" }
> {
  return {
    kind: "high-bit-output-blocked",
    category: "output",
    requestedBits: bitDepth,
  };
}

function hdrDiagnostic(intent: HdrExportOutputIntent): Extract<
  DevelopDiagnostic,
  { readonly kind: "hdr-output-blocked" }
> {
  return {
    kind: "hdr-output-blocked",
    category: "output",
    requestedTransfer: intent.transfer,
  };
}

export function resolveExportOutputPolicy(
  intent: ExportOutputIntent,
  report: DevelopCapabilityReport = BASELINE_CAPABILITY_REPORT,
): ExportOutputPolicy {
  if (intent.kind === "export-sdr") {
    if (intent.bitDepth === 8 || highBitOutputAvailable(report)) {
      return { kind: "allowed-sdr", intent, diagnostics: [] };
    }
    const diagnostic = highBitDiagnostic(intent.bitDepth);
    return { kind: "blocked", intent, diagnostics: [diagnostic] };
  }
  const highBitAvailable = highBitOutputAvailable(report);
  const hdrAvailable = capabilityIsAvailable(
    report.capabilities["hdr-output-encode"],
  );
  if (highBitAvailable && hdrAvailable) {
    return { kind: "allowed-hdr", intent, diagnostics: [] };
  }
  const blockedDiagnostics: DevelopDiagnostic[] = [];
  if (!hdrAvailable) blockedDiagnostics.push(hdrDiagnostic(intent));
  if (!highBitAvailable) {
    blockedDiagnostics.push(highBitDiagnostic(intent.bitDepth));
  }
  const firstDiagnostic = blockedDiagnostics[0];
  if (!firstDiagnostic) {
    throw new Error("Blocked HDR output has no diagnostic.");
  }
  const diagnostics: readonly [DevelopDiagnostic, ...DevelopDiagnostic[]] = [
    firstDiagnostic,
    ...blockedDiagnostics.slice(1),
  ];
  if (intent.unsupported.kind === "block") {
    return {
      kind: "blocked",
      intent,
      diagnostics,
    };
  }
  const fallback = resolveExportOutputPolicy(intent.unsupported.fallback, report);
  if (fallback.kind !== "allowed-sdr") {
    return {
      kind: "blocked",
      intent,
      diagnostics: [firstDiagnostic, ...fallback.diagnostics],
    };
  }
  return {
    kind: "converted-to-sdr",
    requested: intent,
    intent: fallback.intent,
    diagnostics,
  };
}

export function selectProofProfileForExport(
  request: ProofProfileExportRequest,
  report: DevelopCapabilityReport = BASELINE_CAPABILITY_REPORT,
): ProofProfileExportSelection {
  if (request.kind === "not-requested") return { kind: "none" };
  const proof = resolveProofPolicy(request.proofView, report);
  return proof.kind === "enabled"
    ? { kind: "selected", profile: proof.view.profile }
    : { kind: "unavailable", reason: "The requested proof profile cannot be transformed." };
}
