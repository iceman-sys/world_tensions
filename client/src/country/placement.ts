import * as THREE from 'three';
import { BUILDINGS, PLACEMENT_MESSAGES, footprint, validatePlacement, type Building, type BuildingKind, type PlacementResult } from '../../../shared/country/buildings.ts';
import type { LocalTerrain } from '../../../shared/country/terrain.ts';
import { heightAt, type Disposables } from './props.ts';
import { placementTransform, type BuildingLayer } from './buildingLayer.ts';

export interface PlacementHint {
  kind: BuildingKind;
  result: PlacementResult;
  x: number;
  y: number;
}

/**
 * Build mode: a translucent ghost follows the pointer on a snapped tile grid and
 * turns green or red using the same validatePlacement the server runs.
 */
export class Placement {
  kind: BuildingKind | null = null;
  rot: 0 | 1 = 0;
  private tile: { i: number; j: number } | null = null;
  private last: PlacementResult | null = null;
  private readonly ghost = new THREE.Group();
  private readonly ghostMat: THREE.MeshBasicMaterial;
  private readonly padMat: THREE.MeshBasicMaterial;
  private readonly ghostMesh: THREE.Mesh;
  private readonly pad: THREE.Mesh;
  private readonly raycaster = new THREE.Raycaster();
  private readonly ndc = new THREE.Vector2();
  private readonly pt = new THREE.Vector3();
  private downX = 0;
  private downY = 0;
  onPlace: ((kind: BuildingKind, i: number, j: number, rot: 0 | 1) => void) | null = null;
  onHint: ((hint: PlacementHint | null) => void) | null = null;

  constructor(
    private readonly t: LocalTerrain,
    private readonly layer: BuildingLayer,
    private readonly camera: THREE.Camera,
    private readonly canvas: HTMLCanvasElement,
    private readonly funds: () => number,
    private readonly existing: () => readonly Building[],
    d: Disposables,
  ) {
    this.ghostMat = d.add(new THREE.MeshBasicMaterial({ color: '#4ade80', transparent: true, opacity: 0.55, depthWrite: false }));
    this.padMat = d.add(new THREE.MeshBasicMaterial({ color: '#4ade80', transparent: true, opacity: 0.35, depthWrite: false, side: THREE.DoubleSide }));
    this.ghostMesh = new THREE.Mesh(undefined, this.ghostMat);
    const padGeo = d.add(new THREE.PlaneGeometry(1, 1).rotateX(-Math.PI / 2));
    this.pad = new THREE.Mesh(padGeo, this.padMat);
    this.ghost.add(this.ghostMesh, this.pad);
    this.ghost.visible = false;
    this.ghost.renderOrder = 5;
    canvas.addEventListener('pointermove', this.move);
    canvas.addEventListener('pointerdown', this.down);
    canvas.addEventListener('pointerup', this.up);
    canvas.addEventListener('contextmenu', this.context);
  }

  get object(): THREE.Object3D {
    return this.ghost;
  }

  get active(): boolean {
    return this.kind !== null;
  }

  start(kind: BuildingKind): void {
    this.kind = kind;
    this.rot = 0;
    const model = this.layer.models.get(kind);
    if (model) this.ghostMesh.geometry = model.body;
    this.ghost.visible = false;
    this.canvas.style.cursor = 'crosshair';
  }

  cancel(): void {
    this.kind = null;
    this.tile = null;
    this.ghost.visible = false;
    this.canvas.style.cursor = '';
    this.onHint?.(null);
  }

  rotate(): void {
    if (!this.kind) return;
    this.rot = this.rot === 0 ? 1 : 0;
    this.refresh();
  }

  /** Re-validates the current spot (funds or buildings may have changed). */
  refresh(): void {
    if (!this.kind || !this.tile) return;
    this.apply(this.tile.i, this.tile.j);
  }

