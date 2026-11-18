import { afterEach, describe, expect, it } from 'vitest';
import { DEMO_CONFIG, configFromEnv, inactivityMs, tickMs } from '../shared/config.ts';
import { foundNation, simulateUntil, tickNation } from '../shared/economy.ts';
import { generateEarthMeta } from '../shared/earth.ts';
import { chooseHeir } from '../shared/inactivity.ts';
import { mulberry32 } from '../shared/rng.ts';
import { EarthState } from '../server/src/state.ts';
import { SqliteRepository } from '../server/src/db/sqlite.ts';
import { FakeClock, T0, openGame, tempDbFile } from './helpers.ts';

const cleanups: (() => void)[] = [];
afterEach(() => {
  while (cleanups.length) cleanups.pop()?.();
});

function tmp(): string {
  const t = tempDbFile();
  cleanups.push(t.cleanup);
  return t.file;
}

describe('config', () => {
  it('DEMO_MODE makes 1 real second one game minute', () => {
    const { config } = configFromEnv({ DEMO_MODE: 'true' }, true);
    expect(config.timeScale).toBe(60);
    expect(tickMs(config)).toBe(5_000); // 5 game minutes
    expect(inactivityMs(config)).toBe(72 * 60 * 1000); // 72 game hours = 72 real minutes
  });

  it('defaults to real time in production and accepts overrides', () => {
    const { config } = configFromEnv({ INACTIVITY_GAME_HOURS: '1' }, true);
    expect(config.demoMode).toBe(false);
    expect(inactivityMs(config)).toBe(3_600_000);
  });

  it('rejects invalid values with a warning', () => {
    const { config, warnings } = configFromEnv({ TICK_GAME_MINUTES: 'banana' }, false);
    expect(config.tickGameMinutes).toBe(DEMO_CONFIG.tickGameMinutes);
    expect(warnings).toHaveLength(1);
  });
});

describe('server restart keeps state', () => {
  it('restores governors, sessions, countries and territory from SQLite', async () => {
    const file = tmp();
    const clock = new FakeClock();
    const a = await openGame({ file, clock });
    const alice = await a.game.join('Alice');
    const bob = await a.game.join('Bob');
    if (!alice.ok || !bob.ok || !alice.token) throw new Error('join failed');
    await a.game.attach(alice.player.id);
    clock.advance(tickMs(DEMO_CONFIG) * 3);
    await a.game.tick();
    const before = a.game.world.nations.get(alice.nation.id);
    await a.repo.close();

    const b = await openGame({ file, clock });
    const resumed = b.game.playerByToken(alice.token);
    expect(resumed?.name).toBe('Alice');
    expect(b.game.world.nations.get(alice.nation.id)).toEqual(before);
    expect(b.game.countryState(alice.nation.homeCell)).toMatchObject({ owner: 'Alice', nationId: alice.nation.id, online: false });
    expect(b.game.countryState(bob.nation.homeCell).owner).toBe('Bob');
    expect(b.game.seed).toBe(a.game.seed);
    expect(b.game.neighbors).toEqual(a.game.neighbors);
    await b.repo.close();
  });

  it('never stores raw session tokens', async () => {
    const { game, repo } = await openGame({});
    const r = await game.join('Alice');
    if (!r.ok || !r.token) throw new Error('join failed');
    for (const hash of game.world.sessions.keys()) expect(hash).not.toContain(r.token);
    expect(game.playerByToken('not-the-token-at-all')).toBeNull();
    await repo.close();
  });

  it('commits change sets atomically (all or nothing)', async () => {
    const repo = new SqliteRepository(':memory:');
    const meta = generateEarthMeta(1, { samples: 2000 });
    const nation = foundNation({ id: 1, playerId: 'ghost', meta: meta.countries[0], earthSeed: 1, now: T0, cfg: DEMO_CONFIG });
    // the nation references a player that does not exist: the foreign key fails,
    // so the meta write in the same change set must be rolled back too
    await expect(repo.commit({ meta: { marker: 'x' }, nations: [nation] })).rejects.toThrow();
    const snap = await repo.load();
    expect(snap.meta.has('marker')).toBe(false);
    expect(snap.nations).toHaveLength(0);
    await repo.close();
  });

  it('imports governors from the old state.json once', async () => {
    const legacy = new EarthState(0x1234abcd, () => 0);
    const r = legacy.join('Legacy');
    if (!r.ok) throw new Error('join failed');
    const { game, repo } = await openGame({ legacy: legacy.toJSON() });
    expect(game.playerByToken(r.player.token)?.name).toBe('Legacy');
    expect(game.countryState(r.player.countryId).owner).toBe('Legacy');
    await repo.close();
  });
});

