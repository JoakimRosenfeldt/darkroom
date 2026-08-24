import type { EntryMetadata } from "@/lib/catalog/types";
import { createDefaultDevelopDocument, parseDevelopDocument } from "@/lib/develop/document";
import type { DevelopDocument, DevelopSettings } from "@/lib/develop/types";
import type { DevelopSidecar } from "@/lib/develop/sidecar";
import { decodePersistedDevelopDocument } from "@/lib/develop/v3/codec";
import type { StoredDevelopDocument } from "@/lib/develop/v3/document";

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

export function resolveStoredDevelopDocument(
  sidecar: Pick<DevelopSidecar, "document" | "lastModified"> | null,
  metadata: Pick<EntryMetadata, "develop" | "developUpdatedAt">,
): StoredDevelopDocument {
  if (sidecar && sidecar.lastModified > metadata.developUpdatedAt) {
    return sidecar.document;
  }
  return metadata.develop ?? createDefaultDevelopDocument();
}

export function resolveDevelopDocument(
  sidecar: Pick<DevelopSidecar, "document" | "lastModified"> | null,
  metadata: Pick<EntryMetadata, "develop" | "developUpdatedAt">,
): DevelopDocument {
  const decoded = decodePersistedDevelopDocument(
    resolveStoredDevelopDocument(sidecar, metadata),
  );
  if (decoded.kind === "editable") {
    if (decoded.document.version === 2) return parseDevelopDocument(decoded.document);
    throw new Error("A v3 Develop document cannot be resolved as frozen v2 settings.");
  }
  if (decoded.kind === "read-only-newer") {
    throw new Error(
      `Develop process v${decoded.foundVersion} is newer than this app and is read-only.`,
    );
  }
  throw new Error(decoded.message);
}

export function resolveV2DevelopProjection(
  metadata: Pick<EntryMetadata, "develop" | "developUpdatedAt">,
): DevelopDocument {
  const decoded = decodePersistedDevelopDocument(
    metadata.develop ?? createDefaultDevelopDocument(),
  );
  if (decoded.kind === "editable") {
    if (decoded.document.version === 2) return parseDevelopDocument(decoded.document);
    return decoded.document.compatibility.legacyV2
      ? parseDevelopDocument(decoded.document.compatibility.legacyV2)
      : createDefaultDevelopDocument();
  }
  return createDefaultDevelopDocument();
}
