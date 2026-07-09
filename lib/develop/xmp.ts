import type { EntryMetadata } from "@/lib/catalog/types";
import { COLOR_LABELS } from "@/lib/catalog/types";
import { DEVELOP_PLUGINS, createDevelopSettings } from "@/lib/develop/registry";
import type { DevelopSettings } from "@/lib/develop/types";

export interface ParsedDevelopXmp {
  settings: DevelopSettings;
  rating?: EntryMetadata["rating"];
  colorLabel?: EntryMetadata["colorLabel"];
}

function escapeXml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll('"', "&quot;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;");
}

function collectDevelopProps(settings: DevelopSettings): Record<string, string> {
  const props: Record<string, string> = {};
  for (const plugin of DEVELOP_PLUGINS) {
    Object.assign(props, plugin.xmp.write(settings[plugin.id] as never));
  }
  return props;
}

const OWNED_XMP_KEYS = (() => {
  const settings = createDevelopSettings();
  settings.crop.enabled = true;
  return new Set([
    ...Object.keys(collectDevelopProps(settings)),
    "xmp:Rating",
    "xmp:Label",
  ]);
})();

function getDescription(doc: Document): Element | null {
  return doc.getElementsByTagNameNS("*", "Description")[0] ?? null;
}

function mergeDevelopProps(
  existing: string,
  props: Record<string, string>,
): string {
  const parser = new DOMParser();
  const doc = parser.parseFromString(existing, "application/xml");
  if (doc.querySelector("parsererror")) {
    throw new Error("Could not parse existing XMP sidecar; refusing to overwrite it.");
  }

  const description = getDescription(doc);
  if (!description) {
    throw new Error("Existing XMP sidecar has no rdf:Description; refusing to overwrite it.");
  }

  for (const key of OWNED_XMP_KEYS) {
    description.removeAttribute(key);
  }
  for (const [key, value] of Object.entries(props)) {
    description.setAttribute(key, value);
  }

  return new XMLSerializer().serializeToString(doc);
}

export function serializeDevelopXmp(
  settings: DevelopSettings,
  metadata?: Pick<EntryMetadata, "rating" | "colorLabel">,
  existing?: string | null,
): string {
  const props: Record<string, string> = {
    ...collectDevelopProps(settings),
  };

  if (metadata?.rating) {
    props["xmp:Rating"] = String(metadata.rating);
  }
  if (metadata?.colorLabel) {
    props["xmp:Label"] = metadata.colorLabel;
  }

  if (existing) {
    return mergeDevelopProps(existing, props);
  }

  const attributes = Object.entries(props)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([key, value]) => `   ${key}="${escapeXml(value)}"`)
    .join("\n");

  return `<?xpacket begin="" id="W5M0MpCehiHzreSzNTczkc9d"?>
<x:xmpmeta xmlns:x="adobe:ns:meta/">
 <rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#">
  <rdf:Description
   xmlns:crs="http://ns.adobe.com/camera-raw-settings/1.0/"
   xmlns:xmp="http://ns.adobe.com/xap/1.0/"
${attributes}
  />
 </rdf:RDF>
</x:xmpmeta>
<?xpacket end="w"?>`;
}

function extractAttributes(xml: string): Record<string, string> {
  const parser = new DOMParser();
  const doc = parser.parseFromString(xml, "application/xml");
  if (doc.querySelector("parsererror")) {
    throw new Error("Could not parse XMP sidecar.");
  }

  const description = getDescription(doc);
  if (!description) {
    return {};
  }

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
