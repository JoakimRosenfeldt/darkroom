import type { EntryMetadata } from "@/lib/catalog/types";
import { getDarkroomAPI } from "@/lib/fs/platform";
import type { DevelopDocument } from "@/lib/develop/types";
import { parseDevelopXmp, serializeDevelopXmp } from "@/lib/develop/xmp";

export interface DevelopSidecar {
  contents: string;
  document: DevelopDocument;
  lastModified: number;
  rating?: EntryMetadata["rating"];
  colorLabel: EntryMetadata["colorLabel"] | undefined;
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
    contents: sidecar.contents,
    ...parseDevelopXmp(sidecar.contents),
    lastModified: sidecar.lastModified,
  };
}

export async function writeDevelopSidecar(
  rootPath: string,
  relativePath: string,
  document: DevelopDocument,
  metadata: Pick<EntryMetadata, "rating" | "colorLabel">,
  existingContents: string | null,
): Promise<string | null> {
  const contents = serializeDevelopXmp(document, metadata, existingContents);
  if (contents === null) {
    return null;
  }
  await getDarkroomAPI().writeSidecar(rootPath, relativePath, contents);
  return contents;
}
