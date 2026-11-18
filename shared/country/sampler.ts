/**
 * Exact border sampling for the local view. A direction belongs to the cell whose
 * seed has the highest warped score (the same rule as shared/pick.ts and the planet
 * shader). Only cells whose seed lies within a safe angular radius of the area are
 * scored; no cell can own a point that far from its seed, so the result is exact.
 */

/** No cell reaches farther than this from its (warped) seed direction, radians. */
export const CELL_REACH = 0.5;

/** Cells whose seed is within `angle` (+ CELL_REACH) of any of the given unit directions. */
export function cellsNear(input: SamplerInput, dirs: readonly Vec3Tuple[], angle: number): number[] {
  const cos = Math.cos(Math.min(Math.PI, angle + CELL_REACH));
  const out: number[] = [];
  const n = input.weights.length;
  for (let c = 0; c < n; c++) {
    const sx = input.seeds[c * 3], sy = input.seeds[c * 3 + 1], sz = input.seeds[c * 3 + 2];
    const l = Math.hypot(sx, sy, sz) || 1;
    for (const d of dirs) {
      if ((sx * d[0] + sy * d[1] + sz * d[2]) / l > cos) {
        out.push(c);
        break;
      }
    }
  }
  return out;
}
import { warpDir, type Vec3Tuple } from '../warp.ts';

export interface SamplerInput {
  /** warped-space seed directions, xyz per cell (packSeeds) */
  seeds: Float32Array;
  weights: Float32Array;
  warpOffset: Vec3Tuple;
}

export type CellSampler = (x: number, y: number, z: number) => number;

export function createRestrictedSampler(input: SamplerInput, candidates: readonly number[]): CellSampler {
  const { seeds, weights, warpOffset } = input;
  const ids = Int32Array.from(new Set(candidates));
  const w = new Float64Array(3);
  return (x, y, z) => {
    warpDir(x, y, z, warpOffset, w);
    let best = ids[0];
    let bestScore = -Infinity;
    for (let k = 0; k < ids.length; k++) {
      const c = ids[k];
      const s = w[0] * seeds[c * 3] + w[1] * seeds[c * 3 + 1] + w[2] * seeds[c * 3 + 2] + weights[c];
      if (s > bestScore) {
        bestScore = s;
        best = c;
      }
    }
    return best;
  };
}

/** Tangent-plane frame of the local view (gnomonic projection around the centroid). */
export interface LocalFrame {
  center: Vec3Tuple;
  east: Vec3Tuple;
  north: Vec3Tuple;
  /** half-width of the frame in tangent-plane units (tan of the half angle) */
  halfTan: number;
}

function normalize(v: Vec3Tuple): Vec3Tuple {
  const l = Math.hypot(v[0], v[1], v[2]) || 1;
  return [v[0] / l, v[1] / l, v[2] / l];
}

export function frameBasis(center: Vec3Tuple): { east: Vec3Tuple; north: Vec3Tuple } {
  // same convention as the planet shader's flag projection
  const c = normalize(center);
  const east: Vec3Tuple = Math.abs(c[1]) > 0.98 ? [1, 0, 0] : normalize([c[2], 0, -c[0]]);
  const north: Vec3Tuple = [c[1] * east[2] - c[2] * east[1], c[2] * east[0] - c[0] * east[2], c[0] * east[1] - c[1] * east[0]];
  return { east, north };
}

/**
 * Centroid and extent of the nation's cells, from a fixed Fibonacci sampling of
 * the sphere (deterministic, identical on client and server).
 */
export function computeFrame(input: SamplerInput, ownCells: readonly number[], samples: number, margin: number): LocalFrame {
  const own = new Set(ownCells);
  const caps = ownCells.map((c) => normalize([input.seeds[c * 3], input.seeds[c * 3 + 1], input.seeds[c * 3 + 2]]));
  const sample = createRestrictedSampler(input, cellsNear(input, caps, CELL_REACH));
  const capCos = Math.cos(CELL_REACH);
  const golden = Math.PI * (3 - Math.sqrt(5));
  const pts: number[] = [];
  let sx = 0, sy = 0, sz = 0;
  for (let i = 0; i < samples; i++) {
    const y = 1 - ((i + 0.5) / samples) * 2;
    const r = Math.sqrt(1 - y * y);
    const th = golden * i;
    const x = Math.cos(th) * r;
    const z = Math.sin(th) * r;
    let near = false;
    for (const cap of caps) if (x * cap[0] + y * cap[1] + z * cap[2] > capCos) near = true;
    if (!near || !own.has(sample(x, y, z))) continue;
    pts.push(x, y, z);
    sx += x;
    sy += y;
    sz += z;
  }
  let center: Vec3Tuple = pts.length ? normalize([sx, sy, sz]) : caps[0] ?? [0, 0, 1];
  // fit a square to the land's bounding box in the tangent plane (two passes: re-centre, then measure)
  let half = 0.05;
  for (let pass = 0; pass < 2; pass++) {
    const { east, north } = frameBasis(center);
    let u0 = Infinity, u1 = -Infinity, v0 = Infinity, v1 = -Infinity;
    for (let i = 0; i < pts.length; i += 3) {
      const d = pts[i] * center[0] + pts[i + 1] * center[1] + pts[i + 2] * center[2];
      if (d <= 0.05) continue;
      const u = (pts[i] * east[0] + pts[i + 1] * east[1] + pts[i + 2] * east[2]) / d;
      const v = (pts[i] * north[0] + pts[i + 1] * north[1] + pts[i + 2] * north[2]) / d;
      u0 = Math.min(u0, u); u1 = Math.max(u1, u);
      v0 = Math.min(v0, v); v1 = Math.max(v1, v);
    }
    if (!Number.isFinite(u0)) break;
    if (pass === 0) {
      const uc = (u0 + u1) / 2, vc = (v0 + v1) / 2;
      center = normalize([center[0] + uc * east[0] + vc * north[0], center[1] + uc * east[1] + vc * north[1], center[2] + uc * east[2] + vc * north[2]]);
    } else {
      half = Math.max(u1 - u0, v1 - v0) / 2;
    }
  }
  // sample spacing ~ sqrt(4pi / samples): pad by one spacing so the edge is never clipped
  const spacing = Math.sqrt((4 * Math.PI) / samples);
  const { east, north } = frameBasis(center);
  return { center, east, north, halfTan: Math.min(2, (half + spacing) * margin) };
}

/** Unit direction of grid point (i, j) of an n x n local grid (row j runs south to north). */
export function gridDir(frame: LocalFrame, n: number, i: number, j: number, out: Float64Array): void {
  const u = ((i / (n - 1)) * 2 - 1) * frame.halfTan;
  const v = ((j / (n - 1)) * 2 - 1) * frame.halfTan;
  const x = frame.center[0] + u * frame.east[0] + v * frame.north[0];
  const y = frame.center[1] + u * frame.east[1] + v * frame.north[1];
  const z = frame.center[2] + u * frame.east[2] + v * frame.north[2];
  const inv = 1 / Math.hypot(x, y, z);
  out[0] = x * inv;
  out[1] = y * inv;
  out[2] = z * inv;
}
