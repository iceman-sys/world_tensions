import * as THREE from 'three';
import { BIOME, MASK, RESOURCE_SPOT, WATER } from '../../../shared/country/config.ts';
import { tileToWorld, type LocalTerrain } from '../../../shared/country/terrain.ts';

const BIOME_COLORS: Record<number, string> = {
  [BIOME.grass]: '#6f9a4a',
  [BIOME.forest]: '#466f3a',
  [BIOME.desert]: '#cdb27a',
  [BIOME.snow]: '#eef2f5',
  [BIOME.rock]: '#8a8276',
  [BIOME.sand]: '#d6c597',
};

/** Per-vertex variation without Math.random (stable for a given tile). */
function jitter(k: number): number {
  let h = Math.imul(k ^ 0x9e3779b9, 0x85ebca6b);
  h ^= h >>> 13;
  h = Math.imul(h, 0xc2b2ae35);
  h ^= h >>> 16;
  return ((h >>> 0) / 4294967296) * 2 - 1;
}

/**
 * Heightfield mesh with vertex colours from biome, water and resource sites.
 * `neighborTint(cell)` gives the flag colour of a neighbouring cell for the strip.
 */
export function buildTerrainMesh(t: LocalTerrain, neighborTint: (cell: number) => string | null): THREE.Mesh<THREE.BufferGeometry, THREE.MeshStandardMaterial> {
  const n = t.size;
  const N = n * n;
  const pos = new Float32Array(N * 3);
  const col = new Float32Array(N * 3);
  const c = new THREE.Color();
  const tint = new THREE.Color();
  const palette = new Map<string, THREE.Color>();
  const colorOf = (hex: string) => {
    let v = palette.get(hex);
    if (!v) {
      v = new THREE.Color(hex);
      palette.set(hex, v);
    }
    return v;
  };

  // resource-site ground colouring (fields in rows, pasture, pits)
  const siteColor = new Array<THREE.Color | null>(N).fill(null);
  for (const s of t.spots) {
    const base = colorOf(RESOURCE_SPOT[s.resource]?.color ?? '#888888');
    const R = Math.ceil(s.r);
    for (let dj = -R; dj <= R; dj++) {
      for (let di = -R; di <= R; di++) {
        const i = s.i + di, j = s.j + dj;
        if (i < 0 || j < 0 || i >= n || j >= n) continue;
        const k = j * n + i;
        if (t.mask[k] !== MASK.own || t.water[k] !== WATER.none) continue;
        const d = Math.hypot(di, dj) / s.r;
        if (d > 1) continue;
        if (s.kind === 'field') siteColor[k] = (i + j) % 3 === 0 ? colorOf('#7a5c3a') : base;
        else if (s.kind === 'pasture') siteColor[k] = colorOf('#9cc76a');
        else if (s.kind === 'mine' || s.kind === 'oil') siteColor[k] = d < 0.65 ? base : colorOf('#7b6d5d');
      }
    }
  }

  // cold countries: grass and forest fade towards tundra greys
  const cold = Math.max(0, Math.min(1, (Math.abs(t.latitude) - 0.75) / 0.55));
  const tundra = new THREE.Color('#8e9a7c');
  for (let j = 0; j < n; j++) {
    for (let i = 0; i < n; i++) {
      const k = j * n + i;
      const { x, z } = tileToWorld(n, i, j);
      pos[k * 3] = x;
      pos[k * 3 + 1] = t.heights[k];
      pos[k * 3 + 2] = z;
      const m = t.mask[k];
      const w = t.water[k];
      if (m === MASK.own) {
        if (w === WATER.river) c.set('#3c8cbf');
        else if (w === WATER.lake) c.set('#6b7f6a');
        else {
          c.copy(siteColor[k] ?? colorOf(BIOME_COLORS[t.biome[k]] ?? '#6f9a4a'));
          if (!siteColor[k] && (t.biome[k] === BIOME.grass || t.biome[k] === BIOME.forest)) c.lerp(tundra, cold * 0.6);
        }
        // light relief tint: higher ground slightly lighter, valleys darker
        const shade = 0.9 + Math.min(0.25, t.heights[k] * 0.012) + jitter(k) * 0.04;
        c.multiplyScalar(shade);
      } else if (m === MASK.neighbor) {
        c.set('#6d8a5a');
        const hex = neighborTint(t.cells[k]);
        if (hex) c.lerp(tint.set(hex), 0.28);
        c.multiplyScalar(0.72 + jitter(k) * 0.03);
      } else if (m === MASK.channel) {
        c.set('#7a7560');
      } else {
        c.set('#3b4a52');
      }
      col[k * 3] = c.r;
      col[k * 3 + 1] = c.g;
      col[k * 3 + 2] = c.b;
    }
  }

  // soften biome edges on land (keeps rivers and field rows crisp)
  const src = col.slice();
  for (let j = 1; j < n - 1; j++) {
    for (let i = 1; i < n - 1; i++) {
      const k = j * n + i;
      if (t.mask[k] !== MASK.own || t.water[k] === WATER.river || siteColor[k]) continue;
      let r = 0, g = 0, b = 0, w = 0;
      for (let dj = -1; dj <= 1; dj++) {
        for (let di = -1; di <= 1; di++) {
          const q = k + dj * n + di;
          if (t.mask[q] !== MASK.own || t.water[q] === WATER.river) continue;
          r += src[q * 3]; g += src[q * 3 + 1]; b += src[q * 3 + 2]; w++;
        }
      }
      col[k * 3] = r / w; col[k * 3 + 1] = g / w; col[k * 3 + 2] = b / w;
    }
  }

  const index = new Uint32Array((n - 1) * (n - 1) * 6);
  let q = 0;
  for (let j = 0; j < n - 1; j++) {
    for (let i = 0; i < n - 1; i++) {
      const a = j * n + i, b = a + 1, d = a + n, e = d + 1;
      // world z is flipped relative to j, so this order faces up
      index[q++] = a; index[q++] = b; index[q++] = d;
      index[q++] = b; index[q++] = e; index[q++] = d;
    }
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  geo.setAttribute('color', new THREE.BufferAttribute(col, 3));
  geo.setIndex(new THREE.BufferAttribute(index, 1));
  geo.computeVertexNormals();
  geo.computeBoundingSphere();
  const mat = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.93, metalness: 0 });
  const mesh = new THREE.Mesh(geo, mat);
  mesh.receiveShadow = true;
  mesh.castShadow = true;
  return mesh;
}

/** Water depth (0..255) per tile for the water shader: shallow shores, deep sea. */
export function buildDepthTexture(t: LocalTerrain): THREE.DataTexture {
  const n = t.size;
  const data = new Uint8Array(n * n);
  for (let k = 0; k < n * n; k++) data[k] = Math.max(0, Math.min(255, Math.round((-t.heights[k] / 3) * 255)));
  const tex = new THREE.DataTexture(data, n, n, THREE.RedFormat, THREE.UnsignedByteType);
  tex.magFilter = THREE.LinearFilter;
  tex.minFilter = THREE.LinearFilter;
  tex.unpackAlignment = 1;
  tex.needsUpdate = true;
  return tex;
}
