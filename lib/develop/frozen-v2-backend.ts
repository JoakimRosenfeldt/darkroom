import type { DevelopImage } from "@/lib/cache/develop-image-cache";
import {
  DevelopRenderer,
  renderDevelopExport,
  type MaskOverlayMode,
  type RenderDiagnostic,
  type RenderOptions,
  type RenderPreparation,
} from "@/lib/develop/renderer";
import type { SourceRenderMode } from "@/lib/develop/source-transform";
import type { DevelopDocument, SourceSignature } from "@/lib/develop/types";
import type {
  ExportSizeOptions,
  RawExportRenderResult,
} from "@/lib/export/types";

export type { MaskOverlayMode, RenderDiagnostic, RenderPreparation };

export class FrozenV2Renderer {
  readonly #renderer: DevelopRenderer;

  constructor(canvas: HTMLCanvasElement, preserveDrawingBuffer = false) {
    this.#renderer = new DevelopRenderer(canvas, preserveDrawingBuffer);
  }

  setImage(image: DevelopImage): Promise<void> {
    return this.#renderer.setImage(image);
  }

  resize(width: number, height: number): void {
    this.#renderer.resize(width, height);
  }

  dispose(): void {
    this.#renderer.dispose();
  }

  renderer(): DevelopRenderer {
    return this.#renderer;
  }
}

export interface FrozenV2PrepareRequest {
  readonly kind: "prepare";
  readonly renderer: FrozenV2Renderer;
  readonly sourceSignature: SourceSignature;
  readonly policy?: "preview" | "export";
  readonly documentOverride?: DevelopDocument;
}

export interface FrozenV2PreviewRequest {
  readonly kind: "preview";
  readonly renderer: FrozenV2Renderer;
  readonly sourceSignature: SourceSignature;
  readonly showOriginal: boolean;
  readonly mode?: SourceRenderMode;
  readonly options?: RenderOptions;
  readonly documentOverride?: DevelopDocument;
}

export interface FrozenV2ExportRequest {
  readonly kind: "export";
  readonly image: DevelopImage;
  readonly sourceSignature: SourceSignature;
  readonly size?: ExportSizeOptions;
  readonly renderer?: FrozenV2Renderer;
}

export type FrozenV2RenderRequest =
  | FrozenV2PrepareRequest
  | FrozenV2PreviewRequest
  | FrozenV2ExportRequest;

export type FrozenV2RenderResult = RenderPreparation | RawExportRenderResult;

export function renderFrozenV2(
  document: DevelopDocument,
  request: FrozenV2PrepareRequest,
): Promise<RenderPreparation>;
export function renderFrozenV2(
  document: DevelopDocument,
  request: FrozenV2PreviewRequest,
): Promise<RenderPreparation>;
export function renderFrozenV2(
  document: DevelopDocument,
  request: FrozenV2ExportRequest,
): Promise<RawExportRenderResult>;
export function renderFrozenV2(
  document: DevelopDocument,
  request: FrozenV2RenderRequest,
): Promise<FrozenV2RenderResult> {
  switch (request.kind) {
    case "prepare":
      return request.renderer.renderer().prepare(
        request.documentOverride ?? document,
        request.sourceSignature,
        request.policy,
      );
    case "preview":
      return request.renderer.renderer().render(
        request.documentOverride ?? document,
        request.sourceSignature,
        request.showOriginal,
        request.mode,
        request.options,
      );
    case "export":
      return renderDevelopExport(
        request.image,
        document,
        request.sourceSignature,
        request.size,
        request.renderer?.renderer(),
      );
    default: {
      const exhaustive: never = request;
      return exhaustive;
    }
  }
}
