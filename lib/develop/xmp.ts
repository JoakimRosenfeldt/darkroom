import type { EntryMetadata } from "@/lib/catalog/types";
import { COLOR_LABELS } from "@/lib/catalog/types";
import {
  DEVELOP_PLUGINS,
  createDevelopSettings,
  isDefaultDevelopSettings,
} from "@/lib/develop/registry";
import type { DevelopSettings } from "@/lib/develop/types";

const RDF_NS = "http://www.w3.org/1999/02/22-rdf-syntax-ns#";
const CRS_NS = "http://ns.adobe.com/camera-raw-settings/1.0/";
const XMP_NS = "http://ns.adobe.com/xap/1.0/";

export interface ParsedDevelopXmp {
  settings: DevelopSettings;
  rating?: EntryMetadata["rating"];
  colorLabel?: EntryMetadata["colorLabel"];
}

function collectDevelopProps(settings: DevelopSettings): Record<string, string> {
  const props: Record<string, string> = {};
  for (const plugin of DEVELOP_PLUGINS) {
    Object.assign(props, plugin.xmp.write(settings[plugin.id] as never));
  }
  return props;
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
    description.setAttributeNS(CRS_NS, key, value);
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

function extractAttributes(xml: string): Record<string, string> {
  const description = descriptionFor(parseXmpDocument(xml));
  return Array.from(description.attributes).reduce<Record<string, string>>(
    (props, attribute) => {
      if (attribute.name.startsWith("crs:") || attribute.name.startsWith("xmp:")) {
        props[attribute.name] = attribute.value;
      }
      return props;
    },
    {},
  );
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
  const props = extractAttributes(xml);
  const patch: Partial<DevelopSettings> = {};

  for (const plugin of DEVELOP_PLUGINS) {
    patch[plugin.id] = plugin.xmp.read(props) as never;
  }

  return {
    settings: createDevelopSettings(patch),
    rating: parseRating(props["xmp:Rating"]),
    colorLabel: parseColorLabel(props["xmp:Label"]),
  };
}
