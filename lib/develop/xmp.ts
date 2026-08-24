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
import type {
  MetadataEditableField,
  MetadataFieldConflict,
  MetadataOverrides,
} from "@/lib/metadata/types";
import { parseMetadataOverrides } from "@/lib/metadata/types";
import { serializeLightroomMaskInterchangeManifest } from "@/lib/develop/lightroom-mask-adapter";

const RDF_NS = "http://www.w3.org/1999/02/22-rdf-syntax-ns#";
const XMLNS_NS = "http://www.w3.org/2000/xmlns/";
const CRS_NS = "http://ns.adobe.com/camera-raw-settings/1.0/";
const XMP_NS = "http://ns.adobe.com/xap/1.0/";
const DC_NS = "http://purl.org/dc/elements/1.1/";
const LR_NS = "http://ns.adobe.com/lightroom/1.0/";
const EXIF_NS = "http://ns.adobe.com/exif/1.0/";
const PHOTOSHOP_NS = "http://ns.adobe.com/photoshop/1.0/";
export const DARKROOM_NS = "http://darkroom.app/ns/1.0/";
const MASKING_LOCAL_NAME = "MaskingData";
const LIGHTROOM_MASK_MANIFEST_LOCAL_NAME = "LightroomMaskInterchange";

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

function setArrayProperty(
  doc: XMLDocument,
  description: Element,
  namespace: string,
  qualifiedName: string,
  values: readonly string[],
): void {
  const localName = qualifiedName.slice(qualifiedName.indexOf(":") + 1);
  for (const child of Array.from(description.children)) {
    if (child.namespaceURI === namespace && child.localName === localName) child.remove();
  }
  const property = doc.createElementNS(namespace, qualifiedName);
  const bag = doc.createElementNS(RDF_NS, "rdf:Bag");
  for (const value of [...new Set(values.map((item) => item.trim()).filter(Boolean))]) {
    const item = doc.createElementNS(RDF_NS, "rdf:li");
    item.textContent = value;
    bag.append(item);
  }
  property.append(bag);
  description.append(property);
}

function arrayProperty(description: Element, namespace: string, localName: string): string[] {
  const property = Array.from(description.children).find(
    (child) => child.namespaceURI === namespace && child.localName === localName,
  );
  if (!property) return [];
  const container = Array.from(property.children).find((child) => child.namespaceURI === RDF_NS);
  if (!container || container.localName !== "Bag") {
    throw new Error(`${property.tagName} uses an unsupported XMP array container.`);
  }
  const items = Array.from(container.children);
  if (items.some((item) => item.namespaceURI !== RDF_NS || item.localName !== "li" || item.children.length > 0)) {
    throw new Error(`${property.tagName} contains unsupported structured keyword values.`);
  }
  return [...new Set(items
    .map((item) => item.textContent?.trim() ?? "")
    .filter(Boolean))];
}

export interface ParsedKeywordXmp {
  readonly flat: readonly string[];
  readonly hierarchical: readonly string[];
}

function propertyElement(description: Element, namespace: string, localName: string): Element | null {
  return Array.from(description.children).find(
    (child) => child.namespaceURI === namespace && child.localName === localName,
  ) ?? null;
}

function languageAlternative(description: Element, namespace: string, localName: string): string | null {
  const property = propertyElement(description, namespace, localName);
  if (!property) return null;
  const alternative = Array.from(property.children).find(
    (child) => child.namespaceURI === RDF_NS && child.localName === "Alt",
  );
  if (!alternative) return property.textContent?.trim() || null;
  const items = Array.from(alternative.children).filter(
    (child) => child.namespaceURI === RDF_NS && child.localName === "li",
  );
  const preferred = items.find((item) => item.getAttribute("xml:lang") === "x-default") ?? items[0];
  return preferred?.textContent?.trim() || null;
}

