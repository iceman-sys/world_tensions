import { faceToDir, texelSolidAngle, texelToFaceCoord } from './cube.ts';
import { warpDir, type Vec3Tuple } from './warp.ts';

export interface RasterParams {
  /** warped-space seed directions, xyz per country */
  seeds: Float32Array;
  weights: Float32Array;
  warpOffset: Vec3Tuple;
  /** interior texels per face side */
  N: number;
  /** gutter texels */
  G: number;
}

export interface FaceRaster {
  face: number;
  /** S*S country ids, row-major (row = j) */
  ids: Uint8Array;
  /** per-country solid angle (sr) of interior texels */
  area: Float64Array;
  /** per-country solid-angle-weighted direction sums (for centroids) */
  cx: Float64Array;
  cy: Float64Array;
  cz: Float64Array;
  /** n*n adjacency flags (1 = share a border somewhere on this face) */
  adjacency: Uint8Array;
}

/**
 * The warp is smooth, so it is evaluated on a coarse grid and bilinearly
 * interpolated. The grid spacing is fixed in angle (~1/256 of a face) so the
 * interpolation error stays well under a texel at every resolution.
 */
const warpStepFor = (N: number) => Math.max(1, Math.round(N / 256));
/** Candidate seeds are pre-selected per block of texels spanning ~2.8 degrees. */
const cellFor = (N: number) => Math.max(2, Math.round(N / 32));
const CANDIDATES = 12;

/**
 * Rasterises one cube face (with gutter) of the country map.
 * Pure function: used by the client Web Workers and by the tests.
 */
export function rasterizeFace(p: RasterParams, face: number, onProgress?: (fraction: number) => void): FaceRaster {
  const { seeds, weights, warpOffset, N, G } = p;
  const n = weights.length;
  const S = N + 2 * G;
  const dir = new Float64Array(3);
  const wd = new Float64Array(3);

  // --- 1. coarse warp grid ---
  const WARP_STEP = warpStepFor(N);
  const gc = Math.ceil((S - 1) / WARP_STEP) + 1;
  const grid = new Float64Array(gc * gc * 3);
  for (let gj = 0; gj < gc; gj++) {
    const b = texelToFaceCoord(gj * WARP_STEP, N, G);
    for (let gi = 0; gi < gc; gi++) {
      const a = texelToFaceCoord(gi * WARP_STEP, N, G);
      faceToDir(face, a, b, dir);
      warpDir(dir[0], dir[1], dir[2], warpOffset, wd);
      const o = (gj * gc + gi) * 3;
      grid[o] = wd[0];
      grid[o + 1] = wd[1];
      grid[o + 2] = wd[2];
    }
  }

  const sampleWarp = (i: number, j: number, out: Float64Array) => {
    const fx = i / WARP_STEP;
    const fy = j / WARP_STEP;
    const x0 = Math.min(gc - 2, Math.floor(fx));
    const y0 = Math.min(gc - 2, Math.floor(fy));
    const tx = fx - x0;
    const ty = fy - y0;
    const o00 = (y0 * gc + x0) * 3;
    const o10 = o00 + 3;
    const o01 = o00 + gc * 3;
    const o11 = o01 + 3;
    const w00 = (1 - tx) * (1 - ty), w10 = tx * (1 - ty), w01 = (1 - tx) * ty, w11 = tx * ty;
    const x = grid[o00] * w00 + grid[o10] * w10 + grid[o01] * w01 + grid[o11] * w11;
    const y = grid[o00 + 1] * w00 + grid[o10 + 1] * w10 + grid[o01 + 1] * w01 + grid[o11 + 1] * w11;
    const z = grid[o00 + 2] * w00 + grid[o10 + 2] * w10 + grid[o01 + 2] * w01 + grid[o11 + 2] * w11;
    const inv = 1 / Math.hypot(x, y, z);
    out[0] = x * inv;
    out[1] = y * inv;
    out[2] = z * inv;
  };

  // --- 2. candidate lists per cell (top-K seeds by score at the cell centre) ---
  const CELL = cellFor(N);
  const cc = Math.ceil(S / CELL);
  const cand = new Int16Array(cc * cc * CANDIDATES);
  const topScore = new Float64Array(CANDIDATES);
  const topId = new Int16Array(CANDIDATES);
  for (let cj = 0; cj < cc; cj++) {
    for (let ci = 0; ci < cc; ci++) {
      sampleWarp(Math.min(S - 1, ci * CELL + CELL / 2), Math.min(S - 1, cj * CELL + CELL / 2), wd);
      topScore.fill(-Infinity);
      topId.fill(0);
      for (let c = 0; c < n; c++) {
        const s = wd[0] * seeds[c * 3] + wd[1] * seeds[c * 3 + 1] + wd[2] * seeds[c * 3 + 2] + weights[c];
        if (s <= topScore[CANDIDATES - 1]) continue;
        let k = CANDIDATES - 1;
        while (k > 0 && topScore[k - 1] < s) {
          topScore[k] = topScore[k - 1];
          topId[k] = topId[k - 1];
          k--;
        }
        topScore[k] = s;
        topId[k] = c;
      }
      cand.set(topId, (cj * cc + ci) * CANDIDATES);
    }
  }

  // --- 3. per-texel nearest seed + stats ---
  const ids = new Uint8Array(S * S);
  const area = new Float64Array(n);
  const cx = new Float64Array(n);
  const cy = new Float64Array(n);
  const cz = new Float64Array(n);
  const faceA = new Float64Array(S);
  for (let i = 0; i < S; i++) faceA[i] = texelToFaceCoord(i, N, G);

  for (let j = 0; j < S; j++) {
    const interiorRow = j >= G && j < G + N;
    const rowCell = Math.floor(j / CELL) * cc;
    for (let i = 0; i < S; i++) {
      sampleWarp(i, j, wd);
      const base = (rowCell + Math.floor(i / CELL)) * CANDIDATES;
      let best = cand[base];
      let bestScore = -Infinity;
      for (let k = 0; k < CANDIDATES; k++) {
        const c = cand[base + k];
        const s = wd[0] * seeds[c * 3] + wd[1] * seeds[c * 3 + 1] + wd[2] * seeds[c * 3 + 2] + weights[c];
        if (s > bestScore) { bestScore = s; best = c; }
      }
      ids[j * S + i] = best;
      if (interiorRow && i >= G && i < G + N) {
        const sa = texelSolidAngle(faceA[i], faceA[j], N);
        faceToDir(face, faceA[i], faceA[j], dir);
        area[best] += sa;
        cx[best] += dir[0] * sa;
        cy[best] += dir[1] * sa;
        cz[best] += dir[2] * sa;
      }
    }
    if (onProgress && (j & 63) === 63) onProgress(j / S);
  }

  // --- 4. adjacency (gutter texels make cross-face borders visible) ---
  const adjacency = new Uint8Array(n * n);
  for (let j = 0; j < S; j++) {
    for (let i = 0; i < S; i++) {
      const a = ids[j * S + i];
      if (i + 1 < S) {
        const b = ids[j * S + i + 1];
        if (a !== b) { adjacency[a * n + b] = 1; adjacency[b * n + a] = 1; }
      }
      if (j + 1 < S) {
        const b = ids[(j + 1) * S + i];
        if (a !== b) { adjacency[a * n + b] = 1; adjacency[b * n + a] = 1; }
      }
    }
  }
  onProgress?.(1);

  return { face, ids, area, cx, cy, cz, adjacency };
}
