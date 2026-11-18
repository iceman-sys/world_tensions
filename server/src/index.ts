import { createServer } from 'node:http';
import { existsSync, readFileSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { WebSocketServer, type WebSocket } from 'ws';
import { configFromEnv, tickMs } from '../../shared/config.ts';
import { formatSeed, parseSeed, randomSeed, mulberry32 } from '../../shared/rng.ts';
import { MAX_MESSAGE_BYTES, parseClientMessage, type ClientMessage, type ErrorCode, type ServerMessage } from '../../shared/protocol.ts';
import { generateCountryNames } from '../../shared/names.ts';
import { SqliteRepository } from './db/sqlite.ts';
import { computeNeighbors } from './geometry.ts';
import { Game } from './game.ts';
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
const seedRng = mulberry32(randomSeed());
const t0 = Date.now();
const game = await Game.open(
  {
    repo,
    cfg: config,
    clock: () => Date.now(),
    rng: seedRng,
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

// ---------- connections ----------
interface Conn {
  ws: WebSocket;
  playerId: string | null;
  tokens: number;
  lastRefill: number;
  violations: number;
  alive: boolean;
  hello: boolean;
  /** messages from one socket are handled strictly in order */
  chain: Promise<void>;
}

const conns = new Set<Conn>();

function send(c: Conn, msg: ServerMessage): void {
  if (c.ws.readyState === c.ws.OPEN) c.ws.send(JSON.stringify(msg));
}

function broadcast(msg: ServerMessage): void {
  const payload = JSON.stringify(msg);
  for (const c of conns) if (c.hello && c.ws.readyState === c.ws.OPEN) c.ws.send(payload);
}

function sendToPlayer(playerId: string, msg: ServerMessage): void {
  for (const c of conns) if (c.playerId === playerId) send(c, msg);
}

let flushTimer: NodeJS.Timeout | null = null;
game.onDirty = () => {
  if (flushTimer) return;
  flushTimer = setTimeout(() => {
    flushTimer = null;
    const d = game.drainDiff();
    if (d.countries.length || d.nations.length || d.removedNations.length) {
      broadcast({ t: 'diff', countries: d.countries, nations: d.nations, removedNations: d.removedNations, counts: game.counts(), now: Date.now() });
    }
    if (d.log.length) broadcast({ t: 'log', entries: d.log });
  }, 100);
};
game.onPlayerChanged = (playerId) => {
  // runs inside a commit; send after it has been applied
  setTimeout(() => {
    const p = game.world.players.get(playerId);
    if (p) sendToPlayer(playerId, { t: 'you', you: game.you(p) });
  }, 0);
};

function error(c: Conn, code: ErrorCode, message: string): void {
  send(c, { t: 'error', code, message });
}

// ---------- rate limiting: token bucket per connection ----------
const BUCKET_SIZE = 20;
const REFILL_PER_SEC = 8;
function allow(c: Conn): boolean {
  const now = Date.now();
  c.tokens = Math.min(BUCKET_SIZE, c.tokens + ((now - c.lastRefill) / 1000) * REFILL_PER_SEC);
  c.lastRefill = now;
  if (c.tokens < 1) return false;
  c.tokens -= 1;
  return true;
}

// ---------- dev bots ----------
let botTimers: NodeJS.Timeout[] = [];
const botRng = mulberry32(randomSeed());

function startBots(): void {
  stopBots();
  const count = 20 + Math.floor(botRng() * 31);
  const names = generateCountryNames(botRng, count + 10).map((n) => `${n.replace(/^.* of /, '')}Bot`.slice(0, 20));
  let delay = 0;
  for (let i = 0; i < count; i++) {
    delay += 150 + botRng() * 900;
    botTimers.push(
      setTimeout(() => {
        void game.join(names[i], { bot: true }).then((r) => {
          if (r.ok) game.setBotOnline(r.player.id, botRng() < 0.7);
        });
      }, delay),
    );
  }
}

function stopBots(): void {
  botTimers.forEach(clearTimeout);
  botTimers = [];
  for (const p of [...game.world.players.values()]) if (p.bot) void game.release(p.id);
}

// persisted bots come back online after a restart; their online dot flickers
for (const p of game.world.players.values()) if (p.bot) game.setBotOnline(p.id, botRng() < 0.7);
const botFlicker = setInterval(() => {
  const bots = [...game.world.players.values()].filter((p) => p.bot);
  if (!bots.length) return;
  const b = bots[Math.floor(botRng() * bots.length)];
  game.setBotOnline(b.id, !game.isOnline(b));
}, 1500);

// ---------- message handling ----------
async function handle(c: Conn, msg: ClientMessage): Promise<void> {
  switch (msg.t) {
    case 'hello': {
      if (c.hello) return;
      c.hello = true;
      const restored = msg.token ? game.playerByToken(msg.token) : null;
      let summary = null;
      if (restored && !restored.bot) {
        c.playerId = restored.id;
        summary = await game.attach(restored.id);
      }
      const p = c.playerId ? game.world.players.get(c.playerId) : undefined;
      send(c, {
        t: 'welcome',
        seed: game.seed,
        you: p ? game.you(p) : null,
        countries: game.allCountries(),
        nations: game.allNations(),
        neighbors: game.neighbors,
        counts: game.counts(),
        devTools: DEV,
        config: game.clientConfig(),
        now: Date.now(),
        log: game.world.log.slice(-60),
      });
      if (summary) send(c, { t: 'away', summary });
      return;
    }
    case 'join': {
      if (!c.hello) return error(c, 'not-allowed', 'Say hello first.');
      const existing = c.playerId ? game.world.players.get(c.playerId) ?? null : null;
      const r = await game.join(msg.name, { existing });
      if (!r.ok) return error(c, r.code, r.message);
      if (!existing) {
        c.playerId = r.player.id;
        await game.attach(r.player.id);
      }
      const p = game.world.players.get(r.player.id);
      if (!p) return;
      if (r.token) send(c, { t: 'joined', you: game.you(p), token: r.token });
      else sendToPlayer(p.id, { t: 'you', you: game.you(p) });
      console.log(`[server] ${p.name} founded ${game.countryName(r.nation.homeCell)} (cell ${r.nation.homeCell})`);
      return;
    }
    case 'ping':
      send(c, { t: 'pong' });
      return;
    case 'dev:bots':
      if (!DEV) return error(c, 'not-allowed', 'Bots are only available on a development server.');
      if (msg.on) startBots();
      else stopBots();
      return;
  }
}

function receive(c: Conn, raw: string): void {
  if (!allow(c)) {
    c.violations++;
    error(c, 'rate-limited', 'Too many messages; slow down.');
    if (c.violations > 20) c.ws.close(1008, 'rate limit');
    return;
  }
  const msg = parseClientMessage(raw);
  if (!msg) {
    c.violations++;
    error(c, 'bad-message', 'Malformed or unknown message.');
    if (c.violations > 20) c.ws.close(1008, 'too many bad messages');
    return;
  }
  c.chain = c.chain.then(() => handle(c, msg)).catch((err: unknown) => {
    console.error('[server] action failed', err);
    error(c, 'server-error', 'The server could not complete that action.');
  });
}

// ---------- servers ----------
const http = createServer((req, res) => {
  if (req.url === '/health') {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ ok: true, seed: formatSeed(game.seed), players: game.world.players.size, connections: conns.size }));
    return;
  }
  res.writeHead(200, { 'content-type': 'text/plain' });
  res.end('World Tensions prototype server. Connect with a WebSocket.\n');
});

