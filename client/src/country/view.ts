import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { MASK } from '../../../shared/country/config.ts';
import { tileToWorld, type LocalTerrain } from '../../../shared/country/terrain.ts';
import { buildDepthTexture, buildTerrainMesh } from './terrainMesh.ts';
import { buildWater, type WaterUniforms } from './water.ts';
import { Disposables, buildFlagpole, buildResourceSites, buildTrees, heightAt } from './props.ts';

export interface CountryViewOptions {
  terrain: LocalTerrain;
  seed: number;
  name: string;
  flag: HTMLCanvasElement;
  neighborTint: (cell: number) => string | null;
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
    this.scene.background = FOG;
    this.scene.fog = new THREE.Fog(FOG, n * 0.9, n * 2.6);

    const hemi = new THREE.HemisphereLight('#cfe3ff', '#5a5040', 1.1);
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

    this.scene.add(buildTrees(t, o.seed, this.d));
    const sites = buildResourceSites(t, this.d);
    this.scene.add(sites);

    const cap = tileToWorld(n, t.capital.i, t.capital.j);
    const capY = heightAt(t, cap.x, cap.z);
    const flag = buildFlagpole(o.flag, this.d);
    flag.group.position.set(cap.x, capY - 0.1, cap.z);
    this.flagUpdate = flag.update;
    this.scene.add(flag.group);

    // labels: capital and resource sites
    this.addLabel(`★ ${o.name}`, new THREE.Vector3(cap.x, capY + 10.5, cap.z), 'capital');
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

    // start looking at the capital
    this.camera.position.set(cap.x + 70, capY + 75, cap.z + 95);
    this.cameraTarget.set(cap.x, capY, cap.z);
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
    this.renderer.render(this.scene, this.camera);
    this.layoutLabels();
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
    this.sun.shadow.dispose();
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