function setLanguageAlternative(
  doc: XMLDocument,
  description: Element,
  qualifiedName: string,
  value: string | null,
): void {
  const localName = qualifiedName.slice(qualifiedName.indexOf(":") + 1);
  let property = propertyElement(description, DC_NS, localName);
  if (!property && value === null) return;
  if (!property) {
    property = doc.createElementNS(DC_NS, qualifiedName);
    description.append(property);
  }
  let alternative = Array.from(property.children).find(
    (child) => child.namespaceURI === RDF_NS && child.localName === "Alt",
  );
  if (!alternative) {
    property.replaceChildren();
    alternative = doc.createElementNS(RDF_NS, "rdf:Alt");
    property.append(alternative);
  }
  const existingDefault = Array.from(alternative.children).find(
    (child) => child.namespaceURI === RDF_NS && child.localName === "li" && child.getAttribute("xml:lang") === "x-default",
  );
  if (value === null) {
    existingDefault?.remove();
    if (alternative.children.length === 0) property.remove();
    return;
  }
  const item = existingDefault ?? doc.createElementNS(RDF_NS, "rdf:li");
  item.setAttribute("xml:lang", "x-default");
  item.textContent = value;
  if (!existingDefault) alternative.prepend(item);
}

function attributeValue(description: Element, namespace: string, localName: string): string | null {
  const attribute = description.getAttributeNS(namespace, localName)?.trim();
  if (attribute) return attribute;
  return propertyElement(description, namespace, localName)?.textContent?.trim() || null;
}

function removeProperty(description: Element, namespace: string, localName: string): void {
  description.removeAttributeNS(namespace, localName);
  description.removeAttribute(`${namespace === PHOTOSHOP_NS ? "photoshop" : "exif"}:${localName}`);
  propertyElement(description, namespace, localName)?.remove();
}

function setAttributeProperty(description: Element, namespace: string, qualifiedName: string, value: string | null): void {
  const localName = qualifiedName.slice(qualifiedName.indexOf(":") + 1);
  removeProperty(description, namespace, localName);
  if (value !== null) description.setAttributeNS(namespace, qualifiedName, value);
}

