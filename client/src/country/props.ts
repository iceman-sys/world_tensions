import * as THREE from 'three';
import { BIOME, MASK, RESOURCE_SPOT, WATER } from '../../../shared/country/config.ts';
import { tileToWorld, type LocalTerrain, type ResourceSpot } from '../../../shared/country/terrain.ts';
import { deriveSeed, mulberry32 } from '../../../shared/rng.ts';

export const MAX_TREES = 3200;

/** Collects everything created for the scene so it can be disposed exactly once. */
export class Disposables {
  private readonly items = new Set<{ dispose: () => void }>();
  add<T extends { dispose: () => void }>(item: T): T {
    this.items.add(item);
    return item;
  }
  dispose(): void {
    for (const i of this.items) i.dispose();
    this.items.clear();
  }
}

function heightAt(t: LocalTerrain, x: number, z: number): number {
  const n = t.size;
  const c = (n - 1) / 2;
  const fi = Math.max(0, Math.min(n - 1.001, x + c));
  const fj = Math.max(0, Math.min(n - 1.001, c - z));
  const i = Math.floor(fi), j = Math.floor(fj);
  const tx = fi - i, ty = fj - j;
  const h = t.heights;
  const a = h[j * n + i], b = h[j * n + i + 1], d = h[(j + 1) * n + i], e = h[(j + 1) * n + i + 1];
  return (a * (1 - tx) + b * tx) * (1 - ty) + (d * (1 - tx) + e * tx) * ty;
}
export { heightAt };

/**
 * Instanced trees: forests by biome (sparse pines on snow) plus dense groves for
 * Timber/Rubber sites. Placement is seeded per nation, so it is the same every visit.
 */
export interface Trees {
  group: THREE.Group;
  /** hides every tree inside (or next to) the given tile rectangles; shows the rest */
  clear: (rects: { i: number; j: number; w: number; d: number }[]) => void;
}

export function buildTrees(t: LocalTerrain, seed: number, d: Disposables): Trees {
  const rng = mulberry32(deriveSeed(seed, 'trees'));
  const n = t.size;
  const spots = new Set<number>();
  for (const s of t.spots) {
    if (s.kind !== 'grove') continue;
    for (let dj = -s.r; dj <= s.r; dj++) for (let di = -s.r; di <= s.r; di++) if (Math.hypot(di, dj) <= s.r) spots.add((s.j + dj) * n + s.i + di);
  }
  const keepClear = (i: number, j: number) => Math.hypot(i - t.capital.i, j - t.capital.j) < 14;
  const places: { x: number; z: number; y: number; s: number; pine: boolean; shade: number }[] = [];
  for (let j = 1; j < n - 1 && places.length < MAX_TREES; j++) {
    for (let i = 1; i < n - 1 && places.length < MAX_TREES; i++) {
      const k = j * n + i;
      if (t.mask[k] !== MASK.own || t.water[k] !== WATER.none || keepClear(i, j)) continue;
      const b = t.biome[k];
      const grove = spots.has(k);
      const p = grove ? 0.75 : b === BIOME.forest ? 0.32 : b === BIOME.grass ? 0.025 : b === BIOME.snow ? 0.02 : 0;
      if (rng() >= p) continue;
      const x = i - (n - 1) / 2 + (rng() - 0.5) * 0.8;
      const z = -(j - (n - 1) / 2) + (rng() - 0.5) * 0.8;
      places.push({ x, z, y: heightAt(t, x, z), s: 0.7 + rng() * 0.6, pine: b === BIOME.snow || t.latitude > 0.85 || t.latitude < -0.85 || rng() < 0.35, shade: rng() });
    }
  }
  const trunkGeo = d.add(new THREE.CylinderGeometry(0.08, 0.12, 0.8, 5));
  trunkGeo.translate(0, 0.4, 0);
  const crownGeo = d.add(new THREE.ConeGeometry(0.62, 1.9, 7));
  crownGeo.translate(0, 1.55, 0);
  const trunkMat = d.add(new THREE.MeshStandardMaterial({ color: '#5a4030', roughness: 1 }));
  const crownMat = d.add(new THREE.MeshStandardMaterial({ roughness: 0.9 }));
  const trunks = d.add(new THREE.InstancedMesh(trunkGeo, trunkMat, Math.max(1, places.length)));
  const crowns = d.add(new THREE.InstancedMesh(crownGeo, crownMat, Math.max(1, places.length)));
  const m = new THREE.Matrix4();
  const q = new THREE.Quaternion();
  const sc = new THREE.Vector3();
  const p = new THREE.Vector3();
  const c = new THREE.Color();
  places.forEach((pl, idx) => {
    p.set(pl.x, pl.y - 0.05, pl.z);
    sc.setScalar(pl.s);
    m.compose(p, q, sc);
    trunks.setMatrixAt(idx, m);
    crowns.setMatrixAt(idx, m);
    c.set(pl.pine ? '#2f5a3a' : '#3f7a3a').offsetHSL((pl.shade - 0.5) * 0.04, 0, (pl.shade - 0.5) * 0.08);
    crowns.setColorAt(idx, c);
  });
  trunks.count = crowns.count = places.length;
  for (const mesh of [trunks, crowns]) {
    mesh.castShadow = true;
    mesh.instanceMatrix.needsUpdate = true;
    mesh.computeBoundingSphere();
  }
  if (crowns.instanceColor) crowns.instanceColor.needsUpdate = true;
  const g = new THREE.Group();
  g.name = 'trees';
  g.add(trunks, crowns);

  const c0 = (n - 1) / 2;
  const hidden = new Uint8Array(places.length);
  const zero = new THREE.Matrix4().makeScale(0, 0, 0);
  const clear = (rects: { i: number; j: number; w: number; d: number }[]) => {
    let changed = false;
    places.forEach((pl, idx) => {
      const ti = pl.x + c0, tj = c0 - pl.z;
      const inside = rects.some((r) => ti > r.i - 1.5 && ti < r.i + r.w + 0.5 && tj > r.j - 1.5 && tj < r.j + r.d + 0.5);
      if (inside === (hidden[idx] === 1)) return;
      hidden[idx] = inside ? 1 : 0;
      changed = true;
      if (inside) {
        trunks.setMatrixAt(idx, zero);
        crowns.setMatrixAt(idx, zero);
      } else {
        p.set(pl.x, pl.y - 0.05, pl.z);
        sc.setScalar(pl.s);
        m.compose(p, q, sc);
        trunks.setMatrixAt(idx, m);
        crowns.setMatrixAt(idx, m);
      }
    });
    if (changed) {
      trunks.instanceMatrix.needsUpdate = true;
      crowns.instanceMatrix.needsUpdate = true;
    }
  };
  return { group: g, clear };
}

