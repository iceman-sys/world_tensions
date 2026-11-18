/**
 * Featured citizens: ~40 individual characters per country whose lives follow
 * the country's real aggregates. Pure and deterministic: the RNG is injected
 * (the server derives it from the Earth seed, the nation and the tick time).
 */
import type { Rng } from '../rng.ts';
import type { Nation, TownStats } from '../model.ts';
import { BUILDINGS, type Building, type BuildingKind } from './buildings.ts';
import { SIM } from './config.ts';

export const TRAITS = [
  'frugal', 'family-oriented', 'ambitious', 'cautious', 'cheerful', 'grumpy',
  'loyal', 'independent', 'curious', 'hard-working', 'generous', 'worried',
] as const;
export type Trait = (typeof TRAITS)[number];

export type Education = 'primary' | 'secondary' | 'vocational' | 'university';
export type CitizenStatus = 'content' | 'complaining' | 'protesting' | 'planning to move';
export type Need = 'food' | 'a job' | 'a home' | 'safety' | 'lower taxes' | 'health care' | 'schooling' | 'nothing urgent';

export interface Citizen {
  id: number;
  name: string;
  /** years (fractional; shown rounded down) */
  age: number;
  job: string;
  workplaceId: number | null;
  homeId: number | null;
  /** take-home pay per month, dollars */
  income: number;
  education: Education;
  partner: string | null;
  children: string[];
  traits: [Trait, Trait, Trait];
  /** 0..100 */
  happiness: number;
  /** 0..100 */
  loyalty: number;
  /** -100 (very critical) .. 100 (very supportive) */
  opinion: number;
  need: Need;
  status: CitizenStatus;
  /** why this citizen stands out, if they do */
  notable: string | null;
  /** detained by the police, awaiting the government's decision */
  suspect: { reason: string; since: number } | null;
  /** consecutive ticks below the migration threshold */
  lowTicks: number;
  history: { at: number; text: string }[];
  /** stable per-citizen seed (portrait, walking route) */
  seed: number;
}

/** Job title for each kind of workplace. */
export const JOB_TITLE: Partial<Record<BuildingKind, string>> = {
  farm: 'Farmer',
  mine: 'Miner',
  school: 'Teacher',
  market: 'Shopkeeper',
  clinic: 'Nurse',
  police: 'Police officer',
  townhall: 'Town clerk',
  park: 'Gardener',
  apartment: 'Caretaker',
};

/** Gross monthly pay by job. */
export const GROSS_PAY: Record<string, number> = {
  Farmer: 2200, Miner: 3400, Teacher: 3000, Shopkeeper: 2500, Nurse: 3200, 'Police officer': 3100,
  'Town clerk': 2800, Gardener: 2000, Caretaker: 2100, Student: 0, Retired: 1300, Unemployed: 400,
};

const FIRST_A = ['A', 'Bel', 'Cor', 'Da', 'El', 'Fen', 'Ga', 'Hal', 'I', 'Jo', 'Ka', 'Li', 'Ma', 'Ne', 'O', 'Pa', 'Ri', 'Sa', 'Ta', 'U', 'Va', 'We', 'Ya', 'Zo'];
const FIRST_B = ['ra', 'na', 'lo', 'ri', 'en', 'an', 'is', 'el', 'mi', 'da', 'rin', 'beth', 'ton', 'lia', 'ro', 'sa'];
const FAMILY_A = ['Brook', 'Stone', 'Vale', 'Marsh', 'Hollow', 'Ridge', 'Field', 'Ash', 'Thorn', 'Wood', 'Mill', 'Fair', 'Glen', 'Hart', 'Lark', 'Moss'];
const FAMILY_B = ['er', 'ley', 'by', 'wick', 'ton', 'son', 'well', 'more', 'den', 'ford'];

const pick = <T>(rng: Rng, list: readonly T[]): T => list[Math.floor(rng() * list.length)];

export function firstName(rng: Rng): string {
  return pick(rng, FIRST_A) + pick(rng, FIRST_B);
}

function familyName(rng: Rng): string {
  return pick(rng, FAMILY_A) + pick(rng, FAMILY_B);
}

function threeTraits(rng: Rng): [Trait, Trait, Trait] {
  const pool = [...TRAITS];
  const out: Trait[] = [];
  while (out.length < 3) {
    const t = pool.splice(Math.floor(rng() * pool.length), 1)[0];
    // opposite moods don't mix
    if ((t === 'cheerful' && out.includes('grumpy')) || (t === 'grumpy' && out.includes('cheerful'))) continue;
    out.push(t);
  }
  return [out[0], out[1], out[2]];
}

