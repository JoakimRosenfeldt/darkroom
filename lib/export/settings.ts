import type { EntryMetadata } from "@/lib/catalog/types";
import { createDefaultDevelopDocument, parseDevelopDocument } from "@/lib/develop/document";
import type { DevelopDocument, DevelopSettings } from "@/lib/develop/types";
import type { DevelopSidecar } from "@/lib/develop/sidecar";

/**
 * Resolve the settings that belong to an entry at export time.
 *
 * Sidecars are authoritative only when they are newer than the catalog Develop
 * document. The active Develop entry is handled by the export runner before calling
 * this function so an edit waiting for its debounced sidecar write is not lost.
 */
export function resolveDevelopSettings(
  sidecar: Pick<DevelopSidecar, "document" | "lastModified"> | null,
  metadata: Pick<EntryMetadata, "develop" | "developUpdatedAt">,
): DevelopSettings {
  return resolveDevelopDocument(sidecar, metadata).settings;
}

export function resolveDevelopDocument(
  sidecar: Pick<DevelopSidecar, "document" | "lastModified"> | null,
  metadata: Pick<EntryMetadata, "develop" | "developUpdatedAt">,
): DevelopDocument {
  if (sidecar && sidecar.lastModified > metadata.developUpdatedAt) {
    return parseDevelopDocument(sidecar.document);
  }

  return metadata.develop
    ? parseDevelopDocument(metadata.develop)
    : createDefaultDevelopDocument();
}
