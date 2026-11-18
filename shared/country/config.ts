/**
 * Every Country View constant in one place (documented in docs/COUNTRY_VIEW.md).
 * Values are plain data so tests and docs can import them.
 */

export const TERRAIN = {
  /** vertices per side of the local heightfield */
  size: 256,
  /** scene units per grid step */
  cellSize: 1,
  /** the frame extends this much beyond the country's bounding box */
  frameMargin: 1.2,
  /** width of the water channel around the border, in grid steps */
  channelWidth: 2.5,
  /** width of the neighbouring-land strip beyond the channel, in grid steps */
  neighborStrip: 9,
  /** sample points used to find a country's centroid and extent */
  frameSamples: 60_000,
  /** heights in scene units; water level is 0 */
  lowland: 0.8,
  hills: 5,
  mountains: 20,
  /** inland rise: full height is reached this many steps from the coast */
  coastRamp: 16,
  channelDepth: -1.6,
  seaDepth: -3,
  riverCount: 3,
  riverDepth: 0.7,
  lakeCount: 2,
  lakeRadius: [5, 9] as const,
  /** tiles steeper than this (height difference to a neighbour) count as steep */
  steepSlope: 1.6,
} as const;

/**
 * Country simulation (shared/country/sim.ts). The local town is a representative
 * model of the whole country: building capacities are scaled by the country's
 * founding population so the starter town covers it at the ratios below.
 */
export const SIM = {
  /** starter-town housing covers this share of the founding population */
  starterHousingCover: 1.05,
  /** share of the population that works */
  workforceShare: 0.55,
  /** starter-town jobs cover this share of the workforce */
  starterJobsCover: 0.85,
  /** food units per game hour consumed at the founding population */
  foodDemand: 30,
  /** food stock a new country starts with (game hours of demand) */
  startingFoodHours: 24,
  /** extra food per game hour for each food natural resource (Grain, Rice, Fish, Livestock, Cocoa, Coffee) */
  naturalFood: 6,
  /** service capacity needed at the founding population for full coverage */
  need: { education: 120, health: 100, safety: 140, leisure: 60 },
  /** safety without any police */
  baseSafety: 0.5,
  // ---- satisfaction target (0..100) ----
  baseSatisfaction: 50,
  /** points lost per tax percent above taxNeutral (gained below) */
  taxNeutral: 25,
  taxSlope: 0.9,
  /** extra, steeper penalty above taxHarsh: (tax - taxHarsh)^1.5 x taxHarshSlope */
  taxHarsh: 40,
  taxHarshSlope: 0.35,
  housingWeight: 30,
  jobsWeight: 40,
  /** employment considered normal */
  jobsNormal: 0.9,
  shortagePenalty: 18,
  surplusBonus: 3,
  safetyWeight: 14,
  serviceWeights: { education: 4, health: 5, leisure: 4 },
  /** cap on the sum of building satisfaction bonuses */
  buildingBonusCap: 8,
  /** satisfaction eases towards the target by this fraction of the gap per game hour */
  satisfactionRate: 0.06,
  /** below this satisfaction people emigrate: population falls by up to migrationRate per game hour */
  migrationBelow: 25,
  migrationRate: 0.004,
  /** inbox warnings when satisfaction falls to these levels */
  warningStages: [40, 30, 25] as const,
  /** at or below this for overthrowTicks consecutive ticks, the government falls */
  overthrowAt: 20,
  overthrowTicks: 36,
  // ---- featured citizens ----
  featuredCount: 40,
  complainBelow: 45,
  protestBelow: 35,
  migrateBelow: 25,
  /** consecutive ticks below migrateBelow before a citizen plans to leave / actually leaves */
  migratePlanTicks: 6,
  migrateLeaveTicks: 48,
  /** citizen happiness eases towards its target by this fraction per game hour */
  happinessRate: 0.12,
  /** citizen years that pass per game day */
  yearsPerGameDay: 1,
  retireAge: 67,
  historyLength: 12,
} as const;

/** mask values per tile */
export const MASK = { own: 0, channel: 1, neighbor: 2, outside: 3 } as const;
/** water values per tile */
export const WATER = { none: 0, river: 1, lake: 2, sea: 3 } as const;
/** biome values per tile */
export const BIOME = { grass: 0, forest: 1, desert: 2, snow: 3, rock: 4, sand: 5 } as const;

export type SpotKind = 'mine' | 'oil' | 'field' | 'grove' | 'pasture' | 'fishery';

/** How each of the 20 natural resources appears in the landscape. */
export const RESOURCE_SPOT: Record<string, { kind: SpotKind; color: string }> = {
  'Crude Oil': { kind: 'oil', color: '#2b2b30' },
  'Natural Gas': { kind: 'oil', color: '#9fb7c9' },
  Coal: { kind: 'mine', color: '#2f2f33' },
  'Iron Ore': { kind: 'mine', color: '#8a4b32' },
  Copper: { kind: 'mine', color: '#c27a45' },
  Bauxite: { kind: 'mine', color: '#b5653f' },
  Gold: { kind: 'mine', color: '#e5c04a' },
  Silver: { kind: 'mine', color: '#c9ccd3' },
  Lithium: { kind: 'mine', color: '#d9e6ef' },
  Uranium: { kind: 'mine', color: '#9acd4f' },
  'Rare Earths': { kind: 'mine', color: '#a07fc4' },
  Timber: { kind: 'grove', color: '#2f6b35' },
  Grain: { kind: 'field', color: '#e2c35a' },
  Rice: { kind: 'field', color: '#9fcf6b' },
  Cotton: { kind: 'field', color: '#f1efe6' },
  Coffee: { kind: 'field', color: '#6f8f3c' },
  Cocoa: { kind: 'field', color: '#8a5a35' },
  Livestock: { kind: 'pasture', color: '#93b95a' },
  Fish: { kind: 'fishery', color: '#3a8fb8' },
  Rubber: { kind: 'grove', color: '#3f7f45' },
};
