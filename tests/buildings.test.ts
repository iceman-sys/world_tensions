import { afterEach, describe, expect, it } from 'vitest';
import { DEMO_CONFIG, NORMAL_CONFIG, gameHoursToMs } from '../shared/config.ts';
import { BUILDINGS, constructionMs, footprint, planStarterTown, progressOf, validatePlacement, type PlacementTerrain } from '../shared/country/buildings.ts';
import { MASK, WATER } from '../shared/country/config.ts';
import { generateEarthMeta } from '../shared/earth.ts';
import { generateLocalTerrain, terrainInputFor } from '../shared/country/terrain.ts';
import { UPRISING_THRESHOLD } from '../server/src/game.ts';
import { FakeClock, openGame, tempDbFile } from './helpers.ts';

/** 20x20 flat own land with a channel column, a lake tile and a steep corner. */
function synthetic(): PlacementTerrain {
  const n = 20;
  const mask = new Uint8Array(n * n);
  const water = new Uint8Array(n * n);
  const heights = new Float32Array(n * n).fill(1);
  for (let j = 0; j < n; j++) {
    mask[j * n + 0] = MASK.channel; // column 0 is not own land
    water[j * n + 0] = WATER.sea;
  }
  water[10 * n + 10] = WATER.lake;
  for (let j = 15; j < 20; j++) for (let i = 15; i < 20; i++) heights[j * n + i] = 1 + (i - 15) * 2.5; // steep
  return { size: n, mask, water, heights };
}

describe('placement validation', () => {
  const t = synthetic();
  const rich = 1e12;

  it('accepts a valid spot', () => {
    expect(validatePlacement(t, [], 'house', 3, 3, 0, rich)).toEqual({ ok: true });
  });
  it('rejects land outside the territory', () => {
    expect(validatePlacement(t, [], 'house', 0, 3, 0, rich)).toEqual({ ok: false, reason: 'territory' });
  });
  it('rejects water', () => {
    expect(validatePlacement(t, [], 'house', 9, 9, 0, rich)).toEqual({ ok: false, reason: 'water' });
  });
  it('rejects steep ground', () => {
    expect(validatePlacement(t, [], 'house', 16, 16, 0, rich)).toEqual({ ok: false, reason: 'slope' });
  });
  it('rejects overlaps, including the one-tile street around buildings', () => {
    const existing = [{ kind: 'house' as const, i: 3, j: 3, rot: 0 as const }];
    expect(validatePlacement(t, existing, 'house', 4, 4, 0, rich)).toEqual({ ok: false, reason: 'overlap' });
    expect(validatePlacement(t, existing, 'house', 5, 3, 0, rich)).toEqual({ ok: false, reason: 'overlap' });
    expect(validatePlacement(t, existing, 'house', 6, 3, 0, rich)).toEqual({ ok: true });
  });
  it('rejects insufficient funds and a locked (uprising) country', () => {
    expect(validatePlacement(t, [], 'clinic', 3, 3, 0, BUILDINGS.clinic.cost - 1)).toEqual({ ok: false, reason: 'funds' });
    expect(validatePlacement(t, [], 'house', 3, 3, 0, rich, { locked: true })).toEqual({ ok: false, reason: 'locked' });
  });
  it('rejects out-of-bounds, unknown and non-buildable kinds', () => {
    expect(validatePlacement(t, [], 'house', 19, 3, 0, rich)).toEqual({ ok: false, reason: 'bounds' });
    expect(validatePlacement(t, [], 'castle', 3, 3, 0, rich)).toEqual({ ok: false, reason: 'unknown-kind' });
    expect(validatePlacement(t, [], 'townhall', 3, 3, 0, rich)).toEqual({ ok: false, reason: 'not-buildable' });
  });
  it('rotation swaps the footprint', () => {
    expect(footprint('farm', 0)).toEqual([6, 5]);
    expect(footprint('farm', 1)).toEqual([5, 6]);
  });
});

describe('construction timers', () => {
  it('scale with game time and the demo construction factor', () => {
    const normal = constructionMs('school', gameHoursToMs(NORMAL_CONFIG, 1), NORMAL_CONFIG.constructionFactor);
    expect(normal).toBe(24 * 3_600_000);
    const demo = constructionMs('school', gameHoursToMs(DEMO_CONFIG, 1), DEMO_CONFIG.constructionFactor);
    expect(demo).toBe(72_000); // 24 game h * 0.05 = 1.2 game h = 72 real s in demo mode
  });
  it('report progress', () => {
    const b = { status: 'building' as const, startedAt: 1000, completesAt: 2000 };
    expect(progressOf(b, 1500)).toBe(0.5);
    expect(progressOf(b, 3000)).toBe(1);
    expect(progressOf({ ...b, status: 'done' }, 0)).toBe(1);
  });
});

