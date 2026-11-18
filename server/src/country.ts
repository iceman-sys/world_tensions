import type { EarthMeta } from '../../shared/earth.ts';
import { generateLocalTerrain, terrainInputFor, type LocalTerrain } from '../../shared/country/terrain.ts';

/**
 * Server-side local terrain per nation, generated with exactly the same pure
 * function and inputs as the client, so placement checks agree tile by tile.
 * ~150 ms per country at 256x256, so recent results are kept in a small LRU.
 */
export class TerrainCache {
  private readonly cache = new Map<string, LocalTerrain>();

  constructor(private readonly meta: EarthMeta, private readonly size: number | undefined, private readonly limit = 24) {}

  get(homeCell: number, ownCells: number[]): LocalTerrain {
    const own = [...ownCells].sort((a, b) => a - b);
    const key = `${homeCell}:${own.join(',')}`;
    const hit = this.cache.get(key);
    if (hit) {
      this.cache.delete(key);
      this.cache.set(key, hit);
      return hit;
    }
    const t = generateLocalTerrain(terrainInputFor(this.meta, homeCell, own.length ? own : [homeCell], this.meta.countries[homeCell].resources, this.size));
    this.cache.set(key, t);
    while (this.cache.size > this.limit) {
      const oldest = this.cache.keys().next().value;
      if (oldest === undefined) break;
      this.cache.delete(oldest);
    }
    return t;
  }
}
