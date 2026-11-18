import * as THREE from 'three';
import { BUILDINGS, footprint, type Building } from '../../../shared/country/buildings.ts';
import type { Citizen } from '../../../shared/country/citizens.ts';
import type { TownStats } from '../../../shared/model.ts';
import type { LocalTerrain } from '../../../shared/country/terrain.ts';
import { mulberry32 } from '../../../shared/rng.ts';
import { placementTransform } from './buildingLayer.ts';
import { heightAt, type Disposables } from './props.ts';

export const MAX_AGENTS = 300;
const MAX_SIGNS = 90;
const MAX_FEATURED = 40;
/** walking speed in tiles per game hour */
const SPEED = 30;

/** What the server says about the mood of the country (drives visible reactions). */
export interface CrowdState {
  population: number;
  satisfaction: number;
  stats: TownStats | null;
  citizens: readonly Citizen[];
}

interface Place {
  x: number;
  z: number;
}

interface Agent {
  home: Place;
  work: Place;
  /** evening destination (market or park) */
  leisure: Place;
  /** 0..1 offsets so not everyone moves at once */
  phase: number;
  /** featured citizen id, or 0 */
  citizenId: number;
  /** hidden indoors at night unless a night walker */
  nightWalker: boolean;
  shirt: THREE.Color;
  /** current role override: 0 normal, 1 protester, 2 queueing */
  role: number;
  slot: number;
}

/**
 * Simulated crowd for the country view. Routine movement is a cheap, seeded
 * daily schedule (home -> work -> market/park -> home); what the crowd DOES is
 * driven by the real state from the server: protests near the town hall when
 * citizens are protesting, queues at the market during a food shortage, busier
 * parks when people are happy. All buffers are preallocated; update() does not allocate.
 */
export class Agents {
  readonly group = new THREE.Group();
  private readonly bodies: THREE.InstancedMesh;
  private readonly heads: THREE.InstancedMesh;
  private readonly signs: THREE.InstancedMesh;
  private readonly markers: THREE.InstancedMesh;
  private readonly dots: THREE.Points<THREE.BufferGeometry, THREE.PointsMaterial>;
  private readonly dotPos: Float32Array;
  private agents: Agent[] = [];
  /** world positions of every agent this frame (x, y, z) */
  readonly positions = new Float32Array(MAX_AGENTS * 3);
  readonly visible = new Uint8Array(MAX_AGENTS);
  private readonly m = new THREE.Matrix4();
  private readonly q = new THREE.Quaternion();
  private readonly s = new THREE.Vector3(1, 1, 1);
  private readonly p = new THREE.Vector3();
  private readonly up = new THREE.Vector3(0, 1, 0);
  private hall: Place = { x: 0, z: 0 };
  private market: Place | null = null;
  private protesters = 0;
  private queue = 0;
  private parkBias = 0.4;
  /** featured agent index -> citizen id (for hover/click) */
  readonly featuredIndex: number[] = [];
  shown = 0;
  hoverId = 0;

  constructor(private readonly t: LocalTerrain, d: Disposables) {
    this.group.name = 'citizens';
    const bodyGeo = d.add(new THREE.CylinderGeometry(0.1, 0.13, 0.46, 7).translate(0, 0.23, 0));
    const headGeo = d.add(new THREE.SphereGeometry(0.105, 8, 6).translate(0, 0.56, 0));
    const signParts = [new THREE.BoxGeometry(0.035, 0.85, 0.035).translate(0.16, 0.6, 0), new THREE.BoxGeometry(0.42, 0.28, 0.03).translate(0.16, 1.08, 0)];
    const signGeo = d.add(mergeTwo(signParts[0], signParts[1]));
    signParts.forEach((g) => g.dispose());
    const markerGeo = d.add(new THREE.ConeGeometry(0.11, 0.22, 4).rotateX(Math.PI).translate(0, 0.95, 0));
    this.bodies = d.add(new THREE.InstancedMesh(bodyGeo, d.add(new THREE.MeshStandardMaterial({ roughness: 0.8 })), MAX_AGENTS));
    this.heads = d.add(new THREE.InstancedMesh(headGeo, d.add(new THREE.MeshStandardMaterial({ color: '#e0b48f', roughness: 0.7 })), MAX_AGENTS));
    this.signs = d.add(new THREE.InstancedMesh(signGeo, d.add(new THREE.MeshStandardMaterial({ color: '#f4efe2', roughness: 0.9 })), MAX_SIGNS));
    this.markers = d.add(new THREE.InstancedMesh(markerGeo, d.add(new THREE.MeshBasicMaterial({ color: '#ffd36b' })), MAX_FEATURED));
    for (const mesh of [this.bodies, this.heads, this.signs, this.markers]) {
      mesh.count = 0;
      mesh.frustumCulled = false;
      mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    }
    this.bodies.castShadow = true;
    this.dotPos = new Float32Array(MAX_AGENTS * 3);
    const dotGeo = d.add(new THREE.BufferGeometry());
    const attr = new THREE.BufferAttribute(this.dotPos, 3);
    attr.setUsage(THREE.DynamicDrawUsage);
    dotGeo.setAttribute('position', attr);
    dotGeo.setDrawRange(0, 0);
    this.dots = new THREE.Points(dotGeo, d.add(new THREE.PointsMaterial({ color: '#2b2f3a', size: 3, sizeAttenuation: false })));
    this.dots.frustumCulled = false;
    this.group.add(this.bodies, this.heads, this.signs, this.markers, this.dots);
  }