describe('starter town', () => {
  it('is a valid, deterministic layout around the capital', () => {
    const meta = generateEarthMeta(0x1234abcd, { samples: 6000 });
    const t = generateLocalTerrain(terrainInputFor(meta, 30, [30], meta.countries[30].resources, 128));
    const town = planStarterTown(t, t.capital);
    expect(town.map((b) => b.kind)).toEqual(expect.arrayContaining(['townhall', 'market', 'farm', 'house', 'park']));
    expect(planStarterTown(t, t.capital)).toEqual(town);
    // every building is valid with respect to all the others
    town.forEach((b, idx) => {
      const others = town.filter((_, k) => k !== idx);
      expect(validatePlacement(t, others, b.kind, b.i, b.j, b.rot, Infinity, { allowUnbuildable: true })).toEqual({ ok: true });
    });
  });
});

const cleanups: (() => void)[] = [];
afterEach(() => {
  while (cleanups.length) cleanups.pop()?.();
});

/** First valid spot for a kind on the nation's terrain. */
function findSpot(game: Awaited<ReturnType<typeof openGame>>['game'], nationId: number, kind: 'house' | 'school') {
  const t = game.terrainOf(nationId);
  if (!t) throw new Error('no terrain');
  const existing = game.world.buildingsOf(nationId);
  for (let j = 0; j < t.size; j++) {
    for (let i = 0; i < t.size; i++) {
      if (validatePlacement(t, existing, kind, i, j, 0, Infinity).ok) return { i, j, t };
    }
  }
  throw new Error('no spot');
}

describe('server-side building', () => {
  it('founds a starter town and builds, completes and persists constructions', async () => {
    const t = tempDbFile();
    cleanups.push(t.cleanup);
    const clock = new FakeClock();
    const a = await openGame({ file: t.file, clock });
    const r = await a.game.join('Alice');
    if (!r.ok) throw new Error('join failed');
    const starter = a.game.world.buildingsOf(r.nation.id);
    expect(starter.length).toBeGreaterThanOrEqual(6);
    expect(starter.every((b) => b.status === 'done')).toBe(true);

    const fundsBefore = a.game.world.nations.get(r.nation.id)?.funds ?? 0;
    const spot = findSpot(a.game, r.nation.id, 'school');
    const built = await a.game.build(r.player.id, 'school', spot.i, spot.j, 0);
    expect(built.ok).toBe(true);
    if (!built.ok) return;
    expect(a.game.world.nations.get(r.nation.id)?.funds).toBe(fundsBefore - BUILDINGS.school.cost);
    expect(built.building.status).toBe('building');

    // the same spot is now taken
    const again = await a.game.build(r.player.id, 'school', spot.i, spot.j, 0);
    expect(again).toMatchObject({ ok: false, reason: 'overlap' });

    // completes after its (demo) construction time
    clock.advance(constructionMs('school', gameHoursToMs(DEMO_CONFIG, 1), DEMO_CONFIG.constructionFactor) - 1000);
    await a.game.tick();
    expect(a.game.world.buildings.get(built.building.id)?.status).toBe('building');
    clock.advance(2000);
    await a.game.tick();
    expect(a.game.world.buildings.get(built.building.id)?.status).toBe('done');

    // audit has the governor's name
    const audit = await a.repo.audit(50, r.nation.id);
    expect(audit.find((e) => e.action === 'build')?.actorName).toBe('Alice');

    // persisted across a restart
    await a.repo.close();
    const b = await openGame({ file: t.file, clock });
    expect(b.game.world.buildingsOf(r.nation.id).length).toBe(starter.length + 1);
    expect(b.game.world.buildings.get(built.building.id)?.status).toBe('done');
    await b.repo.close();
  });

  it('cancels with a partial refund, never touches other nations, and refuses when broke or in uprising', async () => {
    const { game, repo } = await openGame({});
    const alice = await game.join('Alice');
    const bob = await game.join('Bob');
    if (!alice.ok || !bob.ok) throw new Error('join failed');
    const spot = findSpot(game, alice.nation.id, 'house');
    const b = await game.build(alice.player.id, 'house', spot.i, spot.j, 0);
    if (!b.ok) throw new Error('build failed');

    // Bob cannot cancel Alice's construction: it looks like it does not exist
    expect(await game.cancelBuild(bob.player.id, b.building.id)).toMatchObject({ ok: false, reason: 'not-found' });

    const funds = game.world.nations.get(alice.nation.id)?.funds ?? 0;
    const c = await game.cancelBuild(alice.player.id, b.building.id);
    expect(c.ok).toBe(true);
    expect(game.world.nations.get(alice.nation.id)?.funds).toBe(funds + Math.round(BUILDINGS.house.cost * 0.75));
    expect(game.world.buildings.has(b.building.id)).toBe(false);

    // broke
    const n = game.world.nations.get(alice.nation.id);
    if (!n) throw new Error('missing');
    game.world.nations.set(n.id, { ...n, funds: 10 });
    expect(await game.build(alice.player.id, 'house', spot.i, spot.j, 0)).toMatchObject({ ok: false, reason: 'funds' });
    // uprising lock
    game.world.nations.set(n.id, { ...n, satisfaction: UPRISING_THRESHOLD });
    expect(await game.build(alice.player.id, 'house', spot.i, spot.j, 0)).toMatchObject({ ok: false, reason: 'locked' });
    await repo.close();
  });
});
