import type { DevelopImage } from "@/lib/cache/develop-image-cache";
import {
  cachedMaskAsset,
  cachedMaskAssetBytes,
  type DecodedMaskAsset,
} from "@/lib/develop/renderer";
import {
  BASELINE_CAPABILITY_REPORT,
  COORDINATE_FRAME_REVISION,
  DEVELOP_PROCESS_VERSION,
  SEMANTIC_STAGE_REGISTRY_VERSION,
  type DecoderProvenance,
  type PixelDimensions,
  type PixelPrecision,
  type SourceColorEncoding,
  type SourceRecord,
} from "@/lib/develop/process";
import {
  parseSha256Digest,
  type AcceptedAssetRevision,
  type ExportQualityRequest,
  type PreviewQualityRequest,
  type RenderRequest,
  type Sha256Digest,
} from "@/lib/develop/render-contract";
import type { LibraryEntry } from "@/lib/fs/types";
import {
  MAX_EXPORT_EDGE,
  MAX_EXPORT_PIXELS,
  type ExportFormatId,
  type ExportSizeOptions,
} from "@/lib/export/types";
import { acceptedAssetRevision, type DevelopAssetRef } from "./assets";
import { V3_COMPILER_VERSION } from "./compiler";
import {
  MAX_CPU_EXPORT_PIXELS,
  MAX_CPU_RENDER_PIXELS,
  V3_CPU_BACKEND_ID,
  V3_CPU_BACKEND_REVISION,
  renderV3Cpu,
  type CpuAssetAvailability,
  type CpuBackendBlockingDiagnostic,
  type CpuRenderResult,
} from "./cpu-backend";
import {
  canonicalV3DocumentHashInput,
  type DevelopDocumentV3,
} from "./document";
import { resolveConstrainedCrop, type CanonicalGeometry } from "./geometry";
import type { MaskCoverageAssets } from "./manual-edits";
import { NEUTRAL_LENS_CALIBRATION } from "./optics";
import {
  MAX_TILE_OVERLAP,
  parseSourceRecord,
  type CancellationProbe,
} from "./source";

const STANDARD_SRGB_PROFILE = {
  id: "darkroom-standard-srgb",
  revision: "iec-61966-2-1",
  source: "registry",
} as const;
const PREVIEW_ANALYSIS_TAPS = [
  "tone-input",
  "display-output",
  "scene-headroom",
] as const;
const EXPORT_ANALYSIS_TAPS = ["display-output", "scene-headroom"] as const;
const EXPORT_TILE_EDGE = 1_024;
const INTERACTIVE_PREVIEW_MAX_PIXELS = 16_000;

export type V3SourcePurpose = "preview" | "export";

export type V3SourceRecordResult =
  | { readonly kind: "source"; readonly source: SourceRecord }
  | {
      readonly kind: "blocked";
      readonly diagnostic: CpuBackendBlockingDiagnostic;
    };

interface V3RuntimeRequestBase {
  readonly entry: LibraryEntry;
  readonly image: DevelopImage;
  readonly cancellation?: CancellationProbe;
  readonly assets?: CpuAssetAvailability;
}

export interface V3PreviewSessionRenderRequest extends V3RuntimeRequestBase {
  readonly kind: "v3-preview";
  readonly viewportDimensions: PixelDimensions;
  readonly devicePixelRatio: number;
  readonly previewMode: "interactive" | "settled";
}

export interface V3ExportSessionRenderRequest extends V3RuntimeRequestBase {
  readonly kind: "v3-export";
  readonly size: ExportSizeOptions;
  readonly format: ExportFormatId;
  readonly quality?: number;
  readonly lossless?: boolean;
}

export type V3SessionRenderRequest =
  | V3PreviewSessionRenderRequest
  | V3ExportSessionRenderRequest;

type V3RuntimeRenderRequest = V3SessionRenderRequest;

type RuntimeSourceColorEncoding = Extract<
  SourceColorEncoding,
  { readonly kind: "decoder-provided" | "uncharacterized" }
>;

function blockedSource(reason: string): V3SourceRecordResult {
  return {
    kind: "blocked",
    diagnostic: { kind: "source-pixels-invalid", category: "source", reason },
  };
}

