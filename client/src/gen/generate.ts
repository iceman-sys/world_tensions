import { packSeeds, type EarthMeta } from '../../../shared/earth.ts';
import { atlasLayout, faceOrigin, GUTTER, type AtlasLayout } from '../../../shared/cube.ts';
import { colorCountries } from '../../../shared/palette.ts';
import { deriveSeed, mulberry32 } from '../../../shared/rng.ts';
import { PLANET_RADIUS_KM } from '../../../shared/resources.ts';
import type { FaceRaster } from '../../../shared/raster.ts';
import type { WorkerRequest, WorkerResponse } from './worker.ts';

export interface EarthMap {
  meta: EarthMeta;
  layout: AtlasLayout;
  /** country id per texel, layout.width x layout.height */
  atlas: Uint8Array;
  seeds: Float32Array;
  weights: Float32Array;
  /** unit centroid per country (xyz) */
  centroids: Float32Array;
  /** angular radius (rad) of an equal-area cap */
  radius: Float32Array;
  areaKm2: Float64Array;
  neighbors: number[][];
  /** index into PRIMARIES per country */
  primaries: number[];
  genMs: number;
}

/** Omit that distributes over the request union. */
type JobRequest = WorkerRequest extends infer R ? (R extends WorkerRequest ? Omit<R, 'jobId'> : never) : never;

type Pending ={ resolve: (r: WorkerResponse) => void; reject: (e: Error) => void };

/** Small pool of generation workers, kept alive between Earths. */
class WorkerPool {
  private workers: Worker[] = [];
  private pending = new Map<number, Pending>();
  private nextJob = 1;
  private rr = 0;
  onProgress: ((face: number, fraction: number) => void) | null = null;

  constructor(size: number) {
    for (let i = 0; i < size; i++) {
      const w = new Worker(new URL('./worker.ts', import.meta.url), { type: 'module' });
      w.onmessage = (e: MessageEvent<WorkerResponse>) => this.handle(e.data);
      w.onerror = (e) => {
        for (const p of this.pending.values()) p.reject(new Error(e.message || 'worker error'));
        this.pending.clear();
      };
      this.workers.push(w);
    }
  }

  get size(): number {
    return this.workers.length;
  }

  private handle(msg: WorkerResponse): void {
    if (msg.type === 'progress') {
      this.onProgress?.(msg.face, msg.fraction);
      return;
    }
    const p = this.pending.get(msg.jobId);
    if (!p) return;
    this.pending.delete(msg.jobId);
    if (msg.type === 'error') p.reject(new Error(msg.message));
    else p.resolve(msg);
  }

  run(req: JobRequest, workerIndex?: number): Promise<WorkerResponse> {
    const jobId = this.nextJob++;
    const w = this.workers[workerIndex ?? this.rr++ % this.workers.length];
    return new Promise((resolve, reject) => {
      this.pending.set(jobId, { resolve, reject });
      w.postMessage({ ...req, jobId } as WorkerRequest);
    });
  }
}

let pool: WorkerPool | null = null;

function getPool(): WorkerPool {
  if (!pool) {
    const cores = navigator.hardwareConcurrency || 4;
    pool = new WorkerPool(Math.max(2, Math.min(6, cores - 1)));
  }
  return pool;
}

/**
 * Generates the full Earth off the main thread: metadata in one worker, then the
 * six cube faces in parallel. Progress is reported in [0, 1].
 */
export async function generateEarthMap(seed: number, N: number, onProgress: (p: number) => void): Promise<EarthMap> {
  const t0 = performance.now();
  const workers = getPool();
  onProgress(0.02);

  const metaMsg = await workers.run({ type: 'meta', seed });
  if (metaMsg.type !== 'meta') throw new Error('unexpected worker reply');
  const meta = metaMsg.meta;
  onProgress(0.3);

  const { seeds, weights } = packSeeds(meta);
  const layout = atlasLayout(N, GUTTER);
  const faceProgress = new Float64Array(6);
  workers.onProgress = (face, fraction) => {
    faceProgress[face] = fraction;
    onProgress(0.3 + 0.65 * (faceProgress.reduce((s, v) => s + v, 0) / 6));
  };

  const params = { seeds, weights, warpOffset: meta.warpOffset, N, G: GUTTER };
  const faces = await Promise.all(
    [0, 1, 2, 3, 4, 5].map(async (face) => {
      const msg = await workers.run({ type: 'face', face, params });
      if (msg.type !== 'face') throw new Error('unexpected worker reply');
      return msg.result;
    }),
  );
  workers.onProgress = null;

  const map = assemble(meta, layout, faces, seeds, weights);
  map.genMs = performance.now() - t0;
  onProgress(1);
  return map;
}

function assemble(meta: EarthMeta, layout: AtlasLayout, faces: FaceRaster[], seeds: Float32Array, weights: Float32Array): EarthMap {
  const n = meta.countries.length;
  const { S, width, height } = layout;
  const atlas = new Uint8Array(width * height);
  const area = new Float64Array(n);
  const sum = new Float64Array(n * 3);
  const adjacency = new Uint8Array(n * n);

  for (const f of faces) {
    const [ox, oy] = faceOrigin(f.face, S);
    for (let j = 0; j < S; j++) atlas.set(f.ids.subarray(j * S, (j + 1) * S), (oy + j) * width + ox);
    for (let c = 0; c < n; c++) {
      area[c] += f.area[c];
      sum[c * 3] += f.cx[c];
      sum[c * 3 + 1] += f.cy[c];
      sum[c * 3 + 2] += f.cz[c];
    }
    for (let k = 0; k < n * n; k++) adjacency[k] |= f.adjacency[k];
  }

  const centroids = new Float32Array(n * 3);
  const radius = new Float32Array(n);
  const areaKm2 = new Float64Array(n);
  const neighbors: number[][] = [];
  for (let c = 0; c < n; c++) {
    const len = Math.hypot(sum[c * 3], sum[c * 3 + 1], sum[c * 3 + 2]) || 1;
    centroids[c * 3] = sum[c * 3] / len;
    centroids[c * 3 + 1] = sum[c * 3 + 1] / len;
    centroids[c * 3 + 2] = sum[c * 3 + 2] / len;
    radius[c] = Math.sqrt(area[c] / Math.PI);
    areaKm2[c] = area[c] * PLANET_RADIUS_KM * PLANET_RADIUS_KM;
    const list: number[] = [];
    for (let o = 0; o < n; o++) if (adjacency[c * n + o]) list.push(o);
    neighbors.push(list);
  }

  const primaries = colorCountries(neighbors, mulberry32(deriveSeed(meta.seed, 'colors')));
  return { meta, layout, atlas, seeds, weights, centroids, radius, areaKm2, neighbors, primaries, genMs: 0 };
}
