import { canonicalDevelopDocument, parseDevelopDocument } from "../document";
import { COORDINATE_FRAME_REVISION } from "../process";
import { parseSha256Digest } from "../render-contract";
import type {
  DevelopDocument,
  MaskComponent,
  MaskRasterAsset,
} from "../types";
import type { DevelopAssetRef } from "./assets";
import {
  V2_TO_V3_MAPPING_REVISION,
  createDefaultV3DevelopDocument,
  type DevelopDocumentV3,
} from "./document";
import type { Homography } from "./geometry";

export interface RequiredV2AssetCopy {
  readonly kind: "required-v2-inline-copy";
  readonly sourceAssetId: string;
  readonly expectedReference: DevelopAssetRef;
  readonly byteLength: number;
  readonly mimeType: "image/png";
  readonly width: number;
  readonly height: number;
}

export interface V3MigrationComparisonRequest {
  readonly kind: "same-quality-comparison-required";
  readonly baselineVersion: 2;
  readonly candidateVersion: 3;
  readonly quality: "fit";
  readonly compareGroups: readonly [
    "tone-and-color",
    "geometry",
    "masks",
    "detail-and-post-crop",
  ];
}

export interface V3MigrationCandidate {
  readonly kind: "candidate";
  readonly document: DevelopDocumentV3;
  readonly requiredAssetCopies: readonly RequiredV2AssetCopy[];
  readonly comparison: V3MigrationComparisonRequest;
  readonly persistence: "requires-explicit-acceptance";
  readonly acceptanceCommand: "upgrade-and-first-v3-edit";
}

function manualPerspectiveMatrix(horizontal: number, vertical: number): Homography {
  const horizontalScale = horizontal * 0.002;
  const verticalScale = vertical * 0.002;
  return [
    1,
    horizontalScale,
    -horizontalScale * 0.5,
    verticalScale,
    1,
    -verticalScale * 0.5,
    0,
    0,
    1,
  ];
}

function assetReference(asset: MaskRasterAsset): DevelopAssetRef {
  const digest = parseSha256Digest(asset.sha256);
  return {
    assetId: digest,
    kind: "mask-matte",
    sha256: digest,
    producerRevision: "frozen-v2-inline-mask-1",
    coordinateFrameRevision: COORDINATE_FRAME_REVISION,
    colorStageId: "local-adjustments",
  };
}

function requiredAssetCopies(
  document: DevelopDocument,
): RequiredV2AssetCopy[] {
  return Object.values(document.maskAssets)
    .sort((left, right) => left.id.localeCompare(right.id))
    .map((asset) => ({
      kind: "required-v2-inline-copy",
      sourceAssetId: asset.id,
      expectedReference: assetReference(asset),
      byteLength: asset.byteLength,
      mimeType: asset.mimeType,
      width: asset.width,
      height: asset.height,
    }));
}

function migratedMasks(
  document: DevelopDocument,
  copies: readonly RequiredV2AssetCopy[],
): DevelopDocument["settings"]["masking"]["masks"] {
  const copiedAssetIds = new Map(
    copies.map((copy) => [copy.sourceAssetId, copy.expectedReference.assetId]),
  );
  const migrateComponent = (component: MaskComponent): MaskComponent =>
    component.kind === "ai"
      ? {
          ...structuredClone(component),
          assetId: copiedAssetIds.get(component.assetId) ?? component.assetId,
        }
      : structuredClone(component);
  return document.settings.masking.masks.map((mask) => {
    const [first, ...rest] = mask.components;
    return {
      ...structuredClone(mask),
      components: [migrateComponent(first), ...rest.map(migrateComponent)],
    };
  });
}

