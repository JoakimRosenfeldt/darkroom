import { createHash, type Hash } from "node:crypto";
import type {
  CatalogV3AlbumInput,
  CatalogV3AssetCandidate,
  CatalogV3AssetMetadata,
  CatalogV3FingerprintInput,
  CatalogV3Observation,
} from "../lib/catalog/v3.ts";
import type { RootId } from "../lib/catalog/ids.ts";

export const CATALOG_V3_DEFAULT_METADATA: CatalogV3AssetMetadata = {
  archive: false,
  pick: "none",
  rating: 0,
  colorLabel: null,
  developJson: null,
  developUpdatedAt: 0,
  updatedAt: 0,
  title: null,
  caption: null,
  copyright: null,
  keywordsJson: "[]",
  rawXmp: null,
  xmpState: "unknown",
  xmpMtime: null,
  xmpSha256: null,
};

export interface CatalogV3StateLocation {
  readonly rootId: RootId;
  readonly relativePath: string;
}

export interface CatalogV3StateFingerprint {
  readonly status: CatalogV3FingerprintInput["status"];
  readonly sha256: string | null;
  readonly observedAt: number | null;
  readonly observedByteLength: number | null;
  readonly observedModifiedAt: number | null;
  readonly localFileId: string | null;
}

export interface CatalogV3StateAsset extends CatalogV3StateLocation {
  readonly observation: CatalogV3Observation | null;
  readonly health: CatalogV3AssetCandidate["health"];
  readonly formatId: string;
  readonly cameraMake: string | null;
  readonly cameraModel: string | null;
  readonly lensModel: string | null;
  readonly legacyIds: readonly string[];
  readonly metadata: CatalogV3AssetMetadata;
  readonly fingerprint: CatalogV3StateFingerprint;
}

export interface CatalogV3StateAlbum {
  readonly id: string;
  readonly name: string;
  readonly createdAt: number;
  readonly updatedAt: number;
  readonly position: number;
  readonly members: readonly CatalogV3StateLocation[];
}

export interface CatalogV3State {
  readonly assets: readonly CatalogV3StateAsset[];
  readonly albums: readonly CatalogV3StateAlbum[];
}

export interface CatalogV3ExpectedStateInput {
  readonly assets: readonly CatalogV3AssetCandidate[];
  readonly albums: readonly Pick<CatalogV3AlbumInput, "id" | "name" | "createdAt" | "updatedAt" | "position" | "entryIds">[];
  readonly archiveLegacyIds: readonly string[];
}

function fingerprintFor(candidate: CatalogV3AssetCandidate): CatalogV3StateFingerprint {
  const raw = candidate.fingerprint;
  return {
    status: raw?.status ?? "missing",
    sha256: raw?.sha256 ?? null,
    observedAt: raw?.observedAt ?? candidate.observation?.observedAt ?? null,
    observedByteLength: raw?.observedByteLength ?? candidate.observation?.byteLength ?? null,
    observedModifiedAt: raw?.observedModifiedAt ?? candidate.observation?.modifiedAt ?? null,
    localFileId: raw?.localFileId ?? candidate.observation?.localFileId ?? null,
  };
}

function compareText(left: string, right: string): number {
  return Buffer.compare(Buffer.from(left, "utf8"), Buffer.from(right, "utf8"));
}

type CatalogV3StateAlbumHeader = Omit<CatalogV3StateAlbum, "members">;

const STATE_DIGEST_VERSION = "darkroom.catalog-v3-state.v1";

export class CatalogV3StateDigest {
  private readonly hash: Hash = createHash("sha256");
  private phase: "assets" | "albums" | "finished" = "assets";

  constructor() {
    this.marker(1);
    this.value(STATE_DIGEST_VERSION);
  }

  private marker(value: number): void {
    this.hash.update(Buffer.from([0xff, value]));
  }

  private bytes(value: Uint8Array): void {
    const length = Buffer.allocUnsafe(8);
    length.writeBigUInt64BE(BigInt(value.byteLength));
    this.hash.update(length);
    this.hash.update(value);
  }

  private value(value: string | number | boolean | null): void {
    if (value === null) {
      this.hash.update(Buffer.from([0]));
      return;
    }
    if (typeof value === "boolean") {
      this.hash.update(Buffer.from([1, value ? 1 : 0]));
      return;
    }
    if (typeof value === "number") {
      if (!Number.isFinite(value)) throw new Error("Catalog v3 state number must be finite.");
      this.hash.update(Buffer.from([2]));
      this.bytes(Buffer.from(JSON.stringify(value), "utf8"));
      return;
    }
    this.hash.update(Buffer.from([3]));
    this.bytes(Buffer.from(value, "utf8"));
  }

  addAsset(asset: CatalogV3StateAsset): void {
    if (this.phase !== "assets") throw new Error("Catalog v3 state assets are out of order.");
    this.marker(2);
    this.value(asset.rootId);
    this.value(asset.relativePath);
    this.value(asset.observation !== null);
    if (asset.observation !== null) {
      this.value(asset.observation.byteLength);
      this.value(asset.observation.modifiedAt);
      this.value(asset.observation.observedAt);
      this.value(asset.observation.localFileId);
    }
    this.value(asset.health);
    this.value(asset.formatId);
    this.value(asset.cameraMake);
    this.value(asset.cameraModel);
    this.value(asset.lensModel);
    const legacyIds = [...asset.legacyIds].sort(compareText);
    this.value(legacyIds.length);
    for (const legacyId of legacyIds) this.value(legacyId);

    const metadata = asset.metadata;
    this.value(metadata.archive);
    this.value(metadata.pick);
    this.value(metadata.rating);
    this.value(metadata.colorLabel);
    this.value(metadata.developJson);
    this.value(metadata.developUpdatedAt);
    this.value(metadata.updatedAt);
    this.value(metadata.title);
    this.value(metadata.caption);
    this.value(metadata.copyright);
    this.value(metadata.keywordsJson);
    this.value(metadata.rawXmp);
    this.value(metadata.xmpState);
    this.value(metadata.xmpMtime);
    this.value(metadata.xmpSha256);

    const fingerprint = asset.fingerprint;
    this.value(fingerprint.status);
    this.value(fingerprint.sha256);
    this.value(fingerprint.observedAt);
    this.value(fingerprint.observedByteLength);
    this.value(fingerprint.observedModifiedAt);
    this.value(fingerprint.localFileId);
  }

