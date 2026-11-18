/**
 * Building catalog, placement validation and the starter town. Pure and shared:
 * the client uses validatePlacement for the ghost preview, the server uses the
 * same function to accept or reject every build request.
 */
import { MASK, WATER } from './config.ts';
import type { LocalTerrain } from './terrain.ts';

export const BUILDING_KINDS = ['house', 'apartment', 'farm', 'mine', 'school', 'market', 'clinic', 'park', 'police', 'townhall'] as const;
export type BuildingKind = (typeof BUILDING_KINDS)[number];

export interface BuildingSpec {
  kind: BuildingKind;
  label: string;
  description: string;
  /** whole dollars */
  cost: number;
  /** game hours at construction factor 1 */
  buildHours: number;
  /** dollars per game hour once built */
  upkeepPerHour: number;
  /** citizens served (school pupils, clinic patients, market customers, park visitors...) */
  capacity: number;
  jobs: number;
  housing: number;
  /** direct satisfaction points while it stands (summed, capped in the simulation) */
  satisfaction: number;
  /** food units per game hour */
  food: number;
  safety: number;
  education: number;
  health: number;
  leisure: number;
  /** footprint in tiles at rotation 0 (width along x/i, depth along j) */
  size: [number, number];
  /** max height difference across the footprint */
  maxRelief: number;
  color: string;
  buildable: boolean;
}

const spec = (s: Omit<BuildingSpec, 'food' | 'safety' | 'education' | 'health' | 'leisure'> & Partial<BuildingSpec>): BuildingSpec => ({
  food: 0,
  safety: 0,
  education: 0,
  health: 0,
  leisure: 0,
  ...s,
});

/** The catalog (documented in docs/COUNTRY_VIEW.md). */
export const BUILDINGS: Record<BuildingKind, BuildingSpec> = {
  house: spec({ kind: 'house', label: 'House', description: 'Homes for a few families.', cost: 800_000, buildHours: 6, upkeepPerHour: 400, capacity: 0, jobs: 0, housing: 6, satisfaction: 0.5, size: [2, 2], maxRelief: 1.6, color: '#d9a066', buildable: true }),
  apartment: spec({ kind: 'apartment', label: 'Apartment', description: 'Dense housing for many citizens.', cost: 3_000_000, buildHours: 18, upkeepPerHour: 1_500, capacity: 0, jobs: 2, housing: 24, satisfaction: 0, size: [3, 3], maxRelief: 1.4, color: '#b9c3cf', buildable: true }),
  farm: spec({ kind: 'farm', label: 'Farm', description: 'Grows food and employs farm hands.', cost: 2_500_000, buildHours: 12, upkeepPerHour: 900, capacity: 0, jobs: 8, housing: 1, satisfaction: 0, food: 30, size: [6, 5], maxRelief: 2.2, color: '#d8b44a', buildable: true }),
  mine: spec({ kind: 'mine', label: 'Mine', description: 'Steady industrial jobs.', cost: 6_000_000, buildHours: 24, upkeepPerHour: 2_400, capacity: 0, jobs: 18, housing: 0, satisfaction: -0.5, size: [4, 4], maxRelief: 4, color: '#6f6a64', buildable: true }),
  school: spec({ kind: 'school', label: 'School', description: 'Education for children; teachers’ jobs.', cost: 5_000_000, buildHours: 24, upkeepPerHour: 2_000, capacity: 60, jobs: 6, housing: 0, satisfaction: 1.5, education: 60, size: [4, 3], maxRelief: 1.4, color: '#c8553d', buildable: true }),
  market: spec({ kind: 'market', label: 'Market', description: 'Shops and stalls; distributes food.', cost: 4_000_000, buildHours: 12, upkeepPerHour: 1_200, capacity: 80, jobs: 10, housing: 0, satisfaction: 1, food: 4, size: [4, 4], maxRelief: 1.4, color: '#e0b84f', buildable: true }),
  clinic: spec({ kind: 'clinic', label: 'Clinic', description: 'Health care for the neighbourhood.', cost: 6_000_000, buildHours: 24, upkeepPerHour: 2_600, capacity: 50, jobs: 8, housing: 0, satisfaction: 2, health: 50, size: [3, 3], maxRelief: 1.4, color: '#f2f2f2', buildable: true }),
  park: spec({ kind: 'park', label: 'Park', description: 'Green space where people relax.', cost: 1_500_000, buildHours: 6, upkeepPerHour: 300, capacity: 60, jobs: 1, housing: 0, satisfaction: 1.5, leisure: 60, size: [5, 5], maxRelief: 2.5, color: '#5fae5a', buildable: true }),
  police: spec({ kind: 'police', label: 'Police Station', description: 'Keeps neighbourhoods safe.', cost: 4_500_000, buildHours: 18, upkeepPerHour: 1_800, capacity: 70, jobs: 7, housing: 0, satisfaction: 0.5, safety: 70, size: [3, 3], maxRelief: 1.4, color: '#3b5b9a', buildable: true }),
  townhall: spec({ kind: 'townhall', label: 'Town Hall', description: 'Seat of government (built with the country).', cost: 0, buildHours: 0, upkeepPerHour: 1_000, capacity: 0, jobs: 6, housing: 0, satisfaction: 0, size: [5, 4], maxRelief: 2, color: '#e8dcc0', buildable: false }),
};

export type BuildingStatus = 'building' | 'done';

export interface Building {
  id: number;
  nationId: number;
  kind: BuildingKind;
  /** min-corner tile */
  i: number;
  j: number;
  /** 0 or 1 (90 degrees: footprint width and depth swap) */
  rot: 0 | 1;
  status: BuildingStatus;
  startedAt: number;
  completesAt: number;
}

