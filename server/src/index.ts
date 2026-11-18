import { existsSync, readFileSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { configFromEnv, tickMs } from '../../shared/config.ts';
import { formatSeed, parseSeed, randomSeed, mulberry32 } from '../../shared/rng.ts';
import { SqliteRepository } from './db/sqlite.ts';
import { computeNeighbors } from './geometry.ts';
import { Game } from './game.ts';
import { createGameServer } from './net.ts';
import { EarthState, type PersistedState } from './state.ts';

const PORT = Number(process.env.PORT ?? 8787);
const PRODUCTION = process.env.NODE_ENV === 'production';
const DEV = !PRODUCTION;
const DATA_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', 'data');
const DB_FILE = process.env.DB_FILE ?? join(DATA_DIR, 'world.db');
/** pre-database save file; imported once into an empty database */
const LEGACY_FILE = process.env.STATE_FILE ?? join(DATA_DIR, 'state.json');

const { config, warnings } = configFromEnv(process.env, PRODUCTION);
for (const w of warnings) console.warn(`[server] config: ${w}`);

function readLegacy(): PersistedState | null {
  if (!existsSync(LEGACY_FILE)) return null;
  try {
    // EarthState.fromJSON validates the old format; toJSON returns the clean player list
    return EarthState.fromJSON(JSON.parse(readFileSync(LEGACY_FILE, 'utf8')))?.toJSON() ?? null;
  } catch {
    return null;
  }
}

const repo = new SqliteRepository(DB_FILE);
const envSeed = process.env.EARTH_SEED ? parseSeed(process.env.EARTH_SEED) : null;
const t0 = Date.now();
const game = await Game.open(
  {
    repo,
    cfg: config,
    clock: () => Date.now(),
    rng: mulberry32(randomSeed()),
    newId: () => randomBytes(9).toString('base64url'),
    newToken: () => randomBytes(24).toString('base64url'),
    computeNeighbors: (meta) => {
      console.log('[server] computing neighbour graph (cached afterwards)…');
      return computeNeighbors(meta);
    },
  },
  { seed: envSeed ?? randomSeed(), legacy: readLegacy() },
);
console.log(
  `[server] Earth ${formatSeed(game.seed)} ready in ${Date.now() - t0} ms: ${game.world.nations.size} countries governed, ` +
    `${game.world.players.size} governors (${DB_FILE})`,
);
console.log(
  `[server] ${config.demoMode ? 'DEMO_MODE: 1 s = 1 game minute' : 'real time'}; tick every ${(tickMs(config) / 1000).toFixed(1)} s, ` +
    `inactivity ${config.inactivityGameHours} game h, protection ${config.protectionGameHours} game h`,
);

const server = createGameServer(game, { port: PORT, dev: DEV, log: (m) => console.log(`[server] ${m}`) });
void server.ready.then((port) => console.log(`[server] listening on ws://localhost:${port} (${DEV ? 'development' : 'production'})`));

let shuttingDown = false;
function shutdown(): void {
  if (shuttingDown) return;
  shuttingDown = true;
  try {
    repo.commitSync(game.shutdownChanges());
  } catch (err) {
    console.error('[server] failed to save on shutdown', err);
  }
  void server
    .close()
    .then(() => repo.close())
    .finally(() => process.exit(0));
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