function numericText(value: string | null): number | null {
  if (value === null) return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

export function parseMetadataXmp(xml: string): MetadataOverrides {
  const description = descriptionFor(parseXmpDocument(xml));
  const title = languageAlternative(description, DC_NS, "title");
  const caption = languageAlternative(description, DC_NS, "description");
  const copyright = languageAlternative(description, DC_NS, "rights");
  const keywords = arrayProperty(description, DC_NS, "subject");
  const capture = attributeValue(description, PHOTOSHOP_NS, "DateCreated");
  const captureKey = capture === null ? null : Date.parse(capture);
  const latitude = numericText(attributeValue(description, EXIF_NS, "GPSLatitude"));
  const longitude = numericText(attributeValue(description, EXIF_NS, "GPSLongitude"));
  return {
    ...(title === null ? {} : { title: { kind: "set", value: title } }),
    ...(caption === null ? {} : { caption: { kind: "set", value: caption } }),
    ...(copyright === null ? {} : { copyright: { kind: "set", value: copyright } }),
    ...(keywords.length === 0 ? {} : { keywords: { kind: "set", value: keywords } }),
    ...(capture === null || captureKey === null || !Number.isFinite(captureKey)
      ? {}
      : { captureTime: { kind: "set", value: { value: capture.replace(/Z$/u, "").slice(0, 19), offset: capture.endsWith("Z") ? "Z" : null, sortKey: captureKey } } }),
    ...(latitude === null ? {} : { latitude: { kind: "set", value: latitude } }),
    ...(longitude === null ? {} : { longitude: { kind: "set", value: longitude } }),
  };
}

export function serializeMetadataXmp(existingContents: string | null, overrides: MetadataOverrides): string {
  const doc = existingContents ? parseXmpDocument(existingContents) : createXmpDocument();
  const description = descriptionFor(doc);
  description.setAttributeNS(XMLNS_NS, "xmlns:dc", DC_NS);
  description.setAttributeNS(XMLNS_NS, "xmlns:photoshop", PHOTOSHOP_NS);
  description.setAttributeNS(XMLNS_NS, "xmlns:exif", EXIF_NS);
  if (overrides.title) setLanguageAlternative(doc, description, "dc:title", overrides.title.kind === "set" ? overrides.title.value : null);
  if (overrides.caption) setLanguageAlternative(doc, description, "dc:description", overrides.caption.kind === "set" ? overrides.caption.value : null);
  if (overrides.copyright) setLanguageAlternative(doc, description, "dc:rights", overrides.copyright.kind === "set" ? overrides.copyright.value : null);
  if (overrides.keywords) setArrayProperty(doc, description, DC_NS, "dc:subject", overrides.keywords.kind === "set" ? overrides.keywords.value : []);
  if (overrides.captureTime) {
    setAttributeProperty(
      description,
      PHOTOSHOP_NS,
      "photoshop:DateCreated",
      overrides.captureTime.kind === "set"
        ? `${overrides.captureTime.value.value}${overrides.captureTime.value.offset ?? ""}`
        : null,
    );
  }
  if (overrides.latitude) setAttributeProperty(description, EXIF_NS, "exif:GPSLatitude", overrides.latitude.kind === "set" ? String(overrides.latitude.value) : null);
  if (overrides.longitude) setAttributeProperty(description, EXIF_NS, "exif:GPSLongitude", overrides.longitude.kind === "set" ? String(overrides.longitude.value) : null);
  const serialized = new XMLSerializer().serializeToString(doc);
  if (new TextEncoder().encode(serialized).byteLength > MAX_DEVELOP_PAYLOAD_BYTES) throw new Error("XMP sidecar exceeds the 16 MiB size limit.");
  return serialized;
}

const EDITABLE_FIELDS: readonly MetadataEditableField[] = [
  "title", "caption", "copyright", "keywords", "captureTime", "latitude", "longitude",
];

function semantic(value: unknown, field: MetadataEditableField): string {
  if (field === "keywords" && typeof value === "object" && value !== null && "kind" in value && value.kind === "set" && "value" in value && Array.isArray(value.value)) {
    return JSON.stringify({ kind: "set", value: [...value.value].map(String).sort((left, right) => left.localeCompare(right)) });
  }
  return JSON.stringify(value ?? null);
}

export function reconcileMetadataXmp(
  baseline: MetadataOverrides,
  catalog: MetadataOverrides,
  sidecar: MetadataOverrides,
): { readonly merged: MetadataOverrides; readonly conflicts: readonly MetadataFieldConflict[] } {
  const merged: Record<string, unknown> = {};
  const conflicts: MetadataFieldConflict[] = [];
  for (const field of EDITABLE_FIELDS) {
    const baseValue = baseline[field];
    const catalogValue = catalog[field];
    const sidecarValue = sidecar[field];
    const baseSemantic = semantic(baseValue, field);
    const catalogSemantic = semantic(catalogValue, field);
    const sidecarSemantic = semantic(sidecarValue, field);
    if (catalogSemantic === sidecarSemantic || sidecarSemantic === baseSemantic) merged[field] = catalogValue;
    else if (catalogSemantic === baseSemantic) merged[field] = sidecarValue;
    else conflicts.push({ field, base: baseValue, catalog: catalogValue, sidecar: sidecarValue });
  }
  return { merged: parseMetadataOverrides(merged), conflicts };
}

export function parseKeywordXmp(xml: string): ParsedKeywordXmp {
  const description = descriptionFor(parseXmpDocument(xml));
  const hierarchical = arrayProperty(description, LR_NS, "hierarchicalSubject");
  if (hierarchical.some((path) => path.split("|").some((part) => part.trim() === ""))) {
    throw new Error("lr:hierarchicalSubject contains an unsupported empty keyword path segment.");
  }
  return {
    flat: arrayProperty(description, DC_NS, "subject"),
    hierarchical,
  };
}

export function serializeKeywordXmp(
  existingContents: string | null,
  flat: readonly string[],
  hierarchical: readonly string[],
): string {
  const doc = existingContents ? parseXmpDocument(existingContents) : createXmpDocument();
  const description = descriptionFor(doc);
  if (existingContents) {
    arrayProperty(description, DC_NS, "subject");
    arrayProperty(description, LR_NS, "hierarchicalSubject");
  }
  description.setAttributeNS(XMLNS_NS, "xmlns:dc", DC_NS);
  description.setAttributeNS(XMLNS_NS, "xmlns:lr", LR_NS);
  setArrayProperty(doc, description, DC_NS, "dc:subject", flat);
  setArrayProperty(doc, description, LR_NS, "lr:hierarchicalSubject", hierarchical);
  const serialized = new XMLSerializer().serializeToString(doc);
  if (new TextEncoder().encode(serialized).byteLength > MAX_DEVELOP_PAYLOAD_BYTES) {
    throw new Error("XMP sidecar exceeds the 16 MiB size limit.");
  }
  return serialized;
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
  description.setAttributeNS(
    DARKROOM_NS,
    `darkroom:${LIGHTROOM_MASK_MANIFEST_LOCAL_NAME}`,
    utf8ToBase64(serializeLightroomMaskInterchangeManifest(document)),
  );
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
