import { createServer } from 'node:http';
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { WebSocketServer, type WebSocket } from 'ws';
import { generateEarthMeta } from '../../shared/earth.ts';
import { formatSeed, parseSeed, randomSeed, mulberry32 } from '../../shared/rng.ts';
import { MAX_MESSAGE_BYTES, parseClientMessage, type ErrorCode, type ServerMessage } from '../../shared/protocol.ts';
import { generateCountryNames } from '../../shared/names.ts';
import { EarthState, type Player } from './state.ts';

const PORT = Number(process.env.PORT ?? 8787);
const DEV = process.env.NODE_ENV !== 'production';
const DATA_FILE = process.env.STATE_FILE ?? join(dirname(fileURLToPath(import.meta.url)), '..', 'data', 'state.json');

// ---------- state + persistence ----------
function loadState(): EarthState {
  try {
    const restored = EarthState.fromJSON(JSON.parse(readFileSync(DATA_FILE, 'utf8')));
    if (restored) {
      console.log(`[server] restored Earth ${formatSeed(restored.seed)} with ${restored.players.size} players from ${DATA_FILE}`);
      return restored;
    }
  } catch {
    /* no saved state yet */
  }
  const envSeed = process.env.EARTH_SEED ? parseSeed(process.env.EARTH_SEED) : null;
  return new EarthState(envSeed ?? randomSeed());
}

const state = loadState();
// The server derives the same seeded Earth as clients (names, ids) from /shared.
const meta = generateEarthMeta(state.seed);
console.log(`[server] Earth ${formatSeed(state.seed)}: ${meta.countries.length} countries, e.g. ${meta.countries.slice(0, 3).map((c) => c.name).join(', ')}`);

let saveTimer: NodeJS.Timeout | null = null;
function saveNow(): void {
  try {
    mkdirSync(dirname(DATA_FILE), { recursive: true });
    const tmp = `${DATA_FILE}.tmp`;
    writeFileSync(tmp, JSON.stringify(state.toJSON()));
    renameSync(tmp, DATA_FILE);
  } catch (err) {
    console.error('[server] failed to save state', err);
  }
}
function scheduleSave(): void {
  if (saveTimer) return;
  saveTimer = setTimeout(() => {
    saveTimer = null;
    saveNow();
  }, 1000);
}

// ---------- broadcasting (batched diffs) ----------
interface Conn {
  ws: WebSocket;
  player: Player | null;
  tokens: number;
  lastRefill: number;
  violations: number;
  alive: boolean;
  hello: boolean;
}

const conns = new Set<Conn>();
const dirty = new Set<number>();
let flushTimer: NodeJS.Timeout | null = null;

function send(c: Conn, msg: ServerMessage): void {
  if (c.ws.readyState === c.ws.OPEN) c.ws.send(JSON.stringify(msg));
}

function markDirty(countryId: number): void {
  if (countryId < 0) return;
  dirty.add(countryId);
  scheduleSave();
  if (!flushTimer) {
    flushTimer = setTimeout(() => {
      flushTimer = null;
      const msg: ServerMessage = { t: 'diff', countries: [...dirty].map((id) => state.countryState(id)), counts: state.counts() };
      dirty.clear();
      const payload = JSON.stringify(msg);
      for (const c of conns) if (c.hello && c.ws.readyState === c.ws.OPEN) c.ws.send(payload);
    }, 100);
  }
}

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

function attach(c: Conn, p: Player): void {
  c.player = p;
  p.connections++;
  if (state.setOnline(p, true)) markDirty(p.countryId);
}

function detach(c: Conn): void {
  const p = c.player;
  c.player = null;
  if (!p || !state.players.has(p.id)) return;
  p.connections = Math.max(0, p.connections - 1);
  if (p.connections === 0 && state.setOnline(p, false)) markDirty(p.countryId);
}

// ---------- dev bots ----------
let botTimers: NodeJS.Timeout[] = [];
let botFlicker: NodeJS.Timeout | null = null;

