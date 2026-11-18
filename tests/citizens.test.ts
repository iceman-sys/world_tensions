import { describe, expect, it } from 'vitest';
import { DEMO_CONFIG, tickMs } from '../shared/config.ts';
import { generateEarthMeta } from '../shared/earth.ts';
import { foundNation } from '../shared/economy.ts';
import { deriveSeed, mulberry32 } from '../shared/rng.ts';
import { SIM } from '../shared/country/config.ts';
import { STARTER_TOWN, type Building } from '../shared/country/buildings.ts';
import { generateCitizens, updateCitizens, type Citizen } from '../shared/country/citizens.ts';
import { STARTER_SUMMARY, simulateCountryUntil, summarizeTown, taxPenalty, tickCountry, townStats, type CountryContext } from '../shared/country/sim.ts';
import { templateAnswer, type QuestionId } from '../shared/country/dialogue.ts';
import type { Nation } from '../shared/model.ts';
import { T0, openGame } from './helpers.ts';

const meta = generateEarthMeta(7, { samples: 3000 });
const CELL = 12;
const base = foundNation({ id: 1, playerId: 'p', meta: meta.countries[CELL], earthSeed: 7, now: T0, cfg: DEMO_CONFIG });
const town: Building[] = STARTER_TOWN.map((kind, k) => ({ id: k + 1, nationId: 1, kind, i: k * 8, j: 0, rot: 0, status: 'done', startedAt: T0, completesAt: T0 }));
const ctx: Omit<CountryContext, 'at'> = { cfg: DEMO_CONFIG, town: summarizeTown(town), basePopulation: meta.countries[CELL].population, resources: meta.countries[CELL].resources };
const tms = tickMs(DEMO_CONFIG);
const rngFor = (at: number) => mulberry32(deriveSeed(7, `cit:1:${at}`));
const citizens0 = generateCitizens(mulberry32(42), town, base, T0);

function run(n: Nation, ticks: number, cit: Citizen[] = citizens0) {
  return simulateCountryUntil({ nation: n, citizens: cit }, n.lastTickAt + ticks * tms, ctx, town, tms, rngFor);
}

describe('featured citizens', () => {
  it('are generated deterministically with complete profiles', () => {
    const again = generateCitizens(mulberry32(42), town, base, T0);
    expect(again).toEqual(citizens0);
    expect(citizens0).toHaveLength(SIM.featuredCount);
    for (const c of citizens0) {
      expect(c.name).toMatch(/^\S+ \S+$/);
      expect(c.traits).toHaveLength(3);
      expect(new Set(c.traits).size).toBe(3);
      expect(c.history.length).toBeGreaterThan(0);
      if (c.age < 18) expect(c.job).toBe('Student');
      if (c.age >= SIM.retireAge) expect(c.job).toBe('Retired');
    }
    expect(citizens0.some((c) => c.workplaceId !== null)).toBe(true);
    expect(citizens0.some((c) => c.homeId !== null)).toBe(true);
  });
});

