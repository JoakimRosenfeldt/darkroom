import type { EntryMetadata } from "@/lib/catalog/types";
import { getDarkroomAPI } from "@/lib/fs/platform";
import type { DevelopSettings } from "@/lib/develop/types";
import { parseDevelopXmp, serializeDevelopXmp } from "@/lib/develop/xmp";

export interface DevelopSidecar {
  settings: DevelopSettings;
  lastModified: number;
  source: string;
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
    source: sidecar.contents,
  };
}

export async function writeDevelopSidecar(
  rootPath: string,
  relativePath: string,
  settings: DevelopSettings,
  metadata: Pick<EntryMetadata, "rating" | "colorLabel">,
  existing?: string | null,
): Promise<string> {
  const contents = serializeDevelopXmp(settings, metadata, existing);
  await getDarkroomAPI().writeSidecar(rootPath, relativePath, contents);
  return contents;
}
