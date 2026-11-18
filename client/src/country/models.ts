import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { BUILDINGS, type BuildingKind } from '../../../shared/country/buildings.ts';

/**
 * Procedural low-poly building models (no external assets). Each kind becomes
 * one merged "body" geometry with vertex colours and one "windows" geometry, so
 * every kind is drawn with two instanced draw calls and windows can glow at night.
 * Models are centred on the footprint centre with y = 0 at ground level.
 */
export interface BuildingModel {
  body: THREE.BufferGeometry;
  windows: THREE.BufferGeometry;
  /** model height, for labels and progress rings */
  height: number;
}

type Part = THREE.BufferGeometry;

function colored(geo: THREE.BufferGeometry, color: string): Part {
  const g = geo.index ? geo.toNonIndexed() : geo;
  if (g !== geo) geo.dispose();
  g.deleteAttribute('uv');
  const c = new THREE.Color(color);
  const n = g.attributes.position.count;
  const col = new Float32Array(n * 3);
  for (let i = 0; i < n; i++) {
    col[i * 3] = c.r;
    col[i * 3 + 1] = c.g;
    col[i * 3 + 2] = c.b;
  }
  g.setAttribute('color', new THREE.BufferAttribute(col, 3));
  return g;
}

const box = (w: number, h: number, d: number, x: number, y: number, z: number, color: string): Part =>
  colored(new THREE.BoxGeometry(w, h, d).translate(x, y + h / 2, z), color);

const cyl = (r: number, h: number, x: number, y: number, z: number, color: string, seg = 10, rTop = r): Part =>
  colored(new THREE.CylinderGeometry(rTop, r, h, seg).translate(x, y + h / 2, z), color);

const cone = (r: number, h: number, x: number, y: number, z: number, color: string, seg = 8): Part =>
  colored(new THREE.ConeGeometry(r, h, seg).translate(x, y + h / 2, z), color);

/** Four-sided hip roof (pyramid stretched over a w x d rectangle). */
function roof(w: number, d: number, h: number, y: number, color: string, x = 0, z = 0): Part {
  const g = new THREE.ConeGeometry(Math.SQRT1_2, 1, 4, 1).rotateY(Math.PI / 4);
  g.scale(w, h, d).translate(x, y + h / 2, z);
  return colored(g, color);
}

/** Gabled barn roof: a triangular prism along x. */
function gable(w: number, d: number, h: number, y: number, color: string, x = 0, z = 0): Part {
  const shape = new THREE.Shape();
  shape.moveTo(-d / 2, 0);
  shape.lineTo(d / 2, 0);
  shape.lineTo(0, h);
  shape.closePath();
  const g = new THREE.ExtrudeGeometry(shape, { depth: w, bevelEnabled: false });
  g.rotateY(Math.PI / 2).translate(x - w / 2, y, z);
  return colored(g, color);
}

/** A foundation slab reaching below ground, so buildings sit cleanly on slopes. */
const foundation = (w: number, d: number): Part => box(w, 1.6, d, 0, -1.5, 0, '#8d8577');

function windowRow(w: number, z: number, y: number, count: number, size = 0.22): Part[] {
  const out: Part[] = [];
  for (let k = 0; k < count; k++) {
    const x = -w / 2 + ((k + 0.5) * w) / count;
    out.push(box(size, size, 0.04, x, y, z, '#ffffff'));
  }
  return out;
}

