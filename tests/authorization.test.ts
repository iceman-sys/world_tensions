import { afterEach, describe, expect, it } from 'vitest';
import WebSocket from 'ws';
import { parseClientMessage, type ServerMessage } from '../shared/protocol.ts';
import { validatePlacement } from '../shared/country/buildings.ts';
import { createGameServer, type GameServer } from '../server/src/net.ts';
import { openGame } from './helpers.ts';

/** A test client that records every server message. */
class Client {
  readonly messages: ServerMessage[] = [];
  private constructor(readonly ws: WebSocket) {
    ws.on('message', (d) => this.messages.push(JSON.parse(d.toString()) as ServerMessage));
  }
  static async connect(port: number): Promise<Client> {
    const ws = new WebSocket(`ws://127.0.0.1:${port}`);
    await new Promise<void>((resolve, reject) => {
      ws.once('open', () => resolve());
      ws.once('error', reject);
    });
    return new Client(ws);
  }
  send(msg: unknown): void {
    this.ws.send(typeof msg === 'string' ? msg : JSON.stringify(msg));
  }
  async waitFor<T extends ServerMessage['t']>(t: T, timeout = 5000): Promise<Extract<ServerMessage, { t: T }>> {
    const start = Date.now();
    for (;;) {
      const m = this.messages.find((x) => x.t === t);
      if (m) {
        this.messages.splice(this.messages.indexOf(m), 1);
        return m as Extract<ServerMessage, { t: T }>;
      }
      if (Date.now() - start > timeout) throw new Error(`timeout waiting for ${t}`);
      await new Promise((r) => setTimeout(r, 20));
    }
  }
  all<T extends ServerMessage['t']>(t: T): Extract<ServerMessage, { t: T }>[] {
    return this.messages.filter((m) => m.t === t) as Extract<ServerMessage, { t: T }>[];
  }
  close(): void {
    this.ws.close();
  }
}

const running: { server: GameServer; close: () => Promise<void> }[] = [];
afterEach(async () => {
  // sockets first (their disconnect handlers still write), then storage
  while (running.length) {
    const r = running.pop();
    if (!r) break;
    await r.server.close();
    await r.close();
  }
});

async function setup() {
  const { game, repo } = await openGame({});
  const server = createGameServer(game, { port: 0, dev: false });
  running.push({ server, close: () => repo.close() });
  const port = await server.ready;
  const join = async (name: string) => {
    const c = await Client.connect(port);
    c.send({ t: 'hello', token: null });
    await c.waitFor('welcome');
    c.send({ t: 'join', name });
    const j = await c.waitFor('joined');
    return { c, you: j.you };
  };
  return { game, repo, port, join };
}

const settle = () => new Promise((r) => setTimeout(r, 300));