export function footprint(kind: BuildingKind, rot: 0 | 1): [number, number] {
  const [w, d] = BUILDINGS[kind].size;
  return rot === 0 ? [w, d] : [d, w];
}

export type PlacementReason = 'unknown-kind' | 'not-buildable' | 'bounds' | 'territory' | 'water' | 'slope' | 'overlap' | 'funds' | 'locked';
export type PlacementResult = { ok: true } | { ok: false; reason: PlacementReason };

export const PLACEMENT_MESSAGES: Record<PlacementReason, string> = {
  'unknown-kind': 'Unknown building type.',
  'not-buildable': 'That building cannot be built by hand.',
  bounds: 'That spot is outside the map.',
  territory: 'You can only build on your own land.',
  water: 'You cannot build on water.',
  slope: 'The ground is too steep there.',
  overlap: 'Another building is in the way.',
  funds: 'Not enough money in the treasury.',
  locked: 'Construction is halted during the uprising.',
};

/** The subset of terrain placement needs (the server keeps only this per nation). */
export type PlacementTerrain = Pick<LocalTerrain, 'size' | 'mask' | 'water' | 'heights'>;

function overlaps(a: { i: number; j: number; w: number; d: number }, b: { i: number; j: number; w: number; d: number }): boolean {
  return a.i < b.i + b.w && b.i < a.i + a.w && a.j < b.j + b.d && b.j < a.j + a.d;
}

/**
 * Checks one placement. Order matters only for the message: the first failing
 * rule is reported. `funds` and `locked` are checked last so the preview can
 * show terrain problems even when the treasury is empty.
 */
export function validatePlacement(
  t: PlacementTerrain,
  existing: readonly Pick<Building, 'kind' | 'i' | 'j' | 'rot'>[],
  kind: string,
  i: number,
  j: number,
  rot: 0 | 1,
  funds: number,
  opts: { locked?: boolean; allowUnbuildable?: boolean } = {},
): PlacementResult {
  if (!(BUILDING_KINDS as readonly string[]).includes(kind)) return { ok: false, reason: 'unknown-kind' };
  const k = kind as BuildingKind;
  const s = BUILDINGS[k];
  if (!s.buildable && !opts.allowUnbuildable) return { ok: false, reason: 'not-buildable' };
  const [w, d] = footprint(k, rot);
  const n = t.size;
  if (!Number.isInteger(i) || !Number.isInteger(j) || i < 0 || j < 0 || i + w > n || j + d > n) return { ok: false, reason: 'bounds' };
  let lo = Infinity, hi = -Infinity;
  for (let y = j; y < j + d; y++) {
    for (let x = i; x < i + w; x++) {
      const q = y * n + x;
      if (t.mask[q] !== MASK.own) return { ok: false, reason: 'territory' };
      if (t.water[q] !== WATER.none) return { ok: false, reason: 'water' };
      lo = Math.min(lo, t.heights[q]);
      hi = Math.max(hi, t.heights[q]);
    }
  }
  if (hi - lo > s.maxRelief) return { ok: false, reason: 'slope' };
  const box = { i, j, w, d };
  for (const b of existing) {
    const [bw, bd] = footprint(b.kind, b.rot);
    // one tile of clearance around every building keeps streets between them
    if (overlaps(box, { i: b.i - 1, j: b.j - 1, w: bw + 2, d: bd + 2 })) return { ok: false, reason: 'overlap' };
  }
  if (opts.locked) return { ok: false, reason: 'locked' };
  if (funds < s.cost) return { ok: false, reason: 'funds' };
  return { ok: true };
}

/** Real milliseconds a construction takes. */
export function constructionMs(kind: BuildingKind, msPerGameHour: number, factor: number): number {
  return Math.round(BUILDINGS[kind].buildHours * factor * msPerGameHour);
}

/** Construction progress 0..1 at time `now`. */
export function progressOf(b: Pick<Building, 'status' | 'startedAt' | 'completesAt'>, now: number): number {
  if (b.status === 'done') return 1;
  const span = b.completesAt - b.startedAt;
  return span <= 0 ? 1 : Math.max(0, Math.min(1, (now - b.startedAt) / span));
}

/** Starter town: town hall at the capital, then houses, a farm, a market and a park nearby. */
export const STARTER_TOWN: BuildingKind[] = ['townhall', 'market', 'house', 'house', 'house', 'house', 'house', 'farm', 'park'];

/**
 * Deterministic starter-town layout: each building takes the nearest valid spot
 * to the capital (spiral search), farms a little further out.
 */
export function planStarterTown(t: PlacementTerrain, capital: { i: number; j: number }): Pick<Building, 'kind' | 'i' | 'j' | 'rot'>[] {
  const placed: Pick<Building, 'kind' | 'i' | 'j' | 'rot'>[] = [];
  const n = t.size;
  const maxR = Math.min(60, Math.floor(n / 3));
  for (const kind of STARTER_TOWN) {
    const minR = kind === 'farm' ? 8 : 0;
    let done = false;
    for (let r = minR; r <= maxR && !done; r++) {
      // ring of radius r (Chebyshev), scanned in a fixed order
      for (let dj = -r; dj <= r && !done; dj++) {
        for (let di = -r; di <= r && !done; di++) {
          if (Math.max(Math.abs(di), Math.abs(dj)) !== r) continue;
          for (const rot of [0, 1] as const) {
            const [w, d] = footprint(kind, rot);
            const i = capital.i + di - Math.floor(w / 2);
            const j = capital.j + dj - Math.floor(d / 2);
            if (validatePlacement(t, placed, kind, i, j, rot, Infinity, { allowUnbuildable: true }).ok) {
              placed.push({ kind, i, j, rot });
              done = true;
              break;
            }
          }
        }
      }
    }
  }
  return placed;
}
