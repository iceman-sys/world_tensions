/**
 * Country simulation: aggregates from the town's buildings drive satisfaction,
 * food, upkeep and migration; featured citizens follow. Pure and deterministic
 * (time and RNG are injected), so batched catch-up equals ticking one by one.
 */
import type { GameConfig } from '../config.ts';
import { pushCapped, tickHours, tickNation } from '../economy.ts';
import type { Nation, Services, TownStats } from '../model.ts';
import type { Rng } from '../rng.ts';
import { BUILDINGS, STARTER_TOWN, type Building, type BuildingKind } from './buildings.ts';
import { updateCitizens, type Citizen, type CitizenEvent } from './citizens.ts';
import { SIM } from './config.ts';

export interface TownSummary {
  housing: number;
  jobs: number;
  food: number;
  safety: number;
  education: number;
  health: number;
  leisure: number;
  satisfaction: number;
  /** upkeep per game hour, by service so switched-off services cost nothing */
  upkeep: { base: number; health: number; education: number; police: number };
  counts: Partial<Record<BuildingKind, number>>;
}

function summarize(kinds: readonly BuildingKind[]): TownSummary {
  const s: TownSummary = { housing: 0, jobs: 0, food: 0, safety: 0, education: 0, health: 0, leisure: 0, satisfaction: 0, upkeep: { base: 0, health: 0, education: 0, police: 0 }, counts: {} };
  for (const k of kinds) {
    const b = BUILDINGS[k];
    s.housing += b.housing;
    s.jobs += b.jobs;
    s.food += b.food;
    s.safety += b.safety;
    s.education += b.education;
    s.health += b.health;
    s.leisure += b.leisure;
    s.satisfaction += b.satisfaction;
    if (k === 'clinic') s.upkeep.health += b.upkeepPerHour;
    else if (k === 'school') s.upkeep.education += b.upkeepPerHour;
    else if (k === 'police') s.upkeep.police += b.upkeepPerHour;
    else s.upkeep.base += b.upkeepPerHour;
    s.counts[k] = (s.counts[k] ?? 0) + 1;
  }
  return s;
}

/** The starter town: the reference that capacities are scaled against. */
export const STARTER_SUMMARY = summarize(STARTER_TOWN);

/** Sums the finished buildings. A nation without any (bots, older saves) counts as a starter town. */
export function summarizeTown(buildings: readonly Pick<Building, 'kind' | 'status'>[]): TownSummary {
  const done = buildings.filter((b) => b.status === 'done').map((b) => b.kind);
  return done.length ? summarize(done) : STARTER_SUMMARY;
}

/** Food natural resources feed people directly. */
export const FOOD_RESOURCES = ['Grain', 'Rice', 'Fish', 'Livestock', 'Cocoa', 'Coffee'];

export interface CountryContext {
  cfg: GameConfig;
  town: TownSummary;
  /** the country's founding population (scales building capacities) */
  basePopulation: number;
  /** natural resources the country produces */
  resources: readonly string[];
  /** epoch ms of the tick being simulated */
  at: number;
}

/** Policy announcements: preset messages with a short documented effect. */
export const ANNOUNCEMENTS: Record<string, { text: string; satisfaction: number; hours: number }> = {
  thanks: { text: 'The government thanks every citizen for their hard work.', satisfaction: 2, hours: 6 },
  'tax-review': { text: 'The government will review taxes next season.', satisfaction: 3, hours: 6 },
  'food-plan': { text: 'New farms are planned to keep the market stocked.', satisfaction: 2, hours: 8 },
  'safe-streets': { text: 'More patrols will keep neighbourhoods safe.', satisfaction: 2, hours: 8 },
};

const clamp = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, v));

