import { getAssetRequest } from "../fs/session-catalog";
import { getDarkroomAPI } from "../fs/platform";
import type { LibraryEntry } from "../fs/types";
import { serializeKeywordXmp } from "./xmp";

export async function writeKeywordSidecar(
  entry: LibraryEntry,
  flat: readonly string[],
  hierarchical: readonly string[],
): Promise<void> {
  if (entry.entryKind === "virtual") return;
  const api = getDarkroomAPI();
  const request = getAssetRequest(entry);
  const current = await api.catalogReadSidecar(request);
  const contents = serializeKeywordXmp(current?.contents ?? null, flat, hierarchical);
  await api.catalogWriteSidecar({
    ...request,
    contents,
    expectedLastModified: current?.lastModified ?? null,
  });
}
