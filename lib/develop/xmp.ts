import type { EntryMetadata } from "@/lib/catalog/types";
import { COLOR_LABELS } from "@/lib/catalog/types";
import {
  MAX_DEVELOP_PAYLOAD_BYTES,
  canonicalDevelopDocument,
  parseDevelopDocument,
} from "@/lib/develop/document";
import {
  DEVELOP_PLUGINS,
  createDevelopSettings,
  isDefaultDevelopSettings,
} from "@/lib/develop/registry";
import type { DevelopDocument, DevelopSettings, XmpProps, XmpValue } from "@/lib/develop/types";

const RDF_NS = "http://www.w3.org/1999/02/22-rdf-syntax-ns#";
const XMLNS_NS = "http://www.w3.org/2000/xmlns/";
const CRS_NS = "http://ns.adobe.com/camera-raw-settings/1.0/";
const XMP_NS = "http://ns.adobe.com/xap/1.0/";
export const DARKROOM_NS = "http://darkroom.app/ns/1.0/";
const MASKING_LOCAL_NAME = "MaskingData";

export interface ParsedDevelopXmp {
  document: DevelopDocument;
  rating?: EntryMetadata["rating"];
  colorLabel: EntryMetadata["colorLabel"] | undefined;
  source: "xmp-v1" | "xmp-v2";
}

function collectDevelopProps(settings: DevelopSettings): XmpProps {
  const props: XmpProps = {};
  for (const plugin of DEVELOP_PLUGINS) {
    Object.assign(props, plugin.xmp.write(settings[plugin.id] as never));
  }
  return props;
}

function propNamespace(key: string): string {
  return key.startsWith("xmp:") ? XMP_NS : CRS_NS;
}

function propLocalName(key: string): string {
  return key.slice(key.indexOf(":") + 1);
}

function setProp(doc: XMLDocument, description: Element, key: string, value: XmpValue): void {
  const namespace = propNamespace(key);
  const localName = propLocalName(key);
  description.removeAttributeNS(namespace, localName);
  for (const child of Array.from(description.children)) {
    if (child.namespaceURI === namespace && child.localName === localName) child.remove();
  }
  if (typeof value === "string") {
    description.setAttributeNS(namespace, key, value);
    return;
  }
  const property = doc.createElementNS(namespace, key);
  const sequence = doc.createElementNS(RDF_NS, "rdf:Seq");
  for (const item of value) {
    const entry = doc.createElementNS(RDF_NS, "rdf:li");
    entry.textContent = item;
    sequence.append(entry);
  }
  property.append(sequence);
  description.append(property);
}

function createXmpDocument(): XMLDocument {
  return new DOMParser().parseFromString(
    `<x:xmpmeta xmlns:x="adobe:ns:meta/"><rdf:RDF xmlns:rdf="${RDF_NS}"><rdf:Description xmlns:crs="${CRS_NS}" xmlns:xmp="${XMP_NS}" xmlns:darkroom="${DARKROOM_NS}"/></rdf:RDF></x:xmpmeta>`,
    "application/xml",
  );
}

function descriptionFor(doc: XMLDocument): Element {
  const description = doc.getElementsByTagNameNS(RDF_NS, "Description")[0];
  if (!description) throw new Error("Could not find an XMP description.");
  return description;
}

function parseXmpDocument(xml: string): XMLDocument {
  if (new TextEncoder().encode(xml).byteLength > MAX_DEVELOP_PAYLOAD_BYTES) {
    throw new Error("XMP sidecar exceeds the 16 MiB size limit.");
  }
  const doc = new DOMParser().parseFromString(xml, "application/xml");
  if (doc.querySelector("parsererror")) throw new Error("Could not parse XMP sidecar.");
  descriptionFor(doc);
  return doc;
}

function utf8ToBase64(value: string): string {
  const bytes = new TextEncoder().encode(value);
  let binary = "";
  const chunkSize = 0x8000;
  for (let offset = 0; offset < bytes.length; offset += chunkSize) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + chunkSize));
  }
  return btoa(binary);
}

function base64ToUtf8(value: string): string {
  if (value.length === 0 || value.length % 4 !== 0 || !/^[A-Za-z0-9+/]*={0,2}$/.test(value)) {
    throw new Error("darkroom:MaskingData is not valid Base64.");
  }
  const binary = atob(value);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
  return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
}

function maskingPayload(document: DevelopDocument): string {
  const canonical = canonicalDevelopDocument(document);
  return utf8ToBase64(JSON.stringify({
    version: 2,
    masking: canonical.settings.masking,
    maskAssets: canonical.maskAssets,
  }));
}