function metadataText(metadata: Record<string, unknown>, key: string): string | null {
  const value = metadata[key];
  return typeof value === "string" && value.length > 0 && value.length <= 256
    ? value
    : null;
}

function sourcePrecision(image: DevelopImage): PixelPrecision | null {
  if (image.bits === 8 && !(image.rgb instanceof Uint16Array)) {
    return { kind: "integer", componentBits: 8, storageBits: 8 };
  }
  if (!(image.rgb instanceof Uint16Array)) return null;
  switch (image.bits) {
    case 10: return { kind: "integer", componentBits: 10, storageBits: 16 };
    case 12: return { kind: "integer", componentBits: 12, storageBits: 16 };
    case 14: return { kind: "integer", componentBits: 14, storageBits: 16 };
    case 16: return { kind: "integer", componentBits: 16, storageBits: 16 };
    default: return null;
  }
}

function decoderProvenance(
  image: DevelopImage,
  purpose: V3SourcePurpose,
): DecoderProvenance | null {
  const metadata = image.metadata;
  const provenance = metadataText(metadata, "decoderProvenance");
  const embedded = provenance === "embedded" || metadata.developSource === "embedded";
  if (embedded) {
    return {
      kind: "embedded-preview",
      decoderId: "embedded-raw-preview",
      previewDimensions: {
        width: image.sourceWidth,
        height: image.sourceHeight,
      },
    };
  }
  let decoderId: string;
  let decoderRevision: string;
  switch (provenance) {
    case "standard":
      decoderId = "browser-image-decoder";
      decoderRevision = "canvas-rgba8-v1";
      break;
    case "libraw":
      decoderId = "libraw-wasm";
      decoderRevision = "darkroom-libraw-settings-v1";
      break;
    case "nikon-sdk":
    case "nikon-test-only":
      decoderId = provenance;
      decoderRevision = metadata.protocolVersion === 1
        ? "rgb16le-v1"
        : "unverified-protocol";
      break;
    default:
      return null;
  }
  return purpose === "export"
    ? { kind: "full-source", decoderId, decoderRevision }
    : {
        kind: "reduced-source",
        decoderId,
        decoderRevision,
        sourceDimensions: {
          width: image.sourceWidth,
          height: image.sourceHeight,
        },
      };
}

function sourceColor(image: DevelopImage): RuntimeSourceColorEncoding {
  const provenance = metadataText(image.metadata, "decoderProvenance");
  if (
    provenance === "standard" ||
    provenance === "embedded" ||
    image.metadata.developSource === "embedded"
  ) {
    return {
      kind: "decoder-provided",
      decoderColorSpace: STANDARD_SRGB_PROFILE.id,
      transfer: { kind: "srgb" },
    };
  }
  if (provenance === "nikon-sdk" || provenance === "nikon-test-only") {
    const colorSpace = metadataText(image.metadata, "colorSpace");
    const transfer = metadataText(image.metadata, "transferFunction");
    if (colorSpace === "srgb" && transfer === "srgb") {
      return {
        kind: "decoder-provided",
        decoderColorSpace: STANDARD_SRGB_PROFILE.id,
        transfer: { kind: "srgb" },
      };
    }
    if (provenance === "nikon-sdk" && colorSpace === "srgb" && transfer === "linear") {
      return {
        kind: "decoder-provided",
        decoderColorSpace: STANDARD_SRGB_PROFILE.id,
        transfer: { kind: "linear" },
      };
    }
    return {
      kind: "uncharacterized",
      reason: "The Nikon decoder did not prove a supported sRGB transfer.",
    };
  }
  return {
    kind: "uncharacterized",
    reason: "The decoder did not provide a verified transfer and color space.",
  };
}

