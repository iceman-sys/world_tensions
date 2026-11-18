import { WARP } from '../../../shared/warp.ts';

const f = (v: number) => (Number.isInteger(v) ? v.toFixed(1) : String(v));

/**
 * GLSL mirror of shared/noise.ts (scalar, operation-for-operation) and shared/warp.ts.
 * Do not "optimise" one side without the other: picking and borders must agree.
 */
const NOISE_GLSL = /* glsl */ `
// integer lattice hash: uint arithmetic wraps mod 2^32 exactly like Math.imul in JS
uint hash3(ivec3 c) {
  uint h = (uint(c.x) * 0x8da6b343u) ^ (uint(c.y) * 0xd8163841u) ^ (uint(c.z) * 0xcb1ab31fu);
  h ^= h >> 15u;
  h *= 0x2c1b3c6du;
  h ^= h >> 12u;
  h *= 0x297a2d39u;
  h ^= h >> 15u;
  return h;
}

const vec3 GRAD3[12] = vec3[12](
  vec3(1.0, 1.0, 0.0), vec3(-1.0, 1.0, 0.0), vec3(1.0, -1.0, 0.0), vec3(-1.0, -1.0, 0.0),
  vec3(1.0, 0.0, 1.0), vec3(-1.0, 0.0, 1.0), vec3(1.0, 0.0, -1.0), vec3(-1.0, 0.0, -1.0),
  vec3(0.0, 1.0, 1.0), vec3(0.0, -1.0, 1.0), vec3(0.0, 1.0, -1.0), vec3(0.0, -1.0, -1.0)
);

float cornerN(ivec3 c, vec3 d) {
  float m = 0.5 - dot(d, d);
  if (m <= 0.0) return 0.0;
  vec3 g = GRAD3[hash3(c) % 12u];
  m *= m;
  return m * m * dot(g, d);
}

float snoise(vec3 v) {
  float s = (v.x + v.y + v.z) * (1.0 / 3.0);
  vec3 i = floor(v + s);
  float t = (i.x + i.y + i.z) * (1.0 / 6.0);
  vec3 x0 = v - i + t;
  vec3 g = vec3(x0.x >= x0.y ? 1.0 : 0.0, x0.y >= x0.z ? 1.0 : 0.0, x0.z >= x0.x ? 1.0 : 0.0);
  vec3 l = 1.0 - g;
  vec3 i1 = min(g, l.zxy);
  vec3 i2 = max(g, l.zxy);
  ivec3 ic = ivec3(i);
  float n0 = cornerN(ic, x0);
  float n1 = cornerN(ic + ivec3(i1), x0 - i1 + (1.0 / 6.0));
  float n2 = cornerN(ic + ivec3(i2), x0 - i2 + (1.0 / 3.0));
  float n3 = cornerN(ic + ivec3(1), x0 - 0.5);
  return 74.0 * (n0 + n1 + n2 + n3);
}

float fbmWarp(vec3 q) {
  float sum = 0.0;
  float amp = 1.0;
  float fr = 1.0;
  for (int o = 0; o < ${WARP.octaves}; o++) {
    sum += amp * snoise(q * fr);
    fr *= ${f(WARP.lacunarity)};
    amp *= ${f(WARP.gain)};
  }
  return sum;
}

vec3 warpDir(vec3 p, vec3 offset) {
  vec3 q = p * ${f(WARP.freq)} + offset;
  vec3 d = vec3(
    fbmWarp(q),
    fbmWarp(q + vec3(${WARP.oy.map(f).join(', ')})),
    fbmWarp(q + vec3(${WARP.oz.map(f).join(', ')}))
  );
  return normalize(p + ${f(WARP.amp)} * d);
}
`;

export const planetVertex = /* glsl */ `
varying vec3 vDir;
varying vec3 vWorld;
void main() {
  vDir = position;
  vec4 world = modelMatrix * vec4(position, 1.0);
  vWorld = world.xyz;
  gl_Position = projectionMatrix * viewMatrix * world;
}
`;

