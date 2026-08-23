import type {
  CapabilityOperationId,
  CapabilityRoute,
  DecoderProfileId,
  FormatBackend,
  FormatCapability,
  FormatFamily,
  FormatId,
  NikonDecoderKind,
  NikonDecoderProvenance,
  NikonRuntimeCapability,
  OperationCapability,
  SignatureRule,
} from "./types.ts";

const JPEG_SIGNATURE: SignatureRule = { offset: 0, bytes: [0xff, 0xd8] };
const PNG_SIGNATURE: SignatureRule = {
  offset: 0,
  bytes: [0x89, 0x50, 0x4e, 0x47],
};
const WEBP_SIGNATURE: readonly SignatureRule[] = [
  { offset: 0, bytes: [0x52, 0x49, 0x46, 0x46] },
  { offset: 8, bytes: [0x57, 0x45, 0x42, 0x50] },
];

const standardRoute: CapabilityRoute = {
  status: "supported",
  backend: "standard",
  reason: null,
};

const nefRoute = (backend: FormatBackend): CapabilityRoute => ({
  status: "supported",
  backend,
  fallbackBackend: "embedded-preview",
  reason: null,
});

const unavailableRoute = (reason: string): CapabilityRoute => ({
  status: "unavailable",
  backend: "none",
  reason,
});

const unsupportedReason = "No decoder or metadata backend is qualified for this format.";
const dngReason = "#89 has no qualified DNG conversion backend.";
const tiffReason = "TIFF input is not decoded; TIFF remains export-only.";

export const DEFAULT_NIKON_RUNTIME: NikonRuntimeCapability = {
  status: "unavailable",
  kind: "none",
  packageState: "unavailable",
  version: null,
  architecture: null,
  checksum: null,
  backend: null,
  pixelProtocol: null,
  reason: "No qualified packaged Nikon runtime has been probed.",
};