export function buildV3SourceRecord(
  entry: LibraryEntry,
  image: DevelopImage,
  purpose: V3SourcePurpose,
): V3SourceRecordResult {
  const precision = sourcePrecision(image);
  if (!precision) {
    return blockedSource(`The ${image.bits}-bit source does not match its pixel storage.`);
  }
  const decoder = decoderProvenance(image, purpose);
  if (!decoder) {
    return blockedSource("Decoder provenance is unavailable for this source.");
  }
  const color = sourceColor(image);
  try {
    return {
      kind: "source",
      source: parseSourceRecord({
        version: 1,
        signature: {
          entryId: entry.id,
          catalogId: entry.catalogId,
          assetRevision: entry.assetRevision,
          relativePath: entry.relativePath,
          size: entry.size,
          lastModified: entry.lastModified,
        },
        dimensions: {
          width: image.sourceWidth,
          height: image.sourceHeight,
        },
        orientation: image.orientation,
        decoder,
        precision,
        color,
        inputProfile: color.kind === "decoder-provided"
          ? {
              kind: "decoder-default",
              decoderId: decoder.decoderId,
              decoderColorSpace: color.decoderColorSpace,
            }
          : { kind: "unavailable", reason: color.reason },
        asShotWhiteBalance: {
          kind: "unavailable",
          reason: "The active decoder did not provide validated white-balance multipliers.",
        },
        camera: { kind: "unavailable" },
        lens: { kind: "unavailable" },
      }),
    };
  } catch (error) {
    return blockedSource(
      error instanceof Error ? error.message : "Source metadata is invalid.",
    );
  }
}

function documentAssetReferences(
  document: DevelopDocumentV3,
): readonly AcceptedAssetRevision[] {
  const references: DevelopAssetRef[] = [...document.local.maskAssetRefs];
  for (const component of document.cleanup.components) {
    if (component.kind === "repair" && component.source.kind === "accepted-patch") {
      references.push(component.source.asset);
    }
  }
  if (document.lensBlur.kind === "enabled") {
    references.push(document.lensBlur.depthAsset);
  }
  const unique = new Map(references.map((reference) => [reference.assetId, reference]));
  return [...unique.values()]
    .sort((left, right) => left.assetId.localeCompare(right.assetId))
    .map(acceptedAssetRevision);
}

async function runtimeAssets(
  document: DevelopDocumentV3,
  source: SourceRecord,
  supplied: CpuAssetAvailability | undefined,
): Promise<CpuAssetAvailability | undefined> {
  const legacy = document.compatibility.legacyV2;
  const acceptedMasks = new Map<string, DevelopAssetRef>(
    document.local.maskAssetRefs.map((reference) => [reference.assetId, reference]),
  );
  const retainedByDigest = new Map(
    Object.values(legacy?.maskAssets ?? {}).map((asset) => [asset.sha256, asset]),
  );
  const requiredIds = new Set<string>();
  for (const mask of document.local.masks) {
    for (const component of mask.components) {
      if (component.kind === "ai" && acceptedMasks.has(component.assetId)) {
        requiredIds.add(component.assetId);
      }
    }
  }
  if (requiredIds.size === 0) return supplied;
  const decoded = new Map<string, DecodedMaskAsset>();
  await Promise.all([...requiredIds].map(async (assetId) => {
    const retained = retainedByDigest.get(assetId);
    if (retained) {
      try {
        decoded.set(assetId, await cachedMaskAsset(retained));
        return;
      } catch {
        // Try the accepted asset store before preflight reports the matte unavailable.
      }
    }
    if (typeof window === "undefined" || !window.darkroom) return;
    const reference = acceptedMasks.get(assetId);
    if (!reference) return;
    try {
      const result = await window.darkroom.developAssetRead({
        reference,
        sourceSignature: source.signature,
      });
      if (result.kind !== "ready" || result.descriptor.mimeType !== "image/png") return;
      decoded.set(assetId, await cachedMaskAssetBytes({
        id: assetId,
        sha256: result.descriptor.sha256,
        mimeType: result.descriptor.mimeType,
        width: result.descriptor.dimensions.width,
        height: result.descriptor.dimensions.height,
        byteLength: result.descriptor.byteLength,
      }, result.bytes));
    } catch {
      // Preflight reports an unavailable matte and blocks export.
    }
  }));
  if (decoded.size === 0) return supplied;
  return {
    hasAsset: (assetId) => decoded.has(assetId) || (supplied?.hasAsset(assetId) ?? false),
    maskMatte: (assetId) => decoded.get(assetId) ?? supplied?.maskMatte?.(assetId),
  };
}

