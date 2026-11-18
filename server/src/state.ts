import { randomBytes, randomInt } from 'node:crypto';
import type { CountryState, EarthCounts, ErrorCode, You } from '../../shared/protocol.ts';
import { isValidName, normalizeName } from '../../shared/protocol.ts';
import { COUNTRY_COUNT } from '../../shared/resources.ts';

export interface Player {
  id: string;
  name: string;
  token: string;
  countryId: number;
  online: boolean;
  lastSeen: number;
  bot: boolean;
  /** live sockets for this player (a player may have several tabs open) */
  connections: number;
}

export type JoinResult = { ok: true; player: Player } | { ok: false; code: ErrorCode; message: string };

export interface PersistedState {
  version: 1;
  seed: number;
  players: Omit<Player, 'connections' | 'online'>[];
}

/** Random integer in [0, max). Injectable so tests can be deterministic. */
export type RandomInt = (max: number) => number;

const newId = () => randomBytes(9).toString('base64url');
const newToken = () => randomBytes(24).toString('base64url');

/**
 * Authoritative Earth ownership. Pure logic, no networking: the server feeds it
 * validated requests and broadcasts whatever it changes.
 */
export class EarthState {
  readonly players = new Map<string, Player>();
  private readonly byToken = new Map<string, Player>();
  /** playerId per country, or null */
  private readonly owner: (string | null)[] = new Array<string | null>(COUNTRY_COUNT).fill(null);

  constructor(readonly seed: number, private readonly rand: RandomInt = (max) => randomInt(max)) {}

  /** Assigns a random unclaimed country to a new player. The caller never chooses the country. */
  join(rawName: string, opts: { bot?: boolean; now?: number } = {}): JoinResult {
    const name = normalizeName(rawName);
    if (!isValidName(name)) {
      return { ok: false, code: 'invalid-name', message: 'Names must be 2-20 letters, numbers, spaces, _ or -.' };
    }
    const lower = name.toLowerCase();
    for (const p of this.players.values()) {
      if (p.name.toLowerCase() === lower) return { ok: false, code: 'invalid-name', message: 'That governor name is already taken on this Earth.' };
    }
    const free: number[] = [];
    for (let c = 0; c < COUNTRY_COUNT; c++) if (this.owner[c] === null) free.push(c);
    if (free.length === 0) return { ok: false, code: 'earth-full', message: 'All 200 country slots on this Earth are taken.' };

    const countryId = free[this.rand(free.length)];
    const player: Player = {
      id: newId(),
      name,
      token: newToken(),
      countryId: -1,
      online: !opts.bot,
      lastSeen: opts.now ?? Date.now(),
      bot: !!opts.bot,
      connections: 0,
    };
    this.players.set(player.id, player);
    this.byToken.set(player.token, player);
    if (!this.claim(player.id, countryId)) throw new Error('invariant: free country could not be claimed');
    return { ok: true, player };
  }

  /**
   * Low-level claim used by join() and persistence restore. Rejects double claims
   * and players that already own a country (one country per player).
   */
  claim(playerId: string, countryId: number): boolean {
    const player = this.players.get(playerId);
    if (!player) return false;
    if (!Number.isInteger(countryId) || countryId < 0 || countryId >= COUNTRY_COUNT) return false;
    if (this.owner[countryId] !== null) return false;
    if (player.countryId !== -1) return false;
    this.owner[countryId] = playerId;
    player.countryId = countryId;
    return true;
  }

  /** Removes a player and frees their country. Returns the freed country id. */
  release(playerId: string): number {
    const p = this.players.get(playerId);
    if (!p) return -1;
    this.players.delete(playerId);
    this.byToken.delete(p.token);
    if (p.countryId >= 0 && this.owner[p.countryId] === playerId) this.owner[p.countryId] = null;
    return p.countryId;
  }

  byTokenLookup(token: string): Player | null {
    return this.byToken.get(token) ?? null;
  }

  ownerOf(countryId: number): Player | null {
    const id = this.owner[countryId];
    return id ? this.players.get(id) ?? null : null;
  }

  setOnline(player: Player, online: boolean, now = Date.now()): boolean {
    if (player.online === online) return false;
    player.online = online;
    player.lastSeen = now;
    return true;
  }

  countryState(id: number): CountryState {
    const p = this.ownerOf(id);
    return { id, owner: p ? p.name : null, online: p ? p.online : false, lastSeen: p ? p.lastSeen : 0, bot: p ? p.bot : false };
  }

  allCountries(): CountryState[] {
    const list: CountryState[] = [];
    for (let c = 0; c < COUNTRY_COUNT; c++) if (this.owner[c] !== null) list.push(this.countryState(c));
    return list;
  }

  counts(): EarthCounts {
    let online = 0;
    for (const p of this.players.values()) if (p.online) online++;
    return { slotsUsed: this.players.size, online, offline: this.players.size - online, defeated: 0 };
  }

  you(p: Player): You {
    return { playerId: p.id, name: p.name, countryId: p.countryId };
  }

  toJSON(): PersistedState {
    return {
      version: 1,
      seed: this.seed,
      // bots are a dev convenience and are not persisted across restarts
      players: [...this.players.values()].filter((p) => !p.bot).map(({ id, name, token, countryId, lastSeen, bot }) => ({ id, name, token, countryId, lastSeen, bot })),
    };
  }

  static fromJSON(data: unknown, rand?: RandomInt): EarthState | null {
    if (typeof data !== 'object' || data === null) return null;
    const d = data as Partial<PersistedState>;
    if (d.version !== 1 || typeof d.seed !== 'number' || !Array.isArray(d.players)) return null;
    const state = new EarthState(d.seed >>> 0, rand);
    for (const raw of d.players) {
      if (!raw || typeof raw.id !== 'string' || typeof raw.token !== 'string' || typeof raw.name !== 'string') continue;
      if (!isValidName(raw.name) || !Number.isInteger(raw.countryId)) continue;
      const p: Player = { ...raw, countryId: -1, online: false, connections: 0, bot: !!raw.bot, lastSeen: Number(raw.lastSeen) || 0 };
      state.players.set(p.id, p);
      state.byToken.set(p.token, p);
      if (!state.claim(p.id, raw.countryId)) state.release(p.id);
    }
    return state;
  }
}
