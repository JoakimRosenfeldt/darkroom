import type { DevelopDocument, MaskComponent } from "./types";

export const LIGHTROOM_MASK_ADAPTER_VERSION = 1;

export interface LightroomMaskPreflight {
  readonly adapterVersion: typeof LIGHTROOM_MASK_ADAPTER_VERSION;
  readonly status: "compatible" | "blocked";
  readonly maskCount: number;
  readonly componentCount: number;
  readonly unsupported: readonly {
    readonly maskId: string;
    readonly componentId: string;
    readonly reason: string;
  }[];
}

function componentBlockReason(component: MaskComponent): string | null {
  if (component.kind === "ai") {
    return "AI raster masks require an externally verified Lightroom encoding.";
  }
  if (component.kind === "brush" && component.strokes.some((stroke) => stroke.points.length < 2)) {
    return "Single-point brush strokes do not have a verified Lightroom representation.";
  }
  return null;
}

export function lightroomMaskPreflight(document: DevelopDocument): LightroomMaskPreflight {
  const unsupported = document.settings.masking.masks.flatMap((mask) =>
    mask.components.flatMap((component) => {
      const reason = componentBlockReason(component);
      return reason === null ? [] : [{ maskId: mask.id, componentId: component.id, reason }];
    }),
  );
  return {
    adapterVersion: LIGHTROOM_MASK_ADAPTER_VERSION,
    status: unsupported.length === 0 ? "compatible" : "blocked",
    maskCount: document.settings.masking.masks.length,
    componentCount: document.settings.masking.masks.reduce((count, mask) => count + mask.components.length, 0),
    unsupported,
  };
}

export function serializeLightroomMaskInterchangeManifest(document: DevelopDocument): string {
  const preflight = lightroomMaskPreflight(document);
  return JSON.stringify({
    ...preflight,
    verification: "external-lightroom-roundtrip-required",
    stableIds: document.settings.masking.masks.map((mask) => ({
      maskId: mask.id,
      componentIds: mask.components.map((component) => component.id),
    })),
  });
}
