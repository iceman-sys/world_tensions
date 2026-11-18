import { fbm3 } from './noise.ts';

/**
 * Domain warp that turns straight Voronoi edges into organic borders.
 * A country is the weighted-nearest seed to warp(direction). These constants are
 * injected into the GLSL so the shader evaluates the identical warp.
 */
export const WARP = {
  freq: 1.6,
  amp: 0.13,
  octaves: 4,
  lacunarity: 2.0,
  // lower gain keeps fine wiggles but avoids folds that create tiny exclaves
  gain: 0.42,
  // independent offsets so the three warp components are uncorrelated
  oy: [31.416, 17.23, 5.91] as const,
  oz: [-11.71, 47.37, 23.13] as const,
};

export type Vec3Tuple = [number, number, number];

/** Writes normalize(dir + amp * fbmVec(dir)) into out. dir must be unit length. */
export function warpDir(x: number, y: number, z: number, offset: Readonly<Vec3Tuple>, out: Float64Array | number[]): void {
  const qx = x * WARP.freq + offset[0];
  const qy = y * WARP.freq + offset[1];
  const qz = z * WARP.freq + offset[2];
  const { octaves, lacunarity, gain, oy, oz } = WARP;
  const dx = fbm3(qx, qy, qz, octaves, lacunarity, gain);
  const dy = fbm3(qx + oy[0], qy + oy[1], qz + oy[2], octaves, lacunarity, gain);
  const dz = fbm3(qx + oz[0], qy + oz[1], qz + oz[2], octaves, lacunarity, gain);
  const wx = x + WARP.amp * dx;
  const wy = y + WARP.amp * dy;
  const wz = z + WARP.amp * dz;
  const inv = 1 / Math.hypot(wx, wy, wz);
  out[0] = wx * inv;
  out[1] = wy * inv;
  out[2] = wz * inv;
}