export const FORMAT_CAPABILITIES: readonly FormatCapability[] = [
  {
    kind: "format",
    id: "nef",
    label: "NEF",
    extensions: [".nef"],
    signatures: [],
    family: "raw",
    profileId: "nef",
    recognition: "supported",
    recognitionReason: null,
    preview: nefRoute("libraw"),
    develop: nefRoute("libraw"),
    metadata: nefRoute("libraw"),
    exportFormats: ["jpeg", "png", "webp", "avif", "tiff"],
    issueIds: [],
  },
  {
    kind: "format",
    id: "jpeg",
    label: "JPEG",
    extensions: [".jpg", ".jpeg"],
    signatures: [JPEG_SIGNATURE],
    family: "standard",
    profileId: "standard",
    recognition: "supported",
    recognitionReason: null,
    preview: standardRoute,
    develop: standardRoute,
    metadata: standardRoute,
    exportFormats: ["jpeg", "png", "webp", "avif", "tiff"],
    issueIds: [],
  },
  {
    kind: "format",
    id: "png",
    label: "PNG",
    extensions: [".png"],
    signatures: [PNG_SIGNATURE],
    family: "standard",
    profileId: "standard",
    recognition: "supported",
    recognitionReason: null,
    preview: standardRoute,
    develop: standardRoute,
    metadata: standardRoute,
    exportFormats: ["jpeg", "png", "webp", "avif", "tiff"],
    issueIds: [],
  },
  {
    kind: "format",
    id: "webp",
    label: "WebP",
    extensions: [".webp"],
    signatures: WEBP_SIGNATURE,
    family: "standard",
    profileId: "standard",
    recognition: "supported",
    recognitionReason: null,
    preview: standardRoute,
    develop: standardRoute,
    metadata: standardRoute,
    exportFormats: ["jpeg", "png", "webp", "avif", "tiff"],
    issueIds: [],
  },
  {
    kind: "format",
    id: "dng",
    label: "DNG",
    extensions: [".dng"],
    signatures: [],
    family: "raw",
    profileId: null,
    recognition: "recognized-unsupported",
    recognitionReason: dngReason,
    preview: unavailableRoute(dngReason),
    develop: unavailableRoute(dngReason),
    metadata: unavailableRoute(dngReason),
    exportFormats: [],
    issueIds: [89],
  },
  ...(["cr2", "cr3", "arw", "raf", "orf", "rw2"] as const).map(
    (id): FormatCapability => ({
      kind: "format",
      id,
      label: id.toUpperCase(),
      extensions: [`.${id}`],
      signatures: [],
      family: "raw",
      profileId: null,
      recognition: "recognized-unsupported",
      recognitionReason: unsupportedReason,
      preview: unavailableRoute(unsupportedReason),
      develop: unavailableRoute(unsupportedReason),
      metadata: unavailableRoute(unsupportedReason),
      exportFormats: [],
      issueIds: [90],
    }),
  ),
  {
    kind: "format",
    id: "heif",
    label: "HEIF/HEIC/HIF",
    extensions: [".heif", ".heic", ".hif"],
    signatures: [],
    family: "standard",
    profileId: null,
    recognition: "recognized-unsupported",
    recognitionReason: "#91 has no qualified packaged input codec.",
    preview: unavailableRoute("#91 has no qualified packaged input codec."),
    develop: unavailableRoute("#91 has no qualified packaged input codec."),
    metadata: unavailableRoute("#91 has no qualified packaged input codec."),
    exportFormats: [],
    issueIds: [91],
  },
  {
    kind: "format",
    id: "tiff",
    label: "TIFF",
    extensions: [".tif", ".tiff"],
    signatures: [],
    family: "standard",
    profileId: null,
    recognition: "recognized-unsupported",
    recognitionReason: tiffReason,
    preview: unavailableRoute(tiffReason),
    develop: unavailableRoute(tiffReason),
    metadata: unavailableRoute(tiffReason),
    exportFormats: ["tiff"],
    issueIds: [92],
  },
  {
    kind: "format",
    id: "psd",
    label: "PSD/PSB",
    extensions: [".psd", ".psb"],
    signatures: [],
    family: "other",
    profileId: null,
    recognition: "recognized-unsupported",
    recognitionReason: "#93 has no qualified Photoshop decoder.",
    preview: unavailableRoute("#93 has no qualified Photoshop decoder."),
    develop: unavailableRoute("#93 has no qualified Photoshop decoder."),
    metadata: unavailableRoute("#93 has no qualified Photoshop decoder."),
    exportFormats: [],
    issueIds: [93],
  },
  {
    kind: "format",
    id: "jxl",
    label: "JPEG XL",
    extensions: [".jxl"],
    signatures: [],
    family: "standard",
    profileId: null,
    recognition: "recognized-unsupported",
    recognitionReason: "#93 has no qualified JPEG XL decoder.",
    preview: unavailableRoute("#93 has no qualified JPEG XL decoder."),
    develop: unavailableRoute("#93 has no qualified JPEG XL decoder."),
    metadata: unavailableRoute("#93 has no qualified JPEG XL decoder."),
    exportFormats: [],
    issueIds: [93],
  },
  {
    kind: "format",
    id: "video",
    label: "Video",
    extensions: [".mov", ".mp4", ".m4v", ".avi", ".mkv"],
    signatures: [],
    family: "other",
    profileId: null,
    recognition: "recognized-unsupported",
    recognitionReason: "#95-#98 video support is not implemented.",
    preview: unavailableRoute("#95-#98 video support is not implemented."),
    develop: unavailableRoute("#95-#98 video support is not implemented."),
    metadata: unavailableRoute("#95-#98 video support is not implemented."),
    exportFormats: [],
    issueIds: [95, 96, 97, 98],
  },
];

export const OPERATION_CAPABILITIES: readonly OperationCapability[] = [
  {
    kind: "operation",
    id: "copy-as-dng",
    label: "Copy as DNG",
    status: "unavailable",
    reason: dngReason,
    issueId: 89,
  },
  {
    kind: "operation",
    id: "original-raw-export",
    label: "Original/RAW export",
    status: "unavailable",
    reason: "#94 original-byte export is not implemented.",
    issueId: 94,
  },
  {
    kind: "operation",
    id: "video-import",
    label: "Video import",
    status: "unavailable",
    reason: "#95 video import is not implemented.",
    issueId: 95,
  },
  {
    kind: "operation",
    id: "video-playback",
    label: "Video playback",
    status: "unavailable",
    reason: "#96 video playback is not implemented.",
    issueId: 96,
  },
  {
    kind: "operation",
    id: "video-transforms",
    label: "Video transforms and color",
    status: "unavailable",
    reason: "#97 video transforms, color, and presets are not implemented.",
    issueId: 97,
  },
  {
    kind: "operation",
    id: "video-export",
    label: "Video export",
    status: "unavailable",
    reason: "#98 video export is not implemented.",
    issueId: 98,
  },
];

