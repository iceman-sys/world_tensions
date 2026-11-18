/**
 * 3D simplex noise shared bit-for-bit between JS and GLSL (client/src/render/shaders.ts).
 *
 * The CPU (worker rasterizer + picking) and the GPU (planet shader) must agree on
 * the country map, so the lattice hash is done with 32-bit *integer* arithmetic:
 * Math.imul / >>> in JS and uint ops in GLSL ES 3.0 wrap identically modulo 2^32.
 * (The classic float "permute" polynomial is not reliable here: GPU compilers may
 * evaluate it differently and pick different gradients.) Only the smooth parts are
 * floating point, so CPU and GPU differ by ~1e-6 at most.
 */

const GRAD = [
  1, 1, 0, -1, 1, 0, 1, -1, 0, -1, -1, 0,
  1, 0, 1, -1, 0, 1, 1, 0, -1, -1, 0, -1,
  0, 1, 1, 0, -1, 1, 0, 1, -1, 0, -1, -1,
];

/** Integer lattice hash (mirrored in GLSL as hash3). Inputs are int32 cell coords. */
export function hash3(i: number, j: number, k: number): number {
  let h = (Math.imul(i, 0x8da6b343) ^ Math.imul(j, 0xd8163841) ^ Math.imul(k, 0xcb1ab31f)) >>> 0;
  h = (h ^ (h >>> 15)) >>> 0;
  h = Math.imul(h, 0x2c1b3c6d) >>> 0;
  h = (h ^ (h >>> 12)) >>> 0;
  h = Math.imul(h, 0x297a2d39) >>> 0;
  h = (h ^ (h >>> 15)) >>> 0;
  return h;
}

function corner(i: number, j: number, k: number, dx: number, dy: number, dz: number): number {
  let m = 0.5 - (dx * dx + dy * dy + dz * dz);
  if (m <= 0) return 0;
  const g = (hash3(i, j, k) % 12) * 3;
  m *= m;
  return m * m * (GRAD[g] * dx + GRAD[g + 1] * dy + GRAD[g + 2] * dz);
}

export function snoise3(x: number, y: number, z: number): number {
  const s = (x + y + z) * (1 / 3);
  const i0 = Math.floor(x + s);
  const j0 = Math.floor(y + s);
  const k0 = Math.floor(z + s);
  const t = (i0 + j0 + k0) * (1 / 6);
  const x0 = x - i0 + t;
  const y0 = y - j0 + t;
  const z0 = z - k0 + t;

  // simplex corner ordering: g = step(x0.yzx, x0.xyz); i1 = min(g, l.zxy); i2 = max(g, l.zxy)
  const gx = x0 >= y0 ? 1 : 0;
  const gy = y0 >= z0 ? 1 : 0;
  const gz = z0 >= x0 ? 1 : 0;
  const i1x = Math.min(gx, 1 - gz);
  const i1y = Math.min(gy, 1 - gx);
  const i1z = Math.min(gz, 1 - gy);
  const i2x = Math.max(gx, 1 - gz);
  const i2y = Math.max(gy, 1 - gx);
  const i2z = Math.max(gz, 1 - gy);

  const n0 = corner(i0, j0, k0, x0, y0, z0);
  const n1 = corner(i0 + i1x, j0 + i1y, k0 + i1z, x0 - i1x + 1 / 6, y0 - i1y + 1 / 6, z0 - i1z + 1 / 6);
  const n2 = corner(i0 + i2x, j0 + i2y, k0 + i2z, x0 - i2x + 1 / 3, y0 - i2y + 1 / 3, z0 - i2z + 1 / 3);
  const n3 = corner(i0 + 1, j0 + 1, k0 + 1, x0 - 0.5, y0 - 0.5, z0 - 0.5);
  // 74 ~ 105/sqrt(2): cube-edge gradients have length sqrt(2)
  return 74 * (n0 + n1 + n2 + n3);
}

export function fbm3(x: number, y: number, z: number, octaves: number, lacunarity: number, gain: number): number {
  let sum = 0;
  let amp = 1;
  let f = 1;
  for (let o = 0; o < octaves; o++) {
    sum += amp * snoise3(x * f, y * f, z * f);
    f *= lacunarity;
    amp *= gain;
  }
  return sum;
}