export async function loadV3MaskCoverageAssets(
  document: DevelopDocumentV3,
  source: SourceRecord,
): Promise<MaskCoverageAssets | undefined> {
  const assets = await runtimeAssets(document, source, undefined);
  if (!assets?.maskMatte) return undefined;
  return {
    sourceSignature: source.signature,
    maskMatte: assets.maskMatte,
  };
}

export interface V3PreviewMaskMatte {
  readonly assetId: string;
  readonly width: number;
  readonly height: number;
  readonly pixels: Uint8Array;
}

export async function loadV3PreviewMaskMattes(
  document: DevelopDocumentV3,
  entry: LibraryEntry,
  image: DevelopImage,
): Promise<readonly V3PreviewMaskMatte[]> {
  const requiredIds = new Set<string>();
  for (const mask of document.local.masks) {
    for (const component of mask.components) {
      if (component.kind === "ai") requiredIds.add(component.assetId);
    }
  }
  if (requiredIds.size === 0) return [];
  const sourceResult = buildV3SourceRecord(entry, image, "preview");
  if (sourceResult.kind === "blocked") return [];
  const assets = await runtimeAssets(document, sourceResult.source, undefined);
  if (!assets?.maskMatte) return [];
  return [...requiredIds].flatMap((assetId) => {
    const matte = assets.maskMatte?.(assetId);
    return matte ? [{ assetId, ...matte }] : [];
  });
}

function geometrySourceDimensions(source: SourceRecord): PixelDimensions {
  return source.orientation >= 5
    ? { width: source.dimensions.height, height: source.dimensions.width }
    : source.dimensions;
}

function baseOutputDimensions(
  document: DevelopDocumentV3,
  source: SourceRecord,
): PixelDimensions {
  const oriented = geometrySourceDimensions(source);
  const geometry: CanonicalGeometry = {
    frame: document.local.geometryFrame,
    sourceWidth: oriented.width,
    sourceHeight: oriented.height,
    exifOrientation: 1,
    optics: {
      calibration: NEUTRAL_LENS_CALIBRATION,
      amounts: {
        distortion: 0,
        illumination: 0,
        lateralChromaticAberration: 0,
      },
    },
    orientation: document.geometry.orientation,
    manualPerspective: document.geometry.manualPerspective.matrix,
    upright: document.geometry.upright,
    constrainCrop: document.geometry.constrainCrop,
    crop: document.geometry.crop,
  };
  const crop = resolveConstrainedCrop(geometry);
  const turnsAxes = document.geometry.orientation.quarterTurns % 2 === 1;
  const turned = turnsAxes
    ? { width: oriented.height, height: oriented.width }
    : oriented;
  return {
    width: Math.max(1, Math.round(turned.width * crop.width)),
    height: Math.max(1, Math.round(turned.height * crop.height)),
  };
}

function fitDimensions(
  source: PixelDimensions,
  bounds: PixelDimensions,
  allowUpscale: boolean,
): PixelDimensions {
  const ratio = Math.min(bounds.width / source.width, bounds.height / source.height);
  const applied = allowUpscale ? ratio : Math.min(1, ratio);
  return {
    width: Math.max(1, Math.round(source.width * applied)),
    height: Math.max(1, Math.round(source.height * applied)),
  };
}

function previewQuality(
  document: DevelopDocumentV3,
  source: SourceRecord,
  request: V3PreviewSessionRenderRequest,
): PreviewQualityRequest | null {
  const viewport = request.viewportDimensions;
  if (
    !Number.isSafeInteger(viewport.width) ||
    !Number.isSafeInteger(viewport.height) ||
    viewport.width < 1 ||
    viewport.height < 1 ||
    !Number.isFinite(request.devicePixelRatio)
  ) {
    return null;
  }
  const devicePixelRatio = Math.min(1, Math.max(0.5, request.devicePixelRatio));
  const bounds = {
    width: Math.max(1, Math.round(viewport.width * devicePixelRatio)),
    height: Math.max(1, Math.round(viewport.height * devicePixelRatio)),
  };
  let outputDimensions = fitDimensions(
    baseOutputDimensions(document, source),
    bounds,
    false,
  );
  const maximumPixels = request.previewMode === "interactive"
    ? INTERACTIVE_PREVIEW_MAX_PIXELS
    : MAX_CPU_RENDER_PIXELS;
  const pixelCount = outputDimensions.width * outputDimensions.height;
  if (pixelCount > maximumPixels) {
    const scale = Math.sqrt(maximumPixels / pixelCount);
    outputDimensions = {
      width: Math.max(1, Math.floor(outputDimensions.width * scale)),
      height: Math.max(1, Math.floor(outputDimensions.height * scale)),
    };
  }
  return {
    kind: "fit",
    outputDimensions,
    viewportDimensions: viewport,
    devicePixelRatio,
  };
}