function model(kind: BuildingKind): { body: Part[]; windows: Part[]; height: number } {
  const [W, D] = BUILDINGS[kind].size;
  const c = BUILDINGS[kind].color;
  switch (kind) {
    case 'house': {
      const w = W * 0.72, d = D * 0.72, h = 0.95;
      return {
        body: [foundation(w + 0.2, d + 0.2), box(w, h, d, 0, 0, 0, c), roof(w + 0.25, d + 0.25, 0.75, h, '#9c4a3a'), box(0.28, 0.5, 0.05, 0, 0, d / 2 + 0.01, '#4a3326')],
        windows: [...windowRow(w * 0.8, d / 2 + 0.02, 0.45, 2), ...windowRow(w * 0.8, -d / 2 - 0.02, 0.45, 2)],
        height: h + 0.75,
      };
    }
    case 'apartment': {
      const w = W * 0.78, d = D * 0.78, h = 4.2;
      const win: Part[] = [];
      for (let f = 0; f < 5; f++) {
        win.push(...windowRow(w * 0.85, d / 2 + 0.02, 0.45 + f * 0.78, 4), ...windowRow(w * 0.85, -d / 2 - 0.02, 0.45 + f * 0.78, 4));
      }
      return {
        body: [foundation(w + 0.2, d + 0.2), box(w, h, d, 0, 0, 0, c), box(w + 0.15, 0.18, d + 0.15, 0, h, 0, '#6d7682'), box(0.6, 0.5, 0.6, w * 0.2, h + 0.18, 0, '#8a929c')],
        windows: win,
        height: h + 0.7,
      };
    }
    case 'farm': {
      const rows: Part[] = [];
      for (let r = 0; r < 5; r++) rows.push(box(W * 0.55, 0.12, 0.42, -W * 0.18, 0, -D / 2 + 0.6 + r * 0.85, r % 2 ? '#c9a640' : '#9b7b3a'));
      return {
        body: [foundation(W * 0.95, D * 0.95), ...rows, box(1.7, 1.1, 1.3, W * 0.3, 0, -D * 0.15, '#a9452f'), gable(1.7, 1.3, 0.7, 1.1, '#5b3a2a', W * 0.3, -D * 0.15), cyl(0.38, 2.1, W * 0.3, 0, D * 0.25, '#c9c4b8'), cone(0.42, 0.4, W * 0.3, 2.1, D * 0.25, '#7a7f86')],
        windows: [box(0.24, 0.24, 0.04, W * 0.3 - 0.4, 0.55, -D * 0.15 + 0.67, '#ffffff')],
        height: 2.5,
      };
    }
    case 'mine': {
      return {
        body: [
          foundation(W * 0.9, D * 0.9),
          box(0.25, 3.4, 0.25, -0.6, 0, -0.6, '#4f3f33'), box(0.25, 3.4, 0.25, 0.1, 0, -0.6, '#4f3f33'),
          box(0.25, 3.4, 0.25, -0.6, 0, 0.1, '#4f3f33'), box(0.25, 3.4, 0.25, 0.1, 0, 0.1, '#4f3f33'),
          box(1.1, 0.3, 1.1, -0.25, 3.4, -0.25, '#2f2f33'), cyl(0.35, 0.18, -0.25, 3.7, -0.25, '#9a9a9a', 12),
          box(1.8, 1.0, 1.3, 0.9, 0, 1.0, c), roof(1.9, 1.4, 0.45, 1.0, '#45484d', 0.9, 1.0),
          cone(0.9, 0.9, -1.0, 0, 1.2, '#4a443e', 7),
        ],
        windows: windowRow(1.4, 1.66, 0.5, 3),
        height: 4,
      };
    }
    case 'school': {
      const w = W * 0.82, d = D * 0.62, h = 1.5;
      return {
        body: [foundation(W * 0.9, D * 0.9), box(w, h, d, 0, 0, -0.2, c), roof(w + 0.2, d + 0.2, 0.55, h, '#7d2f22', 0, -0.2), box(0.9, 0.9, 0.9, w / 2 - 0.45, 0, d / 2, '#d9cbb0'), cyl(0.05, 2.5, -w / 2 + 0.3, 0, d / 2 + 0.2, '#dddddd', 6), box(0.5, 0.32, 0.03, -w / 2 + 0.56, 2.1, d / 2 + 0.2, '#f0c233')],
        windows: [...windowRow(w * 0.9, d / 2 - 0.18, 0.7, 5, 0.28), ...windowRow(w * 0.9, -d / 2 - 0.22, 0.7, 5, 0.28)],
        height: h + 0.6,
      };
    }
    case 'market': {
      const stalls: Part[] = [];
      const colors = ['#d9534f', '#f0ad4e', '#5bc0de', '#5cb85c'];
      for (let k = 0; k < 4; k++) {
        const x = (k % 2 ? 0.8 : -0.8), z = (k < 2 ? -0.8 : 0.8);
        stalls.push(box(0.9, 0.55, 0.7, x, 0.1, z, '#b48a5a'), roof(1.15, 0.95, 0.45, 0.85, colors[k], x, z));
        stalls.push(box(0.06, 0.85, 0.06, x - 0.5, 0, z - 0.4, '#5a4636'), box(0.06, 0.85, 0.06, x + 0.5, 0, z + 0.4, '#5a4636'));
      }
      return { body: [foundation(W * 0.92, D * 0.92), box(W * 0.9, 0.1, D * 0.9, 0, 0, 0, '#cbbfa8'), ...stalls], windows: [box(0.3, 0.2, 0.04, 0, 0.45, 0.01, '#ffffff')], height: 1.4 };
    }
    case 'clinic': {
      const w = W * 0.78, d = D * 0.78, h = 1.6;
      return {
        body: [foundation(w + 0.2, d + 0.2), box(w, h, d, 0, 0, 0, c), box(w + 0.1, 0.15, d + 0.1, 0, h, 0, '#c9d2d9'), box(0.9, 0.22, 0.28, 0, h + 0.15, 0, '#d9302c'), box(0.28, 0.22, 0.9, 0, h + 0.15, 0, '#d9302c'), box(0.6, 0.7, 0.05, 0, 0, d / 2 + 0.01, '#6fa8d6')],
        windows: [...windowRow(w * 0.9, -d / 2 - 0.02, 0.8, 4), ...windowRow(w * 0.9, d / 2 + 0.02, 1.15, 4)],
        height: h + 0.4,
      };
    }
    case 'park': {
      const trees: Part[] = [];
      const spots = [[-1.4, -1.3], [1.5, -1.0], [-1.6, 1.4], [1.2, 1.5], [0.2, -1.8]];
      for (const [x, z] of spots) trees.push(cyl(0.08, 0.5, x, 0.05, z, '#5a4030', 5), cone(0.55, 1.3, x, 0.5, z, '#3f8a45', 7));
      return {
        body: [foundation(W * 0.95, D * 0.95), box(W * 0.95, 0.08, D * 0.95, 0, 0, 0, '#79b85e'), cyl(0.9, 0.06, 0.2, 0.06, 0.3, '#4aa3c9', 16), ...trees, box(0.9, 0.15, 0.25, -0.2, 0.08, 1.0, '#8a6a4a')],
        windows: [box(0.12, 0.12, 0.12, 0.9, 1.0, 0.1, '#ffffff'), cyl(0.04, 1.0, 0.9, 0, 0.1, '#333333', 5)],
        height: 1.9,
      };
    }
    case 'police': {
      const w = W * 0.8, d = D * 0.75, h = 1.4;
      return {
        body: [foundation(w + 0.2, d + 0.2), box(w, h, d, 0, 0, 0, c), box(w + 0.1, 0.2, d + 0.1, 0, h, 0, '#e8ecf2'), box(0.35, 0.22, 0.35, 0, h + 0.2, 0, '#2f6fd8'), box(0.5, 0.65, 0.05, 0, 0, d / 2 + 0.01, '#1d2c4a')],
        windows: [...windowRow(w * 0.9, d / 2 + 0.02, 0.85, 3), ...windowRow(w * 0.9, -d / 2 - 0.02, 0.85, 3)],
        height: h + 0.5,
      };
    }
    case 'townhall': {
      const w = W * 0.8, d = D * 0.62, h = 1.7;
      const cols: Part[] = [];
      for (let k = 0; k < 6; k++) cols.push(cyl(0.1, h, -w / 2 + 0.3 + (k * (w - 0.6)) / 5, 0.2, d / 2 + 0.3, '#f4efe2', 8));
      return {
        body: [
          foundation(W * 0.9, D * 0.9), box(w + 0.6, 0.2, d + 0.9, 0, 0, 0.15, '#cfc6b0'), box(w, h, d, 0, 0.2, 0, c),
          ...cols, box(w + 0.1, 0.25, 0.7, 0, h + 0.2, d / 2 + 0.2, '#efe7d2'), roof(w + 0.2, d + 0.2, 0.5, h + 0.2, '#8c9aa8'),
          colored(new THREE.SphereGeometry(0.8, 14, 8, 0, Math.PI * 2, 0, Math.PI / 2).translate(0, h + 0.65, 0), '#b8c7a0'),
        ],
        windows: [...windowRow(w * 0.85, d / 2 + 0.02, 1.0, 5, 0.26), ...windowRow(w * 0.85, -d / 2 - 0.02, 1.0, 5, 0.26)],
        height: h + 1.5,
      };
    }
  }
}

