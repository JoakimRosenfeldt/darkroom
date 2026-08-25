import type { PersistedDevelopDocument } from "./v3/document.ts";
import type { DevelopAssetRef } from "./v3/assets.ts";
import { referencedMaskArtifacts } from "./v3/masking.ts";

export function collectDevelopAssetRefs(
  document: PersistedDevelopDocument,
): readonly DevelopAssetRef[] {
  if (document.version !== 3) return [];
  const references: DevelopAssetRef[] = [...document.local.maskAssetRefs];
  for (const mask of document.local.masks) {
    references.push(...referencedMaskArtifacts(mask.expression));
  }
  for (const component of document.cleanup.components) {
    if (component.kind === "repair" && component.source.kind === "accepted-patch") {
      references.push(component.source.asset);
    }
  }
  if (document.lensBlur.kind === "enabled") references.push(document.lensBlur.depthAsset);
  return [...new Map(references.map((reference) => [reference.assetId, reference])).values()]
    .sort((left, right) => left.assetId.localeCompare(right.assetId));
}
