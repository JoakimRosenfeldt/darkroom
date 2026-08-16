import type { EntryMetadata } from "@/lib/catalog/types";
import { createDevelopSettings } from "@/lib/develop/registry";
import type { DevelopSettings } from "@/lib/develop/types";
import type { DevelopSidecar } from "@/lib/develop/sidecar";

/**
 * Resolve the settings that belong to an entry at export time.
 *
 * Sidecars are authoritative only when they are newer than the catalog
 * metadata. The active Develop entry is handled by the export runner before
 * calling this function so an edit that is still waiting for its debounced
 * sidecar write is not lost.
 */
export function resolveDevelopSettings(
  sidecar: Pick<DevelopSidecar, "settings" | "lastModified"> | null,
  metadata: Pick<EntryMetadata, "develop" | "updatedAt">,
): DevelopSettings {
  if (sidecar && sidecar.lastModified > metadata.updatedAt) {
    return createDevelopSettings(sidecar.settings);
  }

  return createDevelopSettings(metadata.develop);
}
