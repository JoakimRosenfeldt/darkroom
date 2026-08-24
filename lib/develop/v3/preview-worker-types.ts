import type { DevelopImage } from "@/lib/cache/develop-image-cache";
import type { PixelDimensions } from "@/lib/develop/process";
import type { CpuRenderResult } from "@/lib/develop/v3/cpu-backend";
import type { DevelopDocumentV3 } from "@/lib/develop/v3/document";
import type { LibraryEntry } from "@/lib/fs/types";

export type V3PreviewWorkerImage = Omit<DevelopImage, "blob" | "objectUrl">;

export interface V3PreviewWorkerMaskMatte {
  readonly assetId: string;
  readonly width: number;
  readonly height: number;
  readonly pixels: Uint8Array;
}

export type V3PreviewWorkerRequest =
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
      readonly previewMode: "interactive" | "settled";
      readonly maskMattes: readonly V3PreviewWorkerMaskMatte[];
    };

export type V3PreviewWorkerResponse =
  | {
      readonly kind: "result";
      readonly requestId: number;
      readonly result: CpuRenderResult;
    }
  | {
      readonly kind: "error";
      readonly requestId: number;
      readonly message: string;
    };