export const planetFragment = /* glsl */ `
precision highp float;
precision highp int;
precision highp sampler2D;

uniform sampler2D uIdAtlas;
uniform sampler2D uCountry;
uniform sampler2D uFlags;
uniform vec3 uFace;          // N, G, S
uniform vec2 uFlagGrid;      // cols, rows
uniform vec2 uFlagInset;
uniform vec3 uWarpOffset;
uniform vec3 uLightDir;
uniform vec3 uCameraPos;
uniform float uHover;
uniform float uSelected;
uniform float uTime;
uniform float uDetail;
uniform float uLineWidth;
uniform float uFlagMix;
uniform int uDebug;

varying vec3 vDir;
varying vec3 vWorld;

#define PI 3.141592653589793

${NOISE_GLSL}

// face index, then face coords (a, b) in [-1, 1]; mirrors shared/cube.ts dirToFace
vec3 dirToFace(vec3 d) {
  vec3 ad = abs(d);
  float face; float u; float v;
  if (ad.x >= ad.y && ad.x >= ad.z) {
    if (d.x > 0.0) { face = 0.0; u = -d.z / ad.x; v = d.y / ad.x; }
    else { face = 1.0; u = d.z / ad.x; v = d.y / ad.x; }
  } else if (ad.y >= ad.z) {
    if (d.y > 0.0) { face = 2.0; u = d.x / ad.y; v = -d.z / ad.y; }
    else { face = 3.0; u = d.x / ad.y; v = d.z / ad.y; }
  } else {
    if (d.z > 0.0) { face = 4.0; u = d.x / ad.z; v = d.y / ad.z; }
    else { face = 5.0; u = -d.x / ad.z; v = d.y / ad.z; }
  }
  return vec3(face, atan(u) * (4.0 / PI), atan(v) * (4.0 / PI));
}

int fetchId(ivec2 origin, vec2 t) {
  float S = uFace.z;
  ivec2 c = ivec2(clamp(floor(t), vec2(0.0), vec2(S - 1.0)));
  return int(texelFetch(uIdAtlas, origin + c, 0).r * 255.0 + 0.5);
}

vec4 countryRow(int id, int row) { return texelFetch(uCountry, ivec2(id, row), 0); }

vec3 idColor(int id) {
  float h = fract(float(id) * 0.61803398875);
  return 0.55 + 0.45 * cos(6.2831853 * (h + vec3(0.0, 0.33, 0.67)));
}

float fbmTerrain(vec3 p, float pxAng) {
  float sum = 0.0;
  float amp = 0.55;
  float fr = 2.6;
  for (int o = 0; o < 7; o++) {
    if (float(o) >= uDetail) break;
    // fade out octaves finer than ~2 pixels to avoid shimmering
    float fade = 1.0 - smoothstep(0.25, 0.6, fr * pxAng);
    if (fade <= 0.0) break;
    sum += amp * fade * snoise(p * fr + vec3(13.1, -7.7, 3.3));
    fr *= 2.13;
    amp *= 0.5;
  }
  return sum;
}

vec3 perturbNormal(vec3 pos, vec3 n, float h) {
  vec3 dpdx = dFdx(pos);
  vec3 dpdy = dFdy(pos);
  float dhdx = dFdx(h);
  float dhdy = dFdy(h);
  vec3 r1 = cross(dpdy, n);
  vec3 r2 = cross(n, dpdx);
  float det = dot(dpdx, r1);
  vec3 grad = sign(det) * (dhdx * r1 + dhdy * r2);
  return normalize(abs(det) * n - grad);
}

void main() {
  vec3 dir = normalize(vDir);
  float pxAng = max(length(fwidth(dir)) * 0.7071, 1e-7);
  float N = uFace.x;
  float G = uFace.y;
  float S = uFace.z;

  // ---- candidate countries from the ID atlas ----
  vec3 fc = dirToFace(dir);
  int face = int(fc.x + 0.5);
  ivec2 origin = ivec2((face - (face / 3) * 3) * int(S), (face / 3) * int(S));
  vec2 t = (fc.yz + 1.0) * 0.5 * N + G;
  float texAng = (PI * 0.5) / N;
  float r = clamp(1.0 + 4.0 * pxAng / texAng, 1.5, G - 0.5);
  // 3x3 lookup pattern (same offsets as shared/pick.ts) so a neighbour straight
  // across a border is never skipped
  int ids[9];
  int c0 = fetchId(origin, t);
  ids[0] = c0;
  ids[1] = fetchId(origin, t + vec2(r, 0.0));
  ids[2] = fetchId(origin, t + vec2(-r, 0.0));
  ids[3] = fetchId(origin, t + vec2(0.0, r));
  ids[4] = fetchId(origin, t + vec2(0.0, -r));
  ids[5] = fetchId(origin, t + vec2(r, r));
  ids[6] = fetchId(origin, t + vec2(-r, r));
  ids[7] = fetchId(origin, t + vec2(r, -r));
  ids[8] = fetchId(origin, t + vec2(-r, -r));

  // ---- exact weighted-nearest seed in warped space (same rule as shared/pick.ts) ----
  // The warp and its screen derivatives are evaluated for every pixel in uniform
  // control flow: derivatives inside a branch are undefined in GLSL.
  vec3 w = warpDir(dir, uWarpOffset);
  vec3 dwx = dFdx(w);
  vec3 dwy = dFdy(w);
  int best = c0;
  float s1 = -1e9;
  for (int k = 0; k < 9; k++) {
    vec4 sd = countryRow(ids[k], 1);
    float s = dot(w, sd.xyz) + sd.w;
    if (s > s1) { s1 = s; best = ids[k]; }
  }
  float s2 = -1e9;
  int second = -1;
  for (int k = 0; k < 9; k++) {
    if (ids[k] == best) continue;
    vec4 sd = countryRow(ids[k], 1);
    float s = dot(w, sd.xyz) + sd.w;
    if (s > s2) { s2 = s; second = ids[k]; }
  }

  // distance to the border in pixels via the chain rule: f = dot(w, s1 - s2) + (w1 - w2)
  float borderPx = 1e4;
  if (second >= 0) {
    vec3 gdir = countryRow(best, 1).xyz - countryRow(second, 1).xyz;
    vec2 df = vec2(dot(gdir, dwx), dot(gdir, dwy));
    borderPx = (s1 - s2) / max(length(df), 1e-9);
  }

  // ---- terrain ----
  float e = fbmTerrain(dir, pxAng);
  float moist = snoise(dir * 1.35 + vec3(-21.0, 4.0, 9.0)) + 0.35 * snoise(dir * 3.1 + vec3(5.0, 2.0, -8.0));
  float lat = abs(dir.y);

  vec3 fertile = vec3(0.45, 0.60, 0.30);
  vec3 forest  = vec3(0.22, 0.42, 0.22);
  vec3 desert  = vec3(0.80, 0.69, 0.47);
  vec3 rock    = vec3(0.50, 0.46, 0.41);
  vec3 snow    = vec3(0.93, 0.95, 0.97);
  vec3 terrain = mix(fertile, forest, smoothstep(0.05, 0.55, moist));
  terrain = mix(terrain, desert, smoothstep(0.1, 0.55, -moist) * (1.0 - smoothstep(0.5, 0.7, lat)));
  float mountain = smoothstep(0.32, 0.75, e);
  terrain = mix(terrain, rock, mountain * 0.85);
  float snowAmt = smoothstep(0.80, 0.90, lat + e * 0.08) + smoothstep(0.62, 0.85, e) * 0.8;
  terrain = mix(terrain, snow, clamp(snowAmt, 0.0, 1.0));

  // ---- flag ----
  vec4 row0 = countryRow(best, 0);
  vec4 row2 = countryRow(best, 2);
  vec3 cen = row0.xyz;
  vec3 east = abs(cen.y) > 0.98 ? vec3(1.0, 0.0, 0.0) : normalize(cross(vec3(0.0, 1.0, 0.0), cen));
  vec3 north = cross(cen, east);
  vec2 local = vec2(dot(dir, east), dot(dir, north)) / (row0.w * 1.05);
  vec2 fuv = clamp(vec2(local.x / 1.5, local.y) * 0.5 + 0.5, 0.0, 1.0);
  float fi = row2.x;
  float col = mod(fi, uFlagGrid.x);
  float rowI = floor(fi / uFlagGrid.x);
  vec2 cell = vec2(col, uFlagGrid.y - 1.0 - rowI);
  vec2 inner = uFlagInset + fuv * (1.0 - 2.0 * uFlagInset);
  vec3 flagCol = texture(uFlags, (cell + inner) / uFlagGrid).rgb;

  vec3 base = mix(terrain, flagCol, uFlagMix);
  // keep relief visible through the flag
  base *= 0.88 + 0.22 * clamp(e + 0.5, 0.0, 1.0);

  if (uDebug == 1) base = idColor(best);

  // small inland lakes (visual only)
  float lake = smoothstep(-0.70, -0.76, e);

  // ---- lighting ----
  vec3 n = perturbNormal(vWorld, dir, e * 0.006 * (1.0 - lake));
  vec3 V = normalize(uCameraPos - vWorld);
  float diff = max(dot(n, uLightDir), 0.0);
  float light = 0.42 + 0.68 * diff;
  vec3 color = base * light;

  vec3 waterCol = vec3(0.13, 0.50, 0.66);
  vec3 waterDeep = vec3(0.06, 0.22, 0.33);
  color = mix(color, mix(waterCol, waterDeep, 0.35) * (0.6 + 0.5 * diff), lake);

  // ---- selection / hover ----
  bool isSel = float(best) == uSelected;
  bool isHover = float(best) == uHover;
  if (uSelected >= 0.0 && !isSel) color *= 0.58;
  if (isHover) {
    color *= 1.16;
    color += vec3(1.0, 0.95, 0.85) * exp(-borderPx / 3.5) * 0.35;
  }
  if (isSel) {
    float pulse = 0.55 + 0.45 * sin(uTime * 4.0);
    float band = 1.0 - smoothstep(2.0, 4.5, borderPx);
    color = mix(color * 1.1, vec3(1.0, 0.86, 0.45), band * (0.55 + 0.45 * pulse));
  }

  // ---- border water channels (constant pixel width at every zoom) ----
  float lw = uLineWidth;
  float rim = 1.0 - smoothstep(lw + 0.2, lw + 1.9, borderPx);
  float water = 1.0 - smoothstep(lw - 0.5, lw + 0.5, borderPx);
  color = mix(color, color * 0.32, rim * 0.75);
  vec3 river = vec3(0.16, 0.56, 0.78) * (0.8 + 0.3 * diff);
  color = mix(color, river, water);

  if (uDebug >= 3 && uDebug <= 5) {
    // precision probe: encode a value in [-1, 1] across three 8-bit channels
    float pv = uDebug == 3 ? w.x : uDebug == 4 ? snoise(dir * 1.6 + uWarpOffset) : snoise(uWarpOffset);
    float v = (pv + 1.0) * 0.5;
    color = vec3(floor(v * 255.0) / 255.0, fract(v * 255.0), fract(v * 65025.0));
    gl_FragColor = vec4(color, 1.0);
    return;
  }
  if (uDebug == 2) {
    // red where the exact winner differs from the centre texel (should only be a
    // sub-texel fringe along borders; wide red areas mean CPU/GPU noise mismatch)
    color = best == c0 ? idColor(best) * 0.6 : vec3(1.0, 0.0, 0.0);
  }

  // ---- atmosphere rim ----
  float fres = pow(1.0 - max(dot(dir, V), 0.0), 3.0);
  color += vec3(0.35, 0.6, 1.0) * fres * 0.45;

  gl_FragColor = vec4(color, 1.0);
}
`;