/** Builds (once per view) the merged geometries for a kind. The caller disposes them. */
export function buildModel(kind: BuildingKind): BuildingModel {
  const m = model(kind);
  const body = mergeGeometries(m.body, false);
  const windows = mergeGeometries(m.windows, false);
  for (const p of [...m.body, ...m.windows]) p.dispose();
  if (!body || !windows) throw new Error(`could not build model ${kind}`);
  return { body, windows, height: m.height };
}

/** Scaffold: an open frame of poles around the footprint (one shared geometry). */
export function buildScaffold(): THREE.BufferGeometry {
  const parts: Part[] = [];
  for (const x of [-0.5, 0.5]) for (const z of [-0.5, 0.5]) parts.push(box(0.04, 1, 0.04, x, 0, z, '#c8a060'));
  for (const y of [0.33, 0.66, 0.98]) {
    parts.push(box(1.02, 0.03, 0.03, 0, y, -0.5, '#b08850'), box(1.02, 0.03, 0.03, 0, y, 0.5, '#b08850'));
    parts.push(box(0.03, 0.03, 1.02, -0.5, y, 0, '#b08850'), box(0.03, 0.03, 1.02, 0.5, y, 0, '#b08850'));
  }
  const g = mergeGeometries(parts, false);
  for (const p of parts) p.dispose();
  if (!g) throw new Error('scaffold');
  return g;
}
