import type { EntryMetadata } from "@/lib/catalog/types";
import { getDarkroomAPI } from "@/lib/fs/platform";
import { getAssetRequest } from "@/lib/fs/session-catalog";
import type { LibraryEntry } from "@/lib/fs/types";
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
  entry: LibraryEntry,
): Promise<DevelopSidecar | null> {
  const sidecar = await getDarkroomAPI().catalogReadSidecar(getAssetRequest(entry));
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
  entry: LibraryEntry,
  document: DevelopDocument,
  metadata: Pick<EntryMetadata, "rating" | "colorLabel">,
  existingContents: string | null,
): Promise<string | null> {
  const contents = serializeDevelopXmp(document, metadata, existingContents);
  if (contents === null) {
    return null;
  }
  await getDarkroomAPI().catalogWriteSidecar({
    ...getAssetRequest(entry),
    contents,
  });
  return contents;
}
