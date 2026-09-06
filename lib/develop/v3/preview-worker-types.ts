import type { DevelopImage } from "@/lib/cache/develop-image-cache";
import type { PixelDimensions } from "@/lib/develop/process";
import type { CpuRenderResult } from "@/lib/develop/v3/cpu-backend";
import type { DevelopDocumentV3 } from "@/lib/develop/v3/document";
import type { V3GpuPreviewRenderResult } from "@/lib/develop/v3/gpu-backend";
import type { V3PreviewRenderMode } from "@/lib/develop/v3/runtime";
import type { LibraryEntry } from "@/lib/fs/types";
import type { ExportSizeOptions } from "@/lib/export/types";
import type { RenderRegion } from "@/lib/develop/v3/cpu-backend";

export type V3PreviewWorkerImage = Omit<DevelopImage, "blob" | "objectUrl">;

export interface V3PreviewWorkerMaskMatte {
  readonly assetId: string;
  readonly width: number;
  readonly height: number;
  readonly pixels: Uint8Array;
}

export type V3PreviewBackend = "gpu" | "cpu";
export type V3PreviewRenderOutput = CpuRenderResult | V3GpuPreviewRenderResult;

export interface V3PreviewWorkerRenderResult {
  readonly backend: V3PreviewBackend;
  readonly result: V3PreviewRenderOutput;
}

export type V3PreviewWorkerRequest =
  | {
      readonly kind: "export";
      readonly requestId: number;
      readonly document: DevelopDocumentV3;
      readonly size: ExportSizeOptions;
      readonly region?: RenderRegion;
      readonly maskMattes: readonly V3PreviewWorkerMaskMatte[];
    }
  | {
      readonly kind: "initialize";
      readonly entry: LibraryEntry;
      readonly image: V3PreviewWorkerImage;
    }
  | {
      readonly kind: "render";
      readonly requestId: number;
      readonly document: DevelopDocumentV3;
      readonly viewportDimensions: PixelDimensions;
      readonly devicePixelRatio: number;
      readonly previewMode: V3PreviewRenderMode;
      readonly includeAnalysis: boolean;
  readonly includePointColor?: boolean;
      readonly maskMattes: readonly V3PreviewWorkerMaskMatte[];
    };

export type V3PreviewWorkerResponse =
  | {
      readonly kind: "result";
      readonly requestId: number;
      readonly backend: V3PreviewBackend;
      readonly result: V3PreviewRenderOutput;
    }
  | {
      readonly kind: "error";
      readonly requestId: number;
      readonly message: string;
    };