describe('country simulation', () => {
  it('batched catch-up equals ticking one by one (economy and citizens)', () => {
    const batched = run(base, 300);
    let s = { nation: base, citizens: citizens0 };
    for (let i = 0; i < 300; i++) {
      const at = base.lastTickAt + (i + 1) * tms;
      const r = tickCountry(s, { ...ctx, at }, town, rngFor(at));
      s = { ...r.state, nation: { ...r.state.nation, lastTickAt: at } };
    }
    expect(batched.state).toEqual(s);
  });

  it('higher taxes lower satisfaction', () => {
    const low = run({ ...base, taxRate: 10 }, 200).state.nation.satisfaction;
    const mid = run({ ...base, taxRate: 30 }, 200).state.nation.satisfaction;
    const high = run({ ...base, taxRate: 55 }, 200).state.nation.satisfaction;
    expect(low).toBeGreaterThan(mid);
    expect(mid).toBeGreaterThan(high);
    expect(taxPenalty(60)).toBeGreaterThan(taxPenalty(40) * 2);
  });

  it('a food shortage lowers satisfaction by the documented penalty', () => {
    const noFarms = { ...ctx, town: summarizeTown(town.filter((b) => b.kind !== 'farm' && b.kind !== 'market')), resources: [] };
    const fed = townStats({ ...base, food: 100 }, noFarms);
    const starving = townStats({ ...base, food: 0 }, noFarms);
    expect(fed.shortage).toBe(false);
    expect(starving.shortage).toBe(true);
    expect(fed.target - starving.target).toBeCloseTo(SIM.shortagePenalty, 5);
    // and the shortage actually happens once the stores run out
    const r = simulateCountryUntil({ nation: { ...base, food: 5 }, citizens: [] }, base.lastTickAt + 50 * tms, noFarms, [], tms, rngFor);
    expect(r.state.nation.stats?.shortage).toBe(true);
    expect(r.events.some((e) => e.event.kind === 'shortage' && e.event.on)).toBe(true);
  });

  it('the starter town gives a reasonable, stable country', () => {
    const s = townStats(base, ctx);
    expect(s.housing).toBeCloseTo(SIM.starterHousingCover, 1);
    expect(s.employment).toBeCloseTo(SIM.starterJobsCover, 1);
    expect(s.target).toBeGreaterThan(50);
    expect(STARTER_SUMMARY.housing).toBeGreaterThan(0);
  });

  it('sends each satisfaction warning once and overthrows after exactly overthrowTicks at or below 20%', () => {
    const angry: Nation = { ...base, taxRate: 60, satisfaction: 45 };
    const r = run(angry, 2000, []);
    const warnings = r.events.filter((e) => e.event.kind === 'warning').map((e) => (e.event.kind === 'warning' ? e.event.stage : 0));
    expect(warnings).toEqual([40, 30, 25]);
    expect(r.overthrownAt).not.toBeNull();
    // the overthrow tick is exactly overthrowTicks after satisfaction first reached the threshold
    let s = { nation: angry, citizens: [] as Citizen[] };
    let firstLow = -1;
    let k = 0;
    for (;;) {
      k++;
      const at = angry.lastTickAt + k * tms;
      const step = tickCountry(s, { ...ctx, at }, town, rngFor(at));
      s = { ...step.state, nation: { ...step.state.nation, lastTickAt: at } };
      if (firstLow < 0 && s.nation.satisfaction <= SIM.overthrowAt) firstLow = k;
      if (step.events.some((e) => e.kind === 'overthrow')) break;
      if (k > 5000) throw new Error('no overthrow');
    }
    expect(k - firstLow + 1).toBe(SIM.overthrowTicks);
    expect(r.overthrownAt).toBe(angry.lastTickAt + k * tms);
  });
});

describe('protest and migration thresholds', () => {
  const stats = townStats(base, ctx);
  const one = (h: number): Citizen => ({ ...citizens0[5], happiness: h, lowTicks: 0, status: 'content', traits: ['curious', 'generous', 'independent'], job: 'Farmer', workplaceId: town[7].id, homeId: town[2].id });

  it('complain < 45, protest < 35, plan to move after 6 ticks < 25, leave after 48', () => {
    // a miserable country keeps everyone's target near zero
    const miserable: Nation = { ...base, satisfaction: 0 };
    const step = (c: Citizen, k: number) =>
      updateCitizens([c], { nation: miserable, stats, prevTaxRate: miserable.taxRate, buildings: town, at: T0 + k, hours: 5 / 60, rng: mulberry32(k) });
    const status = (h: number) => step(one(h), 1).citizens[0]?.status;
    // happiness only eases a little per tick, so these reflect the starting value
    expect(status(60)).toBe('content');
    expect(status(44.9)).toBe('complaining');
    expect(status(34.9)).toBe('protesting');
    let c = one(10);
    const seen: string[] = [];
    let leftAt = -1;
    for (let k = 1; k <= 60; k++) {
      const r = step(c, k);
      if (r.events.some((e) => e.kind === 'left')) {
        leftAt = k;
        break;
      }
      c = r.citizens[0];
      seen.push(c.status);
    }
    expect(seen.indexOf('planning to move') + 1).toBe(SIM.migratePlanTicks);
    expect(leftAt).toBe(SIM.migrateLeaveTicks);
  });
});