export function resolveV3ExportDimensions(
  document: DevelopDocumentV3,
  source: SourceRecord,
  size: ExportSizeOptions,
): PixelDimensions {
  const base = baseOutputDimensions(document, source);
  let output: PixelDimensions;
  if (size.mode === "original") {
    output = base;
  } else if (size.mode === "long-edge" || size.mode === "longEdge") {
    const edge = size.longEdge ?? size.pixels;
    if (!Number.isSafeInteger(edge) || !edge || edge < 1 || edge > MAX_EXPORT_EDGE) {
      throw new Error("Long edge must be a supported positive whole number.");
    }
    const sourceEdge = Math.max(base.width, base.height);
    output = size.neverUpscale !== false && edge >= sourceEdge
      ? base
      : fitDimensions(base, { width: edge, height: edge }, true);
  } else if (size.mode === "fit") {
    if (
      !Number.isSafeInteger(size.width) ||
      !Number.isSafeInteger(size.height) ||
      size.width < 1 ||
      size.height < 1 ||
      size.width > MAX_EXPORT_EDGE ||
      size.height > MAX_EXPORT_EDGE
    ) {
      throw new Error("Fit dimensions must be supported positive whole numbers.");
    }
    output = size.neverUpscale !== false && base.width <= size.width && base.height <= size.height
      ? base
      : fitDimensions(base, { width: size.width, height: size.height }, true);
  } else {
    throw new Error("Unsupported export size.");
  }
  const pixels = output.width * output.height;
  if (
    output.width > MAX_EXPORT_EDGE ||
    output.height > MAX_EXPORT_EDGE ||
    !Number.isSafeInteger(pixels) ||
    pixels > MAX_EXPORT_PIXELS ||
    pixels > MAX_CPU_EXPORT_PIXELS
  ) {
    throw new Error("This edit exceeds the 50 megapixel v3 export limit.");
  }
  return output;
}

function exportQuality(
  document: DevelopDocumentV3,
  source: SourceRecord,
  request: V3ExportSessionRenderRequest,
): ExportQualityRequest {
  const outputDimensions = resolveV3ExportDimensions(document, source, request.size);
  const quality = request.lossless
    ? { kind: "lossless" as const }
    : { kind: "lossy" as const, value: request.quality ?? 90 };
  return {
    kind: "export",
    outputDimensions,
    tileDimensions: {
      width: Math.min(EXPORT_TILE_EDGE, outputDimensions.width),
      height: Math.min(EXPORT_TILE_EDGE, outputDimensions.height),
    },
    tileOverlap: MAX_TILE_OVERLAP,
    encoderQuality: quality,
  };
}

function hexDigest(buffer: ArrayBuffer): string {
  return [...new Uint8Array(buffer)]
    .map((value) => value.toString(16).padStart(2, "0"))
    .join("");
}

async function documentHash(
  document: DevelopDocumentV3,
): Promise<Sha256Digest | null> {
  if (!globalThis.crypto?.subtle) return null;
  const input = new TextEncoder().encode(canonicalV3DocumentHashInput(document));
  const bytes = new Uint8Array(new ArrayBuffer(input.byteLength));
  bytes.set(input);
  const digest = await globalThis.crypto.subtle.digest("SHA-256", bytes);
  return parseSha256Digest(hexDigest(digest));
}

function invalidResult(reason: string): CpuRenderResult {
  return {
    kind: "invalid",
    issues: [{ kind: "request-mismatch", reason }],
  };
}

