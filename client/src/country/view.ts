import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { MASK } from '../../../shared/country/config.ts';
import { tileToWorld, type LocalTerrain } from '../../../shared/country/terrain.ts';
import { buildDepthTexture, buildTerrainMesh } from './terrainMesh.ts';
import { buildWater, type WaterUniforms } from './water.ts';
import { Disposables, buildFlagpole, buildResourceSites, buildTrees, heightAt, type Trees } from './props.ts';
import { BuildingLayer, placementTransform } from './buildingLayer.ts';
import { Placement, type PlacementHint } from './placement.ts';
import { Agents, type CrowdState } from './agents.ts';
import { footprint, validatePlacement, type Building, type BuildingKind } from '../../../shared/country/buildings.ts';

export interface CountryViewOptions {
  terrain: LocalTerrain;
  seed: number;
  name: string;
  flag: HTMLCanvasElement;
  neighborTint: (cell: number) => string | null;
  /** server clock (construction progress) */
  serverNow: () => number;
  /** current treasury (placement preview) */
  funds: () => number;
  onPlace: (kind: BuildingKind, i: number, j: number, rot: 0 | 1) => void;
  onHint: (hint: PlacementHint | null) => void;
  /** hour of the game day, 0..24 (from the server clock) */
  gameHour: () => number;
  citizenName: (id: number) => string | null;
  onCitizenClick: (id: number) => void;
}

export interface CountryStats {
  drawCalls: number;
  triangles: number;
  instances: number;
  geometries: number;
  textures: number;
}

const PIXEL_RATIO_CAP = 1.5;
const FOG = new THREE.Color('#a9c3d6');

interface Label {
  el: HTMLDivElement;
  pos: THREE.Vector3;
  visible: boolean;
}

/**
 * The local "Country View": a self-contained scene that borrows the globe's
 * renderer while active. Everything it creates is tracked and disposed on exit.
 */
export class CountryView {
  readonly scene = new THREE.Scene();
  readonly camera: THREE.PerspectiveCamera;
  private controls: OrbitControls | null = null;
  private readonly d = new Disposables();
  private readonly sun = new THREE.DirectionalLight('#fff1dc', 2.4);
  private readonly sunDir = new THREE.Vector3(0.55, 0.75, 0.35).normalize();
  private water: WaterUniforms | null = null;
  private flagUpdate: ((t: number) => void) | null = null;
  private terrain: LocalTerrain | null = null;
  private labels: Label[] = [];
  private running = false;
  private intro: { start: number; from: THREE.Vector3; to: THREE.Vector3 } | null = null;
  private bounds = { minX: 0, maxX: 0, minZ: 0, maxZ: 0 };
  private readonly tmp = new THREE.Vector3();
  private readonly t0 = performance.now();
  fps = 60;
  private lastT = performance.now();
  /** called each frame after rendering */
  onFrame: (() => void) | null = null;
  private layer: BuildingLayer | null = null;
  private trees: Trees | null = null;
  placement: Placement | null = null;
  private flagGroup: THREE.Group | null = null;
  private capitalLabel: Label | null = null;
  private serverNow: () => number = () => Date.now();
  private agents: Agents | null = null;
  private hemi: THREE.HemisphereLight | null = null;
  private gameHour: () => number = () => 12;
  private citizenName: (id: number) => string | null = () => null;
  private onCitizenClick: (id: number) => void = () => undefined;
  private nameTag: HTMLDivElement | null = null;
  private pointer = { x: -1, y: -1, inside: false, downX: 0, downY: 0 };
  /** 0 (night) .. 1 (full day), for tests and the stats overlay */
  daylight = 1;
  private readonly fogColor = new THREE.Color();
  private readonly night = new THREE.Color('#0c1424');
  private readonly dusk = new THREE.Color('#e2a27c');
  private readonly sunDay = new THREE.Color('#fff1dc');
  private readonly sunDusk = new THREE.Color('#ffb072');
  private readonly moon = new THREE.Color('#9fb3ff');
  private readonly tmpColor = new THREE.Color();

  constructor(private readonly renderer: THREE.WebGLRenderer, private readonly labelRoot: HTMLElement) {
    this.camera = new THREE.PerspectiveCamera(45, 1, 0.5, 1400);
  }