export const atmosphereVertex = /* glsl */ `
varying vec3 vNormalW;
varying vec3 vWorld;
void main() {
  vNormalW = normalize(mat3(modelMatrix) * normal);
  vec4 world = modelMatrix * vec4(position, 1.0);
  vWorld = world.xyz;
  gl_Position = projectionMatrix * viewMatrix * world;
}
`;

export const atmosphereFragment = /* glsl */ `
uniform vec3 uCameraPos;
varying vec3 vNormalW;
varying vec3 vWorld;
void main() {
  // rendered on the back faces of a slightly larger shell: k is 0 at the shell's
  // silhouette and grows towards the planet limb, giving a soft halo
  vec3 V = normalize(uCameraPos - vWorld);
  float k = clamp(-dot(normalize(vNormalW), V), 0.0, 1.0);
  float glow = pow(smoothstep(0.0, 0.42, k), 2.0);
  gl_FragColor = vec4(vec3(0.30, 0.58, 1.0) * glow * 0.85, 1.0);
}
`;

export const starsVertex = /* glsl */ `
attribute float aSize;
attribute float aBright;
varying float vBright;
uniform float uPixelRatio;
void main() {
  vBright = aBright;
  vec4 mv = modelViewMatrix * vec4(position, 1.0);
  gl_PointSize = aSize * uPixelRatio;
  gl_Position = projectionMatrix * mv;
}
`;

export const starsFragment = /* glsl */ `
varying float vBright;
void main() {
  vec2 c = gl_PointCoord - 0.5;
  float d = length(c);
  float a = smoothstep(0.5, 0.0, d);
  gl_FragColor = vec4(vec3(0.85, 0.9, 1.0) * vBright, a * vBright);
}
`;
