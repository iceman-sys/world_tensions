import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { WebSocketServer, type WebSocket } from 'ws';
import { tickMs } from '../../shared/config.ts';
import { formatSeed } from '../../shared/rng.ts';
import { MAX_MESSAGE_BYTES, parseClientMessage, type ClientMessage, type ErrorCode, type ServerMessage } from '../../shared/protocol.ts';
import type { Game } from './game.ts';
import { DevBots } from './bots.ts';

export interface NetOptions {
  port: number;
  /** development server: enables dev tools (bots) */
  dev: boolean;
  log?: (msg: string) => void;
  /** token bucket per connection */
  bucketSize?: number;
  refillPerSec?: number;
}

export interface GameServer {
  readonly http: Server;
  /** resolves to the bound port (useful with port 0 in tests) */
  ready: Promise<number>;
  /** stops timers and closes every socket; does not touch the game or repository */
  close: () => Promise<void>;
}

interface Conn {
  ws: WebSocket;
  playerId: string | null;
  tokens: number;
  lastRefill: number;
  violations: number;
  alive: boolean;
  hello: boolean;
  /** subscribed to its own nation's country-view data */
  local: boolean;
  /** messages from one socket are handled strictly in order */
  chain: Promise<void>;
}

/**
 * WebSocket front end: validates and rate-limits client messages, turns them
 * into Game actions, and fans out public diffs to everyone and private
 * country-view data only to the governors of that nation.
 */
export function createGameServer(game: Game, opts: NetOptions): GameServer {
  const log = opts.log ?? (() => undefined);
  const BUCKET_SIZE = opts.bucketSize ?? 20;
  const REFILL_PER_SEC = opts.refillPerSec ?? 8;
  const conns = new Set<Conn>();
  /** per-socket work still running after a disconnect (e.g. marking the governor offline) */
  const draining = new Set<Promise<void>>();
  const bots = opts.dev ? new DevBots(game) : null;

  const send = (c: Conn, msg: ServerMessage): void => {
    if (c.ws.readyState === c.ws.OPEN) c.ws.send(JSON.stringify(msg));
  };
  const broadcast = (msg: ServerMessage): void => {
    const payload = JSON.stringify(msg);
    for (const c of conns) if (c.hello && c.ws.readyState === c.ws.OPEN) c.ws.send(payload);
  };
  const sendToPlayer = (playerId: string, msg: ServerMessage): void => {
    for (const c of conns) if (c.playerId === playerId) send(c, msg);
  };
  /** The nation a connection governs right now (looked up on every send). */
  const nationOf = (c: Conn): number | null => {
    if (!c.playerId) return null;
    const p = game.world.players.get(c.playerId);
    return p?.nationId ?? null;
  };
  const sendToNation = (nationId: number, msg: ServerMessage): void => {
    for (const c of conns) if (c.local && nationOf(c) === nationId) send(c, msg);
  };
  const error = (c: Conn, code: ErrorCode, message: string): void => send(c, { t: 'error', code, message });

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
      for (const [nationId, local] of game.drainLocal()) {
        sendToNation(nationId, { t: 'local:diff', nationId, buildings: local.buildings, removed: local.removed, now: Date.now() });
      }
    }, 100);
  };
  game.onPlayerChanged = (playerId) => {
    // runs inside a commit; send after it has been applied
    setTimeout(() => {
      const p = game.world.players.get(playerId);
      if (p) sendToPlayer(playerId, { t: 'you', you: game.you(p) });
    }, 0);
  };

  const allow = (c: Conn): boolean => {
    const now = Date.now();
    c.tokens = Math.min(BUCKET_SIZE, c.tokens + ((now - c.lastRefill) / 1000) * REFILL_PER_SEC);
    c.lastRefill = now;
    if (c.tokens < 1) return false;
    c.tokens -= 1;
    return true;
  };

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
          devTools: opts.dev,
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
        log(`${p.name} founded ${game.countryName(r.nation.homeCell)} (cell ${r.nation.homeCell})`);
        return;
      }
      case 'ping':
        send(c, { t: 'pong' });
        return;
      case 'dev:bots':
        if (!bots) return error(c, 'not-allowed', 'Bots are only available on a development server.');
        if (msg.on) bots.start();
        else bots.stop();
        return;
      case 'local:open': {
        if (!c.playerId) return error(c, 'no-country', 'Join the Earth first.');
        const state = await game.openLocal(c.playerId);
        if (!state) return error(c, 'no-country', 'You do not govern a country.');
        c.local = true;
        send(c, { t: 'local:state', state, now: Date.now() });
        return;
      }
      case 'local:close':
        c.local = false;
        return;
      case 'build': {
        if (!c.playerId) return error(c, 'no-country', 'Join the Earth first.');
        const r = await game.build(c.playerId, msg.kind, msg.i, msg.j, msg.rot);
        send(c, { t: 'build:result', ok: r.ok, message: r.ok ? 'Construction started.' : r.message, buildingId: r.ok ? r.building.id : null });
        return;
      }
      case 'build:cancel': {
        if (!c.playerId) return error(c, 'no-country', 'Join the Earth first.');
        const r = await game.cancelBuild(c.playerId, msg.id);
        send(c, { t: 'build:result', ok: r.ok, message: r.ok ? 'Construction cancelled.' : r.message, buildingId: r.ok ? r.building.id : null });
        return;
      }
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
    c.chain = c.chain
      .then(() => handle(c, msg))
      .catch((err: unknown) => {
        console.error('[server] action failed', err);
        error(c, 'server-error', 'The server could not complete that action.');
      });
  }

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
    const c: Conn = { ws, playerId: null, tokens: BUCKET_SIZE, lastRefill: Date.now(), violations: 0, alive: true, hello: false, local: false, chain: Promise.resolve() };
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
      const done = c.chain.catch(() => undefined);
      draining.add(done);
      void done.finally(() => draining.delete(done));
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
  const ticker = setInterval(() => void game.tick(), Math.max(200, Math.min(1000, tickMs(game.cfg) / 5)));

  const ready = new Promise<number>((resolve) => {
    http.listen(opts.port, () => resolve((http.address() as AddressInfo).port));
  });

  const close = async (): Promise<void> => {
    clearInterval(heartbeat);
    clearInterval(ticker);
    if (flushTimer) clearTimeout(flushTimer);
    bots?.dispose();
    const closing = [...conns].map((c) => new Promise<void>((r) => (c.ws.readyState === c.ws.CLOSED ? r() : c.ws.once('close', () => r()))));
    for (const c of conns) c.ws.close(1012, 'server restarting');
    await Promise.race([Promise.all(closing), new Promise((r) => setTimeout(r, 2000))]);
    // let disconnect handlers (and anything queued in the game) finish before the caller closes storage
    await Promise.all([...draining]);
    await game.run(() => undefined);
    wss.close();
    await new Promise<void>((r) => http.close(() => r()));
  };

  return { http, ready, close };
}