function fingerprintBlocked(): CpuRenderResult {
  return {
    kind: "blocked",
    diagnostics: [{
      kind: "fingerprint-unavailable",
      category: "output",
      reason: "Web Crypto SHA-256 is unavailable.",
    }],
  };
}

async function renderRequest(
  document: DevelopDocumentV3,
  source: SourceRecord,
  request: V3RuntimeRenderRequest,
): Promise<RenderRequest | CpuRenderResult> {
  const canonicalDocumentHash = await documentHash(document);
  if (!canonicalDocumentHash) return fingerprintBlocked();
  try {
    const acceptedAssetRevisions = documentAssetReferences(document);
    if (request.kind === "v3-export") {
      const qualityAndDimensions = exportQuality(document, source, request);
      return {
        plan: {
          canonicalDocumentHash,
          acceptedAssetRevisions,
          compilerVersion: V3_COMPILER_VERSION,
          stageRegistryVersion: SEMANTIC_STAGE_REGISTRY_VERSION,
          coordinateFrameRevision: COORDINATE_FRAME_REVISION,
          capabilityTier: BASELINE_CAPABILITY_REPORT.tier,
          processVersion: DEVELOP_PROCESS_VERSION,
          sourceSignature: source.signature,
          backend: {
            kind: "v3",
            id: V3_CPU_BACKEND_ID,
            revision: V3_CPU_BACKEND_REVISION,
          },
          qualityAndDimensions,
          colorIntent: {
            kind: "export-sdr",
            format: request.format,
            bitDepth: 8,
            outputProfile: STANDARD_SRGB_PROFILE,
            transfer: "srgb",
            renderingIntent: "relative-colorimetric",
          },
        },
        requestedTaps: EXPORT_ANALYSIS_TAPS,
      };
    }
    const qualityAndDimensions = previewQuality(document, source, request);
    if (!qualityAndDimensions) return invalidResult("Preview dimensions are invalid.");
    return {
      plan: {
        canonicalDocumentHash,
        acceptedAssetRevisions,
        compilerVersion: V3_COMPILER_VERSION,
        stageRegistryVersion: SEMANTIC_STAGE_REGISTRY_VERSION,
        coordinateFrameRevision: COORDINATE_FRAME_REVISION,
        capabilityTier: BASELINE_CAPABILITY_REPORT.tier,
        processVersion: DEVELOP_PROCESS_VERSION,
        sourceSignature: source.signature,
        backend: {
          kind: "v3",
          id: V3_CPU_BACKEND_ID,
          revision: V3_CPU_BACKEND_REVISION,
        },
        qualityAndDimensions,
        colorIntent: {
          kind: "preview-sdr",
          displayProfile: STANDARD_SRGB_PROFILE,
          transfer: "srgb",
          proofView: { kind: "disabled" },
        },
      },
      requestedTaps: PREVIEW_ANALYSIS_TAPS,
    };
  } catch (error) {
    return invalidResult(
      error instanceof Error ? error.message : "V3 render request is invalid.",
    );
  }
}

export async function renderV3Runtime(
  document: DevelopDocumentV3,
  request: V3RuntimeRenderRequest,
): Promise<CpuRenderResult> {
  if (request.cancellation?.isCancelled()) return { kind: "cancelled" };
  const sourceResult = buildV3SourceRecord(
    request.entry,
    request.image,
    request.kind === "v3-export" ? "export" : "preview",
  );
  if (sourceResult.kind === "blocked") {
    return { kind: "blocked", diagnostics: [sourceResult.diagnostic] };
  }
  const prepared = await renderRequest(document, sourceResult.source, request);
  if (!("plan" in prepared)) return prepared;
  if (request.cancellation?.isCancelled()) return { kind: "cancelled" };
  const assets = await runtimeAssets(document, sourceResult.source, request.assets);
  if (request.cancellation?.isCancelled()) return { kind: "cancelled" };
  return renderV3Cpu({
    image: request.image,
    document,
    source: sourceResult.source,
    request: prepared,
    capabilities: BASELINE_CAPABILITY_REPORT,
    cancellation: request.cancellation,
    assets,
  });
}
