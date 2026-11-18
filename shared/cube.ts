/**
 * Cube-sphere parameterisation used for the country ID atlas.
 *
 * Six faces (+X, -X, +Y, -Y, +Z, -Z), each with face coordinates (a, b) in [-1, 1].
 * We use the "tangent" warp u = tan(a * PI/4) so texels are close to equal-area,
 * which avoids the pole distortion of an equirectangular map entirely.
 *
 * Each face is stored with a gutter of G texels on every side (the gutter holds
 * the real values from the neighbouring face), and the six padded faces are packed
 * into a 3 x 2 atlas. The shader in client/src/render/shaders.ts mirrors this file.
 */

export const FACE_COLS = 3;
export const FACE_ROWS = 2;
export const DEFAULT_FACE_SIZE = 1024;
export const GUTTER = 4;

const QUARTER_PI = Math.PI / 4;

export interface AtlasLayout {
  /** interior texels per face side */
  N: number;
  /** gutter texels per side */
  G: number;
  /** padded face side, N + 2G */
  S: number;
  width: number;
  height: number;
}

export function atlasLayout(N: number, G = GUTTER): AtlasLayout {
  const S = N + 2 * G;
  return { N, G, S, width: S * FACE_COLS, height: S * FACE_ROWS };
}

/** Face coordinates (a, b) -> unit direction. */
export function faceToDir(face: number, a: number, b: number, out: Float64Array | number[]): void {
  const u = Math.tan(a * QUARTER_PI);
  const v = Math.tan(b * QUARTER_PI);
  let x: number, y: number, z: number;
  switch (face) {
    case 0: x = 1; y = v; z = -u; break;
    case 1: x = -1; y = v; z = u; break;
    case 2: x = u; y = 1; z = -v; break;
    case 3: x = u; y = -1; z = v; break;
    case 4: x = u; y = v; z = 1; break;
    default: x = -u; y = v; z = -1; break;
  }
  const inv = 1 / Math.hypot(x, y, z);
  out[0] = x * inv;
  out[1] = y * inv;
  out[2] = z * inv;
}

/**
 * Unit direction -> face index and face coordinates (a, b) in [-1, 1].
 * Writes [face, a, b] into out.
 */
export function dirToFace(x: number, y: number, z: number, out: Float64Array | number[]): void {
  const ax = Math.abs(x);
  const ay = Math.abs(y);
  const az = Math.abs(z);
  let face: number, u: number, v: number;
  if (ax >= ay && ax >= az) {
    if (x > 0) { face = 0; u = -z / ax; v = y / ax; }
    else { face = 1; u = z / ax; v = y / ax; }
  } else if (ay >= az) {
    if (y > 0) { face = 2; u = x / ay; v = -z / ay; }
    else { face = 3; u = x / ay; v = z / ay; }
  } else {
    if (z > 0) { face = 4; u = x / az; v = y / az; }
    else { face = 5; u = -x / az; v = y / az; }
  }
  out[0] = face;
  out[1] = Math.atan(u) / QUARTER_PI;
  out[2] = Math.atan(v) / QUARTER_PI;
}

/** Face coordinate of texel centre i (0..S-1, including gutter). */
export function texelToFaceCoord(i: number, N: number, G: number): number {
  return ((i - G + 0.5) * 2) / N - 1;
}

/** Continuous texel index (texel centres at integers + 0.5 boundaries) for a face coordinate. */
export function faceCoordToTexel(a: number, N: number, G: number): number {
  return ((a + 1) * N) / 2 + G;
}

export function faceOrigin(face: number, S: number): [number, number] {
  return [(face % FACE_COLS) * S, Math.floor(face / FACE_COLS) * S];
}

/**
 * Solid angle (steradians) of a texel centred at face coords (a, b) with side 2/N
 * in the tangent-warped parameterisation.
 */
export function texelSolidAngle(a: number, b: number, N: number): number {
  const u = Math.tan(a * QUARTER_PI);
  const v = Math.tan(b * QUARTER_PI);
  const d = 1 + u * u + v * v;
  const step = 2 / N;
  return QUARTER_PI * QUARTER_PI * (1 + u * u) * (1 + v * v) / (d * Math.sqrt(d)) * step * step;
}