  get active(): boolean {
    return this.running;
  }

  build(o: CountryViewOptions): void {
    const t = o.terrain;
    this.terrain = t;
    const n = t.size;
    const half = (n - 1) / 2;
    // copies: the day/night cycle recolours these every frame
    this.scene.background = FOG.clone();
    this.scene.fog = new THREE.Fog(FOG.clone(), n * 0.9, n * 2.6);

    const hemi = new THREE.HemisphereLight('#cfe3ff', '#5a5040', 1.1);
    this.hemi = hemi;
    this.scene.add(hemi);
    this.sun.position.copy(this.sunDir).multiplyScalar(n);
    this.sun.castShadow = true;
    this.sun.shadow.mapSize.set(2048, 2048);
    const sc = this.sun.shadow.camera;
    sc.left = sc.bottom = -half;
    sc.right = sc.top = half;
    sc.near = 1;
    sc.far = n * 3;
    this.sun.shadow.bias = -0.0004;
    this.sun.shadow.normalBias = 0.35;
    this.scene.add(this.sun, this.sun.target);

    const terrainMesh = buildTerrainMesh(t, o.neighborTint);
    this.d.add(terrainMesh.geometry);
    this.d.add(terrainMesh.material);
    this.scene.add(terrainMesh);

    const depth = this.d.add(buildDepthTexture(t));
    const water = buildWater(depth, half, this.sunDir);
    this.d.add(water.mesh.geometry);
    this.d.add(water.mesh.material);
    this.water = water.uniforms;
    this.scene.add(water.mesh);

    this.trees = buildTrees(t, o.seed, this.d);
    this.scene.add(this.trees.group);
    const sites = buildResourceSites(t, this.d);
    this.scene.add(sites);

    this.serverNow = o.serverNow;
    this.layer = new BuildingLayer(t, this.d, this.labelRoot);
    this.scene.add(this.layer.group);
    this.placement = new Placement(t, this.layer, this.camera, this.renderer.domElement, o.funds, () => this.layer?.list() ?? [], this.d);
    this.placement.onPlace = o.onPlace;
    this.placement.onHint = o.onHint;
    this.scene.add(this.placement.object);

    this.agents = new Agents(t, this.d);
    this.scene.add(this.agents.group);
    this.gameHour = o.gameHour;
    this.citizenName = o.citizenName;
    this.onCitizenClick = o.onCitizenClick;
    this.nameTag = document.createElement('div');
    this.nameTag.className = 'cv-nametag';
    this.nameTag.hidden = true;
    this.labelRoot.appendChild(this.nameTag);

    const cap = tileToWorld(n, t.capital.i, t.capital.j);
    const capY = heightAt(t, cap.x, cap.z);
    const flag = buildFlagpole(o.flag, this.d);
    flag.group.position.set(cap.x, capY - 0.1, cap.z);
    flag.group.scale.setScalar(0.55);
    this.flagUpdate = flag.update;
    this.flagGroup = flag.group;
    this.scene.add(flag.group);

    // labels: capital and resource sites
    this.addLabel(`★ ${o.name}`, new THREE.Vector3(cap.x, capY + 7, cap.z), 'capital');
    this.capitalLabel = this.labels[this.labels.length - 1] ?? null;
    for (const s of sites.children) {
      const r = s.userData.resource;
      if (typeof r === 'string') this.addLabel(r, new THREE.Vector3(s.position.x, s.position.y + 5.5, s.position.z), 'resource');
    }

    // pan limits: the country's own land (plus a little margin)
    let minX = Infinity, maxX = -Infinity, minZ = Infinity, maxZ = -Infinity;
    for (let j = 0; j < n; j++) {
      for (let i = 0; i < n; i++) {
        if (t.mask[j * n + i] !== MASK.own) continue;
        const p = tileToWorld(n, i, j);
        minX = Math.min(minX, p.x); maxX = Math.max(maxX, p.x);
        minZ = Math.min(minZ, p.z); maxZ = Math.max(maxZ, p.z);
      }
    }
    this.bounds = { minX: minX - 10, maxX: maxX + 10, minZ: minZ - 10, maxZ: maxZ + 10 };
    this.sun.target.position.set((minX + maxX) / 2, 0, (minZ + maxZ) / 2);
    this.sun.position.copy(this.sun.target.position).addScaledVector(this.sunDir, n);

    // start looking at the capital, close enough to see the town
    this.camera.position.set(cap.x + 30, capY + 34, cap.z + 42);
    this.cameraTarget.set(cap.x, capY, cap.z);
  }