  /** Rebuilds the crowd plan when buildings, citizens or the mood change. */
  setState(buildings: readonly Building[], crowd: CrowdState): void {
    const done = buildings.filter((b) => b.status === 'done');
    const door = (b: Building): Place => {
      const tr = placementTransform(this.t, b.kind, b.i, b.j, b.rot);
      const [, dd] = footprint(b.kind, b.rot);
      return { x: tr.x, z: tr.z + dd / 2 + 0.8 };
    };
    const byId = new Map(done.map((b) => [b.id, b] as const));
    const homes = done.filter((b) => BUILDINGS[b.kind].housing > 0);
    const works = done.filter((b) => BUILDINGS[b.kind].jobs > 0);
    const markets = done.filter((b) => b.kind === 'market');
    const parks = done.filter((b) => b.kind === 'park');
    const hall = done.find((b) => b.kind === 'townhall');
    const cap = { x: this.t.capital.i - (this.t.size - 1) / 2, z: -(this.t.capital.j - (this.t.size - 1) / 2) };
    this.hall = hall ? door(hall) : cap;
    this.market = markets.length ? door(markets[0]) : null;
    const fallback = (list: Building[], k: number): Place => (list.length ? door(list[k % list.length]) : this.hall);

    const count = Math.max(150, Math.min(MAX_AGENTS, Math.round(120 + crowd.population / 150_000)));
    const rng = mulberry32(this.t.capital.i * 7919 + this.t.capital.j);
    const shirts = ['#c8553d', '#2f6fd8', '#3f8a45', '#e0b84f', '#6c3d9c', '#e8772a', '#11908f', '#d9d4c7'];
    this.agents = [];
    this.featuredIndex.length = 0;
    for (let k = 0; k < count; k++) {
      const c = k < crowd.citizens.length ? crowd.citizens[k] : null;
      const homeB = c?.homeId ? byId.get(c.homeId) : undefined;
      const workB = c?.workplaceId ? byId.get(c.workplaceId) : undefined;
      const a: Agent = {
        home: homeB ? door(homeB) : fallback(homes, Math.floor(rng() * 997)),
        work: workB ? door(workB) : c && (c.job === 'Retired' || c.job === 'Unemployed') ? fallback(parks.length ? parks : markets, k) : fallback(works, Math.floor(rng() * 997)),
        leisure: fallback(rng() < 0.5 ? markets : parks, k),
        phase: rng(),
        citizenId: c?.id ?? 0,
        nightWalker: rng() < 0.08,
        shirt: new THREE.Color(shirts[Math.floor(rng() * shirts.length)]),
        role: 0,
        slot: 0,
      };
      if (c) this.featuredIndex.push(k);
      this.agents.push(a);
      this.bodies.setColorAt(k, a.shirt);
    }
    if (this.bodies.instanceColor) this.bodies.instanceColor.needsUpdate = true;

    // ---- reactions from the real state ----
    const sat = crowd.satisfaction;
    const unhappy = crowd.citizens.filter((c) => c.status === 'protesting' || c.status === 'planning to move').length;
    const share = crowd.citizens.length ? unhappy / crowd.citizens.length : 0;
    // protest crowd size follows the share of featured citizens who are protesting
    this.protesters = Math.min(MAX_SIGNS, Math.round(share * count * 0.6));
    this.queue = crowd.stats?.shortage && this.market ? 22 : 0;
    this.parkBias = sat >= 65 ? 0.75 : sat >= 45 ? 0.4 : 0.15;
    let p = 0;
    let qn = 0;
    // protesting featured citizens join first, then other agents
    const order = [...this.agents.keys()].sort((x, y) => {
      const cx = crowd.citizens.find((c) => c.id === this.agents[x].citizenId);
      const cy = crowd.citizens.find((c) => c.id === this.agents[y].citizenId);
      const px = cx && (cx.status === 'protesting' || cx.status === 'planning to move') ? 0 : 1;
      const py = cy && (cy.status === 'protesting' || cy.status === 'planning to move') ? 0 : 1;
      return px - py || x - y;
    });
    for (const k of order) {
      const a = this.agents[k];
      if (p < this.protesters) {
        a.role = 1;
        a.slot = p++;
      } else if (qn < this.queue) {
        a.role = 2;
        a.slot = qn++;
      } else a.role = 0;
      if (a.role === 0 && parks.length && rng() < this.parkBias) a.leisure = fallback(parks, k);
    }
  }

