import type { EntryMetadata } from "@/lib/catalog/types";
import { createDefaultDevelopDocument, parseDevelopDocument } from "@/lib/develop/document";
import type { DevelopDocument } from "@/lib/develop/types";
import type { DevelopSidecar } from "@/lib/develop/sidecar";
import { decodePersistedDevelopDocument } from "@/lib/develop/v3/codec";
import {
  createDefaultV3DevelopDocument,
  type StoredDevelopDocument,
} from "@/lib/develop/v3/document";

export function resolveStoredDevelopDocument(
  sidecar: Pick<DevelopSidecar, "document" | "lastModified"> | null,
  metadata: Pick<EntryMetadata, "develop" | "developUpdatedAt">,
): StoredDevelopDocument {
  if (sidecar && sidecar.lastModified > metadata.developUpdatedAt) {
    return sidecar.document;
  }
  return metadata.develop ?? createDefaultV3DevelopDocument();
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