  /** Shows the server's building list (full replace; cheap). */
  setBuildings(list: Building[]): void {
    if (!this.layer || !this.terrain) return;
    this.layer.set(list, this.serverNow());
    this.trees?.clear(this.layer.footprints());
    this.placement?.refresh();
    // the flag stands in front of the town hall
    const hall = list.find((b) => b.kind === 'townhall');
    if (hall && this.flagGroup) {
      const tr = placementTransform(this.terrain, hall.kind, hall.i, hall.j, hall.rot);
      const [, d] = footprint(hall.kind, hall.rot);
      const z = tr.z + d / 2 + 1.2;
      this.flagGroup.position.set(tr.x - 1.6, heightAt(this.terrain, tr.x - 1.6, z) - 0.1, z);
      if (this.capitalLabel) this.capitalLabel.pos.set(tr.x, tr.y + 7, tr.z);
    }
  }

  /**
   * Test/dev hook: nearest spot to the capital where `kind` would be valid (or,
   * with wantValid=false, an invalid one), in screen pixels.
   */
  findSpot(kind: BuildingKind, wantValid: boolean): { x: number; y: number; i: number; j: number } | null {
    const t = this.terrain;
    if (!t || !this.layer) return null;
    const list = this.layer.list();
    for (let r = 4; r < 60; r++) {
      for (let dj = -r; dj <= r; dj++) {
        for (let di = -r; di <= r; di++) {
          if (Math.max(Math.abs(di), Math.abs(dj)) !== r) continue;
          const i = t.capital.i + di, j = t.capital.j + dj;
          const ok = validatePlacement(t, list, kind, i, j, 0, Infinity).ok;
          if (ok !== wantValid) continue;
          const tr = placementTransform(t, kind, i, j, 0);
          this.tmp.set(tr.x, tr.y, tr.z).project(this.camera);
          // stay clear of the HUD (top) and the build bar (bottom)
          if (Math.abs(this.tmp.x) > 0.7 || Math.abs(this.tmp.y) > 0.55 || this.tmp.z > 1) continue;
          const el = this.renderer.domElement;
          const rect = el.getBoundingClientRect();
          return { x: rect.left + (this.tmp.x * 0.5 + 0.5) * rect.width, y: rect.top + (-this.tmp.y * 0.5 + 0.5) * rect.height, i, j };
        }
      }
    }
    return null;
  }

  /** Updates the crowd from the server's buildings, citizens and mood. */
  setCrowd(buildings: readonly Building[], crowd: CrowdState): void {
    this.agents?.setState(buildings, crowd);
  }

  /** Sun, sky, fog, water and window lights for an hour of the game day. */
  private applyTimeOfDay(hour: number): void {
    const angle = ((hour - 6) / 12) * Math.PI;
    const elev = Math.sin(angle);
    const day = Math.max(0, Math.min(1, (elev + 0.12) / 0.4));
    this.daylight = day;
    const duskAmt = Math.max(0, 1 - Math.abs(elev) / 0.3) * (hour > 3 && hour < 21 ? 1 : 0);
    // sun (or moon) direction
    if (elev > -0.05) this.sunDir.set(Math.cos(angle) * 0.85, Math.max(0.12, elev), 0.35).normalize();
    else this.sunDir.set(-0.4, 0.7, -0.3).normalize();
    if (this.terrain) this.sun.position.copy(this.sun.target.position).addScaledVector(this.sunDir, this.terrain.size);
    this.sun.intensity = 0.35 + 2.1 * day;
    this.sun.color.copy(this.moon).lerp(this.sunDusk, Math.min(1, day * 2)).lerp(this.sunDay, Math.max(0, day * 1.6 - 0.6));
    if (this.hemi) this.hemi.intensity = 0.3 + 0.85 * day;
    this.fogColor.copy(this.night).lerp(FOG, day);
    this.fogColor.lerp(this.tmpColor.copy(this.dusk), duskAmt * 0.45);
    if (this.scene.fog instanceof THREE.Fog) this.scene.fog.color.copy(this.fogColor);
    if (this.scene.background instanceof THREE.Color) this.scene.background.copy(this.fogColor);
    if (this.water) this.water.uNight.value = 1 - day;
    const glow = this.layer?.windowMaterial;
    if (glow) glow.emissiveIntensity = (1 - day) * 1.8;
  }