/** Aggregates for the current state (no time passes). */
export function townStats(n: Nation, ctx: Pick<CountryContext, 'town' | 'basePopulation' | 'resources'>, services: Services = n.services): TownStats {
  const t = ctx.town;
  const base = Math.max(1, ctx.basePopulation);
  const popRatio = Math.max(0.01, n.population / base);
  const housingCapacity = (t.housing / STARTER_SUMMARY.housing) * SIM.starterHousingCover * base;
  const workforce = n.population * SIM.workforceShare;
  const jobs = (t.jobs / STARTER_SUMMARY.jobs) * SIM.starterJobsCover * base * SIM.workforceShare;
  const employment = workforce > 0 ? clamp(jobs / workforce, 0, 1) : 1;
  const foodRes = ctx.resources.filter((r) => FOOD_RESOURCES.includes(r)).length;
  const foodProduction = t.food + foodRes * SIM.naturalFood;
  const foodBalance = foodProduction - SIM.foodDemand * popRatio;
  const cover = (amount: number, need: number) => clamp(amount / (need * popRatio), 0, 1);
  const safety = clamp(SIM.baseSafety + (services.police ? cover(t.safety, SIM.need.safety) * (1 - SIM.baseSafety) : 0), 0, 1);
  const education = services.education ? cover(t.education, SIM.need.education) : 0;
  const health = services.health ? cover(t.health, SIM.need.health) : 0;
  const leisure = cover(t.leisure, SIM.need.leisure);
  const upkeep = t.upkeep.base + (services.health ? t.upkeep.health : 0) + (services.education ? t.upkeep.education : 0) + (services.police ? t.upkeep.police : 0);
  const stats: TownStats = {
    housingCapacity,
    housing: housingCapacity / Math.max(1, n.population),
    workforce,
    jobs,
    employment,
    foodBalance,
    shortage: n.food <= 0 && foodBalance < 0,
    safety,
    education,
    health,
    leisure,
    target: 0,
    upkeep,
    taxRate: n.taxRate,
  };
  stats.target = satisfactionTarget(n, stats, t, 0);
  return stats;
}

/** Tax penalty (points): linear above the neutral rate, steeper above the harsh rate. */
export function taxPenalty(rate: number): number {
  return (rate - SIM.taxNeutral) * SIM.taxSlope + Math.pow(Math.max(0, rate - SIM.taxHarsh), 1.5) * SIM.taxHarshSlope;
}

/** The satisfaction level the country moves towards (documented in docs/COUNTRY_VIEW.md). */
export function satisfactionTarget(n: Nation, s: TownStats, t: TownSummary, at: number): number {
  let v = SIM.baseSatisfaction;
  v -= taxPenalty(n.taxRate);
  v += clamp((s.housing - 1) * SIM.housingWeight, -20, 3);
  v += clamp((s.employment - SIM.jobsNormal) * SIM.jobsWeight, -20, 4);
  v += s.shortage ? -SIM.shortagePenalty : s.foodBalance > 0 ? SIM.surplusBonus : 0;
  v += (s.safety - 0.5) * SIM.safetyWeight;
  v += s.education * SIM.serviceWeights.education + s.health * SIM.serviceWeights.health + s.leisure * SIM.serviceWeights.leisure;
  v += Math.min(SIM.buildingBonusCap, t.satisfaction);
  if (n.announcement && n.announcement.until > at) v += ANNOUNCEMENTS[n.announcement.id]?.satisfaction ?? 0;
  return clamp(v, 0, 100);
}

export type CountryEvent =
  | { kind: 'warning'; stage: number; satisfaction: number }
  | { kind: 'overthrow' }
  | { kind: 'shortage'; on: boolean }
  | { kind: 'citizen'; event: CitizenEvent };

export interface CountryState {
  nation: Nation;
  citizens: Citizen[];
}

