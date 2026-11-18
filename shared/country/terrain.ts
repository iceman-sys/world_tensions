/**
 * Deterministic local terrain for a nation (pure: same input, same output).
 * Used by the client (rendering, placement preview) and the server (placement
 * validation), so both agree on land, water and slope tile by tile.
 */
import { snoise3 } from '../noise.ts';
import { packSeeds, type EarthMeta } from '../earth.ts';
import { deriveSeed, mulberry32, type Rng } from '../rng.ts';
import { BIOME, MASK, RESOURCE_SPOT, TERRAIN, WATER, type SpotKind } from './config.ts';
import { cellsNear, computeFrame, createRestrictedSampler, gridDir, type LocalFrame, type SamplerInput } from './sampler.ts';

export interface TerrainInput extends SamplerInput {
  earthSeed: number;
  homeCell: number;
  /** cells held by the nation */
  ownCells: number[];
  /** the nation's natural resources (names from the catalog) */
  resources: string[];
  size?: number;
  frameSamples?: number;
}

export interface ResourceSpot {
  resource: string;
  kind: SpotKind;
  /** centre tile */
  i: number;
  j: number;
  /** radius in tiles */
  r: number;
}

export interface LocalTerrain {
  size: number;
  frame: LocalFrame;
  /** cell id per tile (from the exact sampler) */
  cells: Int16Array;
  mask: Uint8Array;
  heights: Float32Array;
  water: Uint8Array;
  biome: Uint8Array;
  /** max absolute height difference to a 4-neighbour */
  slope: Float32Array;
  /** distance (tiles) from an own tile to the nearest non-own tile; 0 elsewhere */
  inland: Float32Array;
  capital: { i: number; j: number };
  spots: ResourceSpot[];
  lakes: { i: number; j: number; r: number }[];
  /** tile indices along each river, source to mouth */
  rivers: number[][];
  /** latitude of the frame centre, radians */
  latitude: number;
}

const SQRT2 = Math.SQRT2;

/** Two-pass chamfer distance transform: distance from each tile to the nearest `source` tile. */
export function distanceTransform(n: number, isSource: (k: number) => boolean): Float32Array {
  const d = new Float32Array(n * n);
  for (let k = 0; k < n * n; k++) d[k] = isSource(k) ? 0 : 1e9;
  for (let j = 0; j < n; j++) {
    for (let i = 0; i < n; i++) {
      const k = j * n + i;
      let v = d[k];
      if (i > 0) v = Math.min(v, d[k - 1] + 1);
      if (j > 0) {
        v = Math.min(v, d[k - n] + 1);
        if (i > 0) v = Math.min(v, d[k - n - 1] + SQRT2);
        if (i < n - 1) v = Math.min(v, d[k - n + 1] + SQRT2);
      }
      d[k] = v;
    }
  }
  for (let j = n - 1; j >= 0; j--) {
    for (let i = n - 1; i >= 0; i--) {
      const k = j * n + i;
      let v = d[k];
      if (i < n - 1) v = Math.min(v, d[k + 1] + 1);
      if (j < n - 1) {
        v = Math.min(v, d[k + n] + 1);
        if (i < n - 1) v = Math.min(v, d[k + n + 1] + SQRT2);
        if (i > 0) v = Math.min(v, d[k + n - 1] + SQRT2);
      }
      d[k] = v;
    }
  }
  return d;
}

function fbm2(x: number, y: number, z: number, octaves: number): number {
  let sum = 0, amp = 0.5, fr = 1;
  for (let o = 0; o < octaves; o++) {
    sum += amp * snoise3(x * fr, y * fr, z * fr);
    fr *= 2.03;
    amp *= 0.5;
  }
  return sum;
}

const smooth = (a: number, b: number, x: number) => {
  const t = Math.max(0, Math.min(1, (x - a) / (b - a)));
  return t * t * (3 - 2 * t);
};