export function createV3MigrationCandidate(
  value: DevelopDocument,
): V3MigrationCandidate {
  const legacyV2 = canonicalDevelopDocument(parseDevelopDocument(value));
  const defaults = createDefaultV3DevelopDocument();
  const basic = legacyV2.settings.basic;
  const crop = legacyV2.settings.crop;
  const effects = legacyV2.settings.effects;
  const copies = requiredAssetCopies(legacyV2);
  const maskAssetRefs = [...new Map(
    copies.map((copy) => [copy.expectedReference.assetId, copy.expectedReference]),
  ).values()];
  const document: DevelopDocumentV3 = {
    ...defaults,
    tone: {
      basic: {
        exposure: basic.exposure,
        contrast: basic.contrast,
        highlights: basic.highlights,
        shadows: basic.shadows,
        whites: basic.whites,
        blacks: basic.blacks,
      },
      curves: structuredClone(legacyV2.settings.curve),
    },
    color: {
      ...defaults.color,
      whiteBalance: {
        mode: "legacy-custom",
        adjustment: {
          temperature: basic.temperature,
          tint: basic.tint,
        },
        resolved: {
          temperatureKelvin: 5_500 + basic.temperature,
          tint: basic.tint,
          gains: [1, 1, 1],
        },
      },
      global: {
        vibrance: basic.vibrance,
        saturation: basic.saturation,
      },
      mixer: structuredClone(legacyV2.settings.mixer),
    },
    optics: {
      ...defaults.optics,
      manualDistortion: crop.distortion,
    },
    geometry: {
      ...defaults.geometry,
      orientation: {
        ...defaults.geometry.orientation,
        fineAngleDegrees: crop.angle,
      },
      manualPerspective: {
        horizontal: crop.perspectiveX,
        vertical: crop.perspectiveY,
        matrix: manualPerspectiveMatrix(crop.perspectiveX, crop.perspectiveY),
      },
      upright: {
        ...defaults.geometry.upright,
        mode: "manual",
      },
      constrainCrop: false,
      crop: {
        enabled: crop.enabled,
        x: crop.x,
        y: crop.y,
        width: crop.width,
        height: crop.height,
        aspectPreset: crop.aspectPreset,
        customAspectWidth: crop.customAspectWidth,
        customAspectHeight: crop.customAspectHeight,
      },
    },
    local: {
      geometryFrame: "legacy-oriented-v2",
      masks: migratedMasks(legacyV2, copies),
      maskAssetRefs,
    },
    detail: {
      noiseReduction: {
        noiseReduction: effects.noiseReduction,
        noiseDetail: effects.noiseDetail,
        noiseContrast: effects.noiseContrast,
        colorNoiseReduction: effects.colorNoiseReduction,
        colorNoiseDetail: effects.colorNoiseDetail,
        colorNoiseSmoothness: effects.colorNoiseSmoothness,
      },
      sharpening: {
        sharpening: effects.sharpening,
        sharpenRadius: effects.sharpenRadius,
        sharpenDetail: effects.sharpenDetail,
        sharpenMasking: effects.sharpenMasking,
      },
    },
    effects: {
      postCrop: {
        vignette: effects.vignette,
        vignetteMidpoint: effects.vignetteMidpoint,
        vignetteRoundness: effects.vignetteRoundness,
        vignetteFeather: effects.vignetteFeather,
        vignetteHighlights: effects.vignetteHighlights,
        grain: effects.grain,
        grainSize: effects.grainSize,
        grainRoughness: effects.grainRoughness,
      },
    },
    compatibility: {
      mappingRevision: V2_TO_V3_MAPPING_REVISION,
      legacyV2: structuredClone(legacyV2),
      externalFieldIndex: [],
      quarantine: [],
    },
  };
  return {
    kind: "candidate",
    document,
    requiredAssetCopies: copies,
    comparison: {
      kind: "same-quality-comparison-required",
      baselineVersion: 2,
      candidateVersion: 3,
      quality: "fit",
      compareGroups: [
        "tone-and-color",
        "geometry",
        "masks",
        "detail-and-post-crop",
      ],
    },
    persistence: "requires-explicit-acceptance",
    acceptanceCommand: "upgrade-and-first-v3-edit",
  };
}