  /** Finds where a screen ray first meets the heightfield (march + bisection). */
  private groundAt(clientX: number, clientY: number): THREE.Vector3 | null {
    const rect = this.canvas.getBoundingClientRect();
    this.ndc.set(((clientX - rect.left) / rect.width) * 2 - 1, -((clientY - rect.top) / rect.height) * 2 + 1);
    this.raycaster.setFromCamera(this.ndc, this.camera);
    const { origin, direction } = this.raycaster.ray;
    let prev = 0;
    for (let s = 0.5; s < 900; s += 0.75) {
      this.pt.copy(origin).addScaledVector(direction, s);
      if (this.pt.y <= heightAt(this.t, this.pt.x, this.pt.z)) {
        let lo = prev, hi = s;
        for (let k = 0; k < 10; k++) {
          const mid = (lo + hi) / 2;
          this.pt.copy(origin).addScaledVector(direction, mid);
          if (this.pt.y <= heightAt(this.t, this.pt.x, this.pt.z)) hi = mid;
          else lo = mid;
        }
        this.pt.copy(origin).addScaledVector(direction, hi);
        return this.pt;
      }
      prev = s;
    }
    return null;
  }

  private readonly move = (e: PointerEvent): void => {
    if (!this.kind) return;
    const g = this.groundAt(e.clientX, e.clientY);
    if (!g) {
      this.ghost.visible = false;
      this.onHint?.(null);
      return;
    }
    const n = this.t.size;
    const c = (n - 1) / 2;
    const [w, d] = footprint(this.kind, this.rot);
    const i = Math.round(g.x + c - (w - 1) / 2);
    const j = Math.round(c - g.z - (d - 1) / 2);
    this.apply(i, j, e.clientX, e.clientY);
  };

  private hintX = 0;
  private hintY = 0;

  private apply(i: number, j: number, x = this.hintX, y = this.hintY): void {
    if (!this.kind) return;
    this.hintX = x;
    this.hintY = y;
    this.tile = { i, j };
    const result = validatePlacement(this.t, this.existing(), this.kind, i, j, this.rot, this.funds());
    this.last = result;
    const tr = placementTransform(this.t, this.kind, i, j, this.rot);
    const [w, d] = footprint(this.kind, this.rot);
    this.ghost.position.set(tr.x, tr.y + 0.02, tr.z);
    this.ghostMesh.rotation.y = tr.angle;
    this.pad.scale.set(w, 1, d);
    this.pad.position.y = 0.06;
    const color = result.ok ? '#4ade80' : '#f87171';
    this.ghostMat.color.set(color);
    this.padMat.color.set(color);
    this.ghost.visible = true;
    this.onHint?.({ kind: this.kind, result, x, y });
  }

  private readonly down = (e: PointerEvent): void => {
    this.downX = e.clientX;
    this.downY = e.clientY;
  };

  private readonly up = (e: PointerEvent): void => {
    if (!this.kind || e.button !== 0 || !this.tile) return;
    if (Math.hypot(e.clientX - this.downX, e.clientY - this.downY) > 6) return; // that was a drag
    if (this.last?.ok) this.onPlace?.(this.kind, this.tile.i, this.tile.j, this.rot);
  };

  private readonly context = (e: MouseEvent): void => {
    if (!this.kind) return;
    e.preventDefault();
    this.cancel();
  };

  /** Heights under the ghost follow the terrain; keep it from sinking into slopes. */
  ground(x: number, z: number): number {
    return heightAt(this.t, x, z);
  }

  dispose(): void {
    this.canvas.removeEventListener('pointermove', this.move);
    this.canvas.removeEventListener('pointerdown', this.down);
    this.canvas.removeEventListener('pointerup', this.up);
    this.canvas.removeEventListener('contextmenu', this.context);
    this.canvas.style.cursor = '';
  }
}

/** Short human text for a placement result. */
export function placementText(kind: BuildingKind, r: PlacementResult): string {
  return r.ok ? `Place ${BUILDINGS[kind].label} — click to build` : PLACEMENT_MESSAGES[r.reason];
}
