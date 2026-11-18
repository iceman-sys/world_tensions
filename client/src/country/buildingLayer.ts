import * as THREE from 'three';
import { BUILDING_KINDS, BUILDINGS, footprint, progressOf, type Building, type BuildingKind } from '../../../shared/country/buildings.ts';
import type { LocalTerrain } from '../../../shared/country/terrain.ts';
import { buildModel, buildScaffold, type BuildingModel } from './models.ts';
import type { Disposables } from './props.ts';

/** Instances per building kind (grows by rebuilding if a country ever exceeds it). */
const PER_KIND = 256;
const MAX_SITES = 64;

interface Ring {
  el: HTMLDivElement;
  pos: THREE.Vector3;
  last: number;
}

/** Footprint centre, base height and rotation of a building on the terrain. */
export function placementTransform(t: LocalTerrain, kind: BuildingKind, i: number, j: number, rot: 0 | 1): { x: number; y: number; z: number; angle: number } {
  const [w, d] = footprint(kind, rot);
  const n = t.size;
  let hi = -Infinity;
  for (let y = j; y < j + d; y++) for (let x = i; x < i + w; x++) if (x >= 0 && y >= 0 && x < n && y < n) hi = Math.max(hi, t.heights[y * n + x]);
  const c = (n - 1) / 2;
  const ci = i + (w - 1) / 2;
  const cj = j + (d - 1) / 2;
  return { x: ci - c, y: Number.isFinite(hi) ? hi : 0, z: -(cj - c), angle: rot === 1 ? Math.PI / 2 : 0 };
}

/**
 * All buildings of the country: one body + one window InstancedMesh per kind,
 * scaffolds for construction sites, and HTML progress rings.
 */
export class BuildingLayer {
  readonly group = new THREE.Group();
  readonly models = new Map<BuildingKind, BuildingModel>();
  private readonly bodies = new Map<BuildingKind, THREE.InstancedMesh>();
  private readonly windows = new Map<BuildingKind, THREE.InstancedMesh>();
  private readonly scaffold: THREE.InstancedMesh;
  readonly windowMaterial: THREE.MeshStandardMaterial;
  private buildings: Building[] = [];
  private rings = new Map<number, Ring>();
  private readonly m = new THREE.Matrix4();
  private readonly q = new THREE.Quaternion();
  private readonly s = new THREE.Vector3();
  private readonly p = new THREE.Vector3();
  private readonly tmp = new THREE.Vector3();
  private readonly up = new THREE.Vector3(0, 1, 0);
  /** reused every frame (no per-frame allocation) */
  private readonly frameCounts = new Map<BuildingKind, number>();
  /** counts per kind / construction sites (for the stats overlay) */
  instanceCount = 0;

