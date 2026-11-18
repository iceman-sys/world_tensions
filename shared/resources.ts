/** Prototype resource catalog (the full game specifies 50; the demo uses 20 generic ones). */
export const RESOURCE_CATALOG = [
  'Crude Oil', 'Natural Gas', 'Coal', 'Iron Ore', 'Copper', 'Bauxite', 'Gold', 'Silver', 'Lithium', 'Uranium',
  'Rare Earths', 'Timber', 'Grain', 'Rice', 'Cotton', 'Coffee', 'Cocoa', 'Livestock', 'Fish', 'Rubber',
] as const;

export type ResourceName = (typeof RESOURCE_CATALOG)[number];

export const STARTING_FUNDS = 100_000_000;
export const COUNTRY_COUNT = 200;
export const PLANET_RADIUS_KM = 6371;
