export const DETAIL_TILE_EDGE = 384;
export const DETAIL_TILE_BYTES = DETAIL_TILE_EDGE * DETAIL_TILE_EDGE * 4;
export const MIN_DETAIL_CACHE_BYTES = 32 * 1024 * 1024;
export const MAX_DETAIL_CACHE_BYTES = 256 * 1024 * 1024;

export interface DetailDimensions {
  readonly width: number;
  readonly height: number;
}

export interface DetailLevel extends DetailDimensions {
  readonly density: number;
  readonly key: string;
}

export interface DetailTileRequest {
  readonly key: string;
  readonly level: DetailLevel;
  readonly tileX: number;
  readonly tileY: number;
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
  readonly fullX: number;
  readonly fullY: number;
  readonly fullWidth: number;
  readonly fullHeight: number;
}

export interface DetailTile extends DetailTileRequest {
  readonly canvas: HTMLCanvasElement;
  readonly byteLength: number;
}

export interface DetailViewGeometry {
  readonly originX: number;
  readonly originY: number;
  readonly visibleWidth: number;
  readonly visibleHeight: number;
  readonly imageOffsetX: number;
  readonly imageOffsetY: number;
}

export function quantizeDetailDensity(requestedDensity: number): number {
  const safeDensity = Math.min(1, Math.max(1 / 1_048_576, Number.isFinite(requestedDensity) ? requestedDensity : 1));
  return Math.min(1, 2 ** Math.ceil(Math.log2(safeDensity)));
}

export function detailLevelKey(density: number): string {
  return density.toString(2);
}

export function createDetailViewGeometry(
  fullDimensions: DetailDimensions,
  viewport: { readonly width: number; readonly height: number },
  center: { readonly x: number; readonly y: number },
  cssScale: number,
): DetailViewGeometry {
  const safeScale = Number.isFinite(cssScale) && cssScale > 0 ? cssScale : 1;
  const visibleWidth = Math.min(fullDimensions.width, viewport.width / safeScale);
  const visibleHeight = Math.min(fullDimensions.height, viewport.height / safeScale);
  const maxOriginX = Math.max(0, fullDimensions.width - visibleWidth);
  const maxOriginY = Math.max(0, fullDimensions.height - visibleHeight);
  const originX = Math.max(0, Math.min(maxOriginX, (Number.isFinite(center.x) ? center.x : 0.5) * fullDimensions.width - visibleWidth / 2));
  const originY = Math.max(0, Math.min(maxOriginY, (Number.isFinite(center.y) ? center.y : 0.5) * fullDimensions.height - visibleHeight / 2));
  const imageWidth = fullDimensions.width * safeScale;
  const imageHeight = fullDimensions.height * safeScale;
  return {
    originX,
    originY,
    visibleWidth,
    visibleHeight,
    imageOffsetX: Math.max(0, (viewport.width - imageWidth) / 2),
    imageOffsetY: Math.max(0, (viewport.height - imageHeight) / 2),
  };
}

function tileRequest(level: DetailLevel, tileX: number, tileY: number, fullDimensions: DetailDimensions): DetailTileRequest {
  const x = tileX * DETAIL_TILE_EDGE;
  const y = tileY * DETAIL_TILE_EDGE;
  const width = Math.min(DETAIL_TILE_EDGE, level.width - x);
  const height = Math.min(DETAIL_TILE_EDGE, level.height - y);
  return {
    key: `${level.key}:${tileX}:${tileY}`,
    level,
    tileX,
    tileY,
    x,
    y,
    width,
    height,
    fullX: x * fullDimensions.width / level.width,
    fullY: y * fullDimensions.height / level.height,
    fullWidth: width * fullDimensions.width / level.width,
    fullHeight: height * fullDimensions.height / level.height,
  };
}

function distanceSquared(tile: DetailTileRequest, focusX: number, focusY: number): number {
  const dx = Math.max(tile.fullX - focusX, 0, focusX - (tile.fullX + tile.fullWidth));
  const dy = Math.max(tile.fullY - focusY, 0, focusY - (tile.fullY + tile.fullHeight));
  return dx * dx + dy * dy;
}