describe('offline catch-up', () => {
  const meta = generateEarthMeta(5, { samples: 2000 });
  const base = foundNation({ id: 1, playerId: 'p', meta: meta.countries[3], earthSeed: 5, now: T0, cfg: DEMO_CONFIG });
  const ctx = { cfg: DEMO_CONFIG, capacity: meta.countries[3].population * 1.3 };
  const tms = tickMs(DEMO_CONFIG);

  it('one batched simulation equals ticking one by one', () => {
    let stepwise = base;
    for (let i = 0; i < 500; i++) stepwise = tickNation(stepwise, ctx).nation;
    const batched = simulateUntil(base, T0 + 500 * tms + tms / 2, ctx, tms);
    expect(batched.ticks).toBe(500);
    expect(batched.nation).toEqual({ ...stepwise, lastTickAt: T0 + 500 * tms });
  });

  it('is capped by maxCatchUpTicks', () => {
    const r = simulateUntil(base, T0 + 10 * tms, { ...ctx, cfg: { ...DEMO_CONFIG, maxCatchUpTicks: 3 } }, tms);
    expect(r.ticks).toBe(3);
    expect(r.nation.lastTickAt).toBe(T0 + 10 * tms);
  });

  it('offline nations are not ticked live, then caught up on return with a summary', async () => {
    const { game, repo, clock } = await openGame({});
    const r = await game.join('Alice');
    if (!r.ok) throw new Error('join failed');
    await game.attach(r.player.id);
    await game.detach(r.player.id);
    const left = game.world.nations.get(r.nation.id);
    clock.advance(tms * 7); // fewer than sweepEveryTicks: no sweep yet
    await game.tick();
    expect(game.world.nations.get(r.nation.id)).toEqual(left);

    const summary = await game.attach(r.player.id);
    expect(summary?.ticks).toBe(7);
    const now = game.world.nations.get(r.nation.id);
    expect(now?.funds).toBeGreaterThan(left?.funds ?? Infinity);
    expect(summary?.funds).toEqual([left?.funds, now?.funds]);
    // same result as ticking 7 times
    let expected = left;
    if (!expected) throw new Error('missing');
    for (let i = 0; i < 7; i++) expected = tickNation(expected, { cfg: DEMO_CONFIG, capacity: game.meta.countries[r.nation.homeCell].population * 1.3 }).nation;
    expect(now?.funds).toBe(expected.funds);
    expect(now?.population).toBe(expected.population);
    await repo.close();
  });

  it('a server restart counts as being away for connected governors', async () => {
    const file = tmp();
    const clock = new FakeClock();
    const a = await openGame({ file, clock });
    const r = await a.game.join('Alice');
    if (!r.ok || !r.token) throw new Error('join failed');
    await a.game.attach(r.player.id);
    // hard stop: no detach, no shutdown hook
    await a.repo.close();
    clock.advance(tms * 20);
    const b = await openGame({ file, clock });
    const p = b.game.playerByToken(r.token);
    if (!p) throw new Error('session lost');
    const summary = await b.game.attach(p.id);
    expect(summary?.ticks).toBe(20);
    await b.repo.close();
  });
});

describe('inactivity rule', () => {
  it('shows a countdown, then gives the assets to a random active country', async () => {
    const { game, repo, clock } = await openGame({});
    const alice = await game.join('Alice');
    const bob = await game.join('Bob');
    if (!alice.ok || !bob.ok) throw new Error('join failed');
    await game.attach(bob.player.id); // Bob stays online
    await game.attach(alice.player.id);
    await game.detach(alice.player.id);
    const deadline = clock.t + inactivityMs(DEMO_CONFIG);
    expect(game.countryState(alice.nation.homeCell).lostAt).toBe(deadline);
    expect(game.countryState(bob.nation.homeCell).lostAt).toBeNull();

    clock.advance(inactivityMs(DEMO_CONFIG) - 1000);
    await game.tick();
    expect(game.world.nations.has(alice.nation.id)).toBe(true);

    const aliceFunds = simulateUntil(
      game.world.nations.get(alice.nation.id) ?? alice.nation,
      deadline,
      { cfg: DEMO_CONFIG, capacity: game.meta.countries[alice.nation.homeCell].population * 1.3 },
      tickMs(DEMO_CONFIG),
    ).nation.funds;
    const bobBefore = game.world.nations.get(bob.nation.id)?.funds ?? 0;
    clock.advance(2000);
    await game.tick();
    expect(game.world.nations.has(alice.nation.id)).toBe(false);
    expect(game.countryState(alice.nation.homeCell).owner).toBeNull();
    // Bob (the only active country) inherited Alice's treasury on top of his own income
    expect((game.world.nations.get(bob.nation.id)?.funds ?? 0) - bobBefore).toBeGreaterThanOrEqual(aliceFunds);
    const p = game.world.players.get(alice.player.id);
    expect(p?.lostReason).toBe('inactivity');
    expect(game.world.log.at(-1)?.kind).toBe('inactivity');

    // Alice comes back: summary says the country was lost, and she can found a new one
    const summary = await game.attach(alice.player.id);
    expect(summary?.lost).toBe('inactivity');
    const again = await game.join('Alice', { existing: p });
    expect(again.ok).toBe(true);
    await repo.close();
  });

  it('bots and connected governors never expire', async () => {
    const { game, repo, clock } = await openGame({});
    const bot = await game.join('Botty', { bot: true });
    const online = await game.join('Online');
    if (!bot.ok || !online.ok) throw new Error('join failed');
    await game.attach(online.player.id);
    clock.advance(inactivityMs(DEMO_CONFIG) * 2);
    await game.tick();
    expect(game.world.nations.size).toBe(2);
    await repo.close();
  });

  it('heir choice depends only on the injected RNG', () => {
    expect(chooseHeir([5, 2, 9], mulberry32(3))).toBe(chooseHeir([9, 5, 2], mulberry32(3)));
    expect(chooseHeir([], mulberry32(3))).toBeNull();
  });
});