function startBots(): void {
  stopBots();
  const rng = mulberry32((Date.now() & 0xffffffff) >>> 0);
  const count = 20 + Math.floor(rng() * 31);
  const names = generateCountryNames(rng, count + 10).map((n) => `${n.replace(/^.* of /, '')}Bot`.slice(0, 20));
  let delay = 0;
  for (let i = 0; i < count; i++) {
    delay += 150 + rng() * 900;
    botTimers.push(
      setTimeout(() => {
        const r = state.join(names[i], { bot: true });
        if (r.ok) {
          state.setOnline(r.player, rng() < 0.7);
          markDirty(r.player.countryId);
        }
      }, delay),
    );
  }
  botFlicker = setInterval(() => {
    const bots = [...state.players.values()].filter((p) => p.bot);
    if (!bots.length) return;
    const b = bots[Math.floor(rng() * bots.length)];
    if (state.setOnline(b, !b.online)) markDirty(b.countryId);
  }, 1500);
}

function stopBots(): void {
  botTimers.forEach(clearTimeout);
  botTimers = [];
  if (botFlicker) clearInterval(botFlicker);
  botFlicker = null;
  for (const p of [...state.players.values()]) if (p.bot) markDirty(state.release(p.id));
}

// ---------- message handling ----------
function handle(c: Conn, raw: string): void {
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

  switch (msg.t) {
    case 'hello': {
      if (c.hello) return;
      c.hello = true;
      const restored = msg.token ? state.byTokenLookup(msg.token) : null;
      if (restored && !restored.bot) attach(c, restored);
      send(c, {
        t: 'welcome',
        seed: state.seed,
        you: c.player ? state.you(c.player) : null,
        countries: state.allCountries(),
        counts: state.counts(),
        devTools: DEV,
      });
      return;
    }
    case 'join': {
      if (!c.hello) return error(c, 'not-allowed', 'Say hello first.');
      if (c.player) return error(c, 'already-joined', 'You already govern a country on this Earth.');
      const r = state.join(msg.name);
      if (!r.ok) return error(c, r.code, r.message);
      r.player.online = false; // attach() flips it online and records the change
      attach(c, r.player);
      markDirty(r.player.countryId);
      send(c, { t: 'joined', you: state.you(r.player), token: r.player.token });
      console.log(`[server] ${r.player.name} joined -> country ${r.player.countryId} (${meta.countries[r.player.countryId].name})`);
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

// ---------- servers ----------
const http = createServer((req, res) => {
  if (req.url === '/health') {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ ok: true, seed: formatSeed(state.seed), players: state.players.size, connections: conns.size }));
    return;
  }
  res.writeHead(200, { 'content-type': 'text/plain' });
  res.end('World Tensions prototype server. Connect with a WebSocket.\n');
});

const wss = new WebSocketServer({ server: http, maxPayload: MAX_MESSAGE_BYTES });

wss.on('connection', (ws) => {
  const c: Conn = { ws, player: null, tokens: BUCKET_SIZE, lastRefill: Date.now(), violations: 0, alive: true, hello: false };
  conns.add(c);
  ws.on('pong', () => (c.alive = true));
  ws.on('message', (data, isBinary) => {
    if (isBinary) {
      error(c, 'bad-message', 'Binary frames are not supported.');
      return;
    }
    handle(c, data.toString());
  });
  ws.on('close', () => {
    conns.delete(c);
    detach(c);
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

http.listen(PORT, () => {
  console.log(`[server] listening on ws://localhost:${PORT} (${DEV ? 'development' : 'production'})`);
});

function shutdown(): void {
  clearInterval(heartbeat);
  for (const p of state.players.values()) if (!p.bot) state.setOnline(p, false);
  saveNow();
  for (const c of conns) c.ws.close(1012, 'server restarting');
  http.close();
  process.exit(0);
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