  constructor(private readonly t: LocalTerrain, d: Disposables, private readonly labelRoot: HTMLElement) {
    this.group.name = 'buildings';
    const bodyMat = d.add(new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.85 }));
    this.windowMaterial = d.add(new THREE.MeshStandardMaterial({ color: '#2b3a4c', emissive: '#ffcf7a', emissiveIntensity: 0, roughness: 0.4 }));
    for (const kind of BUILDING_KINDS) {
      const model = buildModel(kind);
      d.add(model.body);
      d.add(model.windows);
      this.models.set(kind, model);
      const body = d.add(new THREE.InstancedMesh(model.body, bodyMat, PER_KIND));
      const win = d.add(new THREE.InstancedMesh(model.windows, this.windowMaterial, PER_KIND));
      body.count = win.count = 0;
      body.castShadow = body.receiveShadow = true;
      body.frustumCulled = win.frustumCulled = false; // instances span the whole map; bounds would need recomputing per change
      body.name = `building-${kind}`;
      this.bodies.set(kind, body);
      this.windows.set(kind, win);
      this.group.add(body, win);
    }
    const scaffoldGeo = d.add(buildScaffold());
    this.scaffold = d.add(new THREE.InstancedMesh(scaffoldGeo, d.add(new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 1 })), MAX_SITES));
    this.scaffold.count = 0;
    this.scaffold.frustumCulled = false;
    this.group.add(this.scaffold);
  }

  /** Replaces the full building list (called on every local update from the server). */
  set(buildings: Building[], now: number): void {
    this.buildings = [...buildings].sort((a, b) => a.id - b.id);
    const counts = new Map<BuildingKind, number>();
    let sites = 0;
    for (const b of this.buildings) {
      const k = counts.get(b.kind) ?? 0;
      if (k >= PER_KIND) continue;
      counts.set(b.kind, k + 1);
      this.writeInstance(b, k, now);
      if (b.status === 'building' && sites < MAX_SITES) sites++;
    }
    let total = 0;
    for (const kind of BUILDING_KINDS) {
      const n = counts.get(kind) ?? 0;
      const body = this.bodies.get(kind);
      const win = this.windows.get(kind);
      if (!body || !win) continue;
      body.count = win.count = n;
      body.instanceMatrix.needsUpdate = win.instanceMatrix.needsUpdate = true;
      total += n * 2;
    }
    this.instanceCount = total + sites;
    this.syncRings();
    this.updateConstruction(now, true);
  }

  private writeInstance(b: Building, index: number, now: number): void {
    const tr = placementTransform(this.t, b.kind, b.i, b.j, b.rot);
    const grow = b.status === 'done' ? 1 : 0.12 + 0.88 * progressOf(b, now);
    this.p.set(tr.x, tr.y, tr.z);
    this.q.setFromAxisAngle(this.up, tr.angle);
    this.s.set(1, grow, 1);
    this.m.compose(this.p, this.q, this.s);
    this.bodies.get(b.kind)?.setMatrixAt(index, this.m);
    // windows appear once the building is finished
    if (b.status !== 'done') this.s.set(0, 0, 0);
    this.m.compose(this.p, this.q, this.s);
    this.windows.get(b.kind)?.setMatrixAt(index, this.m);
  }

  private syncRings(): void {
    const live = new Set<number>();
    for (const b of this.buildings) {
      if (b.status !== 'building') continue;
      live.add(b.id);
      if (this.rings.has(b.id)) continue;
      const el = document.createElement('div');
      el.className = 'cv-progress';
      el.innerHTML = '<span></span>';
      this.labelRoot.appendChild(el);
      const tr = placementTransform(this.t, b.kind, b.i, b.j, b.rot);
      const h = this.models.get(b.kind)?.height ?? 2;
      this.rings.set(b.id, { el, pos: new THREE.Vector3(tr.x, tr.y + h + 1.2, tr.z), last: -1 });
    }
    for (const [id, r] of this.rings) {
      if (live.has(id)) continue;
      r.el.remove();
      this.rings.delete(id);
    }
  }

  /** Grows buildings under construction and positions scaffolds; call every frame. */
  updateConstruction(now: number, force = false): void {
    let site = 0;
    const counts = this.frameCounts;
    counts.clear();
    let touched = false;
    for (const b of this.buildings) {
      const k = counts.get(b.kind) ?? 0;
      counts.set(b.kind, k + 1);
      if (b.status !== 'building') continue;
      touched = true;
      if (k < PER_KIND) this.writeInstance(b, k, now);
      if (site >= MAX_SITES) continue;
      const tr = placementTransform(this.t, b.kind, b.i, b.j, b.rot);
      const [w, d] = footprint(b.kind, b.rot);
      const h = (this.models.get(b.kind)?.height ?? 2) * 1.08;
      this.p.set(tr.x, tr.y, tr.z);
      this.q.identity();
      this.s.set(w * 0.95, h, d * 0.95);
      this.m.compose(this.p, this.q, this.s);
      this.scaffold.setMatrixAt(site++, this.m);
    }
    if (touched || force) {
      for (const kind of BUILDING_KINDS) {
        const body = this.bodies.get(kind);
        const win = this.windows.get(kind);
        if (body) body.instanceMatrix.needsUpdate = true;
        if (win) win.instanceMatrix.needsUpdate = true;
      }
    }
    if (this.scaffold.count !== site || site > 0) {
      this.scaffold.count = site;
      this.scaffold.instanceMatrix.needsUpdate = true;
    }
  }

  /** Positions the progress rings (HTML) over construction sites. */
  layoutRings(camera: THREE.Camera, w: number, h: number, now: number): void {
    for (const [id, r] of this.rings) {
      const b = this.buildings.find((x) => x.id === id);
      if (!b) continue;
      this.tmp.copy(r.pos).project(camera);
      const vis = this.tmp.z < 1 && Math.abs(this.tmp.x) < 1.1 && Math.abs(this.tmp.y) < 1.1;
      r.el.style.opacity = vis ? '1' : '0';
      if (!vis) continue;
      r.el.style.transform = `translate3d(${((this.tmp.x * 0.5 + 0.5) * w).toFixed(1)}px, ${((-this.tmp.y * 0.5 + 0.5) * h).toFixed(1)}px, 0) translate(-50%, -50%)`;
      const pct = Math.floor(progressOf(b, now) * 100);
      if (pct !== r.last) {
        r.last = pct;
        r.el.style.setProperty('--p', `${pct}%`);
        const label = r.el.firstElementChild;
        if (label) label.textContent = `${pct}%`;
        r.el.title = `${BUILDINGS[b.kind].label}: ${pct}% built`;
      }
    }
  }

  /** Tile rectangles of all buildings (to clear trees). */
  footprints(): { i: number; j: number; w: number; d: number }[] {
    return this.buildings.map((b) => {
      const [w, d] = footprint(b.kind, b.rot);
      return { i: b.i, j: b.j, w, d };
    });
  }

  /** World position of a building's roof (for labels). */
  topOf(b: Building): THREE.Vector3 {
    const tr = placementTransform(this.t, b.kind, b.i, b.j, b.rot);
    return new THREE.Vector3(tr.x, tr.y + (this.models.get(b.kind)?.height ?? 2), tr.z);
  }

  list(): readonly Building[] {
    return this.buildings;
  }

  dispose(): void {
    for (const r of this.rings.values()) r.el.remove();
    this.rings.clear();
  }
}