  /** Where agent `a` is at `hour` (0..24); returns false when indoors. */
  private place(a: Agent, k: number, hour: number, time: number, out: THREE.Vector3): boolean {
    const day = hour >= 6 && hour < 22;
    if (a.role === 1 && day) {
      // a crowd in front of the town hall, facing it
      const ring = 2.2 + (a.slot % 3) * 0.75;
      const ang = (a.slot / Math.max(1, this.protesters)) * Math.PI * 1.1 - Math.PI * 0.05 + Math.sin(time * 0.7 + k) * 0.03;
      out.set(this.hall.x + Math.cos(ang) * ring * 1.6, 0, this.hall.z + 1.5 + Math.sin(ang) * ring);
      return true;
    }
    if (a.role === 2 && day && this.market) {
      // a queue snaking away from the market door
      out.set(this.market.x + 0.5 + (a.slot % 2) * 0.05, 0, this.market.z + 0.4 + a.slot * 0.55);
      return true;
    }
    const start = 6 + a.phase * 1.6; // leave home
    const workStart = start + travel(a.home, a.work);
    const workEnd = 16 + a.phase * 1.5;
    const leisureStart = workEnd + travel(a.work, a.leisure);
    const leisureEnd = 19.5 + a.phase * 2;
    const homeAt = leisureEnd + travel(a.leisure, a.home);
    if (hour < start || hour >= homeAt) {
      if (!a.nightWalker) return false;
      return wander(a.home, 3, time, k, out);
    }
    if (hour < workStart) return lerpPlace(a.home, a.work, (hour - start) / (workStart - start), out);
    // people spread out around their workplace instead of standing in one knot
    if (hour < workEnd) return wander(a.work, 1.6 + a.phase * 3.2, time, k, out);
    if (hour < leisureStart) return lerpPlace(a.work, a.leisure, (hour - workEnd) / (leisureStart - workEnd), out);
    if (hour < leisureEnd) return wander(a.leisure, 2 + a.phase * 3, time, k, out);
    return lerpPlace(a.leisure, a.home, (hour - leisureEnd) / (homeAt - leisureEnd), out);
  }