function box(d: Disposables, w: number, h: number, depth: number, color: string, mats: Map<string, THREE.Material>): THREE.Mesh {
  const geo = d.add(new THREE.BoxGeometry(w, h, depth));
  geo.translate(0, h / 2, 0);
  let mat = mats.get(color);
  if (!mat) {
    mat = d.add(new THREE.MeshStandardMaterial({ color, roughness: 0.85 }));
    mats.set(color, mat);
  }
  const mesh = new THREE.Mesh(geo, mat);
  mesh.castShadow = true;
  mesh.receiveShadow = true;
  return mesh;
}

function cone(d: Disposables, r: number, h: number, sides: number, color: string, mats: Map<string, THREE.Material>): THREE.Mesh {
  const geo = d.add(new THREE.ConeGeometry(r, h, sides));
  geo.translate(0, h / 2, 0);
  let mat = mats.get(color);
  if (!mat) {
    mat = d.add(new THREE.MeshStandardMaterial({ color, roughness: 0.85 }));
    mats.set(color, mat);
  }
  const mesh = new THREE.Mesh(geo, mat);
  mesh.castShadow = true;
  return mesh;
}

/** A small, recognisable landmark for each natural-resource site. */
export function buildResourceSites(t: LocalTerrain, d: Disposables): THREE.Group {
  const g = new THREE.Group();
  g.name = 'resource-sites';
  const mats = new Map<string, THREE.Material>();
  const n = t.size;
  for (const s of t.spots) {
    const site = new THREE.Group();
    const { x, z } = tileToWorld(n, s.i, s.j);
    site.position.set(x, heightAt(t, x, z), z);
    const color = RESOURCE_SPOT[s.resource]?.color ?? '#888888';
    addSiteModel(site, s, color, d, mats);
    site.userData.resource = s.resource;
    g.add(site);
  }
  return g;
}

