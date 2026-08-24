import type {
  V3AssetCopyReceipt,
  V3UpgradeAssetCopyAdapter,
} from "../session";
import type { DevelopDocument } from "../types";
import type { LibraryEntry } from "@/lib/fs/types";
import type { DevelopAssetCandidate, DevelopAssetRef } from "./assets";

const RECOVERY_WINDOW_MS = 24 * 60 * 60 * 1_000;

function decodeBase64(value: string): Uint8Array {
  const binary = atob(value);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index);
  }
  return bytes;
}

async function candidateId(input: {
  readonly entry: LibraryEntry;
  readonly sourceAssetId: string;
  readonly sha256: string;
}): Promise<string> {
  const identity = JSON.stringify([
    input.entry.catalogId,
    input.entry.id,
    input.entry.assetRevision,
    input.sourceAssetId,
    input.sha256,
  ]);
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(identity),
  );
  const hex = Array.from(new Uint8Array(digest), (byte) =>
    byte.toString(16).padStart(2, "0")
  ).join("");
  return `v2-inline-${hex}`;
}

type AssetCopy = Parameters<
  V3UpgradeAssetCopyAdapter["copyRequiredAssets"]
>[0]["copies"][number];

function matchingAsset(document: DevelopDocument, copy: AssetCopy) {
  const asset = document.maskAssets[copy.sourceAssetId];
  if (
    !asset ||
    asset.sha256 !== copy.expectedReference.sha256 ||
    asset.byteLength !== copy.byteLength ||
    asset.mimeType !== copy.mimeType ||
    asset.width !== copy.width ||
    asset.height !== copy.height
  ) {
    throw new Error(`Retained mask asset ${copy.sourceAssetId} no longer matches the v2 document.`);
  }
  return asset;
}

export function createV3UpgradeAssetCopyAdapter(input: {
  readonly entry: LibraryEntry;
  readonly currentDocument: () => DevelopDocument | null;
}): V3UpgradeAssetCopyAdapter {
  return {
    async copyRequiredAssets(request): Promise<V3AssetCopyReceipt> {
      if (
        request.catalogId !== input.entry.catalogId ||
        request.entryId !== input.entry.id
      ) {
        throw new Error("The retained mask copy does not match the active source photo.");
      }
      if (typeof window === "undefined" || !window.darkroom) {
        throw new Error("Retained mask storage is available only in the desktop app.");
      }
      const document = input.currentDocument();
      if (!document) {
        throw new Error("The frozen v2 document changed before its masks were copied.");
      }

      const references: DevelopAssetRef[] = [];
      for (const copy of request.copies) {
        const asset = matchingAsset(document, copy);
        const bytes = decodeBase64(asset.pngBase64);
        const candidate: DevelopAssetCandidate = {
          kind: "candidate",
          candidateId: await candidateId({
            entry: input.entry,
            sourceAssetId: copy.sourceAssetId,
            sha256: copy.expectedReference.sha256,
          }),
          descriptor: {
            kind: copy.expectedReference.kind,
            sha256: copy.expectedReference.sha256,
            sourceSignature: {
              entryId: input.entry.id,
              catalogId: input.entry.catalogId,
              assetRevision: input.entry.assetRevision,
              relativePath: input.entry.relativePath,
              size: input.entry.size,
              lastModified: input.entry.lastModified,
            },
            coordinateFrameRevision: copy.expectedReference.coordinateFrameRevision,
            colorStageId: copy.expectedReference.colorStageId,
            dimensions: { width: copy.width, height: copy.height },
            byteLength: copy.byteLength,
            mimeType: copy.mimeType,
            producerId: "darkroom-v2-migration",
            producerRevision: copy.expectedReference.producerRevision,
          },
        };
        const nowMs = Date.now();
        const stored = await window.darkroom.developAssetPut({
          candidate,
          bytes,
          nowMs,
          recoveryUntilMs: nowMs + RECOVERY_WINDOW_MS,
        });
        if (stored.kind === "rejected") {
          throw new Error(stored.message);
        }
        const transitioned = await window.darkroom.developAssetTransition({
          candidate,
          lifecycle: "accepted",
          reference: copy.expectedReference,
          nowMs,
          recoveryUntilMs: nowMs + RECOVERY_WINDOW_MS,
        });
        if (transitioned.kind === "missing" || transitioned.kind === "conflict") {
          throw new Error(transitioned.message);
        }
        references.push(copy.expectedReference);
      }
      return { kind: "copied", references };
    },
  };
}