  addAlbum(album: CatalogV3StateAlbumHeader, members: Iterable<CatalogV3StateLocation>): void {
    if (this.phase === "assets") {
      this.marker(3);
      this.phase = "albums";
    }
    if (this.phase !== "albums") throw new Error("Catalog v3 state albums are out of order.");
    this.marker(4);
    this.value(album.id);
    this.value(album.name);
    this.value(album.createdAt);
    this.value(album.updatedAt);
    this.value(album.position);
    for (const member of members) {
      this.marker(5);
      this.value(member.rootId);
      this.value(member.relativePath);
    }
    this.marker(6);
  }

  digest(): string {
    if (this.phase === "finished") throw new Error("Catalog v3 state digest is already finished.");
    if (this.phase === "assets") this.marker(3);
    this.marker(7);
    this.phase = "finished";
    return this.hash.digest("hex");
  }
}

export function catalogV3StateSha256(state: CatalogV3State): string {
  const digest = new CatalogV3StateDigest();
  for (const asset of [...state.assets].sort((left, right) =>
    compareText(left.rootId, right.rootId) || compareText(left.relativePath, right.relativePath)
  )) {
    digest.addAsset(asset);
  }
  for (const album of state.albums) {
    const { members, ...header } = album;
    digest.addAlbum(header, members);
  }
  return digest.digest();
}

function expectedStateFacts(input: CatalogV3ExpectedStateInput): {
  readonly locations: ReadonlyMap<string, CatalogV3StateLocation>;
  readonly archived: ReadonlySet<string>;
} {
  if (input.albums.some((album, index) => album.position !== index)) {
    throw new Error("Catalog v3 expected album positions must be contiguous.");
  }
  const locations = new Map<string, CatalogV3StateLocation>();
  for (const asset of input.assets) {
    for (const legacyId of asset.legacyIds) {
      if (locations.has(legacyId)) {
        throw new Error(`Catalog v3 expected state has duplicate legacy ID ${legacyId}.`);
      }
      locations.set(legacyId, { rootId: asset.rootId, relativePath: asset.relativePath });
    }
  }
  const archived = new Set(input.archiveLegacyIds);
  for (const legacyId of archived) {
    if (!locations.has(legacyId)) {
      throw new Error(`Catalog v3 expected archive references unknown legacy ID ${legacyId}.`);
    }
  }
  return { locations, archived };
}

function expectedAsset(
  asset: CatalogV3AssetCandidate,
  archived: ReadonlySet<string>,
): CatalogV3StateAsset {
  const metadata = asset.metadata ?? CATALOG_V3_DEFAULT_METADATA;
  return {
    rootId: asset.rootId,
    relativePath: asset.relativePath,
    observation: asset.observation,
    health: asset.health,
    formatId: asset.formatId,
    cameraMake: asset.cameraMake,
    cameraModel: asset.cameraModel,
    lensModel: asset.lensModel,
    legacyIds: asset.legacyIds,
    metadata: archived.size > 0 && asset.legacyIds.some((legacyId) => archived.has(legacyId))
      ? { ...metadata, archive: true }
      : metadata,
    fingerprint: fingerprintFor(asset),
  };
}

function* albumMembers(
  album: CatalogV3ExpectedStateInput["albums"][number],
  locations: ReadonlyMap<string, CatalogV3StateLocation>,
): Generator<CatalogV3StateLocation> {
  for (const legacyId of album.entryIds) {
    const location = locations.get(legacyId);
    if (location === undefined) {
      throw new Error(`Catalog v3 expected album references unknown legacy ID ${legacyId}.`);
    }
    yield location;
  }
}

export function catalogV3ExpectedState(input: CatalogV3ExpectedStateInput): CatalogV3State {
  const { locations, archived } = expectedStateFacts(input);

  return {
    assets: input.assets.map((asset) => expectedAsset(asset, archived)),
    albums: input.albums.map((album) => ({
      id: album.id,
      name: album.name,
      createdAt: album.createdAt,
      updatedAt: album.updatedAt,
      position: album.position,
      members: [...albumMembers(album, locations)],
    })),
  };
}

export function catalogV3ExpectedStateSha256(input: CatalogV3ExpectedStateInput): string {
  const { locations, archived } = expectedStateFacts(input);
  const digest = new CatalogV3StateDigest();
  for (const asset of [...input.assets].sort((left, right) =>
    compareText(left.rootId, right.rootId) || compareText(left.relativePath, right.relativePath)
  )) {
    digest.addAsset(expectedAsset(asset, archived));
  }
  for (const album of input.albums) {
    digest.addAlbum({
      id: album.id,
      name: album.name,
      createdAt: album.createdAt,
      updatedAt: album.updatedAt,
      position: album.position,
    }, albumMembers(album, locations));
  }
  return digest.digest();
}
