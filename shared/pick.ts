import { dirToFace, faceCoordToTexel, faceOrigin, type AtlasLayout } from './cube.ts';
import { warpDir, type Vec3Tuple } from './warp.ts';

export interface PickContext {
  atlas: Uint8Array;
  layout: AtlasLayout;
  seeds: Float32Array;
  weights: Float32Array;
  warpOffset: Vec3Tuple;
}

/** 3x3 texel lookup pattern (x, y pairs), mirrored in the planet shader. */
const R = 1.5;
const OFFSETS = [0, 0, R, 0, -R, 0, 0, R, 0, -R, R, R, -R, R, R, -R, -R, -R];

/** Country id stored in the atlas texel that contains (x, y, z). */
export function atlasLookup(atlas: Uint8Array, layout: AtlasLayout, x: number, y: number, z: number): number {
  const f = new Float64Array(3);
  dirToFace(x, y, z, f);
  const { N, G, S, width } = layout;
  const [ox, oy] = faceOrigin(f[0], S);
  const tx = Math.min(S - 1, Math.max(0, Math.floor(faceCoordToTexel(f[1], N, G))));
  const ty = Math.min(S - 1, Math.max(0, Math.floor(faceCoordToTexel(f[2], N, G))));
  return atlas[(oy + ty) * width + ox + tx];
}

/**
 * Exact country under a unit direction. The atlas only supplies nearby candidate
 * ids; the winner is decided by the same warped weighted-nearest-seed rule the
 * shader uses, so picking matches the drawn borders to sub-texel precision.
 */
export function createPicker(ctx: PickContext): (x: number, y: number, z: number) => number {
  const f = new Float64Array(3);
  const w = new Float64Array(3);
  const cands = new Int16Array(9);
  return (x, y, z) => {
    const { atlas, layout, seeds, weights, warpOffset } = ctx;
    const { N, G, S, width } = layout;
    dirToFace(x, y, z, f);
    const [ox, oy] = faceOrigin(f[0], S);
    const tx = faceCoordToTexel(f[1], N, G);
    const ty = faceCoordToTexel(f[2], N, G);
    let count = 0;
    for (let k = 0; k < OFFSETS.length; k += 2) {
      const ix = Math.min(S - 1, Math.max(0, Math.floor(tx + OFFSETS[k])));
      const iy = Math.min(S - 1, Math.max(0, Math.floor(ty + OFFSETS[k + 1])));
      const id = atlas[(oy + iy) * width + ox + ix];
      let dup = false;
      for (let q = 0; q < count; q++) if (cands[q] === id) dup = true;
      if (!dup) cands[count++] = id;
    }
    if (count === 1) return cands[0];
    warpDir(x, y, z, warpOffset, w);
    let best = cands[0];
    let bestScore = -Infinity;
    for (let q = 0; q < count; q++) {
      const c = cands[q];
      const s = w[0] * seeds[c * 3] + w[1] * seeds[c * 3 + 1] + w[2] * seeds[c * 3 + 2] + weights[c];
      if (s > bestScore) { bestScore = s; best = c; }
    }
    return best;
  };
}

/** Brute force reference: weighted-nearest seed over all countries (tests only). */
export function bruteForceCountry(seeds: Float32Array, weights: Float32Array, warpOffset: Vec3Tuple, x: number, y: number, z: number): number {
  const w = new Float64Array(3);
  warpDir(x, y, z, warpOffset, w);
  let best = 0;
  let bestScore = -Infinity;
  for (let c = 0; c < weights.length; c++) {
    const s = w[0] * seeds[c * 3] + w[1] * seeds[c * 3 + 1] + w[2] * seeds[c * 3 + 2] + weights[c];
    if (s > bestScore) { bestScore = s; best = c; }
  }
  return best;
}