export const SUPPORTED_INPUT_EXTENSIONS: readonly string[] = FORMAT_CAPABILITIES
  .filter((format) => format.recognition === "supported")
  .flatMap((format) => format.extensions);

export function getFormatCapability(id: string): FormatCapability | null {
  return FORMAT_CAPABILITIES.find((format) => format.id === id) ?? null;
}

export function getFormatCapabilityForFileName(name: string): FormatCapability | null {
  const lower = name.toLowerCase();
  return FORMAT_CAPABILITIES.find((format) =>
    format.extensions.some((extension) => lower.endsWith(extension)),
  ) ?? null;
}

export function getFormatCapabilityForProfileId(
  profileId: string | null,
): FormatCapability | null {
  if (profileId === "nef") {
    return getFormatCapability("nef");
  }
  return null;
}

export function getFormatFamilyForEntry(
  name: string,
  profileId: string | null,
): FormatFamily | null {
  const format = getFormatCapabilityForFileName(name);
  if (format) {
    return format.family;
  }
  if (profileId === "standard") {
    return "standard";
  }
  if (profileId === "nef") {
    return "raw";
  }
  return null;
}

export function getFormatLabelForEntry(
  name: string,
  profileId: string | null,
): string {
  const format = getFormatCapabilityForFileName(name);
  if (format) {
    return format.label;
  }
  if (profileId === "standard") {
    return "Standard image";
  }
  return getFormatCapabilityForProfileId(profileId)?.label ?? "Unknown";
}

export function isSupportedInputFileName(name: string): boolean {
  return getFormatCapabilityForFileName(name)?.recognition === "supported";
}

export function getFormatExtensionsForProfile(
  profileId: DecoderProfileId,
): readonly string[] {
  return FORMAT_CAPABILITIES
    .filter((format) => format.profileId === profileId && format.recognition === "supported")
    .flatMap((format) => format.extensions);
}

export function getDecoderProfileIdForFileName(
  name: string,
): DecoderProfileId | null {
  return getFormatCapabilityForFileName(name)?.profileId ?? null;
}

function matchesSignature(input: Uint8Array, signature: SignatureRule): boolean {
  return signature.bytes.every((byte, index) => input[signature.offset + index] === byte);
}

export function matchesFormatSignature(
  input: Uint8Array,
  formatId: FormatId,
): boolean {
  const format = getFormatCapability(formatId);
  return Boolean(format && format.signatures.length > 0 && format.signatures.every((signature) => matchesSignature(input, signature)));
}

export function recognizeFormatFromBytes(input: Uint8Array): FormatCapability | null {
  return FORMAT_CAPABILITIES.find((format) =>
    format.signatures.length > 0 && format.signatures.every((signature) => matchesSignature(input, signature)),
  ) ?? null;
}

export function getNikonDecoderProvenance(
  kind: NikonDecoderKind | undefined,
): NikonDecoderProvenance {
  return kind === "native" ? "nikon-sdk" : "nikon-test-only";
}

export function isNikonDecoderProvenance(
  value: unknown,
): value is NikonDecoderProvenance {
  return value === "nikon-sdk" || value === "nikon-test-only";
}

export function getDecoderProvenanceLabel(value: unknown): string | null {
  if (value === "nikon-sdk") return "Nikon native decoder";
  if (value === "nikon-test-only") return "Nikon test decoder";
  if (value === "libraw") return "LibRaw";
  if (value === "embedded") return "Embedded preview";
  if (value === "standard") return "Standard image decoder";
  return null;
}

export function isSupportedFormatId(id: string): id is FormatId {
  return getFormatCapability(id) !== null;
}

export function isCapabilityOperationId(id: string): id is CapabilityOperationId {
  return OPERATION_CAPABILITIES.some((operation) => operation.id === id);
}
