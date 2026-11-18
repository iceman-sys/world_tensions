/**
 * Economy rules. Pure and deterministic: no clock, no randomness. The server
 * decides *when* ticks happen; these functions decide *what* a tick does.
 */
import type { CountryMeta } from './earth.ts';
import type { GameConfig } from './config.ts';
import { protectionMs } from './config.ts';
import type { Nation, ResourceAmounts } from './model.ts';
import { deriveSeed, mulberry32, randInt } from './rng.ts';
import { STARTING_FUNDS, type ResourceName } from './resources.ts';

export const ECONOMY = {
  /** taxable income per citizen per game hour, in dollars */
  incomePerCapitaHour: 2.4,
  defaultTaxRate: 20,
  minTaxRate: 0,
  maxTaxRate: 60,
  /** population growth per game hour at full housing headroom */
  growthPerHour: 0.002,
  /** housing capacity of a cell relative to its starting population */
  housingFactor: 1.3,
  /** natural-resource output range, units per game hour */
  productionMin: 30,
  productionMax: 180,
  /** a new nation starts with this many hours of its own production in storage */
  startingStockHours: 12,
  /** sparkline length (ticks) */
  historyLength: 60,
} as const;

/** Game hours covered by one tick. */
export function tickHours(cfg: GameConfig): number {
  return cfg.tickGameMinutes / 60;
}

/** Housing capacity of a single cell (from its generated starting population). */
export function cellCapacity(meta: CountryMeta): number {
  return Math.round(meta.population * ECONOMY.housingFactor);
}

/** Deterministic natural-resource production rates for a cell. */
export function cellProduction(earthSeed: number, meta: CountryMeta): ResourceAmounts {
  const rng = mulberry32(deriveSeed(earthSeed, `production:${meta.id}`));
  const out: ResourceAmounts = {};
  for (const r of meta.resources as ResourceName[]) out[r] = randInt(rng, ECONOMY.productionMin, ECONOMY.productionMax);
  return out;
}

/** A brand-new nation founded on `meta`'s cell. */
export function foundNation(args: {
  id: number;
  playerId: string;
  meta: CountryMeta;
  earthSeed: number;
  now: number;
  cfg: GameConfig;
}): Nation {
  const { id, playerId, meta, earthSeed, now, cfg } = args;
  const production = cellProduction(earthSeed, meta);
  const stock: ResourceAmounts = {};
  for (const [r, rate] of Object.entries(production) as [ResourceName, number][]) stock[r] = Math.round(rate * ECONOMY.startingStockHours);
  return {
    id,
    playerId,
    homeCell: meta.id,
    funds: STARTING_FUNDS,
    population: meta.population,
    satisfaction: meta.satisfaction,
    taxRate: ECONOMY.defaultTaxRate,
    stock,
    production,
    military: { size: meta.militarySize, readiness: meta.militaryStrength },
    createdAt: now,
    protectedUntil: now + protectionMs(cfg),
    lastActiveAt: now,
    lastTickAt: now,
    lowSatTicks: 0,
    warnStage: 0,
    history: { funds: [STARTING_FUNDS], population: [meta.population], satisfaction: [meta.satisfaction] },
  };
}

export interface TickContext {
  cfg: GameConfig;
  /** total housing capacity of all cells the nation holds */
  capacity: number;
}

export type TickEvent = { kind: 'none' };

export interface TickResult {
  nation: Nation;
  events: TickEvent[];
}

function pushCapped(list: number[], v: number): number[] {
  const out = list.length >= ECONOMY.historyLength ? list.slice(list.length - ECONOMY.historyLength + 1) : list.slice();
  out.push(v);
  return out;
}

/** Advances one nation by exactly one tick. Returns a new object; the input is not modified. */
export function tickNation(n: Nation, ctx: TickContext): TickResult {
  const h = tickHours(ctx.cfg);
  const funds = n.funds + Math.round(n.population * ECONOMY.incomePerCapitaHour * (n.taxRate / 100) * h);

  const stock: ResourceAmounts = { ...n.stock };
  for (const [r, rate] of Object.entries(n.production) as [ResourceName, number][]) {
    stock[r] = round3((stock[r] ?? 0) + rate * h);
  }

  const headroom = 1 - n.population / Math.max(1, ctx.capacity);
  const population = Math.max(0, n.population + Math.round(n.population * ECONOMY.growthPerHour * h * headroom));

  const nation: Nation = {
    ...n,
    funds,
    stock,
    population,
    history: {
      funds: pushCapped(n.history.funds, funds),
      population: pushCapped(n.history.population, population),
      satisfaction: pushCapped(n.history.satisfaction, n.satisfaction),
    },
  };
  return { nation, events: [] };
}

export interface SimulationResult {
  nation: Nation;
  ticks: number;
  /** events paired with the epoch ms of the tick that produced them */
  events: { at: number; event: TickEvent }[];
}

/**
 * Batched catch-up: simulates every tick due between `n.lastTickAt` and `now`
 * in one call (bounded by cfg.maxCatchUpTicks). Equivalent to calling
 * tickNation once per tick, which the tests verify.
 */
export function simulateUntil(n: Nation, now: number, ctx: TickContext, tickLengthMs: number): SimulationResult {
  const due = Math.max(0, Math.floor((now - n.lastTickAt) / tickLengthMs));
  const ticks = Math.min(due, ctx.cfg.maxCatchUpTicks);
  let nation = n;
  const events: SimulationResult['events'] = [];
  for (let i = 0; i < ticks; i++) {
    const r = tickNation(nation, ctx);
    nation = r.nation;
    const at = n.lastTickAt + (i + 1) * tickLengthMs;
    for (const e of r.events) events.push({ at, event: e });
  }
  // skipped ticks beyond the cap are dropped rather than replayed later
  nation = { ...nation, lastTickAt: n.lastTickAt + due * tickLengthMs };
  return { nation, ticks, events };
}

export function round3(v: number): number {
  return Math.round(v * 1000) / 1000;
}