export function generateLocalTerrain(input: TerrainInput): LocalTerrain {
  const n = input.size ?? TERRAIN.size;
  const N = n * n;
  const frame = computeFrame(input, input.ownCells, input.frameSamples ?? TERRAIN.frameSamples, TERRAIN.frameMargin);
  // the frame corner is atan(halfTan * sqrt2) from the centre
  const sample = createRestrictedSampler(input, cellsNear(input, [frame.center], Math.atan(frame.halfTan * Math.SQRT2)));
  const own = new Set(input.ownCells);

  // ---- 1. exact cell per tile -> own mask ----
  const cells = new Int16Array(N);
  const dir = new Float64Array(3);
  for (let j = 0; j < n; j++) {
    for (let i = 0; i < n; i++) {
      gridDir(frame, n, i, j, dir);
      cells[j * n + i] = sample(dir[0], dir[1], dir[2]);
    }
  }
  const isOwn = (k: number) => own.has(cells[k]);
  const toOwn = distanceTransform(n, isOwn);
  const inland = distanceTransform(n, (k) => !isOwn(k));
  const mask = new Uint8Array(N);
  for (let k = 0; k < N; k++) {
    if (isOwn(k)) mask[k] = MASK.own;
    else if (toOwn[k] <= TERRAIN.channelWidth) mask[k] = MASK.channel;
    else if (toOwn[k] <= TERRAIN.channelWidth + TERRAIN.neighborStrip) mask[k] = MASK.neighbor;
    else mask[k] = MASK.outside;
    if (!isOwn(k)) inland[k] = 0;
  }

  // ---- 2. heights ----
  const tseed = deriveSeed(input.earthSeed, `terrain:${input.homeCell}`);
  const rng = mulberry32(tseed);
  const ox = rng() * 200 - 100, oy = rng() * 200 - 100, oz = rng() * 200 - 100;
  const scale = 3.2 / n; // ~3 noise periods across the frame
  const heights = new Float32Array(N);
  const moist = new Float32Array(N);
  for (let j = 0; j < n; j++) {
    for (let i = 0; i < n; i++) {
      const k = j * n + i;
      const x = i * scale + ox, y = j * scale + oy;
      const base = fbm2(x, y, oz, 5) * 0.5 + 0.5;
      const ridge = 1 - Math.abs(snoise3(x * 0.9 + 7.3, y * 0.9 - 3.1, oz + 11));
      const mountainMask = smooth(0.05, 0.55, fbm2(x * 0.55 + 31, y * 0.55 + 17, oz - 5, 3) + 0.15);
      moist[k] = fbm2(x * 0.8 - 40, y * 0.8 + 12, oz + 23, 4);
      const m = mask[k];
      if (m === MASK.own) {
        // gentle beach: rises from just above water at the border to lowland, then inland relief
        const shore = 0.12 + (TERRAIN.lowland - 0.12) * smooth(0, 3, inland[k]);
        const coast = smooth(0, TERRAIN.coastRamp, inland[k]);
        heights[k] = shore + coast * (TERRAIN.hills * base + TERRAIN.mountains * ridge * ridge * ridge * mountainMask);
      } else {
        // continuous profile by distance from the border: channel bed, neighbour bank, then open sea
        const d = toOwn[k];
        const cw = TERRAIN.channelWidth;
        const outer = cw + TERRAIN.neighborStrip;
        const bed = TERRAIN.channelDepth * smooth(0, cw * 0.6, d);
        const bank = (0.45 + 1.4 * base) * smooth(cw * 0.75, cw + 2, d) * (1 - smooth(outer - 3, outer + 1, d));
        const sea = TERRAIN.seaDepth * smooth(outer - 1, outer + 4, d);
        heights[k] = d <= cw ? bed : Math.min(bank + TERRAIN.channelDepth * (1 - smooth(cw * 0.75, cw + 2, d)), 2.5) + sea;
      }
    }
  }

  const water = new Uint8Array(N);
  for (let k = 0; k < N; k++) if (mask[k] === MASK.channel || mask[k] === MASK.outside) water[k] = WATER.sea;

  // ---- 3. lakes: bowls carved below water level on interior land ----
  const lakes: LocalTerrain['lakes'] = [];
  const interior: number[] = [];
  for (let k = 0; k < N; k++) if (inland[k] > 14 && heights[k] < TERRAIN.lowland + TERRAIN.hills * 0.9) interior.push(k);
  for (let l = 0; l < TERRAIN.lakeCount && interior.length; l++) {
    const k = interior[Math.floor(rng() * interior.length)];
    const ci = k % n, cj = Math.floor(k / n);
    const r = TERRAIN.lakeRadius[0] + rng() * (TERRAIN.lakeRadius[1] - TERRAIN.lakeRadius[0]);
    if (lakes.some((o) => Math.hypot(o.i - ci, o.j - cj) < o.r + r + 6)) continue;
    const rr = Math.min(r, inland[k] - 3);
    if (rr < 3) continue;
    lakes.push({ i: ci, j: cj, r: rr });
    // the basin blends into the surrounding land over 2.6 radii, so there is no crater rim
    const R = Math.ceil(rr * 2.6);
    for (let dj = -R; dj <= R; dj++) {
      for (let di = -R; di <= R; di++) {
        const i = ci + di, j = cj + dj;
        if (i < 0 || j < 0 || i >= n || j >= n) continue;
        const q = j * n + i;
        if (mask[q] !== MASK.own) continue;
        const d = Math.hypot(di, dj) / rr;
        if (d < 1) {
          heights[q] = Math.min(heights[q], -0.4 - 1.2 * (1 - d * d));
          water[q] = WATER.lake;
        } else if (d < 2.6) {
          const shore = 0.2 + (d - 1) * 0.5;
          heights[q] = Math.min(heights[q], shore + (heights[q] - shore) * smooth(1, 2.6, d));
        }
      }
    }
  }

  // ---- 4. rivers: steepest descent from high ground to any water ----
  const rivers: number[][] = [];
  const high: number[] = [];
  for (let k = 0; k < N; k++) if (mask[k] === MASK.own && inland[k] > 10 && water[k] === WATER.none) high.push(k);
  high.sort((a, b) => heights[b] - heights[a] || a - b);
  // springs rise in the hills, not on the peaks
  const pool = high.slice(Math.floor(high.length * 0.12), Math.max(1, Math.floor(high.length * 0.35)));
  const NB = [-1, 0, 1, 0, 0, -1, 0, 1, -1, -1, 1, -1, -1, 1, 1, 1];
  for (let r = 0; r < TERRAIN.riverCount * 8 && rivers.length < TERRAIN.riverCount && pool.length; r++) {
    let k = pool[Math.floor(rng() * pool.length)];
    if (rivers.some((path) => path.includes(k))) continue;
    const path: number[] = [];
    const seen = new Set<number>();
    let reachedWater = false;
    for (let step = 0; step < n * 3; step++) {
      path.push(k);
      seen.add(k);
      if (water[k] === WATER.lake || water[k] === WATER.sea) {
        reachedWater = true;
        break;
      }
      const i = k % n, j = Math.floor(k / n);
      let best = -1;
      let bestH = Infinity;
      let sill = -1;
      let sillH = Infinity;
      for (let q = 0; q < NB.length; q += 2) {
        const a = i + NB[q], b = j + NB[q + 1];
        if (a < 0 || b < 0 || a >= n || b >= n) continue;
        const nk = b * n + a;
        if (seen.has(nk)) continue;
        if (heights[nk] < sillH) {
          sillH = heights[nk];
          sill = nk;
        }
        // water flows downhill (a tiny tolerance crosses flats); noise picks among the
        // downhill options so the course meanders, and on flats it heads for the coast
        if (heights[nk] > heights[k] + 0.04) continue;
        const h = heights[nk] + inland[nk] * 0.02 + snoise3(a * 0.09 + ox, b * 0.09 + oy, 3.7 + r) * 0.35;
        if (h < bestH) {
          bestH = h;
          best = nk;
        }
      }
      // in a small sink the river spills over the lowest low sill; a high one ends it
      if (best < 0 && sill >= 0 && sillH <= heights[k] + 0.6) best = sill;
      if (best < 0) break;
      k = best;
    }
    if (!reachedWater || path.length < 12) continue;
    // carve: never rising downstream, a little below the surrounding land
    let level = heights[path[0]] - TERRAIN.riverDepth;
    for (const q of path) {
      if (water[q] === WATER.lake || water[q] === WATER.sea) break;
      level = Math.min(level, heights[q] - TERRAIN.riverDepth);
      heights[q] = Math.max(level, 0.05);
      water[q] = WATER.river;
    }
    rivers.push(path);
  }

  // ---- 4b. soften the border: blur heights in a band around it (removes stair-step cliffs) ----
  const band = (k: number) => (mask[k] === MASK.own ? inland[k] < 4 : toOwn[k] < TERRAIN.channelWidth + TERRAIN.neighborStrip + 5);
  const tmp = new Float32Array(N);
  for (let pass = 0; pass < 2; pass++) {
    tmp.set(heights);
    for (let j = 1; j < n - 1; j++) {
      for (let i = 1; i < n - 1; i++) {
        const k = j * n + i;
        if (!band(k) || water[k] === WATER.river) continue;
        let s = 0;
        for (let dj = -1; dj <= 1; dj++) for (let di = -1; di <= 1; di++) s += tmp[k + dj * n + di];
        heights[k] = s / 9;
      }
    }
  }
  // own land stays above water so the silhouette is exactly the country's border
  for (let k = 0; k < N; k++) {
    if (mask[k] === MASK.own && water[k] === WATER.none) heights[k] = Math.max(heights[k], 0.08);
    else if (mask[k] !== MASK.own) heights[k] = Math.min(heights[k], mask[k] === MASK.channel ? -0.25 : heights[k]);
  }

  // ---- 5. slope ----
  const slope = new Float32Array(N);
  for (let j = 0; j < n; j++) {
    for (let i = 0; i < n; i++) {
      const k = j * n + i;
      const h = heights[k];
      let s = 0;
      if (i > 0) s = Math.max(s, Math.abs(h - heights[k - 1]));
      if (i < n - 1) s = Math.max(s, Math.abs(h - heights[k + 1]));
      if (j > 0) s = Math.max(s, Math.abs(h - heights[k - n]));
      if (j < n - 1) s = Math.max(s, Math.abs(h - heights[k + n]));
      slope[k] = s;
    }
  }

  // ---- 6. biomes: latitude sets the climate, height and moisture the local cover ----
  const latitude = Math.asin(Math.max(-1, Math.min(1, frame.center[1])));
  const warmth = 1 - Math.abs(latitude) / (Math.PI / 2);
  const biome = new Uint8Array(N);
  for (let k = 0; k < N; k++) {
    // a little noise on the thresholds so snowlines and forest edges are not blocky
    const h = heights[k] + moist[k] * 2.2;
    const t = warmth - h * 0.022;
    if (h < 0.6 && mask[k] === MASK.own && water[k] === WATER.none && inland[k] < 3) biome[k] = BIOME.sand;
    // snow on high ground; in cold countries the snowline comes down, but lowlands stay tundra/taiga
    else if (h > TERRAIN.mountains * 0.72 || (t < 0.18 && h > 4) || t < 0.02) biome[k] = BIOME.snow;
    else if (slope[k] > TERRAIN.steepSlope * 1.2 || h > TERRAIN.mountains * 0.5) biome[k] = BIOME.rock;
    else if (warmth > 0.68 && moist[k] < -0.08) biome[k] = BIOME.desert;
    else if (moist[k] > 0.12) biome[k] = BIOME.forest;
    else biome[k] = BIOME.grass;
  }

  // ---- 7. capital: the most interior flat dry tile, nudged towards the frame centre ----
  let capK = -1;
  let capScore = -Infinity;
  const c0 = (n - 1) / 2;
  // the town needs dry room around it: prefer tiles away from lakes and rivers
  const toWater = distanceTransform(n, (k) => water[k] === WATER.lake || water[k] === WATER.river);
  for (let k = 0; k < N; k++) {
    if (mask[k] !== MASK.own || water[k] !== WATER.none || slope[k] > TERRAIN.steepSlope * 0.5) continue;
    const i = k % n, j = Math.floor(k / n);
    // towns grow in the lowlands: height costs much more than distance from the centre
    const score = Math.min(inland[k], 24) + Math.min(toWater[k], 12) * 0.8 - Math.hypot(i - c0, j - c0) * 0.05 - heights[k] * 2.5 - slope[k] * 6;
    if (score > capScore) {
      capScore = score;
      capK = k;
    }
  }
  if (capK < 0) capK = Math.floor(N / 2);
  const capital = { i: capK % n, j: Math.floor(capK / n) };

  // ---- 8. resource spots: one site per natural resource, placed deterministically ----
  const spots = placeSpots(input.resources, n, mask, water, slope, inland, heights, capital, rng);

  return { size: n, frame, cells, mask, heights, water, biome, slope, inland, capital, spots, lakes, rivers, latitude };
}