/** One tick of the whole country: economy, town aggregates, satisfaction, citizens. */
export function tickCountry(state: CountryState, ctx: CountryContext, buildings: readonly Building[], rng: Rng): { state: CountryState; events: CountryEvent[] } {
  // policy changes accepted since the last tick take effect now
  const p = state.nation.pending;
  const n0: Nation = p ? { ...state.nation, taxRate: p.taxRate ?? state.nation.taxRate, services: p.services ?? state.nation.services, pending: null } : state.nation;
  const h = tickHours(ctx.cfg);
  const events: CountryEvent[] = [];
  const before = townStats(n0, ctx);

  // economy core (taxes, production, logistic growth towards housing capacity)
  const eco = tickNation(n0, { cfg: ctx.cfg, capacity: before.housingCapacity }).nation;
  // taxes are paid by people with jobs; unemployment halves the yield
  const income = (eco.funds - n0.funds) * (0.5 + 0.5 * before.employment);
  let funds = Math.round(n0.funds + income - before.upkeep * h);
  let population = eco.population;
  if (n0.satisfaction < SIM.migrationBelow) {
    population = Math.max(0, population - Math.round(population * SIM.migrationRate * h * ((SIM.migrationBelow - n0.satisfaction) / SIM.migrationBelow)));
  }
  const food = Math.max(0, n0.food + before.foodBalance * h);
  let n: Nation = { ...eco, funds, population, food };
  const stats = townStats(n, ctx);
  stats.target = satisfactionTarget(n, stats, ctx.town, ctx.at);
  if (stats.shortage !== (n0.stats?.shortage ?? false)) events.push({ kind: 'shortage', on: stats.shortage });

  // satisfaction eases towards its target
  const satisfaction = clamp(n0.satisfaction + (stats.target - n0.satisfaction) * Math.min(1, SIM.satisfactionRate * h), 0, 100);
  let warnStage = n0.warnStage;
  SIM.warningStages.forEach((level, idx) => {
    if (satisfaction <= level && warnStage < idx + 1) {
      warnStage = idx + 1;
      events.push({ kind: 'warning', stage: level, satisfaction });
    }
  });
  if (satisfaction > SIM.warningStages[0] + 5) warnStage = 0; // recovered: warnings can fire again later
  const lowSatTicks = satisfaction <= SIM.overthrowAt ? n0.lowSatTicks + 1 : 0;
  if (lowSatTicks >= SIM.overthrowTicks) events.push({ kind: 'overthrow' });
  if (n.announcement && n.announcement.until <= ctx.at) n = { ...n, announcement: null };
  funds = n.funds;

  n = {
    ...n,
    funds,
    satisfaction,
    warnStage,
    lowSatTicks,
    stats,
    history: {
      ...n.history,
      satisfaction: pushCapped(n0.history.satisfaction, satisfaction),
      employment: pushCapped(n0.history.employment ?? [], Math.round(stats.employment * 1000) / 10),
    },
  };

  const cit = state.citizens.length
    ? updateCitizens(state.citizens, { nation: n, stats, prevTaxRate: n0.stats?.taxRate ?? n0.taxRate, buildings, at: ctx.at, hours: h, rng })
    : { citizens: state.citizens, events: [] };
  for (const e of cit.events) events.push({ kind: 'citizen', event: e });
  return { state: { nation: n, citizens: cit.citizens }, events };
}

export interface CountrySimulation {
  state: CountryState;
  ticks: number;
  events: { at: number; event: CountryEvent }[];
  /** set when the government fell during the batch (simulation stops there) */
  overthrownAt: number | null;
}

/**
 * Batched catch-up for a whole country (economy + citizens). Stops early at an
 * overthrow. Identical to calling tickCountry once per tick (tested).
 */
export function simulateCountryUntil(
  state: CountryState,
  until: number,
  ctx: Omit<CountryContext, 'at'>,
  buildings: readonly Building[],
  tickLengthMs: number,
  rngFor: (tickAt: number) => Rng,
): CountrySimulation {
  const start = state.nation.lastTickAt;
  const due = Math.max(0, Math.floor((until - start) / tickLengthMs));
  const ticks = Math.min(due, ctx.cfg.maxCatchUpTicks);
  let s = state;
  const events: CountrySimulation['events'] = [];
  for (let i = 0; i < ticks; i++) {
    const at = start + (i + 1) * tickLengthMs;
    const r = tickCountry(s, { ...ctx, at }, buildings, rngFor(at));
    s = { ...r.state, nation: { ...r.state.nation, lastTickAt: at } };
    for (const e of r.events) events.push({ at, event: e });
    if (r.events.some((e) => e.kind === 'overthrow')) return { state: s, ticks: i + 1, events, overthrownAt: at };
  }
  return { state: { ...s, nation: { ...s.nation, lastTickAt: start + due * tickLengthMs } }, ticks, events, overthrownAt: null };
}