describe('preset dialogue', () => {
  const n: Nation = { ...base, taxRate: 47 };
  const stats = townStats(n, ctx);
  const ask = (c: Citizen, q: QuestionId, s = stats) => templateAnswer({ citizen: c, question: q, nation: n, stats: s, countryName: 'Testland', buildingLabel: () => 'farm' });

  it('quotes the real tax rate and take-home pay', () => {
    const worker = { ...citizens0[0], job: 'Farmer', income: 1166 };
    const a = ask(worker, 'taxes');
    expect(a).toContain('47%');
    expect(a).toContain('$1,166');
  });

  it('reports food truthfully', () => {
    expect(ask(citizens0[0], 'food', { ...stats, shortage: true })).toMatch(/run out of food/);
    expect(ask(citizens0[0], 'food', { ...stats, shortage: false, foodBalance: 5 })).toMatch(/enough/);
    expect(ask(citizens0[0], 'food', { ...stats, shortage: false, foodBalance: -2 })).toMatch(/shrinking/);
  });

  it('job answers use the real employment rate', () => {
    const jobless = { ...citizens0[0], job: 'Unemployed', workplaceId: null };
    expect(ask(jobless, 'job', { ...stats, employment: 0.62 })).toContain('62%');
  });

  it('is deterministic and never empty', () => {
    for (const q of ['feeling', 'food', 'taxes', 'job', 'moving', 'home', 'safety'] as QuestionId[]) {
      const a = ask(citizens0[3], q);
      expect(a.length).toBeGreaterThan(10);
      expect(ask(citizens0[3], q)).toBe(a);
    }
  });
});

describe('citizens on the server', () => {
  it('are created with the starter town, answer only their own governor, and justice is audited', async () => {
    const { game, repo } = await openGame({});
    const alice = await game.join('Alice');
    const bob = await game.join('Bob');
    if (!alice.ok || !bob.ok) throw new Error('join failed');
    const list = game.world.citizens.get(alice.nation.id) ?? [];
    expect(list).toHaveLength(SIM.featuredCount);
    const answer = await game.askCitizen(alice.player.id, list[0].id, 'taxes');
    expect(answer).toContain(`${alice.nation.taxRate}%`);
    // citizen ids are scoped to the asker's own nation: Bob's id 1 is Bob's citizen, never Alice's,
    // and an id that does not exist in his nation answers like a missing citizen
    const bobsFirst = (game.world.citizens.get(bob.nation.id) ?? [])[0];
    const bobAnswer = await game.askCitizen(bob.player.id, bobsFirst.id, 'home');
    expect(bobAnswer).not.toBeNull();
    expect(await game.askCitizen(bob.player.id, 9999, 'feeling')).toBeNull();

    // detain someone (as the simulation would under hardship), then release and exile
    const detained = list.map((c, k) => (k < 2 ? { ...c, suspect: { reason: 'took food from the market stalls during the shortage', since: T0 } } : c));
    game.world.citizens.set(alice.nation.id, detained);
    const satBefore = game.world.nations.get(alice.nation.id)?.satisfaction ?? 0;
    expect((await game.judgeCitizen(alice.player.id, detained[0].id, 'release')).ok).toBe(true);
    expect((await game.judgeCitizen(bob.player.id, detained[1].id, 'exile')).ok).toBe(false);
    expect((await game.judgeCitizen(alice.player.id, detained[1].id, 'exile')).ok).toBe(true);
    const after = game.world.citizens.get(alice.nation.id) ?? [];
    expect(after.find((c) => c.id === detained[0].id)?.suspect).toBeNull();
    expect(after.some((c) => c.id === detained[1].id)).toBe(false);
    expect(game.world.nations.get(alice.nation.id)?.satisfaction).toBeCloseTo(satBefore + 0.5 - 1.5, 5);
    const audit = await repo.audit(30, alice.nation.id);
    expect(audit.filter((e) => e.action.startsWith('citizen-')).map((e) => e.actorName)).toEqual(['Alice', 'Alice']);
    expect((game.world.news.get(alice.nation.id) ?? []).map((x) => x.text).join(' | ')).toMatch(/released .* \| .*exiled/);
    await repo.close();
  });
});
