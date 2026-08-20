import type {
  AiModelDisclosure,
  AiModelDisclosureLink,
  AiModelId,
} from "../lib/ai/types";

export interface AiModelManifestEntry {
  readonly disclosure: AiModelDisclosure;
  readonly artifactUrl: string;
  readonly filename: string;
  readonly sha256: string;
  readonly allowedRedirectHosts: readonly string[];
}

const OFFLINE_CACHE_BEHAVIOR =
  "Darkroom downloads this model once, verifies it, and keeps it in private app storage for offline use until you remove it.";

const subjectDisclosure = Object.freeze({
  id: "subject",
  selector: "subject",
  purpose: "Select salient foreground subjects on this device.",
  bytes: 98484532,
  revision: "4a3c40c36c94093cc1e724d9ea428b8fa4b57dc7",
  input: Object.freeze({ width: 512, height: 512 }),
  sourceUrl: "https://huggingface.co/studioludens/birefnet-lite-512/tree/4a3c40c36c94093cc1e724d9ea428b8fa4b57dc7",
  license: Object.freeze({
    name: "MIT",
    url: "https://huggingface.co/studioludens/birefnet-lite-512/blob/4a3c40c36c94093cc1e724d9ea428b8fa4b57dc7/README.md",
  }),
  offlineCacheBehavior: OFFLINE_CACHE_BEHAVIOR,
}) satisfies AiModelDisclosure;

const skyRevision = "dac255883ec5faf508561a47172096bfd8708db0";
const skyDisclosure = Object.freeze({
  id: "sky",
  selector: "sky",
  purpose: "Select sky pixels on this device.",
  bytes: 99310780,
  revision: skyRevision,
  input: Object.freeze({ width: 384, height: 384 }),
  sourceUrl: `https://huggingface.co/Realcat/skywater_seg/tree/${skyRevision}`,
  license: Object.freeze({
    name: "MIT",
    url: `https://huggingface.co/Realcat/skywater_seg/blob/${skyRevision}/README.md`,
  }),
  offlineCacheBehavior: OFFLINE_CACHE_BEHAVIOR,
}) satisfies AiModelDisclosure;

const subject = Object.freeze({
  disclosure: subjectDisclosure,
  artifactUrl:
    "https://huggingface.co/studioludens/birefnet-lite-512/resolve/4a3c40c36c94093cc1e724d9ea428b8fa4b57dc7/onnx/model_fp16.onnx?download=true",
  filename: "BiRefNet-general-bb_swin_v1_tiny-epoch_232.onnx",
  sha256: "eff9216bb2f9d3f023d9c2b7196845a7485739ab1f231593633e4d2344ffc516",
  allowedRedirectHosts: Object.freeze([
    "huggingface.co",
    "us.aws.cdn.hf.co",
  ]),
}) satisfies AiModelManifestEntry;

const sky = Object.freeze({
  disclosure: skyDisclosure,
  artifactUrl:
    "https://huggingface.co/Realcat/skywater_seg/resolve/dac255883ec5faf508561a47172096bfd8708db0/skywater_segformer_b2_fp32.onnx?download=true",
  filename: "skywater_segformer_b2_fp32.onnx",
  sha256: "e4e9a6927c2d910c3243f86e392b18da715b41c03e6e6f41672f8f6b8eaa71b5",
  allowedRedirectHosts: Object.freeze([
    "huggingface.co",
    "us.aws.cdn.hf.co",
  ]),
}) satisfies AiModelManifestEntry;

const APPROVED_DISCLOSURE_URLS = new Set<string>([
  subjectDisclosure.sourceUrl,
  subjectDisclosure.license.url,
  skyDisclosure.sourceUrl,
  skyDisclosure.license.url,
]);

export function getAiModelManifestEntry(modelId: AiModelId): AiModelManifestEntry {
  switch (modelId) {
    case "subject":
      return subject;
    case "sky":
      return sky;
  }
}

export function getAiModelDisclosureUrl(
  modelId: AiModelId,
  link: AiModelDisclosureLink,
): string {
  const disclosure = getAiModelManifestEntry(modelId).disclosure;
  const url = link === "source" ? disclosure.sourceUrl : disclosure.license.url;
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new Error("The disclosed model page is invalid.");
  }
  if (
    parsed.protocol !== "https:" ||
    parsed.username !== "" ||
    parsed.password !== "" ||
    parsed.toString() !== url ||
    !APPROVED_DISCLOSURE_URLS.has(url)
  ) {
    throw new Error("The disclosed model page is not approved.");
  }
  return url;
}