  private readonly onPointerMove = (e: PointerEvent): void => {
    const rect = this.renderer.domElement.getBoundingClientRect();
    this.pointer.x = e.clientX - rect.left;
    this.pointer.y = e.clientY - rect.top;
    this.pointer.inside = true;
  };

  private readonly onPointerLeave = (): void => {
    this.pointer.inside = false;
  };

  private readonly onPointerDown = (e: PointerEvent): void => {
    this.pointer.downX = e.clientX;
    this.pointer.downY = e.clientY;
  };

  private readonly onPointerUp = (e: PointerEvent): void => {
    if (e.button !== 0 || this.placement?.active || !this.agents) return;
    if (Math.hypot(e.clientX - this.pointer.downX, e.clientY - this.pointer.downY) > 6) return;
    const rect = this.renderer.domElement.getBoundingClientRect();
    const id = this.agents.pick(this.camera, rect.width, rect.height, e.clientX - rect.left, e.clientY - rect.top, 18);
    if (id) this.onCitizenClick(id);
  };

  /** Hover: highlight and name tag for the featured citizen under the pointer. */
  private updateHover(): void {
    const tag = this.nameTag;
    if (!this.agents || !tag) return;
    const el = this.renderer.domElement;
    const id = this.pointer.inside && !this.placement?.active ? this.agents.pick(this.camera, el.clientWidth, el.clientHeight, this.pointer.x, this.pointer.y, 16) : 0;
    this.agents.hoverId = id;
    el.style.cursor = this.placement?.active ? 'crosshair' : id ? 'pointer' : '';
    if (!id || !this.agents.positionOf(id, this.tmp)) {
      tag.hidden = true;
      return;
    }
    this.tmp.y += 1.15;
    this.tmp.project(this.camera);
    tag.hidden = false;
    const name = this.citizenName(id) ?? '';
    if (tag.textContent !== name) tag.textContent = name;
    tag.style.transform = `translate3d(${((this.tmp.x * 0.5 + 0.5) * el.clientWidth).toFixed(1)}px, ${((-this.tmp.y * 0.5 + 0.5) * el.clientHeight).toFixed(1)}px, 0) translate(-50%, -100%)`;
  }

  /** Test/dev hook: screen position of a featured citizen (or null when indoors / off screen). */
  citizenScreen(id: number): { x: number; y: number } | null {
    if (!this.agents?.positionOf(id, this.tmp)) return null;
    this.tmp.y += 0.5;
    this.tmp.project(this.camera);
    if (this.tmp.z > 1 || Math.abs(this.tmp.x) > 0.9 || Math.abs(this.tmp.y) > 0.8) return null;
    const rect = this.renderer.domElement.getBoundingClientRect();
    return { x: rect.left + (this.tmp.x * 0.5 + 0.5) * rect.width, y: rect.top + (-this.tmp.y * 0.5 + 0.5) * rect.height };
  }

  /** Points the camera at a world position (keeps the current angle). */
  lookAt(x: number, z: number, distance: number): void {
    if (!this.controls || !this.terrain) return;
    const y = heightAt(this.terrain, x, z);
    const dir = this.tmp.copy(this.camera.position).sub(this.controls.target).normalize();
    this.controls.target.set(x, y, z);
    this.camera.position.copy(this.controls.target).addScaledVector(dir, distance);
    this.camera.lookAt(this.controls.target);
    this.intro = null;
  }

  crowdCounts(): { agents: number; protesters: number; queue: number } {
    return this.agents?.counts() ?? { agents: 0, protesters: 0, queue: 0 };
  }

  startPlacement(kind: BuildingKind | null): void {
    if (kind) this.placement?.start(kind);
    else this.placement?.cancel();
  }

  private readonly cameraTarget = new THREE.Vector3();

  private addLabel(text: string, pos: THREE.Vector3, kind: string): void {
    const el = document.createElement('div');
    el.className = `cv-label ${kind}`;
    el.textContent = text;
    el.style.opacity = '0';
    this.labelRoot.appendChild(el);
    this.labels.push({ el, pos, visible: false });
  }

