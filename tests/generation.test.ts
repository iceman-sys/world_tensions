import { describe, expect, it } from 'vitest';
import { generateEarthMeta, packSeeds } from '../shared/earth.ts';
import { rasterizeFace } from '../shared/raster.ts';
import { generateCountryNames } from '../shared/names.ts';
import { mulberry32 } from '../shared/rng.ts';
import { atlasLayout, dirToFace, faceOrigin, faceToDir, GUTTER } from '../shared/cube.ts';
import { atlasLookup, bruteForceCountry, createPicker } from '../shared/pick.ts';

const SEED = 0x1234abcd;
const meta = generateEarthMeta(SEED, { samples: 6000 });

describe('seeded generation', () => {
  it('is deterministic for the same seed', () => {
    const again = generateEarthMeta(SEED, { samples: 6000 });
    expect(again).toEqual(meta);
  });

  it('differs for a different seed', () => {
    const other = generateEarthMeta(SEED + 1, { samples: 6000 });
    expect(other.countries[0].seed).not.toEqual(meta.countries[0].seed);
  });

  it('produces 200 countries with unit seed vectors', () => {
    expect(meta.countries).toHaveLength(200);
    for (const c of meta.countries) expect(Math.hypot(...c.seed)).toBeCloseTo(1, 6);
  });

  it('rasterises a face identically twice', () => {
    const { seeds, weights } = packSeeds(meta);
    const p = { seeds, weights, warpOffset: meta.warpOffset, N: 48, G: GUTTER };
    const a = rasterizeFace(p, 2);
    const b = rasterizeFace(p, 2);
    expect(Buffer.from(a.ids).equals(Buffer.from(b.ids))).toBe(true);
  });
});

describe('country names', () => {
  it('are unique within an Earth across many seeds', () => {
    for (let s = 1; s <= 25; s++) {
      const names = generateCountryNames(mulberry32(s * 7919), 200);
      expect(new Set(names.map((n) => n.toLowerCase())).size).toBe(200);
    }
  });

  it('are unique in generated Earth metadata', () => {
    expect(new Set(meta.countries.map((c) => c.name)).size).toBe(200);
  });
});

describe('cube mapping and ID lookup', () => {
  it('round-trips face coordinates', () => {
    const d = new Float64Array(3);
    const f = new Float64Array(3);
    for (let face = 0; face < 6; face++) {
      for (const [a, b] of [[0, 0], [0.5, -0.3], [-0.95, 0.9], [0.99, 0.99]]) {
        faceToDir(face, a, b, d);
        dirToFace(d[0], d[1], d[2], f);
        expect(f[0]).toBe(face);
        expect(f[1]).toBeCloseTo(a, 9);
        expect(f[2]).toBeCloseTo(b, 9);
      }
    }
  });

  // build a small full atlas once
  const N = 128;
  const layout = atlasLayout(N, GUTTER);
  const { seeds, weights } = packSeeds(meta);
  const atlas = new Uint8Array(layout.width * layout.height);
  for (let face = 0; face < 6; face++) {
    const r = rasterizeFace({ seeds, weights, warpOffset: meta.warpOffset, N, G: GUTTER }, face);
    const [ox, oy] = faceOrigin(face, layout.S);
    for (let j = 0; j < layout.S; j++) atlas.set(r.ids.subarray(j * layout.S, (j + 1) * layout.S), (oy + j) * layout.width + ox);
  }
  const pick = createPicker({ atlas, layout, seeds, weights, warpOffset: meta.warpOffset });

  it('exact picking matches a brute-force search everywhere (incl. poles and borders)', () => {
    const rng = mulberry32(99);
    let mismatches = 0;
    const samples = 3000;
    for (let i = 0; i < samples; i++) {
      const z = rng() * 2 - 1;
      const th = rng() * Math.PI * 2;
      const r = Math.sqrt(1 - z * z);
      const x = Math.cos(th) * r, y = z, w = Math.sin(th) * r;
      if (pick(x, y, w) !== bruteForceCountry(seeds, weights, meta.warpOffset, x, y, w)) mismatches++;
    }
    // poles explicitly
    for (const [x, y, w] of [[0, 1, 0], [0, -1, 0], [1e-4, 0.99999999, 0]]) {
      const n = Math.hypot(x, y, w);
      expect(pick(x / n, y / n, w / n)).toBe(bruteForceCountry(seeds, weights, meta.warpOffset, x / n, y / n, w / n));
    }
    // remaining misses are sub-texel slivers where the warp folds (~0.1% at this test
    // resolution of 128/face, ~0.005% at 512, effectively 0 at the real 1024). The
    // shader uses the same candidate rule, so drawn borders still match picking.
    expect(mismatches / samples).toBeLessThan(0.005);
  });

  it('raw atlas texel lookup agrees with brute force away from borders', () => {
    const rng = mulberry32(7);
    let ok = 0;
    let total = 0;
    for (let i = 0; i < 1000; i++) {
      const z = rng() * 2 - 1;
      const th = rng() * Math.PI * 2;
      const r = Math.sqrt(1 - z * z);
      const x = Math.cos(th) * r, y = z, w = Math.sin(th) * r;
      total++;
      if (atlasLookup(atlas, layout, x, y, w) === bruteForceCountry(seeds, weights, meta.warpOffset, x, y, w)) ok++;
    }
    // at this tiny test resolution (N=128) ~6% of the sphere lies within half a texel
    // of a border, where the nearest texel may belong to the neighbour; exact picking
    // (previous test) resolves those cases
    expect(ok / total).toBeGreaterThan(0.92);
  });
});