export function planDetailTiles(
  fullDimensions: DetailDimensions,
  level: DetailLevel,
  view: DetailViewGeometry,
  focus: { readonly x: number; readonly y: number },
): { readonly visible: readonly DetailTileRequest[]; readonly prefetch: readonly DetailTileRequest[] } {
  const startX = Math.max(0, view.originX / fullDimensions.width * level.width);
  const startY = Math.max(0, view.originY / fullDimensions.height * level.height);
  const endX = Math.min(level.width, (view.originX + view.visibleWidth) / fullDimensions.width * level.width);
  const endY = Math.min(level.height, (view.originY + view.visibleHeight) / fullDimensions.height * level.height);
  const tileCountX = Math.ceil(level.width / DETAIL_TILE_EDGE);
  const tileCountY = Math.ceil(level.height / DETAIL_TILE_EDGE);
  const minTileX = Math.max(0, Math.min(tileCountX - 1, Math.floor(startX / DETAIL_TILE_EDGE)));
  const minTileY = Math.max(0, Math.min(tileCountY - 1, Math.floor(startY / DETAIL_TILE_EDGE)));
  const maxTileX = Math.max(minTileX, Math.min(tileCountX - 1, Math.ceil(endX / DETAIL_TILE_EDGE) - 1));
  const maxTileY = Math.max(minTileY, Math.min(tileCountY - 1, Math.ceil(endY / DETAIL_TILE_EDGE) - 1));
  const visible: DetailTileRequest[] = [];
  const visibleKeys = new Set<string>();
  const focusX = Math.max(view.originX, Math.min(view.originX + view.visibleWidth - 1e-5, (Number.isFinite(focus.x) ? focus.x : 0.5) * fullDimensions.width));
  const focusY = Math.max(view.originY, Math.min(view.originY + view.visibleHeight - 1e-5, (Number.isFinite(focus.y) ? focus.y : 0.5) * fullDimensions.height));
  const focusTileX = Math.min(tileCountX - 1, Math.floor(focusX / fullDimensions.width * level.width / DETAIL_TILE_EDGE));
  const focusTileY = Math.min(tileCountY - 1, Math.floor(focusY / fullDimensions.height * level.height / DETAIL_TILE_EDGE));

  for (let tileY = minTileY; tileY <= maxTileY; tileY += 1) {
    for (let tileX = minTileX; tileX <= maxTileX; tileX += 1) {
      const request = tileRequest(level, tileX, tileY, fullDimensions);
      visible.push(request);
      visibleKeys.add(request.key);
    }
  }
  visible.sort((left, right) => {
    const leftContainsFocus = left.tileX === focusTileX && left.tileY === focusTileY;
    const rightContainsFocus = right.tileX === focusTileX && right.tileY === focusTileY;
    if (leftContainsFocus !== rightContainsFocus) return leftContainsFocus ? -1 : 1;
    return distanceSquared(left, focusX, focusY) - distanceSquared(right, focusX, focusY);
  });

  const prefetch: DetailTileRequest[] = [];
  for (let tileY = Math.max(0, minTileY - 1); tileY <= Math.min(tileCountY - 1, maxTileY + 1); tileY += 1) {
    for (let tileX = Math.max(0, minTileX - 1); tileX <= Math.min(tileCountX - 1, maxTileX + 1); tileX += 1) {
      const request = tileRequest(level, tileX, tileY, fullDimensions);
      if (!visibleKeys.has(request.key)) prefetch.push(request);
    }
  }
  prefetch.sort((left, right) => distanceSquared(left, focusX, focusY) - distanceSquared(right, focusX, focusY));
  return { visible, prefetch };
}

function tileIntersects(request: DetailTileRequest, tile: DetailTile): boolean {
  return request.fullX < tile.fullX + tile.fullWidth && request.fullX + request.fullWidth > tile.fullX &&
    request.fullY < tile.fullY + tile.fullHeight && request.fullY + request.fullHeight > tile.fullY;
}

