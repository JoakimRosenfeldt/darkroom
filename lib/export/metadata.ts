import type { EntryMetadata } from "@/lib/catalog/types";
import { serializeMetadataXmp } from "@/lib/develop/xmp";
import { effectiveMetadataValue, metadataValue, type MetadataOverrides, type SourceMetadataSnapshot } from "@/lib/metadata/types";
import type { ExportEncodeOptions, ExportMetadataMode } from "./types";

export function exportMetadata(
  catalog: EntryMetadata,
  overrides: MetadataOverrides,
  source: SourceMetadataSnapshot | null,
  mode: ExportMetadataMode,
  includeLocation: boolean,
): Pick<ExportEncodeOptions, "xmp" | "exif"> {
  if (mode === "none") return {};
  const absent = { kind: "absent" } as const;
  const copyright = overrides.copyright ?? { kind: "set", value: catalog.copyright ?? metadataValue(source?.description.copyright ?? absent) ?? "" };
  const description: MetadataOverrides = mode === "copyright" ? { copyright } : {
    title: overrides.title ?? { kind: "set", value: catalog.title ?? metadataValue(source?.description.title ?? absent) ?? "" },
    caption: overrides.caption ?? { kind: "set", value: catalog.caption ?? metadataValue(source?.description.caption ?? absent) ?? "" },
    copyright,
    keywords: overrides.keywords ?? { kind: "set", value: catalog.keywords.length ? catalog.keywords : metadataValue(source?.description.keywords ?? absent) ?? [] },
  };
  const time = effectiveMetadataValue(source?.capture.time ?? absent, overrides.captureTime);
  const latitude = includeLocation ? effectiveMetadataValue(source?.location.latitude ?? absent, overrides.latitude) : null;
  const longitude = includeLocation ? effectiveMetadataValue(source?.location.longitude ?? absent, overrides.longitude) : null;
  const xmp = serializeMetadataXmp(null, {
    ...description,
    ...(mode === "all" && time ? { captureTime: { kind: "set", value: time } as const } : {}),
    ...(mode === "all" && latitude !== null && longitude !== null ? {
      latitude: { kind: "set", value: latitude } as const,
      longitude: { kind: "set", value: longitude } as const,
    } : {}),
  });
  const IFD0: Record<string, string> = { Orientation: "1" };
  if (copyright.kind === "set" && copyright.value) IFD0.Copyright = copyright.value;
  const IFD2: Record<string, string> = {};
  if (mode === "all" && source) {
    for (const [tag, field] of [["Make", source.capture.cameraMake], ["Model", source.capture.cameraModel]] as const) {
      const value = metadataValue(field);
      if (value) IFD0[tag] = value;
    }
    for (const [tag, field] of [["LensModel", source.capture.lens], ["FocalLength", source.capture.focalLength], ["FNumber", source.capture.aperture], ["ExposureTime", source.capture.shutter], ["ISOSpeedRatings", source.capture.iso]] as const) {
      if (field.kind === "value") IFD2[tag] = String(field.value);
    }
    if (time) IFD2.DateTimeOriginal = time.value.replace(/^(\d{4})-(\d{2})-(\d{2})T/, "$1:$2:$3 ");
  }
  return { xmp, exif: { IFD0, ...(Object.keys(IFD2).length ? { IFD2 } : {}) } };
}
