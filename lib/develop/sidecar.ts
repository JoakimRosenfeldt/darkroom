import type { EntryMetadata } from "@/lib/catalog/types";
import { getDarkroomAPI } from "@/lib/fs/platform";
import { getAssetRequest } from "@/lib/fs/session-catalog";
import type { LibraryEntry } from "@/lib/fs/types";
import type {
  PersistedDevelopDocument,
  StoredDevelopDocument,
} from "@/lib/develop/v3/document";
import { parseDevelopXmp, parseKeywordXmp, serializeDevelopXmp } from "@/lib/develop/xmp";

export interface DevelopSidecar {
  contents: string;
  document: StoredDevelopDocument;
  lastModified: number;
  rating?: EntryMetadata["rating"];
  colorLabel: EntryMetadata["colorLabel"] | undefined;
  keywords: ReturnType<typeof parseKeywordXmp>;
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
    keywords: parseKeywordXmp(sidecar.contents),
    lastModified: sidecar.lastModified,
  };
}

export async function writeDevelopSidecar(
  entry: LibraryEntry,
  document: PersistedDevelopDocument,
  metadata: Pick<EntryMetadata, "rating" | "colorLabel">,
  existingContents: string | null,
  expectedLastModified: number | null,
): Promise<{ readonly contents: string; readonly lastModified: number } | null> {
  const contents = serializeDevelopXmp(document, metadata, existingContents);
  if (contents === null) {
    return null;
  }
  await getDarkroomAPI().catalogWriteSidecar({
    ...getAssetRequest(entry),
    contents,
    expectedLastModified,
  });
  const written = await getDarkroomAPI().catalogReadSidecar(getAssetRequest(entry));
  if (!written) throw new Error("XMP sidecar disappeared after it was written.");
  return written;
}