export function serializeDevelopXmp(
  document: DevelopDocument,
  metadata: Pick<EntryMetadata, "rating" | "colorLabel">,
  existingContents: string | null,
): string | null {
  if (
    existingContents === null &&
    isDefaultDevelopSettings(document.settings) &&
    metadata.rating === 0 &&
    metadata.colorLabel === null
  ) return null;

  const doc = existingContents ? parseXmpDocument(existingContents) : createXmpDocument();
  const description = descriptionFor(doc);
  description.setAttributeNS(XMLNS_NS, "xmlns:crs", CRS_NS);
  description.setAttributeNS(XMLNS_NS, "xmlns:xmp", XMP_NS);
  description.setAttributeNS(XMLNS_NS, "xmlns:darkroom", DARKROOM_NS);
  for (const [key, value] of Object.entries(collectDevelopProps(document.settings))) {
    setProp(doc, description, key, value);
  }
  description.setAttributeNS(XMP_NS, "xmp:Rating", String(metadata.rating));
  if (metadata.colorLabel) description.setAttributeNS(XMP_NS, "xmp:Label", metadata.colorLabel);
  else {
    description.removeAttributeNS(XMP_NS, "Label");
    description.removeAttribute("xmp:Label");
  }
  description.setAttributeNS(DARKROOM_NS, "darkroom:MaskingData", maskingPayload(document));
  const serialized = new XMLSerializer().serializeToString(doc);
  if (new TextEncoder().encode(serialized).byteLength > MAX_DEVELOP_PAYLOAD_BYTES) {
    throw new Error("XMP sidecar exceeds the 16 MiB size limit.");
  }
  return serialized;
}

function extractProps(description: Element): XmpProps {
  const props = Array.from(description.attributes).reduce<XmpProps>((result, attribute) => {
    if (attribute.namespaceURI === CRS_NS) result[`crs:${attribute.localName}`] = attribute.value;
    else if (attribute.namespaceURI === XMP_NS) result[`xmp:${attribute.localName}`] = attribute.value;
    return result;
  }, {});
  for (const child of Array.from(description.children)) {
    const prefix = child.namespaceURI === CRS_NS ? "crs" : child.namespaceURI === XMP_NS ? "xmp" : null;
    if (!prefix) continue;
    const items = Array.from(child.getElementsByTagNameNS(RDF_NS, "li"));
    if (items.length) props[`${prefix}:${child.localName}`] = items.map((item) => item.textContent?.trim() ?? "");
  }
  return props;
}

function parseRating(value: string | undefined): EntryMetadata["rating"] | undefined {
  switch (value) {
    case "0": return 0;
    case "1": return 1;
    case "2": return 2;
    case "3": return 3;
    case "4": return 4;
    case "5": return 5;
    default: return undefined;
  }
}

function parseColorLabel(value: string | undefined): EntryMetadata["colorLabel"] | undefined {
  if (value === undefined) return null;
  const normalized = value.toLowerCase();
  return COLOR_LABELS.find((label) => label === normalized);
}

function parseMaskingDocument(description: Element, settings: DevelopSettings): {
  document: DevelopDocument;
  source: "xmp-v1" | "xmp-v2";
} {
  const encoded = description.getAttributeNS(DARKROOM_NS, MASKING_LOCAL_NAME);
  if (!encoded) return { document: { version: 2, settings, maskAssets: {} }, source: "xmp-v1" };
  let payload: unknown;
  try {
    payload = JSON.parse(base64ToUtf8(encoded));
  } catch (error) {
    throw new Error("Could not parse darkroom:MaskingData.", { cause: error });
  }
  if (typeof payload !== "object" || payload === null || Array.isArray(payload)) {
    throw new Error("darkroom:MaskingData must contain an object.");
  }
  const payloadRecord = payload satisfies object;
  if (!("version" in payloadRecord) || !("masking" in payloadRecord) || !("maskAssets" in payloadRecord)) {
    throw new Error("darkroom:MaskingData is incomplete.");
  }
  return {
    document: parseDevelopDocument({
      version: payloadRecord.version,
      settings: { ...settings, masking: payloadRecord.masking },
      maskAssets: payloadRecord.maskAssets,
    }),
    source: "xmp-v2",
  };
}

export function parseDevelopXmp(xml: string): ParsedDevelopXmp {
  const doc = parseXmpDocument(xml);
  const description = descriptionFor(doc);
  const props = extractProps(description);
  const patch: Partial<DevelopSettings> = {};
  for (const plugin of DEVELOP_PLUGINS) patch[plugin.id] = plugin.xmp.read(props) as never;
  const settings = createDevelopSettings(patch);
  return {
    ...parseMaskingDocument(description, settings),
    rating: parseRating(typeof props["xmp:Rating"] === "string" ? props["xmp:Rating"] : undefined),
    colorLabel: parseColorLabel(typeof props["xmp:Label"] === "string" ? props["xmp:Label"] : undefined),
  };
}
