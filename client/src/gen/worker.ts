import { generateEarthMeta, type EarthMeta } from '../../../shared/earth.ts';
import { rasterizeFace, type FaceRaster, type RasterParams } from '../../../shared/raster.ts';

export type WorkerRequest =
  | { type: 'meta'; jobId: number; seed: number }
  | { type: 'face'; jobId: number; face: number; params: RasterParams };

export type WorkerResponse =
  | { type: 'meta'; jobId: number; meta: EarthMeta }
  | { type: 'progress'; jobId: number; face: number; fraction: number }
  | { type: 'face'; jobId: number; result: FaceRaster }
  | { type: 'error'; jobId: number; message: string };

const post = (msg: WorkerResponse, transfer: Transferable[] = []) => postMessage(msg, { transfer });

onmessage = (e: MessageEvent<WorkerRequest>) => {
  const req = e.data;
  try {
    if (req.type === 'meta') {
      post({ type: 'meta', jobId: req.jobId, meta: generateEarthMeta(req.seed) });
      return;
    }
    const result = rasterizeFace(req.params, req.face, (fraction) =>
      post({ type: 'progress', jobId: req.jobId, face: req.face, fraction }),
    );
    post({ type: 'face', jobId: req.jobId, result }, [
      result.ids.buffer,
      result.area.buffer,
      result.cx.buffer,
      result.cy.buffer,
      result.cz.buffer,
      result.adjacency.buffer,
    ]);
  } catch (err) {
    post({ type: 'error', jobId: req.jobId, message: err instanceof Error ? err.message : String(err) });
  }
};
