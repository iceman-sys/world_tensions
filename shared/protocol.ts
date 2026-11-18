/** Wire protocol between the browser and the authoritative server (JSON over WebSocket). */

export interface CountryState {
  id: number;
  /** owner display name, or null when unclaimed */
  owner: string | null;
  online: boolean;
  /** epoch ms the owner was last connected */
  lastSeen: number;
  bot: boolean;
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
  countryId: number;
}

// ---- client -> server ----
export type ClientMessage =
  | { t: 'hello'; token: string | null }
  | { t: 'join'; name: string }
  | { t: 'ping' }
  | { t: 'dev:bots'; on: boolean };

// ---- server -> client ----
export type ServerMessage =
  | { t: 'welcome'; seed: number; you: You | null; countries: CountryState[]; counts: EarthCounts; devTools: boolean }
  | { t: 'joined'; you: You; token: string }
  | { t: 'diff'; countries: CountryState[]; counts: EarthCounts }
  | { t: 'error'; code: ErrorCode; message: string }
  | { t: 'pong' };

export type ErrorCode =
  | 'bad-message'
  | 'rate-limited'
  | 'invalid-name'
  | 'already-joined'
  | 'earth-full'
  | 'not-allowed';

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
    default:
      return null;
  }
}
