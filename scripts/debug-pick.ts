/** Diagnoses picking mismatches against brute force: `npx tsx scripts/debug-pick.ts [N]` */
import { generateEarthMeta, packSeeds } from '../shared/earth.ts';
import { rasterizeFace } from '../shared/raster.ts';
import { mulberry32 } from '../shared/rng.ts';
import { atlasLayout, dirToFace, faceOrigin, GUTTER } from '../shared/cube.ts';
import { atlasLookup, bruteForceCountry, createPicker } from '../shared/pick.ts';
import { warpDir } from '../shared/warp.ts';

const N = Number(process.argv[2] ?? 128);
const meta = generateEarthMeta(0x1234abcd, { samples: 6000 });
const layout = atlasLayout(N, GUTTER);
const { seeds, weights } = packSeeds(meta);
const atlas = new Uint8Array(layout.width * layout.height);
for (let face = 0; face < 6; face++) {
  const r = rasterizeFace({ seeds, weights, warpOffset: meta.warpOffset, N, G: GUTTER }, face);
  const [ox, oy] = faceOrigin(face, layout.S);
  for (let j = 0; j < layout.S; j++) atlas.set(r.ids.subarray(j * layout.S, (j + 1) * layout.S), (oy + j) * layout.width + ox);
}
const pick = createPicker({ atlas, layout, seeds, weights, warpOffset: meta.warpOffset });
const rng = mulberry32(99);
const w = new Float64Array(3);
const f = new Float64Array(3);
let mism = 0;
const samples = 20000;
for (let i = 0; i < samples; i++) {
  const z = rng() * 2 - 1;
  const th = rng() * Math.PI * 2;
  const r = Math.sqrt(1 - z * z);
  const x = Math.cos(th) * r, y = z, q = Math.sin(th) * r;
  const p = pick(x, y, q);
  const b = bruteForceCountry(seeds, weights, meta.warpOffset, x, y, q);
  if (p !== b) {
    mism++;
    warpDir(x, y, q, meta.warpOffset, w);
    const score = (c: number) => w[0] * seeds[c * 3] + w[1] * seeds[c * 3 + 1] + w[2] * seeds[c * 3 + 2] + weights[c];
    dirToFace(x, y, q, f);
    if (mism <= 8) console.log(`face ${f[0]} a=${f[1].toFixed(3)} b=${f[2].toFixed(3)} pick=${p} (${score(p).toFixed(6)}) brute=${b} (${score(b).toFixed(6)}) texel=${atlasLookup(atlas, layout, x, y, q)}`);
  }
}
console.log(`N=${N}: ${mism}/${samples} mismatches (${((mism / samples) * 100).toFixed(3)}%)`);
