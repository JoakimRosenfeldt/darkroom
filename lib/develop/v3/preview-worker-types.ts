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
  readonly kind?: "mask-matte" | "depth-map";
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

// Top-level document groups that may be sent as a patch once a destination
// holds a resident document. Any other top-level key forces a full sync.
export const V3_DOCUMENT_SYNC_GROUPS = [
  "tone",
  "color",
  "optics",
  "geometry",
  "local",
  "cleanup",
  "presence",
  "detail",
  "effects",
  "lensBlur",
  "hdr",
  "appliedPreset",
  "compatibility",
] as const;

export type V3DocumentSyncGroup = (typeof V3_DOCUMENT_SYNC_GROUPS)[number];
export type V3DocumentSyncGroups = Partial<Pick<DevelopDocumentV3, V3DocumentSyncGroup>>;

export type V3DocumentSync =
  | { readonly kind: "full"; readonly document: DevelopDocumentV3 }
  | { readonly kind: "patch"; readonly groups: V3DocumentSyncGroups };

const SYNC_GROUP_KEYS: ReadonlySet<string> = new Set(V3_DOCUMENT_SYNC_GROUPS);
const SYNC_IDENTITY_KEYS: ReadonlySet<string> = new Set(["version", "process", "schemaRevision"]);

// Patch is only valid against `previous` at the same destination; callers
// track the last document dispatched per destination.
export function computeV3DocumentSync(
  previous: DevelopDocumentV3 | null,
  next: DevelopDocumentV3,
): V3DocumentSync {
  if (
    !previous ||
    previous.version !== next.version ||
    previous.process !== next.process ||
    previous.schemaRevision !== next.schemaRevision
  ) {
    return { kind: "full", document: next };
  }
  const previousRecord = previous as unknown as Record<string, unknown>;
  const nextRecord = next as unknown as Record<string, unknown>;
  for (const key of new Set([...Object.keys(previousRecord), ...Object.keys(nextRecord)])) {
    if (SYNC_GROUP_KEYS.has(key) || SYNC_IDENTITY_KEYS.has(key)) continue;
    if (previousRecord[key] !== nextRecord[key]) return { kind: "full", document: next };
  }
  const groups: Record<string, unknown> = {};
  for (const group of V3_DOCUMENT_SYNC_GROUPS) {
    if (previousRecord[group] !== nextRecord[group]) groups[group] = nextRecord[group];
  }
  return { kind: "patch", groups: groups as V3DocumentSyncGroups };
}

// Returns null for a patch with no resident document (protocol error).
// A patch yields a new object so in-flight renders keep their reference.
export function applyV3DocumentSync(
  resident: DevelopDocumentV3 | null,
  sync: V3DocumentSync,
): DevelopDocumentV3 | null {
  if (sync.kind === "full") return sync.document;
  return resident ? { ...resident, ...sync.groups } : null;
}

export type V3PreviewWorkerRequest =
  | {
      readonly kind: "export";
      readonly requestId: number;
      readonly documentSync: V3DocumentSync;
      readonly size: ExportSizeOptions;
      readonly region?: RenderRegion;
      readonly maskMattes?: readonly V3PreviewWorkerMaskMatte[];
    }
  | {
      readonly kind: "initialize";
      readonly entry: LibraryEntry;
      readonly image: V3PreviewWorkerImage;
      readonly nativeGpu?: boolean;
    }
  | {
      readonly kind: "render";
      readonly requestId: number;
      readonly documentSync: V3DocumentSync;
      readonly viewportDimensions: PixelDimensions;
      readonly devicePixelRatio: number;
      readonly previewMode: V3PreviewRenderMode;
      readonly includeAnalysis: boolean;
      readonly includeHistogram?: boolean;
      readonly includePointColor?: boolean;
      readonly maskMattes?: readonly V3PreviewWorkerMaskMatte[];
    };

export type V3PreviewWorkerResponse =
  | { readonly kind: "ready" }
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

export type NativeGpuWorkerRequest = { kind: "native-gpu"; id: number; bytes: Uint8Array<ArrayBuffer> };
export type NativeGpuWorkerResponse =
  | { kind: "native-gpu-result"; id: number; bytes: ArrayBuffer }
  | { kind: "native-gpu-error"; id: number; message: string };
