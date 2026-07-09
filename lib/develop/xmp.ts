import { COLOR_LABELS, type EntryMetadata } from "@/lib/catalog/types";
import {
  readBasicXmp,
  writeBasicXmp,
} from "@/lib/develop/plugins/basic";
import {
  readCropXmp,
  writeCropXmp,
} from "@/lib/develop/plugins/crop";
import {
  readCurveXmp,
  writeCurveXmp,
} from "@/lib/develop/plugins/curve";
import {
  readEffectsXmp,
  writeEffectsXmp,
} from "@/lib/develop/plugins/effects";
import {
  readMixerXmp,
  writeMixerXmp,
} from "@/lib/develop/plugins/mixer";
import {
  createDevelopSettings,
  isDefaultDevelopSettings,
} from "@/lib/develop/registry";
import type { DevelopSettings } from "@/lib/develop/types";

const CRS_NAMESPACE = "http://ns.adobe.com/camera-raw-settings/1.0/";
const RDF_NAMESPACE = "http://www.w3.org/1999/02/22-rdf-syntax-ns#";
const XMP_NAMESPACE = "http://ns.adobe.com/xap/1.0/";

const DEVELOP_XMP_PROPERTIES = [
  "crs:ProcessVersion",
  "crs:Exposure2012",
  "crs:Contrast2012",
  "crs:Highlights2012",
  "crs:Shadows2012",
  "crs:Whites2012",
  "crs:Blacks2012",
  "crs:Temperature",
  "crs:Tint",
  "crs:Vibrance",
  "crs:Saturation",
  "crs:HasCrop",
  "crs:CropLeft",
  "crs:CropTop",
  "crs:CropRight",
  "crs:CropBottom",
  "crs:CropAngle",
  "crs:PerspectiveHorizontal",
  "crs:PerspectiveVertical",
  "crs:LensManualDistortionAmount",
  "crs:ToneCurvePV2012",
  "crs:PostCropVignetteAmount",
  "crs:GrainAmount",
  "crs:Sharpness",
  "crs:LuminanceSmoothing",
  "crs:ColorNoiseReduction",
  ...["Red", "Orange", "Yellow", "Green", "Aqua", "Blue", "Purple", "Magenta"].flatMap(
    (color) => [
      `crs:HueAdjustment${color}`,
      `crs:SaturationAdjustment${color}`,
      `crs:LuminanceAdjustment${color}`,
    ],
  ),
  "xmp:Rating",
  "xmp:Label",
] as const;

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
  if (isDefaultDevelopSettings(settings)) {
    return {};
  }

  return {
    ...writeCropXmp(settings.crop),
    ...writeBasicXmp(settings.basic),
    ...writeCurveXmp(settings.curve),
    ...writeMixerXmp(settings.mixer),
    ...writeEffectsXmp(settings.effects),
  };
}

function collectProps(
  settings: DevelopSettings,
  metadata?: Pick<EntryMetadata, "rating" | "colorLabel">,
): Record<string, string> {
  const props = collectDevelopProps(settings);
  if (metadata?.rating) {
    props["xmp:Rating"] = String(metadata.rating);
  }
  if (metadata?.colorLabel) {
    props["xmp:Label"] = metadata.colorLabel;
  }
  return props;
}

function parseXml(xml: string): XMLDocument {
  const doc = new DOMParser().parseFromString(xml, "application/xml");
  if (doc.querySelector("parsererror")) {
    throw new Error("Could not parse XMP sidecar.");
  }
  return doc;
}

function getDescription(doc: XMLDocument): Element | null {
  return doc.getElementsByTagNameNS(RDF_NAMESPACE, "Description").item(0);
}

function propertyNamespace(property: string): string {
  return property.startsWith("xmp:") ? XMP_NAMESPACE : CRS_NAMESPACE;
}

function propertyLocalName(property: string): string {
  return property.slice(property.indexOf(":") + 1);
}

function applyProps(description: Element, props: Record<string, string>): void {
  for (const property of DEVELOP_XMP_PROPERTIES) {
    description.removeAttributeNS(
      propertyNamespace(property),
      propertyLocalName(property),
    );
  }

  for (const [property, value] of Object.entries(props)) {
    description.setAttributeNS(propertyNamespace(property), property, value);
  }
}

function createXmp(props: Record<string, string>): string {
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

export function serializeDevelopXmp(
  settings: DevelopSettings,
  metadata?: Pick<EntryMetadata, "rating" | "colorLabel">,
  existingXml?: string,
): string | null {
  const props = collectProps(settings, metadata);
  if (!existingXml) {
    return Object.keys(props).length > 0 ? createXmp(props) : null;
  }

  const doc = parseXml(existingXml);
  const description = getDescription(doc);
  if (!description) {
    throw new Error("XMP sidecar does not contain an rdf:Description element.");
  }
  applyProps(description, props);
  return new XMLSerializer().serializeToString(doc);
}

function extractAttributes(xml: string): Record<string, string> {
  const description = getDescription(parseXml(xml));
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
  return {
    settings: createDevelopSettings({
      crop: readCropXmp(props),
      basic: readBasicXmp(props),
      curve: readCurveXmp(props),
      mixer: readMixerXmp(props),
      effects: readEffectsXmp(props),
    }),
    rating: parseRating(props["xmp:Rating"]),
    colorLabel: parseColorLabel(props["xmp:Label"]),
  };
}