function placeSpots(
  resources: string[],
  n: number,
  mask: Uint8Array,
  water: Uint8Array,
  slope: Float32Array,
  inland: Float32Array,
  heights: Float32Array,
  capital: { i: number; j: number },
  rng: Rng,
): ResourceSpot[] {
  const spots: ResourceSpot[] = [];
  const nearWater = (k: number) => {
    const i = k % n, j = Math.floor(k / n);
    for (let dj = -3; dj <= 3; dj++) {
      for (let di = -3; di <= 3; di++) {
        const a = i + di, b = j + dj;
        if (a >= 0 && b >= 0 && a < n && b < n && water[b * n + a] !== WATER.none && water[b * n + a] !== WATER.river) return true;
      }
    }
    return false;
  };
  const s = n / 256; // distances are tuned for the default 256 grid
  const dry: number[] = [];
  for (let k = 0; k < n * n; k++) if (mask[k] === MASK.own && water[k] === WATER.none) dry.push(k);
  for (const resource of resources) {
    const kind = RESOURCE_SPOT[resource]?.kind ?? 'mine';
    const r = Math.max(2, Math.round((kind === 'field' || kind === 'pasture' ? 7 : kind === 'grove' ? 8 : 4) * s));
    let best = -1;
    // relax the constraints step by step so every resource always gets a site
    for (let relax = 0; relax < 3 && best < 0; relax++) {
      const minCap = relax === 2 ? 0 : 18 * s * (relax === 0 ? 1 : 0.5);
      const gap = relax === 2 ? 0 : 6 * s;
      let bestScore = -Infinity;
      for (let t = 0; t < 400 && dry.length; t++) {
        const k = dry[Math.floor(rng() * dry.length)];
        const i = k % n, j = Math.floor(k / n);
        const dCap = Math.hypot(i - capital.i, j - capital.j);
        if (dCap < minCap) continue;
        if (relax < 2 && spots.some((o) => Math.hypot(o.i - i, o.j - j) < o.r + r + gap)) continue;
        let score = Math.min(dCap, 60 * s) * 0.05;
        if (kind === 'fishery') score += nearWater(k) ? 10 : -10;
        else if (relax === 0 && inland[k] < r + 2) continue;
        if (kind === 'mine') score += Math.min(heights[k], 7) * 0.25 - slope[k] * 2; // ores in the foothills, not on peaks
        if (kind === 'field' || kind === 'pasture' || kind === 'oil') score -= slope[k] * 3 + heights[k] * 0.2; // flat lowland
        if (score > bestScore) {
          bestScore = score;
          best = k;
        }
      }
    }
    if (best >= 0) spots.push({ resource, kind, i: best % n, j: Math.floor(best / n), r });
  }
  return spots;
}

/** Terrain input for a nation from the Earth metadata (same on client and server). */
export function terrainInputFor(meta: EarthMeta, homeCell: number, ownCells: number[], resources: string[], size?: number): TerrainInput {
  const { seeds, weights } = packSeeds(meta);
  return { seeds, weights, warpOffset: meta.warpOffset, earthSeed: meta.seed, homeCell, ownCells: [...ownCells].sort((a, b) => a - b), resources, size };
}

/** Scene position of tile (i, j): x east, z south (three.js y-up). */
export function tileToWorld(n: number, i: number, j: number): { x: number; z: number } {
  const c = (n - 1) / 2;
  return { x: (i - c) * TERRAIN.cellSize, z: -(j - c) * TERRAIN.cellSize };
}