function addSiteModel(site: THREE.Group, s: ResourceSpot, color: string, d: Disposables, mats: Map<string, THREE.Material>): void {
  switch (s.kind) {
    case 'mine': {
      // ore heaps around a headframe tower and a shed
      for (let k = 0; k < 3; k++) {
        const heap = cone(d, 0.9, 0.9, 6, color, mats);
        heap.position.set(Math.cos(k * 2.1) * 2.2, 0, Math.sin(k * 2.1) * 2.2);
        site.add(heap);
      }
      const tower = box(d, 0.5, 4, 0.5, '#5b4a3b', mats);
      const top = box(d, 1.4, 0.3, 1.4, '#3a3a3e', mats);
      top.position.y = 4;
      const shed = box(d, 2, 1.1, 1.4, '#9a8f80', mats);
      shed.position.set(1.4, 0, -1.2);
      site.add(tower, top, shed);
      break;
    }
    case 'oil': {
      const derrick = cone(d, 0.9, 5, 4, '#4a4f57', mats);
      const t1 = new THREE.Mesh(d.add(new THREE.CylinderGeometry(0.9, 0.9, 1.4, 12).translate(0, 0.7, 0)), mats.get(color) ?? d.add(new THREE.MeshStandardMaterial({ color, roughness: 0.6, metalness: 0.2 })));
      t1.position.set(2.2, 0, 0.6);
      t1.castShadow = true;
      const t2 = t1.clone();
      t2.position.set(2.2, 0, -1.6);
      site.add(derrick, t1, t2);
      break;
    }
    case 'pasture': {
      for (let k = 0; k < 10; k++) {
        const a = k * 2.399;
        const r = 1 + (k % 4) * 1.2;
        const animal = box(d, 0.45, 0.32, 0.25, k % 3 === 0 ? '#5a4030' : '#efe9dc', mats);
        animal.position.set(Math.cos(a) * r, 0.05, Math.sin(a) * r);
        animal.rotation.y = a;
        site.add(animal);
      }
      const barn = box(d, 1.8, 1.3, 1.2, '#9b3b2e', mats);
      barn.position.set(-s.r * 0.6, 0, s.r * 0.4);
      site.add(barn);
      break;
    }
    case 'field': {
      const barn = box(d, 1.4, 1, 1, '#a9583f', mats);
      const silo = new THREE.Mesh(d.add(new THREE.CylinderGeometry(0.4, 0.4, 2, 10).translate(0, 1, 0)), mats.get('#c9c4b8') ?? d.add(new THREE.MeshStandardMaterial({ color: '#c9c4b8' })));
      silo.castShadow = true;
      barn.position.set(s.r + 0.8, 0, 0);
      silo.position.set(s.r + 0.8, 0, 1.2);
      site.add(barn, silo);
      break;
    }
    case 'grove': {
      const mill = box(d, 1.8, 0.9, 1, '#7a5a3a', mats);
      mill.position.set(s.r + 0.6, 0, 0);
      const logs = box(d, 1.2, 0.35, 0.5, '#9c7a52', mats);
      logs.position.set(s.r + 0.6, 0, 1.1);
      site.add(mill, logs);
      break;
    }
    case 'fishery': {
      const hut = box(d, 1.4, 1, 1.2, '#b8a07a', mats);
      const pier = box(d, 0.6, 0.12, 4, '#7a5e40', mats);
      pier.position.set(0, 0.1, 2.4);
      const boat = box(d, 0.5, 0.25, 1.2, '#d65a3a', mats);
      boat.position.set(1, 0, 3.6);
      site.add(hut, pier, boat);
      break;
    }
  }
}

/** Flagpole with a waving flag at the capital. Call `update(time)` each frame. */
export function buildFlagpole(flag: HTMLCanvasElement, d: Disposables): { group: THREE.Group; update: (time: number) => void } {
  const group = new THREE.Group();
  group.name = 'flagpole';
  const poleMat = d.add(new THREE.MeshStandardMaterial({ color: '#d8dce2', metalness: 0.6, roughness: 0.35 }));
  const pole = new THREE.Mesh(d.add(new THREE.CylinderGeometry(0.09, 0.12, 9, 10).translate(0, 4.5, 0)), poleMat);
  pole.castShadow = true;
  const knob = new THREE.Mesh(d.add(new THREE.SphereGeometry(0.2, 10, 8).translate(0, 9.05, 0)), d.add(new THREE.MeshStandardMaterial({ color: '#e8c24a', metalness: 0.7, roughness: 0.3 })));
  const plinth = new THREE.Mesh(d.add(new THREE.CylinderGeometry(1.4, 1.7, 0.6, 8).translate(0, 0.3, 0)), d.add(new THREE.MeshStandardMaterial({ color: '#b9b3a7', roughness: 0.95 })));
  plinth.receiveShadow = plinth.castShadow = true;

  const tex = d.add(new THREE.CanvasTexture(flag));
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.anisotropy = 4;
  const W = 4.2, H = 2.8, SX = 16, SY = 8;
  const geo = d.add(new THREE.PlaneGeometry(W, H, SX, SY));
  geo.translate(W / 2 + 0.1, 9 - H / 2 - 0.15, 0);
  const base = Float32Array.from(geo.attributes.position.array as Float32Array);
  const cloth = new THREE.Mesh(geo, d.add(new THREE.MeshStandardMaterial({ map: tex, side: THREE.DoubleSide, roughness: 0.8 })));
  cloth.castShadow = true;
  group.add(plinth, pole, knob, cloth);

  const posAttr = geo.attributes.position as THREE.BufferAttribute;
  const arr = posAttr.array as Float32Array;
  const update = (time: number) => {
    for (let v = 0; v < arr.length; v += 3) {
      const x = base[v] - 0.1;
      const amp = (x / W) * 0.35;
      arr[v + 2] = base[v + 2] + Math.sin(x * 1.6 - time * 4.2) * amp + Math.sin(x * 3.1 - time * 6.3 + base[v + 1]) * amp * 0.25;
    }
    // normals stay those of the flat cloth: the ripple is small and this keeps the frame allocation-free
    posAttr.needsUpdate = true;
  };
  update(0);
  return { group, update };
}
