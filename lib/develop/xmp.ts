import type { EntryMetadata } from "@/lib/catalog/types";
import { COLOR_LABELS } from "@/lib/catalog/types";
import {
  DEVELOP_PLUGINS,
  createDevelopSettings,
  isDefaultDevelopSettings,
} from "@/lib/develop/registry";
import type {
  DevelopSettings,
  XmpProps,
  XmpValue,
} from "@/lib/develop/types";

const RDF_NS = "http://www.w3.org/1999/02/22-rdf-syntax-ns#";
const CRS_NS = "http://ns.adobe.com/camera-raw-settings/1.0/";
const XMP_NS = "http://ns.adobe.com/xap/1.0/";

export interface ParsedDevelopXmp {
  settings: DevelopSettings;
  rating?: EntryMetadata["rating"];
  colorLabel?: EntryMetadata["colorLabel"];
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

function setProp(
  doc: XMLDocument,
  description: Element,
  key: string,
  value: XmpValue,
): void {
  const namespace = propNamespace(key);
  const localName = propLocalName(key);
  description.removeAttributeNS(namespace, localName);
  for (const child of Array.from(description.children)) {
    if (child.namespaceURI === namespace && child.localName === localName) {
      child.remove();
    }
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
    `<x:xmpmeta xmlns:x="adobe:ns:meta/"><rdf:RDF xmlns:rdf="${RDF_NS}"><rdf:Description xmlns:crs="${CRS_NS}" xmlns:xmp="${XMP_NS}"/></rdf:RDF></x:xmpmeta>`,
    "application/xml",
  );
}

function descriptionFor(doc: XMLDocument): Element {
  const description = doc.getElementsByTagNameNS(RDF_NS, "Description")[0];
  if (!description) {
    throw new Error("Could not find an XMP description.");
  }
  return description;
}

function parseXmpDocument(xml: string): XMLDocument {
  const doc = new DOMParser().parseFromString(xml, "application/xml");
  if (doc.querySelector("parsererror")) {
    throw new Error("Could not parse XMP sidecar.");
  }
  descriptionFor(doc);
  return doc;
}

export function serializeDevelopXmp(
  settings: DevelopSettings,
  metadata: Pick<EntryMetadata, "rating" | "colorLabel">,
  existingContents: string | null,
): string | null {
  if (
    existingContents === null &&
    isDefaultDevelopSettings(settings) &&
    metadata.rating === 0 &&
    metadata.colorLabel === null
  ) {
    return null;
  }

  const doc = existingContents ? parseXmpDocument(existingContents) : createXmpDocument();
  const description = descriptionFor(doc);
  description.setAttribute("xmlns:crs", CRS_NS);
  description.setAttribute("xmlns:xmp", XMP_NS);

  for (const [key, value] of Object.entries(collectDevelopProps(settings))) {
    setProp(doc, description, key, value);
  }
  description.setAttributeNS(XMP_NS, "xmp:Rating", String(metadata.rating));
  if (metadata.colorLabel) {
    description.setAttributeNS(XMP_NS, "xmp:Label", metadata.colorLabel);
  } else {
    description.removeAttributeNS(XMP_NS, "Label");
    description.removeAttribute("xmp:Label");
  }

  return new XMLSerializer().serializeToString(doc);
}

function extractProps(xml: string): XmpProps {
  const description = descriptionFor(parseXmpDocument(xml));
  const props = Array.from(description.attributes).reduce<XmpProps>(
    (props, attribute) => {
      if (attribute.name.startsWith("crs:") || attribute.name.startsWith("xmp:")) {
        props[attribute.name] = attribute.value;
      }
      return props;
    },
    {},
  );

  for (const child of Array.from(description.children)) {
    const prefix = child.namespaceURI === CRS_NS
      ? "crs"
      : child.namespaceURI === XMP_NS
        ? "xmp"
        : null;
    if (!prefix) {
      continue;
    }
    const items = Array.from(child.getElementsByTagNameNS(RDF_NS, "li"));
    if (items.length) {
      props[`${prefix}:${child.localName}`] = items.map(
        (item) => item.textContent?.trim() ?? "",
      );
    }
  }

  return props;
}

function parseRating(value: string | undefined): EntryMetadata["rating"] | undefined {
  const rating = Number(value);
  if (Number.isInteger(rating) && rating >= 0 && rating <= 5) {
    return rating as EntryMetadata["rating"];
  }
  return undefined;
}

function parseColorLabel(
  value: string | undefined,
): EntryMetadata["colorLabel"] | undefined {
  if (!value) {
    return undefined;
  }
  const normalized = value.toLowerCase();
  if (COLOR_LABELS.includes(normalized as Exclude<EntryMetadata["colorLabel"], null>)) {
    return normalized as EntryMetadata["colorLabel"];
  }
  return undefined;
}

export function parseDevelopXmp(xml: string): ParsedDevelopXmp {
  const props = extractProps(xml);
  const patch: Partial<DevelopSettings> = {};

  for (const plugin of DEVELOP_PLUGINS) {
    patch[plugin.id] = plugin.xmp.read(props) as never;
  }

  return {
    settings: createDevelopSettings(patch),
    rating: parseRating(
      typeof props["xmp:Rating"] === "string" ? props["xmp:Rating"] : undefined,
    ),
    colorLabel: parseColorLabel(
      typeof props["xmp:Label"] === "string" ? props["xmp:Label"] : undefined,
    ),
  };
}