/** Workplaces as a weighted list: each building appears once per job it offers. */
function jobSlots(buildings: readonly Building[]): Building[] {
  const out: Building[] = [];
  for (const b of buildings) if (b.status === 'done' && JOB_TITLE[b.kind]) for (let k = 0; k < Math.min(6, BUILDINGS[b.kind].jobs); k++) out.push(b);
  return out;
}

function homeSlots(buildings: readonly Building[]): Building[] {
  const out: Building[] = [];
  for (const b of buildings) if (b.status === 'done' && BUILDINGS[b.kind].housing > 0) for (let k = 0; k < Math.min(8, BUILDINGS[b.kind].housing); k++) out.push(b);
  return out;
}

function takeHome(job: string, taxRate: number): number {
  const gross = GROSS_PAY[job] ?? 2000;
  // pensions and benefits are not taxed
  return job === 'Retired' || job === 'Unemployed' || job === 'Student' ? gross : Math.round(gross * (1 - taxRate / 100));
}

function newCitizen(rng: Rng, id: number, buildings: readonly Building[], n: Pick<Nation, 'taxRate' | 'satisfaction'>, at: number, employment: number, ageRange: [number, number]): Citizen {
  const family = familyName(rng);
  const age = ageRange[0] + rng() * (ageRange[1] - ageRange[0]);
  const homes = homeSlots(buildings);
  const jobs = jobSlots(buildings);
  let job = 'Unemployed';
  let workplaceId: number | null = null;
  if (age < 18) job = 'Student';
  else if (age >= SIM.retireAge) job = 'Retired';
  else if (jobs.length && rng() < Math.max(0.3, employment)) {
    const w = pick(rng, jobs);
    job = JOB_TITLE[w.kind] ?? 'Town clerk';
    workplaceId = w.id;
  }
  const eduRoll = rng();
  const education: Education = age < 12 ? 'primary' : eduRoll < 0.25 ? 'primary' : eduRoll < 0.6 ? 'secondary' : eduRoll < 0.8 ? 'vocational' : 'university';
  const adult = age >= 20;
  const partner = adult && rng() < 0.55 ? `${firstName(rng)} ${family}` : null;
  const children: string[] = [];
  if (adult && age > 26 && age < 70) for (let k = Math.floor(rng() * 3.2); k > 0; k--) children.push(firstName(rng));
  const traits = threeTraits(rng);
  const happiness = Math.max(5, Math.min(95, n.satisfaction + (rng() - 0.5) * 20));
  const loyalty = Math.max(5, Math.min(95, 50 + (rng() - 0.5) * 40 + (traits.includes('loyal') ? 20 : 0)));
  return {
    id,
    name: `${firstName(rng)} ${family}`,
    age,
    job,
    workplaceId,
    homeId: homes.length ? pick(rng, homes).id : null,
    income: takeHome(job, n.taxRate),
    education,
    partner,
    children,
    traits,
    happiness,
    loyalty,
    opinion: 0,
    need: 'nothing urgent',
    status: 'content',
    notable: null,
    suspect: null,
    lowTicks: 0,
    history: [{ at, text: job === 'Unemployed' ? 'Looking for work in town' : job === 'Student' ? 'Started at the local school' : job === 'Retired' ? 'Enjoying retirement' : `Works as a ${job.toLowerCase()}` }],
    seed: Math.floor(rng() * 2 ** 31),
  };
}

/** The founding population of featured citizens (deterministic for a given RNG). */
export function generateCitizens(rng: Rng, buildings: readonly Building[], n: Pick<Nation, 'taxRate' | 'satisfaction'>, at: number, count = SIM.featuredCount): Citizen[] {
  const out: Citizen[] = [];
  for (let i = 0; i < count; i++) {
    // roughly 20 % children, 65 % working age, 15 % retired
    const r = rng();
    const range: [number, number] = r < 0.2 ? [6, 17.9] : r < 0.85 ? [18, 66] : [67, 88];
    out.push(newCitizen(rng, i + 1, buildings, n, at, 0.85, range));
  }
  return out;
}

export interface CitizenContext {
  nation: Nation;
  stats: TownStats;
  /** tax rate before this tick (to notice tax changes) */
  prevTaxRate: number;
  buildings: readonly Building[];
  /** epoch ms of this tick */
  at: number;
  /** game hours per tick */
  hours: number;
  rng: Rng;
}

export type CitizenEvent =
  | { kind: 'left'; citizen: Citizen }
  | { kind: 'arrived'; citizen: Citizen }
  | { kind: 'suspect'; citizen: Citizen }
  | { kind: 'protest'; citizen: Citizen };