function coveredArea(request: DetailTileRequest, candidates: readonly DetailTile[]): number {
  if (candidates.length === 0) return 0;
  const xEdges = new Set<number>([request.fullX, request.fullX + request.fullWidth]);
  for (const tile of candidates) {
    xEdges.add(Math.max(request.fullX, tile.fullX));
    xEdges.add(Math.min(request.fullX + request.fullWidth, tile.fullX + tile.fullWidth));
  }
  const sortedXEdges = [...xEdges].sort((left, right) => left - right);
  const epsilon = 1e-5;
  let area = 0;
  for (let edgeIndex = 0; edgeIndex < sortedXEdges.length - 1; edgeIndex += 1) {
    const left = sortedXEdges[edgeIndex]!;
    const right = sortedXEdges[edgeIndex + 1]!;
    if (right - left <= epsilon) continue;
    const intervals = candidates
      .filter((tile) => tile.fullX <= left + epsilon && tile.fullX + tile.fullWidth >= right - epsilon)
      .map((tile) => ({
        start: Math.max(request.fullY, tile.fullY),
        end: Math.min(request.fullY + request.fullHeight, tile.fullY + tile.fullHeight),
      }))
      .sort((a, b) => a.start - b.start);
    let coveredEnd = Number.NEGATIVE_INFINITY;
    let coveredHeight = 0;
    for (const interval of intervals) {
      if (interval.start > coveredEnd + epsilon) {
        coveredHeight += Math.max(0, interval.end - interval.start);
        coveredEnd = interval.end;
      } else if (interval.end > coveredEnd) {
        coveredHeight += interval.end - coveredEnd;
        coveredEnd = interval.end;
      }
    }
    area += (right - left) * coveredHeight;
  }
  return area;
}

export function coveringDetailTiles(request: DetailTileRequest, tiles: readonly DetailTile[]): readonly DetailTile[] {
  const candidates = tiles
    .filter((tile) => tile.level.density >= request.level.density && tileIntersects(request, tile))
    .sort((left, right) => right.level.density - left.level.density || left.byteLength - right.byteLength);
  if (candidates.length === 0) return [];

  const selected: DetailTile[] = [];
  let area = 0;
  const targetArea = request.fullWidth * request.fullHeight;
  const tolerance = Math.max(1e-4, targetArea * 1e-9);
  for (const candidate of candidates) {
    const nextArea = coveredArea(request, [...selected, candidate]);
    if (nextArea <= area + tolerance) continue;
    selected.push(candidate);
    area = nextArea;
    if (area >= targetArea - tolerance) return selected;
  }
  return [];
}

export class DetailTileCache {
  #tiles = new Map<string, DetailTile>();
  #protectedKeys = new Set<string>();
  #bytes = 0;
  #budget = MIN_DETAIL_CACHE_BYTES;

  get bytes(): number {
    return this.#bytes;
  }

  get budget(): number {
    return this.#budget;
  }

  setHighWaterBudget(bytes: number): void {
    this.#budget = Math.max(this.#budget, Math.min(MAX_DETAIL_CACHE_BYTES, Math.max(MIN_DETAIL_CACHE_BYTES, Math.ceil(bytes))));
  }

  setProtectedKeys(keys: Iterable<string>): void {
    this.#protectedKeys = new Set(keys);
  }

  get(key: string): DetailTile | undefined {
    const tile = this.#tiles.get(key);
    if (!tile) return undefined;
    this.#tiles.delete(key);
    this.#tiles.set(key, tile);
    return tile;
  }

  values(): readonly DetailTile[] {
    return [...this.#tiles.values()];
  }

  touch(key: string): void {
    const tile = this.#tiles.get(key);
    if (!tile) return;
    this.#tiles.delete(key);
    this.#tiles.set(key, tile);
  }

  canFitPrefetch(byteLength: number): boolean {
    return this.#bytes + byteLength <= this.#budget;
  }

  add(tile: DetailTile): boolean {
    const existing = this.#tiles.get(tile.key);
    if (existing) {
      this.#tiles.delete(tile.key);
      this.#bytes -= existing.byteLength;
      this.#dispose(existing);
    }
    while (this.#bytes + tile.byteLength > this.#budget) {
      let evicted = false;
      for (const [key, candidate] of this.#tiles) {
        if (this.#protectedKeys.has(key)) continue;
        this.#tiles.delete(key);
        this.#bytes -= candidate.byteLength;
        this.#dispose(candidate);
        evicted = true;
        break;
      }
      if (!evicted) break;
    }
    if (this.#bytes + tile.byteLength > MAX_DETAIL_CACHE_BYTES) {
      this.#dispose(tile);
      return false;
    }
    this.#tiles.set(tile.key, tile);
    this.#bytes += tile.byteLength;
    return true;
  }

  clear(): void {
    for (const tile of this.#tiles.values()) this.#dispose(tile);
    this.#tiles.clear();
    this.#protectedKeys.clear();
    this.#bytes = 0;
    this.#budget = MIN_DETAIL_CACHE_BYTES;
  }

  #dispose(tile: DetailTile): void {
    tile.canvas.width = 0;
    tile.canvas.height = 0;
  }
}
