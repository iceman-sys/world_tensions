import { describe, expect, it } from 'vitest';
import { generateEarthMeta, packSeeds } from '../shared/earth.ts';
import { rasterizeFace } from '../shared/raster.ts';
import { atlasLayout, faceOrigin, GUTTER } from '../shared/cube.ts';
import { atlasLookup } from '../shared/pick.ts';
import { generateLocalTerrain, terrainInputFor } from '../shared/country/terrain.ts';
import { gridDir } from '../shared/country/sampler.ts';
import { MASK, RESOURCE_SPOT, WATER } from '../shared/country/config.ts';

const SEED = 0x1234abcd;
const meta = generateEarthMeta(SEED);
const CELL = 47;
const input = terrainInputFor(meta, CELL, [CELL], meta.countries[CELL].resources, 128);
const terrain = generateLocalTerrain(input);

describe('local terrain', () => {
  it('is deterministic for a given seed and country', () => {
    const again = generateLocalTerrain(terrainInputFor(meta, CELL, [CELL], meta.countries[CELL].resources, 128));
    expect(again.heights).toEqual(terrain.heights);
    expect(again.mask).toEqual(terrain.mask);
    expect(again.biome).toEqual(terrain.biome);
    expect(again.spots).toEqual(terrain.spots);
    expect(again.capital).toEqual(terrain.capital);
  });

  it('differs between countries', () => {
    const other = generateLocalTerrain(terrainInputFor(meta, 48, [48], meta.countries[48].resources, 128));
    expect(other.mask).not.toEqual(terrain.mask);
  });

  it('has land, a water channel around it and a neighbour strip beyond', () => {
    const count = [0, 0, 0, 0];
    for (const m of terrain.mask) count[m]++;
    expect(count[MASK.own]).toBeGreaterThan(terrain.size * terrain.size * 0.08);
    expect(count[MASK.channel]).toBeGreaterThan(0);
    expect(count[MASK.neighbor]).toBeGreaterThan(count[MASK.channel]);
    // the frame edge is never own land (the silhouette is not clipped)
    const n = terrain.size;
    for (let i = 0; i < n; i++) {
      for (const k of [i, (n - 1) * n + i, i * n, i * n + n - 1]) expect(terrain.mask[k]).not.toBe(MASK.own);
    }
  });

  it('border mask matches the ID texture the globe draws', () => {
    // the same country-ID atlas the client renders, at 512 px per face
    const N = 512;
    const layout = atlasLayout(N, GUTTER);
    const { seeds, weights } = packSeeds(meta);
    const atlas = new Uint8Array(layout.width * layout.height);
    for (let face = 0; face < 6; face++) {
      const r = rasterizeFace({ seeds, weights, warpOffset: meta.warpOffset, N, G: GUTTER }, face);
      const [ox, oy] = faceOrigin(face, layout.S);
      for (let j = 0; j < layout.S; j++) atlas.set(r.ids.subarray(j * layout.S, (j + 1) * layout.S), (oy + j) * layout.width + ox);
    }
    const n = terrain.size;
    const dir = new Float64Array(3);
    let mismatch = 0;
    let own = 0;
    for (let j = 0; j < n; j++) {
      for (let i = 0; i < n; i++) {
        gridDir(terrain.frame, n, i, j, dir);
        const texel = atlasLookup(atlas, layout, dir[0], dir[1], dir[2]);
        const isOwn = terrain.mask[j * n + i] === MASK.own;
        if (isOwn) own++;
        if ((texel === CELL) !== isOwn) mismatch++;
      }
    }
    // only sub-texel slivers along the border may differ
    expect(mismatch / own).toBeLessThan(0.03);
  });

  it('places the capital on dry own land', () => {
    const k = terrain.capital.j * terrain.size + terrain.capital.i;
    expect(terrain.mask[k]).toBe(MASK.own);
    expect(terrain.water[k]).toBe(WATER.none);
  });

  it('has one resource site per natural resource, of the matching kind, on own land', () => {
    const resources = meta.countries[CELL].resources;
    expect(terrain.spots.map((s) => s.resource).sort()).toEqual([...resources].sort());
    for (const s of terrain.spots) {
      expect(s.kind).toBe(RESOURCE_SPOT[s.resource].kind);
      expect(terrain.mask[s.j * terrain.size + s.i]).toBe(MASK.own);
    }
  });

  it('carves lakes and rivers inside the country', () => {
    expect(terrain.lakes.length).toBeGreaterThan(0);
    for (const l of terrain.lakes) expect(terrain.mask[l.j * terrain.size + l.i]).toBe(MASK.own);
    let river = 0;
    for (const w of terrain.water) if (w === WATER.river) river++;
    expect(river).toBeGreaterThan(0);
  });
});