/** Happiness a citizen is moving towards: the national mood plus personal circumstances and traits. */
export function happinessTarget(c: Citizen, ctx: Pick<CitizenContext, 'nation' | 'stats'>): number {
  const { nation: n, stats: s } = ctx;
  let t = n.satisfaction;
  const unemployed = c.job === 'Unemployed';
  const tr = c.traits;
  if (tr.includes('cheerful')) t += 6;
  if (tr.includes('grumpy')) t -= 6;
  if (tr.includes('frugal')) t -= (n.taxRate - SIM.taxNeutral) * 0.4;
  if (tr.includes('family-oriented')) t -= 10 * Math.max(0, 1 - s.housing) + (s.shortage ? 8 : 0);
  if (tr.includes('ambitious') && unemployed) t -= 10;
  if (tr.includes('hard-working') && unemployed) t -= 6;
  if (tr.includes('cautious')) t += (s.safety - 0.5) * 20;
  if (tr.includes('worried')) t -= (s.shortage ? 6 : 0) + (s.safety < 0.5 ? 5 : 0);
  if (tr.includes('loyal')) t += 3;
  if (tr.includes('generous')) t += 2;
  if (tr.includes('curious')) t += s.education * 4;
  if (unemployed) t -= 12;
  if (c.homeId === null) t -= 10;
  return Math.max(0, Math.min(100, t));
}

/** What a citizen wants most right now, from the real aggregates. */
export function currentNeed(c: Citizen, n: Nation, s: TownStats): Need {
  if (s.shortage) return 'food';
  if (c.job === 'Unemployed') return 'a job';
  if (c.homeId === null || s.housing < 0.9) return 'a home';
  if (s.safety < 0.45) return 'safety';
  if (n.taxRate > 35) return 'lower taxes';
  if (s.health < 0.5) return 'health care';
  if (c.children.length > 0 && s.education < 0.5) return 'schooling';
  return 'nothing urgent';
}

function statusFor(c: Citizen): CitizenStatus {
  if (c.happiness < SIM.migrateBelow && c.lowTicks >= SIM.migratePlanTicks) return 'planning to move';
  if (c.happiness < SIM.protestBelow) return 'protesting';
  if (c.happiness < SIM.complainBelow) return 'complaining';
  return 'content';
}

function addHistory(c: Citizen, at: number, text: string): void {
  c.history.push({ at, text });
  if (c.history.length > SIM.historyLength) c.history.splice(0, c.history.length - SIM.historyLength);
}

