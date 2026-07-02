import type { EntryMetadata } from "@/lib/catalog/types";
import { getDarkroomAPI } from "@/lib/fs/platform";
import { isDefaultDevelopSettings } from "@/lib/develop/registry";
import type { DevelopSettings } from "@/lib/develop/types";
import { parseDevelopXmp, serializeDevelopXmp } from "@/lib/develop/xmp";

export interface DevelopSidecar {
  settings: DevelopSettings;
  lastModified: number;
  rating?: EntryMetadata["rating"];
  colorLabel?: EntryMetadata["colorLabel"];
}

export async function readDevelopSidecar(
  rootPath: string,
  relativePath: string,
): Promise<DevelopSidecar | null> {
  const sidecar = await getDarkroomAPI().readSidecar(rootPath, relativePath);
  if (!sidecar) {
    return null;
  }

  return {
    ...parseDevelopXmp(sidecar.contents),
    lastModified: sidecar.lastModified,
  };
}

export async function writeDevelopSidecar(
  rootPath: string,
  relativePath: string,
  settings: DevelopSettings,
  metadata: Pick<EntryMetadata, "rating" | "colorLabel">,
): Promise<void> {
  const contents = isDefaultDevelopSettings(settings)
    ? null
    : serializeDevelopXmp(settings, metadata);
  await getDarkroomAPI().writeSidecar(rootPath, relativePath, contents);
}