describe('country-view authorization', () => {
  it('a governor only ever receives their own nation\'s buildings', async () => {
    const { game, join } = await setup();
    const alice = await join('Alice');
    const bob = await join('Bob');
    alice.c.send({ t: 'local:open' });
    bob.c.send({ t: 'local:open' });
    const aState = await alice.c.waitFor('local:state');
    const bState = await bob.c.waitFor('local:state');
    expect(aState.state.nationId).toBe(alice.you.nationId);
    expect(bState.state.nationId).toBe(bob.you.nationId);
    expect(aState.state.buildings.every((b) => b.nationId === alice.you.nationId)).toBe(true);
    expect(bState.state.buildings.every((b) => b.nationId === bob.you.nationId)).toBe(true);
    // citizens are private too: the two governors get different, nation-specific lists
    expect(aState.state.citizens.length).toBe(40);
    expect(bState.state.citizens.map((c) => c.name)).not.toEqual(aState.state.citizens.map((c) => c.name));

    // Alice builds: only Alice's sockets get the local diff
    const t = game.terrainOf(alice.you.nationId ?? -1);
    if (!t) throw new Error('no terrain');
    let spot: { i: number; j: number } | null = null;
    for (let j = 0; j < t.size && !spot; j++) for (let i = 0; i < t.size && !spot; i++) if (validatePlacement(t, game.world.buildingsOf(alice.you.nationId ?? -1), 'house', i, j, 0, Infinity).ok) spot = { i, j };
    if (!spot) throw new Error('no spot');
    alice.c.send({ t: 'build', kind: 'house', i: spot.i, j: spot.j, rot: 0 });
    expect((await alice.c.waitFor('build:result')).ok).toBe(true);
    await alice.c.waitFor('local:diff');
    await settle();
    // Bob saw nothing private about Alice, ever: every private message he got is about his own nation
    for (const m of bob.c.messages) {
      if (m.t === 'local:diff') expect(m.nationId).toBe(bob.you.nationId);
      if (m.t === 'local:state') expect(m.state.nationId).toBe(bob.you.nationId);
      if (m.t === 'local:diff') for (const b of m.diff.buildings) expect(b.nationId).toBe(bob.you.nationId);
    }
    const aliceBuildingIds = new Set(game.world.buildingsOf(alice.you.nationId ?? -1).map((b) => b.id));
    for (const m of bob.c.messages) if (m.t === 'local:diff') for (const b of m.diff.buildings) expect(aliceBuildingIds.has(b.id)).toBe(false);
    alice.c.close();
    bob.c.close();
  });

  it('a spectator without a country gets nothing and cannot build', async () => {
    const { port } = await setup();
    const c = await Client.connect(port);
    c.send({ t: 'hello', token: null });
    await c.waitFor('welcome');
    c.send({ t: 'local:open' });
    expect((await c.waitFor('error')).code).toBe('no-country');
    c.send({ t: 'build', kind: 'house', i: 5, j: 5, rot: 0 });
    expect((await c.waitFor('error')).code).toBe('no-country');
    c.close();
  });

  it('no message can name another nation, and cancelling a foreign building fails like a missing one', async () => {
    const { join } = await setup();
    // a request that tries to choose a nation is rejected by the validator outright
    expect(parseClientMessage(JSON.stringify({ t: 'local:open', nationId: 1 }))).toBeNull();
    expect(parseClientMessage(JSON.stringify({ t: 'build', kind: 'house', i: 1, j: 1, rot: 0, nationId: 2 }))).toBeNull();
    const alice = await join('Alice');
    const bob = await join('Bob');
    alice.c.send({ t: 'local:open' });
    const aState = await alice.c.waitFor('local:state');
    const aliceBuilding = aState.state.buildings[0];
    bob.c.send({ t: 'build:cancel', id: aliceBuilding.id });
    const r = await bob.c.waitFor('build:result');
    expect(r.ok).toBe(false);
    expect(r.message).toBe('No such construction site.');
    bob.c.send({ t: 'local:open', nationId: alice.you.nationId });
    expect((await bob.c.waitFor('error')).code).toBe('bad-message');
    alice.c.close();
    bob.c.close();
  });
});

describe('message hygiene', () => {
  it('rejects malformed, oversized and binary frames', async () => {
    const { port } = await setup();
    const c = await Client.connect(port);
    c.send('not json');
    expect((await c.waitFor('error')).code).toBe('bad-message');
    c.send({ t: 'build', kind: 'house', i: -1, j: 2, rot: 0 });
    expect((await c.waitFor('error')).code).toBe('bad-message');
    c.send({ t: 'build', kind: 'house', i: 1.5, j: 2, rot: 0 });
    expect((await c.waitFor('error')).code).toBe('bad-message');
    c.send({ t: 'build', kind: 'castle', i: 1, j: 2, rot: 0 });
    expect((await c.waitFor('error')).code).toBe('bad-message');
    c.ws.send(Buffer.from([1, 2, 3]), { binary: true });
    expect((await c.waitFor('error')).code).toBe('bad-message');
    // over the 2 KB frame limit: the server closes the socket
    const closed = new Promise<number>((r) => c.ws.once('close', (code) => r(code)));
    c.send({ t: 'join', name: 'x'.repeat(5000) });
    expect(await closed).toBe(1009);
  });

  it('rate-limits floods', async () => {
    const { port } = await setup();
    const c = await Client.connect(port);
    for (let i = 0; i < 40; i++) c.send({ t: 'ping' });
    await settle();
    expect(c.all('pong').length).toBeLessThanOrEqual(21);
    expect(c.all('error').some((e) => e.code === 'rate-limited')).toBe(true);
    c.close();
  });
});
