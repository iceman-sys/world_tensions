import { packSeeds, type EarthMeta } from '../../shared/earth.ts';
import { rasterizeFace } from '../../shared/raster.ts';
import { DEFAULT_FACE_SIZE, GUTTER } from '../../shared/cube.ts';

/**
 * Authoritative neighbour graph: rasterises the same cube map the client draws
 * (at the client's default resolution) and collects every pair of cells that
 * share a border. Takes 1-2 s, so the result is cached in the database.
 */
export function computeNeighbors(meta: EarthMeta, N = DEFAULT_FACE_SIZE): number[][] {
  const n = meta.countries.length;
  const { seeds, weights } = packSeeds(meta);
  const adjacency = new Uint8Array(n * n);
  for (let face = 0; face < 6; face++) {
    const r = rasterizeFace({ seeds, weights, warpOffset: meta.warpOffset, N, G: GUTTER }, face);
    for (let k = 0; k < adjacency.length; k++) adjacency[k] |= r.adjacency[k];
  }
  const out: number[][] = [];
  for (let c = 0; c < n; c++) {
    const list: number[] = [];
    for (let o = 0; o < n; o++) if (o !== c && adjacency[c * n + o]) list.push(o);
    out.push(list);
  }
  return out;
}

export function isValidNeighborGraph(v: unknown, n: number): v is number[][] {
  return (
    Array.isArray(v) &&
    v.length === n &&
    v.every((list) => Array.isArray(list) && list.every((x) => Number.isInteger(x) && x >= 0 && x < n))
  );
}
