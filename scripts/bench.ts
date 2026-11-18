/** Generation benchmark: `npx tsx scripts/bench.ts [faceSize]` */
import { generateEarthMeta, packSeeds } from '../shared/earth.ts';
import { rasterizeFace } from '../shared/raster.ts';
import { GUTTER } from '../shared/cube.ts';
import { PLANET_RADIUS_KM } from '../shared/resources.ts';

const N = Number(process.argv[2] ?? 1024);
let t = performance.now();
const meta = generateEarthMeta(0x1234abcd);
console.log(`meta: ${(performance.now() - t).toFixed(0)} ms`);

const { seeds, weights } = packSeeds(meta);
const area = new Float64Array(200);
t = performance.now();
for (let face = 0; face < 6; face++) {
  const f0 = performance.now();
  const r = rasterizeFace({ seeds, weights, warpOffset: meta.warpOffset, N, G: GUTTER }, face);
  for (let c = 0; c < 200; c++) area[c] += r.area[c];
  console.log(`face ${face}: ${(performance.now() - f0).toFixed(0)} ms`);
}
console.log(`raster total (single thread): ${(performance.now() - t).toFixed(0)} ms`);
const km2 = Array.from(area, (a) => a * PLANET_RADIUS_KM ** 2).sort((a, b) => a - b);
const total = km2.reduce((s, a) => s + a, 0);
console.log(`total area ${(total / 1e6).toFixed(1)}M km2 (expect ${(4 * Math.PI * PLANET_RADIUS_KM ** 2 / 1e6).toFixed(1)}M)`);
console.log(`min ${(km2[0] / 1e6).toFixed(2)}M  median ${(km2[100] / 1e6).toFixed(2)}M  max ${(km2[199] / 1e6).toFixed(2)}M km2`);