  start(canvas: HTMLCanvasElement): void {
    if (this.running) return;
    this.running = true;
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, PIXEL_RATIO_CAP));
    this.renderer.shadowMap.enabled = true;
    this.renderer.shadowMap.type = THREE.PCFShadowMap;
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
    this.renderer.toneMappingExposure = 1.05;
    const controls = new OrbitControls(this.camera, canvas);
    controls.enableDamping = true;
    controls.dampingFactor = 0.08;
    controls.screenSpacePanning = false;
    controls.minDistance = 18;
    controls.maxDistance = 260;
    controls.minPolarAngle = 0.2;
    controls.maxPolarAngle = 1.32;
    controls.target.copy(this.cameraTarget);
    controls.zoomSpeed = 0.9;
    this.controls = controls;
    this.resize();
    window.addEventListener('resize', this.resize);
    canvas.addEventListener('webglcontextlost', this.contextLost);
    canvas.addEventListener('webglcontextrestored', this.contextRestored);
    canvas.addEventListener('pointermove', this.onPointerMove);
    canvas.addEventListener('pointerleave', this.onPointerLeave);
    canvas.addEventListener('pointerdown', this.onPointerDown);
    canvas.addEventListener('pointerup', this.onPointerUp);
    this.lastT = performance.now();
    this.renderer.setAnimationLoop(this.frame);
  }

  /** Camera glides down from above onto the capital (part of the enter transition). */
  playIntro(ms = 500): void {
    const to = this.camera.position.clone();
    const from = to.clone().sub(this.cameraTarget).multiplyScalar(2.2).add(this.cameraTarget);
    from.y += 60;
    this.camera.position.copy(from);
    this.intro = { start: performance.now(), from, to };
    this.introMs = ms;
  }
  private introMs = 500;

  private readonly resize = (): void => {
    const canvas = this.renderer.domElement;
    const parent = canvas.parentElement;
    if (!parent) return;
    this.camera.aspect = parent.clientWidth / Math.max(1, parent.clientHeight);
    this.camera.fov = this.camera.aspect < 0.8 ? 58 : 45;
    this.camera.updateProjectionMatrix();
    this.renderer.setSize(parent.clientWidth, parent.clientHeight);
  };

  private readonly contextLost = (): void => {
    this.renderer.setAnimationLoop(null);
  };

  private readonly contextRestored = (): void => {
    this.scene.traverse((o) => {
      const mat = (o as THREE.Mesh).material;
      const mats = Array.isArray(mat) ? mat : mat ? [mat] : [];
      for (const m of mats) {
        const map = (m as THREE.MeshStandardMaterial).map;
        if (map) map.needsUpdate = true;
        const u = (m as THREE.ShaderMaterial).uniforms?.uDepth?.value;
        if (u instanceof THREE.Texture) u.needsUpdate = true;
      }
    });
    if (this.running) this.renderer.setAnimationLoop(this.frame);
  };

  private readonly frame = (): void => {
    const now = performance.now();
    const dt = Math.min(0.1, (now - this.lastT) / 1000);
    this.lastT = now;
    if (dt > 0) this.fps = this.fps * 0.95 + (1 / dt) * 0.05;
    const time = (now - this.t0) / 1000;
    const controls = this.controls;
    if (this.intro && controls) {
      const k = Math.min(1, (now - this.intro.start) / this.introMs);
      const e = 1 - Math.pow(1 - k, 3);
      this.camera.position.lerpVectors(this.intro.from, this.intro.to, e);
      this.camera.lookAt(controls.target);
      if (k >= 1) this.intro = null;
    } else if (controls) {
      const b = this.bounds;
      const tg = controls.target;
      const cx = Math.max(b.minX, Math.min(b.maxX, tg.x));
      const cz = Math.max(b.minZ, Math.min(b.maxZ, tg.z));
      if (cx !== tg.x || cz !== tg.z) {
        this.camera.position.x += cx - tg.x;
        this.camera.position.z += cz - tg.z;
        tg.x = cx;
        tg.z = cz;
      }
      if (this.terrain) tg.y = Math.max(0, heightAt(this.terrain, tg.x, tg.z));
      controls.update(dt);
    }
    if (this.water) this.water.uTime.value = time;
    this.flagUpdate?.(time);
    const serverNow = this.serverNow();
    this.layer?.updateConstruction(serverNow);
    const hour = this.gameHour();
    this.applyTimeOfDay(hour);
    const dist = controls ? this.camera.position.distanceTo(controls.target) : 100;
    this.agents?.update(hour, time, dist);
    this.updateHover();
    this.renderer.render(this.scene, this.camera);
    this.layoutLabels();
    this.layer?.layoutRings(this.camera, this.renderer.domElement.clientWidth, this.renderer.domElement.clientHeight, serverNow);
    this.onFrame?.();
  };

  private layoutLabels(): void {
    const w = this.renderer.domElement.clientWidth;
    const h = this.renderer.domElement.clientHeight;
    const dist = this.camera.position.distanceTo(this.controls?.target ?? this.cameraTarget);
    for (const l of this.labels) {
      this.tmp.copy(l.pos).project(this.camera);
      const vis = this.tmp.z < 1 && Math.abs(this.tmp.x) < 1.1 && Math.abs(this.tmp.y) < 1.1 && (l.el.classList.contains('capital') || dist < 170);
      if (vis) l.el.style.transform = `translate3d(${((this.tmp.x * 0.5 + 0.5) * w).toFixed(1)}px, ${((-this.tmp.y * 0.5 + 0.5) * h).toFixed(1)}px, 0) translate(-50%, -100%)`;
      if (vis !== l.visible) {
        l.visible = vis;
        l.el.style.opacity = vis ? '1' : '0';
      }
    }
  }

  /** Test/dev hook: orbit position relative to the current target (degrees, distance). */
  setOrbit(azimuthDeg: number, polarDeg: number, distance: number): void {
    const target = this.controls?.target ?? this.cameraTarget;
    const az = THREE.MathUtils.degToRad(azimuthDeg);
    const po = THREE.MathUtils.degToRad(polarDeg);
    this.intro = null;
    this.camera.position.set(
      target.x + distance * Math.sin(po) * Math.sin(az),
      target.y + distance * Math.cos(po),
      target.z + distance * Math.sin(po) * Math.cos(az),
    );
    this.camera.lookAt(target);
    if (this.controls) {
      this.controls.enableDamping = false;
      this.controls.update();
      this.controls.enableDamping = true;
    }
  }

  stats(): CountryStats {
    const info = this.renderer.info;
    let instances = 0;
    this.scene.traverse((o) => {
      if ((o as THREE.InstancedMesh).isInstancedMesh) instances += (o as THREE.InstancedMesh).count;
    });
    return { drawCalls: info.render.calls, triangles: info.render.triangles, instances, geometries: info.memory.geometries, textures: info.memory.textures };
  }

  /** Stops rendering and frees every GPU resource this view created. */
  dispose(canvas: HTMLCanvasElement): void {
    this.renderer.setAnimationLoop(null);
    this.running = false;
    this.controls?.dispose();
    this.controls = null;
    window.removeEventListener('resize', this.resize);
    canvas.removeEventListener('webglcontextlost', this.contextLost);
    canvas.removeEventListener('webglcontextrestored', this.contextRestored);
    canvas.removeEventListener('pointermove', this.onPointerMove);
    canvas.removeEventListener('pointerleave', this.onPointerLeave);
    canvas.removeEventListener('pointerdown', this.onPointerDown);
    canvas.removeEventListener('pointerup', this.onPointerUp);
    canvas.style.cursor = '';
    this.nameTag?.remove();
    this.nameTag = null;
    this.agents = null;
    this.hemi = null;
    this.sun.shadow.dispose();
    this.placement?.dispose();
    this.placement = null;
    this.layer?.dispose();
    this.layer = null;
    this.trees = null;
    this.flagGroup = null;
    this.capitalLabel = null;
    this.d.dispose();
    this.scene.clear();
    for (const l of this.labels) l.el.remove();
    this.labels = [];
    this.water = null;
    this.flagUpdate = null;
    this.terrain = null;
    this.renderer.shadowMap.enabled = false;
    this.renderer.toneMapping = THREE.NoToneMapping;
    this.renderer.toneMappingExposure = 1;
  }
}