  /**
   * Positions everyone for this frame. `distance` is the camera's distance to its
   * target: close up every citizen is a figure; further out they become dots,
   * and far away only a share of them is drawn.
   */
  update(hour: number, time: number, distance: number): void {
    const n = this.agents.length;
    const meshCap = distance < 70 ? n : distance < 150 ? Math.round((n * (150 - distance)) / 80) : 0;
    const total = distance < 220 ? n : Math.round(n * 0.6);
    let meshes = 0;
    let dots = 0;
    let signs = 0;
    let marks = 0;
    for (let k = 0; k < total; k++) {
      const a = this.agents[k];
      const vis = this.place(a, k, hour, time, this.p);
      this.visible[k] = vis ? 1 : 0;
      if (!vis) continue;
      this.p.y = heightAt(this.t, this.p.x, this.p.z);
      this.positions[k * 3] = this.p.x;
      this.positions[k * 3 + 1] = this.p.y;
      this.positions[k * 3 + 2] = this.p.z;
      if (k < meshCap || a.citizenId) {
        // walking bob
        this.p.y += Math.abs(Math.sin(time * 6 + k)) * 0.03;
        const facing = a.role === 1 ? Math.atan2(this.hall.x - this.p.x, this.hall.z - this.p.z) : (k * 2.39) % (Math.PI * 2);
        this.q.setFromAxisAngle(this.up, facing);
        const big = a.citizenId && a.citizenId === this.hoverId ? 1.25 : 1;
        this.s.set(big, big, big);
        this.m.compose(this.p, this.q, this.s);
        this.bodies.setMatrixAt(meshes, this.m);
        this.heads.setMatrixAt(meshes, this.m);
        this.bodies.setColorAt(meshes, a.shirt);
        meshes++;
        if (a.role === 1 && signs < MAX_SIGNS) this.signs.setMatrixAt(signs++, this.m);
        if (a.citizenId && marks < MAX_FEATURED) this.markers.setMatrixAt(marks++, this.m);
      } else {
        this.dotPos[dots * 3] = this.p.x;
        this.dotPos[dots * 3 + 1] = this.p.y + 0.3;
        this.dotPos[dots * 3 + 2] = this.p.z;
        dots++;
      }
    }
    for (let k = total; k < n; k++) this.visible[k] = 0;
    this.bodies.count = this.heads.count = meshes;
    this.signs.count = signs;
    this.markers.count = distance < 160 ? marks : 0;
    for (const mesh of [this.bodies, this.heads, this.signs, this.markers]) mesh.instanceMatrix.needsUpdate = true;
    if (this.bodies.instanceColor) this.bodies.instanceColor.needsUpdate = true;
    this.dots.geometry.setDrawRange(0, dots);
    (this.dots.geometry.attributes.position as THREE.BufferAttribute).needsUpdate = true;
    this.shown = meshes + dots;
  }

  /** Featured citizen nearest to a screen point (pixels), within `radius`. */
  pick(camera: THREE.Camera, w: number, h: number, x: number, y: number, radius = 16): number {
    let best = 0;
    let bestD = radius * radius;
    for (const k of this.featuredIndex) {
      if (!this.visible[k]) continue;
      this.p.set(this.positions[k * 3], this.positions[k * 3 + 1] + 0.5, this.positions[k * 3 + 2]).project(camera);
      if (this.p.z > 1) continue;
      const sx = (this.p.x * 0.5 + 0.5) * w;
      const sy = (-this.p.y * 0.5 + 0.5) * h;
      const dd = (sx - x) ** 2 + (sy - y) ** 2;
      if (dd < bestD) {
        bestD = dd;
        best = this.agents[k].citizenId;
      }
    }
    return best;
  }

  /** World position of a featured citizen (for the name tag), or null when indoors. */
  positionOf(citizenId: number, out: THREE.Vector3): THREE.Vector3 | null {
    for (const k of this.featuredIndex) {
      if (this.agents[k].citizenId !== citizenId) continue;
      if (!this.visible[k]) return null;
      return out.set(this.positions[k * 3], this.positions[k * 3 + 1], this.positions[k * 3 + 2]);
    }
    return null;
  }

  /** Counts for the stats overlay. */
  counts(): { agents: number; protesters: number; queue: number } {
    return { agents: this.shown, protesters: this.protesters, queue: this.queue };
  }
}

function travel(a: Place, b: Place): number {
  return Math.max(0.15, Math.hypot(a.x - b.x, a.z - b.z) / SPEED);
}

/** Milling around a place (no allocation). */
function wander(pl: Place, r: number, time: number, k: number, out: THREE.Vector3): boolean {
  out.set(pl.x + Math.cos(time * 0.3 + k * 1.7) * r, 0, pl.z + Math.sin(time * 0.37 + k * 2.3) * r);
  return true;
}

function lerpPlace(a: Place, b: Place, f: number, out: THREE.Vector3): boolean {
  const k = Math.max(0, Math.min(1, f));
  out.set(a.x + (b.x - a.x) * k, 0, a.z + (b.z - a.z) * k);
  return true;
}

function mergeTwo(a: THREE.BufferGeometry, b: THREE.BufferGeometry): THREE.BufferGeometry {
  const pa = a.toNonIndexed(), pb = b.toNonIndexed();
  const pos = new Float32Array(pa.attributes.position.count * 3 + pb.attributes.position.count * 3);
  pos.set(pa.attributes.position.array as Float32Array, 0);
  pos.set(pb.attributes.position.array as Float32Array, pa.attributes.position.count * 3);
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  g.computeVertexNormals();
  pa.dispose();
  pb.dispose();
  return g;
}