const wss = new WebSocketServer({ server: http, maxPayload: MAX_MESSAGE_BYTES });

wss.on('connection', (ws) => {
  const c: Conn = { ws, playerId: null, tokens: BUCKET_SIZE, lastRefill: Date.now(), violations: 0, alive: true, hello: false, chain: Promise.resolve() };
  conns.add(c);
  ws.on('pong', () => (c.alive = true));
  ws.on('message', (data, isBinary) => {
    if (isBinary) {
      error(c, 'bad-message', 'Binary frames are not supported.');
      return;
    }
    receive(c, data.toString());
  });
  ws.on('close', () => {
    conns.delete(c);
    // wait for in-flight messages (e.g. a join) before marking the governor offline
    c.chain = c.chain.then(async () => {
      if (c.playerId) await game.detach(c.playerId);
      c.playerId = null;
    });
  });
  ws.on('error', () => ws.terminate());
});

// drop dead connections so players are marked offline promptly
const heartbeat = setInterval(() => {
  for (const c of conns) {
    if (!c.alive) {
      c.ws.terminate();
      continue;
    }
    c.alive = false;
    c.ws.ping();
  }
}, 15000);

// economy ticks: check often, the game decides whether a tick is due
const ticker = setInterval(() => void game.tick(), Math.max(200, Math.min(1000, tickMs(config) / 5)));

http.listen(PORT, () => {
  console.log(`[server] listening on ws://localhost:${PORT} (${DEV ? 'development' : 'production'})`);
});

let shuttingDown = false;
function shutdown(): void {
  if (shuttingDown) return;
  shuttingDown = true;
  clearInterval(heartbeat);
  clearInterval(ticker);
  clearInterval(botFlicker);
  try {
    repo.commitSync(game.shutdownChanges());
  } catch (err) {
    console.error('[server] failed to save on shutdown', err);
  }
  for (const c of conns) c.ws.close(1012, 'server restarting');
  http.close();
  void repo.close().finally(() => process.exit(0));
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