/** One tick for every featured citizen. Returns new objects; inputs are not modified. */
export function updateCitizens(list: readonly Citizen[], ctx: CitizenContext): { citizens: Citizen[]; events: CitizenEvent[] } {
  const { nation: n, stats: s, at, hours: h, rng } = ctx;
  const events: CitizenEvent[] = [];
  const out: Citizen[] = [];
  const yearsPerTick = (SIM.yearsPerGameDay * h) / 24;
  const jobs = jobSlots(ctx.buildings);
  const taxDelta = n.taxRate - ctx.prevTaxRate;

  for (const old of list) {
    const c: Citizen = { ...old, children: [...old.children], history: [...old.history], traits: old.traits };
    const before = c.status;
    // ---- life ----
    const prevAge = c.age;
    c.age += yearsPerTick;
    if (prevAge < SIM.retireAge && c.age >= SIM.retireAge && c.job !== 'Retired') {
      c.job = 'Retired';
      c.workplaceId = null;
      addHistory(c, at, 'Retired after a long working life');
    }
    if (prevAge < 18 && c.age >= 18 && c.job === 'Student') {
      c.job = 'Unemployed';
      addHistory(c, at, 'Finished school and started looking for work');
    }
    if (c.job === 'Unemployed' && jobs.length && s.employment >= 0.88 && rng() < 0.04 * h * 12) {
      const w = jobs[Math.floor(rng() * jobs.length)];
      c.job = JOB_TITLE[w.kind] ?? 'Town clerk';
      c.workplaceId = w.id;
      addHistory(c, at, `Got a job at the ${BUILDINGS[w.kind].label.toLowerCase()}`);
    } else if (c.workplaceId !== null && s.employment < 0.7 && rng() < 0.02 * h * 12) {
      const w = ctx.buildings.find((b) => b.id === c.workplaceId);
      addHistory(c, at, `Lost their job${w ? ` at the ${BUILDINGS[w.kind].label.toLowerCase()}` : ''}`);
      c.job = 'Unemployed';
      c.workplaceId = null;
    } else if (c.workplaceId !== null && !ctx.buildings.some((b) => b.id === c.workplaceId)) {
      c.job = 'Unemployed';
      c.workplaceId = null;
      addHistory(c, at, 'Lost their job when the workplace closed');
    }
    if (c.homeId !== null && !ctx.buildings.some((b) => b.id === c.homeId)) c.homeId = null;
    if (c.homeId === null && s.housing >= 1) {
      const homes = homeSlots(ctx.buildings);
      if (homes.length && rng() < 0.1) {
        c.homeId = homes[Math.floor(rng() * homes.length)].id;
        addHistory(c, at, 'Moved into a new home');
      }
    }
    if (c.partner && c.age >= 22 && c.age <= 44 && c.happiness > 55 && !s.shortage && rng() < 0.0025 * h * 12) {
      const child = firstName(rng);
      c.children.push(child);
      addHistory(c, at, `Had a child named ${child}`);
    }
    // ---- money ----
    const pay = takeHome(c.job, n.taxRate);
    if (Math.abs(taxDelta) >= 5 && GROSS_PAY[c.job] && c.job !== 'Retired' && c.job !== 'Unemployed') {
      addHistory(c, at, taxDelta > 0 ? `Lost income after the tax rose to ${n.taxRate}%` : `Kept more pay after the tax cut to ${n.taxRate}%`);
    }
    c.income = pay;
    // ---- mood ----
    const target = happinessTarget(c, ctx);
    c.happiness = Math.max(0, Math.min(100, c.happiness + (target - c.happiness) * Math.min(1, SIM.happinessRate * h)));
    const loyaltyTarget = Math.max(c.traits.includes('loyal') ? 60 : 0, c.happiness);
    c.loyalty = Math.max(0, Math.min(100, c.loyalty + (loyaltyTarget - c.loyalty) * Math.min(1, 0.03 * h)));
    c.opinion = Math.round(Math.max(-100, Math.min(100, (c.happiness - 50) * 1.6 + (c.loyalty - 50) * 0.6)));
    c.need = currentNeed(c, n, s);
    c.lowTicks = c.happiness < SIM.migrateBelow ? c.lowTicks + 1 : 0;
    c.status = statusFor(c);
    if (c.status !== before) {
      if (c.status === 'complaining' && before === 'content') addHistory(c, at, `Started complaining about ${c.need === 'nothing urgent' ? 'the government' : c.need}`);
      else if (c.status === 'protesting' && before !== 'planning to move') {
        addHistory(c, at, n.taxRate > 35 ? `Joined a protest against the ${n.taxRate}% tax` : `Joined a protest about ${c.need === 'nothing urgent' ? 'the government' : c.need}`);
        events.push({ kind: 'protest', citizen: c });
      } else if (c.status === 'planning to move') addHistory(c, at, 'Started planning to move away');
      else if (c.status === 'content' && before !== 'content') addHistory(c, at, 'Feels better about the country again');
    }
    // ---- stand-outs ----
    if (!c.notable && c.status === 'protesting' && c.happiness < 22) c.notable = 'protest organiser';
    else if (!c.notable && c.happiness > 85 && c.loyalty > 80) c.notable = 'community volunteer';
    else if (c.notable === 'protest organiser' && c.happiness > 45) c.notable = null;
    // ---- justice: only under real hardship ----
    if (!c.suspect && c.age >= 16 && c.happiness < 30 && (s.shortage || s.safety < 0.45) && rng() < 0.006 * h * 12) {
      c.suspect = { reason: s.shortage ? 'took food from the market stalls during the shortage' : 'damaged a market stall during the unrest', since: at };
      addHistory(c, at, `Was detained by the police: ${c.suspect.reason}`);
      events.push({ kind: 'suspect', citizen: c });
    }
    // ---- leaving the country ----
    if (c.lowTicks >= SIM.migrateLeaveTicks) {
      addHistory(c, at, 'Left the country');
      events.push({ kind: 'left', citizen: c });
      continue;
    }
    out.push(c);
  }

  // newcomers when the country is doing well
  if (out.length < SIM.featuredCount && n.satisfaction > 55 && s.housing >= 0.95 && rng() < 0.03 * h * 12) {
    const id = Math.max(0, ...list.map((c) => c.id), ...out.map((c) => c.id)) + 1;
    const c = newCitizen(rng, id, ctx.buildings, n, at, s.employment, [18, 45]);
    c.history = [{ at, text: 'Moved here looking for a better life' }];
    out.push(c);
    events.push({ kind: 'arrived', citizen: c });
  }
  return { citizens: out, events };
}

/** Documented effects of the government's decisions on a detained citizen. */
export const JUSTICE = {
  release: { satisfaction: 0.5, loyalty: 10, happiness: 5 },
  exile: { satisfaction: -1.5 },
} as const;

/** Releases a detained citizen. Returns the updated citizen, or null if they are not detained. */
export function releaseCitizen(c: Citizen, at: number): Citizen | null {
  if (!c.suspect) return null;
  const out: Citizen = { ...c, suspect: null, history: [...c.history] };
  out.loyalty = Math.min(100, out.loyalty + JUSTICE.release.loyalty);
  out.happiness = Math.min(100, out.happiness + JUSTICE.release.happiness);
  addHistory(out, at, 'Was released by the government');
  return out;
}
