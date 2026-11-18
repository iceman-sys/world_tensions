/** Wire protocol between the browser and the authoritative server (JSON over WebSocket). */
import type { InboxItem, LogEntry, LostReason, Military } from './model.ts';
import { BUILDING_KINDS, type Building, type BuildingKind } from './country/buildings.ts';

/** Per-cell map state (one of the 200 generated territories). */
export interface CountryState {
  id: number;
  /** owner display name, or null when unclaimed */
  owner: string | null;
  online: boolean;
  /** epoch ms the owner was last connected */
  lastSeen: number;
  bot: boolean;
  /** nation holding this cell, or null when unclaimed */
  nationId: number | null;
  /** home cell of the holding nation (its flag is drawn here); the cell itself when unclaimed */
  homeCell: number;
  /** epoch ms when an offline governor loses the country to inactivity, or null */
  lostAt: number | null;
}

/** Public view of a governed nation. */
export interface NationView {
  id: number;
  homeCell: number;
  owner: string;
  bot: boolean;
  online: boolean;
  population: number;
  satisfaction: number;
  funds: number;
  taxRate: number;
  military: Military;
  protectedUntil: number;
  /** natural resources the nation produces */
  resources: string[];
  /** number of cells held */
  cells: number;
}

export interface EarthCounts {
  slotsUsed: number;
  online: number;
  offline: number;
  defeated: number;
}

export interface You {
  playerId: string;
  name: string;
  /** home cell of your nation, or -1 when you currently have no country */
  countryId: number;
  nationId: number | null;
  /** why your last country was lost, when you have none */
  lostReason: LostReason | null;
}

/** Timing constants the client needs for countdowns (all real milliseconds). */
export interface ClientConfig {
  demoMode: boolean;
  timeScale: number;
  tickMs: number;
  inactivityMs: number;
  protectionMs: number;
  warRoundSeconds: number;
  /** multiplies building construction times */
  constructionFactor: number;
}

export interface AwaySummary {
  since: number;
  until: number;
  ticks: number;
  funds: [number, number];
  population: [number, number];
  satisfaction: [number, number];
  resources: { name: string; before: number; after: number }[];
  /** inbox items received while away */
  events: InboxItem[];
  /** set when the country was lost while away */
  lost: LostReason | null;
}

// ---- client -> server ----
// Country-view messages never carry a nation id: the server always acts on the
// sender's own nation, so another country's private data cannot be requested.
export type ClientMessage =
  | { t: 'hello'; token: string | null }
  | { t: 'join'; name: string }
  | { t: 'ping' }
  | { t: 'dev:bots'; on: boolean }
  | { t: 'local:open' }
  | { t: 'local:close' }
  | { t: 'build'; kind: BuildingKind; i: number; j: number; rot: 0 | 1 }
  | { t: 'build:cancel'; id: number };

/** Private country-view data, sent only to the nation's own governors. */
export interface LocalStateMsg {
  nationId: number;
  buildings: Building[];
}

// ---- server -> client ----
export type ServerMessage =
  | {
      t: 'welcome';
      seed: number;
      you: You | null;
      countries: CountryState[];
      nations: NationView[];
      neighbors: number[][];
      counts: EarthCounts;
      devTools: boolean;
      config: ClientConfig;
      /** server clock, for countdowns */
      now: number;
      log: LogEntry[];
    }
  | { t: 'joined'; you: You; token: string }
  | { t: 'you'; you: You }
  | { t: 'diff'; countries: CountryState[]; counts: EarthCounts; nations: NationView[]; removedNations: number[]; now: number }
  | { t: 'away'; summary: AwaySummary }
  | { t: 'log'; entries: LogEntry[] }
  | { t: 'local:state'; state: LocalStateMsg; now: number }
  | { t: 'local:diff'; nationId: number; buildings: Building[]; removed: number[]; now: number }
  | { t: 'build:result'; ok: boolean; message: string; buildingId: number | null }
  | { t: 'error'; code: ErrorCode; message: string }
  | { t: 'pong' };

export type ErrorCode =
  | 'bad-message'
  | 'rate-limited'
  | 'invalid-name'
  | 'already-joined'
  | 'earth-full'
  | 'not-allowed'
  | 'server-error'
  | 'no-country';

export const NAME_MIN = 2;
export const NAME_MAX = 20;
const NAME_RE = /^[\p{L}\p{N} _-]+$/u;
export const MAX_MESSAGE_BYTES = 2048;

export function normalizeName(raw: string): string {
  return raw.normalize('NFC').trim().replace(/\s+/g, ' ');
}

export function isValidName(name: string): boolean {
  return name.length >= NAME_MIN && name.length <= NAME_MAX && NAME_RE.test(name);
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

/** Tile coordinates: integers within any supported terrain grid. */
function isTile(v: unknown): v is number {
  return typeof v === 'number' && Number.isInteger(v) && v >= 0 && v < 1024;
}

function isId(v: unknown): v is number {
  return typeof v === 'number' && Number.isInteger(v) && v > 0 && v < 2 ** 31;
}

function hasExactKeys(o: Record<string, unknown>, keys: string[]): boolean {
  const own = Object.keys(o);
  return own.length === keys.length && keys.every((k) => Object.prototype.hasOwnProperty.call(o, k));
}

/**
 * Strict validator: unknown message types and extra fields are rejected, so a
 * client can never smuggle in e.g. a `countryId` to choose its own country.
 */
export function parseClientMessage(raw: string): ClientMessage | null {
  if (raw.length > MAX_MESSAGE_BYTES) return null;
  let v: unknown;
  try {
    v = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!isRecord(v) || typeof v.t !== 'string') return null;
  switch (v.t) {
    case 'hello':
      if (!hasExactKeys(v, ['t', 'token'])) return null;
      if (v.token !== null && (typeof v.token !== 'string' || !/^[A-Za-z0-9_-]{16,64}$/.test(v.token))) return null;
      return { t: 'hello', token: v.token };
    case 'join':
      if (!hasExactKeys(v, ['t', 'name']) || typeof v.name !== 'string' || v.name.length > 64) return null;
      return { t: 'join', name: v.name };
    case 'ping':
      return hasExactKeys(v, ['t']) ? { t: 'ping' } : null;
    case 'dev:bots':
      if (!hasExactKeys(v, ['t', 'on']) || typeof v.on !== 'boolean') return null;
      return { t: 'dev:bots', on: v.on };
    case 'local:open':
      return hasExactKeys(v, ['t']) ? { t: 'local:open' } : null;
    case 'local:close':
      return hasExactKeys(v, ['t']) ? { t: 'local:close' } : null;
    case 'build': {
      if (!hasExactKeys(v, ['t', 'kind', 'i', 'j', 'rot'])) return null;
      if (typeof v.kind !== 'string' || !(BUILDING_KINDS as readonly string[]).includes(v.kind)) return null;
      if (!isTile(v.i) || !isTile(v.j) || (v.rot !== 0 && v.rot !== 1)) return null;
      return { t: 'build', kind: v.kind as BuildingKind, i: v.i, j: v.j, rot: v.rot };
    }
    case 'build:cancel':
      if (!hasExactKeys(v, ['t', 'id']) || !isId(v.id)) return null;
      return { t: 'build:cancel', id: v.id };
    default:
      return null;
  }
}
