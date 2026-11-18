import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { createPicker } from '../../../shared/pick.ts';
import type { EarthMap } from '../gen/generate.ts';
import { buildFlagAtlas, FLAG_COLS, FLAG_INSET } from './flags.ts';
import {
  atmosphereFragment,
  atmosphereVertex,
  planetFragment,
  planetVertex,
  starsFragment,
  starsVertex,
} from './shaders.ts';

export const MIN_DIST = 1.12;
export const MAX_DIST = 6;
export const HOME_DIST = 3.3;
const AUTO_ROTATE_RESUME_MS = 5000;

export interface GlobeQuality {
  pixelRatioCap: number;
  segments: number;
  detail: number;
}

export const QUALITY_HIGH: GlobeQuality = { pixelRatioCap: 2, segments: 192, detail: 7 };
export const QUALITY_LOW: GlobeQuality = { pixelRatioCap: 1, segments: 96, detail: 4 };

interface FlyAnim {
  from: THREE.Vector3;
  to: THREE.Vector3;
  fromDist: number;
  toDist: number;
  start: number;
  duration: number;
}

function easeInOutCubic(t: number): number {
  return t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2;
}

/**
 * Owns the WebGL renderer, camera, controls and the planet. The planet is a
 * single mesh/draw call; atmosphere and stars are two extra cheap draws.
 */
export class Globe {
  readonly renderer: THREE.WebGLRenderer;
  readonly scene = new THREE.Scene();
  readonly camera: THREE.PerspectiveCamera;
  readonly controls: OrbitControls;
  readonly canvas: HTMLCanvasElement;

  map: EarthMap | null = null;
  hoverId = -1;
  selectedId = -1;
  quality: GlobeQuality = QUALITY_HIGH;

  onHover: ((id: number) => void) | null = null;
  onSelect: ((id: number) => void) | null = null;
  /** called every frame after rendering (used for HTML markers) */
  onFrame: ((dt: number) => void) | null = null;
  onLowPerformance: (() => void) | null = null;
  onContextChange: ((lost: boolean) => void) | null = null;
  onDoubleSelect: ((id: number) => void) | null = null;
  /** true while another view (the country view) owns the renderer */
  suspended = false;

  private planet: THREE.Mesh<THREE.SphereGeometry, THREE.ShaderMaterial>;
  private atmosphere: THREE.Mesh;
  private stars: THREE.Points<THREE.BufferGeometry, THREE.ShaderMaterial>;
  private uniforms: Record<string, THREE.IUniform>;
  private idTex: THREE.DataTexture | null = null;
  private countryTex: THREE.DataTexture | null = null;
  private flagTex: THREE.CanvasTexture | null = null;
  private countryData: Float32Array | null = null;
  private picker: ((x: number, y: number, z: number) => number) | null = null;

  // scratch objects: the render loop must not allocate
  private readonly raycaster = new THREE.Raycaster();
  private readonly sphere = new THREE.Sphere(new THREE.Vector3(), 1);
  private readonly hit = new THREE.Vector3();
  private readonly ndc = new THREE.Vector2();
  private readonly tmpA = new THREE.Vector3();
  private readonly tmpB = new THREE.Vector3();
  private readonly light = new THREE.Vector3();

  private pointerDirty = false;
  private pointerInside = false;
  private downX = 0;
  private downY = 0;
  private downT = 0;
  private resumeTimer = 0;
  private fly: FlyAnim | null = null;
  private zoomTarget = HOME_DIST;
  private wheelZooming = false;
  private lastT = performance.now();
  private running = false;

  // perf monitoring
  fps = 60;
  frameMs = 0;
  private lowFpsSince = 0;
  private perfArmedAt = Infinity;

