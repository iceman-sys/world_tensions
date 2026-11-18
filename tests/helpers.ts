import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DEMO_CONFIG, type GameConfig } from '../shared/config.ts';
import { mulberry32 } from '../shared/rng.ts';
import { SqliteRepository } from '../server/src/db/sqlite.ts';
import { Game } from '../server/src/game.ts';
import { computeNeighbors } from '../server/src/geometry.ts';
import type { PersistedState } from '../server/src/state.ts';

export const T0 = Date.UTC(2026, 0, 1);

/** Controllable clock. */
export class FakeClock {
  constructor(public t = T0) {}
  now = (): number => this.t;
  advance(ms: number): void {
    this.t += ms;
  }
}

let idCounter = 0;

export function tempDbFile(): { file: string; cleanup: () => void } {
  const dir = mkdtempSync(join(tmpdir(), 'wt-test-'));
  return { file: join(dir, 'world.db'), cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

const neighborCache = new Map<number, number[][]>();

export async function openGame(opts: {
  file?: string;
  clock?: FakeClock;
  cfg?: Partial<GameConfig>;
  seed?: number;
  rngSeed?: number;
  legacy?: PersistedState | null;
}): Promise<{ game: Game; repo: SqliteRepository; clock: FakeClock }> {
  const clock = opts.clock ?? new FakeClock();
  const repo = new SqliteRepository(opts.file ?? ':memory:');
  const game = await Game.open(
    {
      repo,
      cfg: { ...DEMO_CONFIG, ...opts.cfg },
      clock: clock.now,
      rng: mulberry32(opts.rngSeed ?? 1),
      newId: () => `p${++idCounter}`,
      newToken: () => `token-${++idCounter}-abcdefghijklmnop`,
      // coarse but real neighbour graph keeps tests fast
      computeNeighbors: (meta) => {
        const hit = neighborCache.get(meta.seed);
        if (hit) return hit;
        const g = computeNeighbors(meta, 64);
        neighborCache.set(meta.seed, g);
        return g;
      },
      metaSamples: 6000,
    },
    { seed: opts.seed ?? 0x1234abcd, legacy: opts.legacy ?? null },
  );
  return { game, repo, clock };
}