  constructor(container: HTMLElement) {
    this.renderer = new THREE.WebGLRenderer({ antialias: true, powerPreference: 'high-performance' });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, this.quality.pixelRatioCap));
    this.renderer.setSize(container.clientWidth, container.clientHeight);
    this.renderer.setClearColor(0x03060d, 1);
    this.canvas = this.renderer.domElement;
    this.canvas.setAttribute('aria-label', 'Interactive 3D globe. Drag to rotate, scroll or pinch to zoom, click a country to select it.');
    this.canvas.setAttribute('role', 'img');
    container.appendChild(this.canvas);

    this.camera = new THREE.PerspectiveCamera(38, container.clientWidth / container.clientHeight, 0.01, 300);
    this.camera.position.set(0.6, 1.2, HOME_DIST).setLength(HOME_DIST);

    // our own smooth wheel zoom must run before OrbitControls sees the event
    this.canvas.addEventListener('wheel', this.handleWheel, { passive: false });

    this.controls = new OrbitControls(this.camera, this.canvas);
    this.controls.enableDamping = true;
    this.controls.dampingFactor = 0.07;
    this.controls.enablePan = false;
    this.controls.minDistance = MIN_DIST;
    this.controls.maxDistance = MAX_DIST;
    this.controls.zoomSpeed = 0.7;
    this.controls.autoRotate = true;
    this.controls.autoRotateSpeed = 0.35;
    this.controls.addEventListener('start', this.handleInteractionStart);
    this.controls.addEventListener('end', this.handleInteractionEnd);

    this.uniforms = {
      uIdAtlas: { value: null },
      uCountry: { value: null },
      uFlags: { value: null },
      uFace: { value: new THREE.Vector3(1024, 4, 1032) },
      uFlagGrid: { value: new THREE.Vector2(FLAG_COLS, 10) },
      uFlagInset: { value: new THREE.Vector2(FLAG_INSET[0], FLAG_INSET[1]) },
      uWarpOffset: { value: new THREE.Vector3() },
      uLightDir: { value: this.light },
      uCameraPos: { value: this.camera.position },
      uHover: { value: -1 },
      uSelected: { value: -1 },
      uTime: { value: 0 },
      uDetail: { value: this.quality.detail },
      uLineWidth: { value: 1.0 },
      uFlagMix: { value: 0.7 },
      uDebug: { value: ({ ids: 1, mismatch: 2, probe: 3, probenoise: 4, probeconst: 5 } as Record<string, number>)[new URLSearchParams(location.search).get('debug') ?? ''] ?? 0 },
    };

    const material = new THREE.ShaderMaterial({
      vertexShader: planetVertex,
      fragmentShader: planetFragment,
      uniforms: this.uniforms,
    });
    this.planet = new THREE.Mesh(new THREE.SphereGeometry(1, this.quality.segments, this.quality.segments / 2), material);
    this.planet.visible = false;
    this.scene.add(this.planet);

    this.atmosphere = new THREE.Mesh(
      new THREE.SphereGeometry(1.05, 96, 48),
      new THREE.ShaderMaterial({
        vertexShader: atmosphereVertex,
        fragmentShader: atmosphereFragment,
        uniforms: { uCameraPos: { value: this.camera.position } },
        side: THREE.BackSide,
        blending: THREE.AdditiveBlending,
        transparent: true,
        depthWrite: false,
      }),
    );
    this.scene.add(this.atmosphere);

    this.stars = this.createStars();
    this.scene.add(this.stars);

    this.canvas.addEventListener('pointermove', this.handlePointerMove);
    this.canvas.addEventListener('pointerdown', this.handlePointerDown);
    this.canvas.addEventListener('pointerup', this.handlePointerUp);
    this.canvas.addEventListener('pointerleave', this.handlePointerLeave);
    this.canvas.addEventListener('dblclick', this.handleDoubleClick);
    this.canvas.addEventListener('webglcontextlost', this.handleContextLost);
    this.canvas.addEventListener('webglcontextrestored', this.handleContextRestored);
    window.addEventListener('resize', this.handleResize);
  }

  private createStars(): THREE.Points<THREE.BufferGeometry, THREE.ShaderMaterial> {
    const count = 3500;
    const pos = new Float32Array(count * 3);
    const size = new Float32Array(count);
    const bright = new Float32Array(count);
    let s = 0x9e3779b9;
    const rnd = () => {
      s = (Math.imul(s ^ (s >>> 15), 0x2c1b3c6d) + 0x297a2d39) >>> 0;
      return s / 4294967296;
    };
    for (let i = 0; i < count; i++) {
      const z = rnd() * 2 - 1;
      const th = rnd() * Math.PI * 2;
      const r = Math.sqrt(1 - z * z);
      pos[i * 3] = Math.cos(th) * r * 120;
      pos[i * 3 + 1] = z * 120;
      pos[i * 3 + 2] = Math.sin(th) * r * 120;
      const big = rnd();
      size[i] = 0.8 + big * big * big * 2.6;
      bright[i] = 0.25 + rnd() * 0.75;
    }
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    geo.setAttribute('aSize', new THREE.BufferAttribute(size, 1));
    geo.setAttribute('aBright', new THREE.BufferAttribute(bright, 1));
    const mat = new THREE.ShaderMaterial({
      vertexShader: starsVertex,
      fragmentShader: starsFragment,
      uniforms: { uPixelRatio: { value: this.renderer.getPixelRatio() } },
      transparent: true,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
    });
    return new THREE.Points(geo, mat);
  }

  /** Uploads a freshly generated Earth to the GPU. */
  setEarth(map: EarthMap): void {
    this.map = map;
    const { layout, meta } = map;
    const n = meta.countries.length;

    this.idTex?.dispose();
    this.idTex = new THREE.DataTexture(map.atlas, layout.width, layout.height, THREE.RedFormat, THREE.UnsignedByteType);
    this.idTex.minFilter = THREE.NearestFilter;
    this.idTex.magFilter = THREE.NearestFilter;
    this.idTex.generateMipmaps = false;
    this.idTex.unpackAlignment = 1;
    this.idTex.needsUpdate = true;

    // rows: 0 centroid.xyz + radius, 1 seed.xyz + weight, 2 flag index
    this.countryData = new Float32Array(n * 3 * 4);
    const d = this.countryData;
    for (let c = 0; c < n; c++) {
      d[c * 4] = map.centroids[c * 3];
      d[c * 4 + 1] = map.centroids[c * 3 + 1];
      d[c * 4 + 2] = map.centroids[c * 3 + 2];
      d[c * 4 + 3] = map.radius[c];
      const r1 = (n + c) * 4;
      d[r1] = map.seeds[c * 3];
      d[r1 + 1] = map.seeds[c * 3 + 1];
      d[r1 + 2] = map.seeds[c * 3 + 2];
      d[r1 + 3] = map.weights[c];
      d[(2 * n + c) * 4] = c;
    }
    this.countryTex?.dispose();
    this.countryTex = new THREE.DataTexture(d, n, 3, THREE.RGBAFormat, THREE.FloatType);
    this.countryTex.minFilter = THREE.NearestFilter;
    this.countryTex.magFilter = THREE.NearestFilter;
    this.countryTex.generateMipmaps = false;
    this.countryTex.needsUpdate = true;

    const flagCanvas = buildFlagAtlas(
      meta.countries.map((c) => c.flag),
      map.primaries,
    );
    this.flagTex?.dispose();
    this.flagTex = new THREE.CanvasTexture(flagCanvas);
    this.flagTex.colorSpace = THREE.NoColorSpace;
    this.flagTex.anisotropy = Math.min(4, this.renderer.capabilities.getMaxAnisotropy());
    this.flagTex.minFilter = THREE.LinearMipmapLinearFilter;

    this.uniforms.uIdAtlas.value = this.idTex;
    this.uniforms.uCountry.value = this.countryTex;
    this.uniforms.uFlags.value = this.flagTex;
    (this.uniforms.uFace.value as THREE.Vector3).set(layout.N, layout.G, layout.S);
    (this.uniforms.uFlagGrid.value as THREE.Vector2).set(FLAG_COLS, Math.ceil(n / FLAG_COLS));
    (this.uniforms.uWarpOffset.value as THREE.Vector3).fromArray(meta.warpOffset);

    this.picker = createPicker({
      atlas: map.atlas,
      layout,
      seeds: map.seeds,
      weights: map.weights,
      warpOffset: meta.warpOffset,
    });
    this.planet.visible = true;
    this.setHover(-1);
    this.setSelected(-1);
    this.perfArmedAt = performance.now() + 4000;
    this.lowFpsSince = 0;
  }

  setQuality(q: GlobeQuality): void {
    this.quality = q;
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, q.pixelRatioCap));
    this.stars.material.uniforms.uPixelRatio.value = this.renderer.getPixelRatio();
    this.uniforms.uDetail.value = q.detail;
    this.planet.geometry.dispose();
    this.planet.geometry = new THREE.SphereGeometry(1, q.segments, q.segments / 2);
    this.handleResize();
  }

  /** Texture memory used by the planet, in bytes. */
  textureBytes(): number {
    if (!this.map) return 0;
    const flags = this.flagTex ? (this.flagTex.image as HTMLCanvasElement) : null;
    const flagBytes = flags ? Math.round(flags.width * flags.height * 4 * 1.333) : 0;
    return this.map.atlas.byteLength + (this.countryData?.byteLength ?? 0) + flagBytes;
  }

  setHover(id: number): void {
    if (id === this.hoverId) return;
    this.hoverId = id;
    this.uniforms.uHover.value = id;
    this.onHover?.(id);
  }

  setSelected(id: number): void {
    this.selectedId = id;
    this.uniforms.uSelected.value = id;
  }

  /** Exact country under a unit direction, or -1 before an Earth is loaded. */
  countryAt(x: number, y: number, z: number): number {
    return this.picker ? this.picker(x, y, z) : -1;
  }

  /** Raycasts the planet at normalised device coordinates; returns a country id or -1. */
  pickAtNdc(x: number, y: number): number {
    this.ndc.set(x, y);
    this.raycaster.setFromCamera(this.ndc, this.camera);
    if (!this.raycaster.ray.intersectSphere(this.sphere, this.hit)) return -1;
    this.hit.normalize();
    return this.countryAt(this.hit.x, this.hit.y, this.hit.z);
  }

  /** Smoothly flies the camera to look at a unit direction. */
  flyTo(x: number, y: number, z: number, distance?: number, duration = 1000): void {
    this.pauseAutoRotate();
    const from = this.camera.position.clone().normalize();
    const to = new THREE.Vector3(x, y, z).normalize();
    const fromDist = this.camera.position.length();
    const toDist = THREE.MathUtils.clamp(distance ?? fromDist, MIN_DIST, MAX_DIST);
    this.fly = { from, to, fromDist, toDist, start: performance.now(), duration };
    this.controls.enabled = false;
    this.scheduleResume();
  }

  flyToCountry(id: number): void {
    if (!this.map || id < 0) return;
    const c = this.map.centroids;
    const dist = THREE.MathUtils.clamp(1 + this.map.radius[id] * 7.5, 1.6, 2.6);
    this.flyTo(c[id * 3], c[id * 3 + 1], c[id * 3 + 2], dist);
  }

  resetCamera(): void {
    this.flyTo(0.45, 0.35, 1, HOME_DIST, 900);
  }

  /** Projects a unit direction to CSS pixels. Returns false if it is behind the planet. */
  project(x: number, y: number, z: number, out: { x: number; y: number; facing: number }): boolean {
    const camLen = this.camera.position.length();
    const facing = (x * this.camera.position.x + y * this.camera.position.y + z * this.camera.position.z) / camLen;
    out.facing = facing;
    // visible if the point is on the camera-facing side of the horizon
    if (facing < 1 / camLen) return false;
    this.tmpA.set(x, y, z).project(this.camera);
    out.x = (this.tmpA.x * 0.5 + 0.5) * this.canvas.clientWidth;
    out.y = (-this.tmpA.y * 0.5 + 0.5) * this.canvas.clientHeight;
    return true;
  }

  start(): void {
    if (this.running || this.suspended) return;
    this.running = true;
    this.lastT = performance.now();
    this.renderer.setAnimationLoop(this.frame);
  }

  /** Hands the renderer and canvas to another view; the globe stops rendering and listening. */
  suspend(): void {
    if (this.suspended) return;
    this.suspended = true;
    this.running = false;
    this.renderer.setAnimationLoop(null);
    this.controls.enabled = false;
    this.fly = null;
    this.setHover(-1);
    window.clearTimeout(this.resumeTimer);
  }

  resume(): void {
    if (!this.suspended) return;
    this.suspended = false;
    this.controls.enabled = true;
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, this.quality.pixelRatioCap));
    this.handleResize();
    this.perfArmedAt = performance.now() + 4000;
    this.lowFpsSince = 0;
    this.start();
  }

  /** Current camera distance from the planet centre. */
  get distance(): number {
    return this.camera.position.length();
  }

  /** True while a programmatic camera flight is running. */
  get flying(): boolean {
    return this.fly !== null;
  }

  private frame = (): void => {
    const now = performance.now();
    const dt = Math.min(0.1, (now - this.lastT) / 1000);
    this.lastT = now;
    const work0 = performance.now();

    if (this.fly) {
      const t = Math.min(1, (now - this.fly.start) / this.fly.duration);
      const k = easeInOutCubic(t);
      this.tmpA.copy(this.fly.from).lerp(this.fly.to, k);
      if (this.tmpA.lengthSq() < 1e-6) this.tmpA.copy(this.fly.to);
      // spherical interpolation of the view direction
      const angle = this.fly.from.angleTo(this.fly.to);
      if (angle > 1e-4) {
        const s = Math.sin(angle);
        const a = Math.sin((1 - k) * angle) / s;
        const b = Math.sin(k * angle) / s;
        this.tmpA.copy(this.fly.from).multiplyScalar(a).addScaledVector(this.fly.to, b);
      }
      const dist = this.fly.fromDist + (this.fly.toDist - this.fly.fromDist) * k;
      this.camera.position.copy(this.tmpA).setLength(dist);
      this.camera.lookAt(0, 0, 0);
      this.zoomTarget = dist;
      if (t >= 1) {
        this.fly = null;
        this.controls.enabled = true;
      }
    } else {
      this.applyWheelZoom(dt);
      const d = this.camera.position.length();
      this.controls.rotateSpeed = THREE.MathUtils.clamp(0.12 + (d - 1) * 0.42, 0.12, 1);
      this.controls.update(dt);
      if (!this.wheelZooming) this.zoomTarget = this.camera.position.length();
    }

    // light from the upper left of the view so the visible side always reads as day
    const m = this.camera.matrixWorld.elements;
    this.light
      .copy(this.camera.position)
      .normalize()
      .addScaledVector(this.tmpB.set(m[4], m[5], m[6]), 0.55)
      .addScaledVector(this.tmpB.set(m[0], m[1], m[2]), -0.45)
      .normalize();

    const dist = this.camera.position.length();
    // ~2.2 px wide at globe scale, slightly wider (river-like) when close
    this.uniforms.uLineWidth.value = THREE.MathUtils.clamp(1.1 + (2.4 - dist) * 0.4, 1.1, 1.6);
    this.uniforms.uTime.value = now / 1000;

    if (this.pointerDirty && !this.fly) {
      this.pointerDirty = false;
      this.setHover(this.pointerInside ? this.pickAtNdc(this.ndc.x, this.ndc.y) : -1);
    }

    this.renderer.render(this.scene, this.camera);
    this.onFrame?.(dt);

    this.frameMs = this.frameMs * 0.9 + (performance.now() - work0) * 0.1;
    if (dt > 0) this.fps = this.fps * 0.95 + (1 / dt) * 0.05;
    this.monitorPerformance(now);
  };

  private monitorPerformance(now: number): void {
    if (now < this.perfArmedAt || document.hidden) return;
    if (this.fps < 30) {
      if (!this.lowFpsSince) this.lowFpsSince = now;
      if (now - this.lowFpsSince > 3000) {
        this.perfArmedAt = Infinity; // fire once
        this.onLowPerformance?.();
      }
    } else {
      this.lowFpsSince = 0;
    }
  }

  private applyWheelZoom(dt: number): void {
    if (!this.wheelZooming) return;
    const d = this.camera.position.length();
    const k = 1 - Math.exp(-dt * 10);
    const nd = d + (this.zoomTarget - d) * k;
    this.camera.position.setLength(nd);
    if (Math.abs(nd - this.zoomTarget) < 1e-4) this.wheelZooming = false;
  }

  private handleWheel = (e: WheelEvent): void => {
    if (this.suspended) return; // let the active view's controls handle it
    e.preventDefault();
    e.stopImmediatePropagation();
    if (this.fly) return;
    const delta = e.deltaMode === 1 ? e.deltaY * 16 : e.deltaY;
    const base = this.wheelZooming ? this.zoomTarget : this.camera.position.length();
    // zoom in log space relative to the surface for even steps at every altitude
    const alt = Math.max(base - 1, 0.001) * Math.exp(delta * 0.0016);
    this.zoomTarget = THREE.MathUtils.clamp(1 + alt, MIN_DIST, MAX_DIST);
    this.wheelZooming = true;
    this.pauseAutoRotate();
    this.scheduleResume();
  };

  private handleInteractionStart = (): void => {
    this.fly = null;
    this.controls.enabled = true;
    this.pauseAutoRotate();
  };

  private handleInteractionEnd = (): void => {
    this.scheduleResume();
  };

  pauseAutoRotate(): void {
    this.controls.autoRotate = false;
    window.clearTimeout(this.resumeTimer);
  }

  private scheduleResume(): void {
    window.clearTimeout(this.resumeTimer);
    this.resumeTimer = window.setTimeout(() => {
      this.controls.autoRotate = true;
    }, AUTO_ROTATE_RESUME_MS);
  }

  private setNdcFromEvent(e: PointerEvent): void {
    const rect = this.canvas.getBoundingClientRect();
    this.ndc.set(((e.clientX - rect.left) / rect.width) * 2 - 1, -((e.clientY - rect.top) / rect.height) * 2 + 1);
  }

  private handleDoubleClick = (e: MouseEvent): void => {
    if (this.suspended || !this.onDoubleSelect) return;
    const rect = this.canvas.getBoundingClientRect();
    this.ndc.set(((e.clientX - rect.left) / rect.width) * 2 - 1, -((e.clientY - rect.top) / rect.height) * 2 + 1);
    this.onDoubleSelect(this.pickAtNdc(this.ndc.x, this.ndc.y));
  };

  private handlePointerMove = (e: PointerEvent): void => {
    if (this.suspended || e.pointerType === 'touch') return; // no hover on touch
    this.setNdcFromEvent(e);
    this.pointerInside = true;
    this.pointerDirty = true;
  };

  private handlePointerLeave = (): void => {
    this.pointerInside = false;
    this.pointerDirty = true;
  };

  private handlePointerDown = (e: PointerEvent): void => {
    this.downX = e.clientX;
    this.downY = e.clientY;
    this.downT = performance.now();
  };

  private handlePointerUp = (e: PointerEvent): void => {
    if (this.suspended) return;
    const moved = Math.hypot(e.clientX - this.downX, e.clientY - this.downY);
    if (moved > 6 || performance.now() - this.downT > 600 || e.button !== 0) return;
    this.setNdcFromEvent(e);
    const id = this.pickAtNdc(this.ndc.x, this.ndc.y);
    this.onSelect?.(id);
  };

  private handleResize = (): void => {
    const parent = this.canvas.parentElement;
    if (!parent || this.suspended) return;
    const w = parent.clientWidth;
    const h = parent.clientHeight;
    this.camera.aspect = w / Math.max(1, h);
    // keep the globe comfortably inside narrow (portrait) viewports
    this.camera.fov = this.camera.aspect < 0.8 ? 52 : 38;
    this.camera.updateProjectionMatrix();
    this.renderer.setSize(w, h);
  };

  private handleContextLost = (e: Event): void => {
    e.preventDefault();
    this.renderer.setAnimationLoop(null);
    this.running = false;
    this.onContextChange?.(true);
  };

  private handleContextRestored = (): void => {
    if (this.idTex) this.idTex.needsUpdate = true;
    if (this.countryTex) this.countryTex.needsUpdate = true;
    if (this.flagTex) this.flagTex.needsUpdate = true;
    this.onContextChange?.(false);
    this.start(); // no-op while suspended; resume() restarts the loop
  };

  /** Dev/test hook: place the camera at latitude/longitude (degrees) and distance. */
  setView(latDeg: number, lonDeg: number, dist: number): void {
    const lat = THREE.MathUtils.degToRad(latDeg);
    const lon = THREE.MathUtils.degToRad(lonDeg);
    this.fly = null;
    this.pauseAutoRotate();
    // flush OrbitControls' damped momentum so the camera stays exactly where placed
    this.controls.enableDamping = false;
    this.controls.update();
    this.camera.position.set(Math.cos(lat) * Math.sin(lon), Math.sin(lat), Math.cos(lat) * Math.cos(lon)).multiplyScalar(dist);
    this.camera.lookAt(0, 0, 0);
    this.zoomTarget = dist;
    this.wheelZooming = false;
    this.controls.update();
    this.controls.enableDamping = true;
  }
}
