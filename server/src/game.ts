import { createHash } from 'node:crypto';
import { generateEarthMeta, type EarthMeta } from '../../shared/earth.ts';
import { gameHoursToMs, inactivityMs, protectionMs, tickMs, type GameConfig } from '../../shared/config.ts';
import { ECONOMY, foundNation } from '../../shared/economy.ts';
import { ANNOUNCEMENTS, simulateCountryUntil, summarizeTown, townStats, type CountryContext, type CountryEvent } from '../../shared/country/sim.ts';
import { JUSTICE, generateCitizens, releaseCitizen, type Citizen } from '../../shared/country/citizens.ts';
import { TemplateBackend, type DialogueBackend, type QuestionId } from '../../shared/country/dialogue.ts';
import { SIM } from '../../shared/country/config.ts';
import { deriveSeed, mulberry32 } from '../../shared/rng.ts';
import { chooseHeir, inactivityDeadline, inheritAssets, isInactiveExpired } from '../../shared/inactivity.ts';
import type { AwaySnapshot, InboxItem, LogEntry, LostReason, Nation, NewsItem, PlayerRec, Services, TownStats } from '../../shared/model.ts';
import type { AwaySummary, ClientConfig, CountryState, EarthCounts, ErrorCode, LocalDiff, LocalStateMsg, MyNation, NationView, You } from '../../shared/protocol.ts';
import { isValidName, normalizeName } from '../../shared/protocol.ts';
import { COUNTRY_COUNT, type ResourceName } from '../../shared/resources.ts';
import type { Rng } from '../../shared/rng.ts';
import type { ChangeSet, Repository } from './db/repository.ts';
import { Changes, World } from './world.ts';
import type { PersistedState } from './state.ts';
import { TerrainCache } from './country.ts';
import {
  BUILDINGS,
  PLACEMENT_MESSAGES,
  constructionMs,
  planStarterTown,
  validatePlacement,
  type Building,
  type BuildingKind,
  type PlacementReason,
} from '../../shared/country/buildings.ts';

/** Satisfaction at or below this locks construction (the uprising rule). */
export const UPRISING_THRESHOLD = 20;

export type BuildResult = { ok: true; building: Building } | { ok: false; reason: PlacementReason | 'no-country' | 'not-found'; message: string };

export type LocalState = LocalStateMsg;

/** The governor's own nation in full (private: only sent to that nation's governors). */
export function privateNation(n: Nation): MyNation {
  return { id: n.id, taxRate: n.taxRate, food: Math.round(n.food), services: n.services, announcement: n.announcement, history: n.history, lowSatTicks: n.lowSatTicks, pending: n.pending };
}

interface LocalDirty {
  changed: Set<number>;
  removed: Set<number>;
  citizens: boolean;
  nation: boolean;
  news: NewsItem[];
}

/** Protest news is summarised at most once per this many game hours per country. */
const PROTEST_NEWS_HOURS = 2;

/** Citizens change every tick; send them at most this often per nation. */
const CITIZEN_SEND_MS = 1500;

export interface GameDeps {
  repo: Repository;
  cfg: GameConfig;
  /** wall clock (epoch ms); injected so tests control time */
  clock: () => number;
  /** seeded RNG for country assignment and heirs */
  rng: Rng;
  newId: () => string;
  newToken: () => string;
  /** neighbour graph for an Earth (expensive; the result is cached in the database) */
  computeNeighbors: (meta: EarthMeta) => number[][];
  /** smaller generation for tests */
  metaSamples?: number;
  /** local terrain grid size (tests use a smaller grid; the client always uses the default) */
  terrainSize?: number;
}

export interface OpenOptions {
  /** seed for a brand-new Earth (ignored when the database already has one) */
  seed: number;
  /** players from the pre-database state.json, imported once into an empty database */
  legacy?: PersistedState | null;
}

export type JoinResult =
  | { ok: true; player: PlayerRec; nation: Nation; token: string | null }
  | { ok: false; code: ErrorCode; message: string };

export function hashToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

const SYSTEM = 'system';
/** share of the cost refunded when a construction is cancelled */
export const CANCEL_REFUND = 0.75;

/**
 * The authoritative game: validates intents, applies rules from /shared, and
 * persists every change atomically before it becomes visible.
 */
export class Game {
  readonly world: World;
  readonly meta: EarthMeta;
  readonly seed: number;
  readonly neighbors: number[][];
  private readonly connections = new Map<string, number>();
  private readonly botOnline = new Set<string>();
  private queue: Promise<unknown> = Promise.resolve();

  // ---- outgoing change tracking (drained by the network layer) ----
  private readonly dirtyCells = new Set<number>();
  private readonly dirtyNations = new Set<number>();
  private readonly removedNations = new Set<number>();
  private pendingLog: LogEntry[] = [];
  private readonly sentCells = new Map<number, string>();
  private readonly sentNations = new Map<number, string>();
  /** per-nation local changes, delivered only to that nation's governors */
  private readonly localDirty = new Map<number, LocalDirty>();
  private readonly citizensSentAt = new Map<number, number>();
  private readonly terrain: TerrainCache;
  private readonly dialogue: DialogueBackend = new TemplateBackend();
  /** private notifications for a player (e.g. their country was lost) */
  onPlayerChanged: ((playerId: string) => void) | null = null;
  onDirty: (() => void) | null = null;
  onConfigChanged: (() => void) | null = null;
  private clockAnchor = { real: 0, game: 0 };
  private readonly lastProtestNews = new Map<number, number>();
  /** inbox items to deliver live, per player */
  private pendingInbox = new Map<string, InboxItem[]>();

  private constructor(private readonly deps: GameDeps, world: World, meta: EarthMeta, neighbors: number[][]) {
    this.world = world;
    this.meta = meta;
    this.seed = meta.seed;
    this.neighbors = neighbors;
    this.terrain = new TerrainCache(meta, deps.terrainSize);
  }

  static async open(deps: GameDeps, opts: OpenOptions): Promise<Game> {
    const world = World.fromSnapshot(await deps.repo.load());
    const now = deps.clock();
    const boot = new Changes(world, now);

    let seed = world.meta.has('seed') ? Number(world.meta.get('seed')) >>> 0 : null;
    const fresh = seed === null;
    if (seed === null) {
      seed = (opts.legacy?.seed ?? opts.seed) >>> 0;
      boot.setMeta('seed', String(seed));
      boot.setMeta('createdAt', String(now));
    }
    const meta = generateEarthMeta(seed, deps.metaSamples ? { samples: deps.metaSamples } : {});

    const cacheKey = `neighbors.${seed}`;
    let neighbors: number[][] | null = null;
    const cached = world.meta.get(cacheKey);
    if (cached) {
      try {
        const parsed: unknown = JSON.parse(cached);
        if (Array.isArray(parsed) && parsed.length === COUNTRY_COUNT) neighbors = parsed as number[][];
      } catch {
        neighbors = null;
      }
    }
    if (!neighbors) {
      neighbors = deps.computeNeighbors(meta);
      boot.setMeta(cacheKey, JSON.stringify(neighbors));
    }

    const game = new Game(deps, world, meta, neighbors);
    if (fresh && opts.legacy) game.importLegacy(boot, opts.legacy, now);

    // Everybody is offline after a restart. Governors who were connected when the
    // server stopped get an "away" snapshot now, so they see a summary on return.
    for (const p of world.players.values()) {
      const n = world.nationOfPlayer(p);
      if (!p.bot && n && !p.away) boot.putPlayer({ ...p, away: snapshotOf(n, p.lastSeen || now) });
    }
    if (!boot.empty) await game.commit(boot);
    return game;
  }

  private importLegacy(c: Changes, legacy: PersistedState, now: number): void {
    for (const lp of legacy.players) {
      if (lp.bot || !isValidName(lp.name) || c.cellOwner(lp.countryId) !== -1) continue;
      if (!Number.isInteger(lp.countryId) || lp.countryId < 0 || lp.countryId >= COUNTRY_COUNT) continue;
      const nationId = c.nextId('nation');
      const nation = foundNation({ id: nationId, playerId: lp.id, meta: this.meta.countries[lp.countryId], earthSeed: this.seed, now, cfg: this.deps.cfg });
      c.putNation(nation);
      c.setCell(lp.countryId, nationId);
      c.putPlayer({ id: lp.id, name: lp.name, bot: false, createdAt: now, lastSeen: lp.lastSeen || now, nationId, away: null, lostReason: null });
      c.putSession({ tokenHash: hashToken(lp.token), playerId: lp.id, createdAt: now, lastUsedAt: now });
      c.addAudit(SYSTEM, 'import-legacy', nationId, `imported ${lp.name} on cell ${lp.countryId} from state.json`);
    }
  }

  /** Runs actions one at a time, so each sees the result of the previous one. */
  run<T>(fn: () => Promise<T> | T): Promise<T> {
    const next = this.queue.then(fn, fn);
    this.queue = next.catch(() => undefined);
    return next;
  }

  /** Persists a change set, then applies it to memory and records what to broadcast. */
  private async commit(c: Changes): Promise<ChangeSet> {
    const cs = c.build();
    await this.deps.repo.commit(cs);
    // remember which nation a deleted building belonged to before it disappears
    const removedFrom = (cs.deleteBuildings ?? []).map((id) => [id, this.world.buildings.get(id)?.nationId ?? -1] as const);
    this.world.apply(cs);
    for (const b of cs.buildings ?? []) this.localFor(b.nationId).changed.add(b.id);
    for (const [id, nid] of removedFrom) if (nid >= 0) this.localFor(nid).removed.add(id);
    for (const m of cs.inbox ?? []) {
      const list = this.pendingInbox.get(m.playerId) ?? [];
      list.push(m);
      this.pendingInbox.set(m.playerId, list);
    }
    for (const [nid] of cs.citizens ?? []) this.localFor(nid).citizens = true;
    for (const item of cs.news ?? []) this.localFor(item.nationId).news.push(item);
    for (const n of cs.nations ?? []) this.localFor(n.id).nation = true;
    for (const [cell] of cs.territory ?? []) this.dirtyCells.add(cell);
    for (const n of cs.nations ?? []) {
      this.dirtyNations.add(n.id);
      for (const cell of this.world.cellsOf(n.id)) this.dirtyCells.add(cell);
    }
    for (const id of cs.deleteNations ?? []) this.removedNations.add(id);
    for (const p of cs.players ?? []) {
      const n = this.world.nationOfPlayer(p);
      if (n) {
        this.dirtyNations.add(n.id);
        for (const cell of this.world.cellsOf(n.id)) this.dirtyCells.add(cell);
      }
    }
    if (cs.log?.length) this.pendingLog.push(...cs.log);
    this.onDirty?.();
    return cs;
  }

  private localFor(nationId: number): LocalDirty {
    let d = this.localDirty.get(nationId);
    if (!d) {
      d = { changed: new Set(), removed: new Set(), citizens: false, nation: false, news: [] };
      this.localDirty.set(nationId, d);
    }
    return d;
  }

  /**
   * Local (private) changes per nation since the last call. The network layer
   * sends each entry only to that nation's own governors. Citizens are sent at
   * most every CITIZEN_SEND_MS; a pending update stays queued until then.
   */
  drainLocal(now = Date.now()): Map<number, LocalDiff> {
    const out = new Map<number, LocalDiff>();
    for (const [nid, d] of this.localDirty) {
      const n = this.world.nations.get(nid);
      if (!n) {
        this.localDirty.delete(nid);
        continue;
      }
      const buildings: Building[] = [];
      for (const id of d.changed) {
        const b = this.world.buildings.get(id);
        if (b) buildings.push(b);
      }
      const sendCitizens = d.citizens && now - (this.citizensSentAt.get(nid) ?? 0) >= CITIZEN_SEND_MS;
      if (sendCitizens) this.citizensSentAt.set(nid, now);
      const diff: LocalDiff = {
        buildings,
        removed: [...d.removed],
        citizens: sendCitizens ? this.world.citizens.get(nid) ?? [] : null,
        stats: d.nation ? n.stats : null,
        nation: d.nation ? privateNation(n) : null,
        news: d.news,
      };
      if (buildings.length || diff.removed.length || diff.citizens || diff.nation || diff.news.length) out.set(nid, diff);
      if (d.citizens && !sendCitizens) {
        // keep only the pending citizens flag
        this.localDirty.set(nid, { changed: new Set(), removed: new Set(), citizens: true, nation: false, news: [] });
      } else this.localDirty.delete(nid);
    }
    return out;
  }

  /** New inbox items per player since the last call. */
  drainInbox(): Map<string, InboxItem[]> {
    const out = this.pendingInbox;
    this.pendingInbox = new Map();
    return out;
  }

  /** True if some private update is waiting (e.g. throttled citizens). */
  get hasPendingLocal(): boolean {
    return this.localDirty.size > 0;
  }

  /** Marks a nation's cells for re-broadcast (online status changed outside a commit). */
  private touchNation(id: number | null): void {
    if (id === null) return;
    this.dirtyNations.add(id);
    for (const cell of this.world.cellsOf(id)) this.dirtyCells.add(cell);
    this.onDirty?.();
  }

  // ------------------------------------------------------------------ queries

  get cfg(): GameConfig {
    return this.deps.cfg;
  }

  countryName(cell: number): string {
    return this.meta.countries[cell]?.name ?? `cell ${cell}`;
  }

  nationName(n: Pick<Nation, 'homeCell'>): string {
    return this.countryName(n.homeCell);
  }

  isOnline(p: PlayerRec): boolean {
    return p.bot ? this.botOnline.has(p.id) : (this.connections.get(p.id) ?? 0) > 0;
  }

  playerByToken(token: string): PlayerRec | null {
    const s = this.world.sessions.get(hashToken(token));
    return s ? this.world.players.get(s.playerId) ?? null : null;
  }

  countryState(cell: number): CountryState {
    const nid = this.world.territory[cell];
    const n = nid >= 0 ? this.world.nations.get(nid) : undefined;
    const p = n ? this.world.players.get(n.playerId) : undefined;
    if (!n || !p) return { id: cell, owner: null, online: false, lastSeen: 0, bot: false, nationId: null, homeCell: cell, lostAt: null };
    const online = this.isOnline(p);
    return {
      id: cell,
      owner: p.name,
      online,
      lastSeen: p.lastSeen,
      bot: p.bot,
      nationId: n.id,
      homeCell: n.homeCell,
      lostAt: online || p.bot ? null : inactivityDeadline(n, this.cfg),
    };
  }

  allCountries(): CountryState[] {
    const out: CountryState[] = [];
    for (let c = 0; c < COUNTRY_COUNT; c++) if (this.world.territory[c] >= 0) out.push(this.countryState(c));
    return out;
  }

  nationView(n: Nation): NationView {
    const p = this.world.players.get(n.playerId);
    return {
      id: n.id,
      homeCell: n.homeCell,
      owner: p?.name ?? '?',
      bot: p?.bot ?? false,
      online: p ? this.isOnline(p) : false,
      population: n.population,
      satisfaction: Math.round(n.satisfaction * 10) / 10,
      funds: n.funds,
      taxRate: n.taxRate,
      military: n.military,
      protectedUntil: n.protectedUntil,
      resources: Object.keys(n.production),
      cells: this.world.cellsOf(n.id).length,
    };
  }

  allNations(): NationView[] {
    return [...this.world.nations.values()].map((n) => this.nationView(n));
  }

  counts(): EarthCounts {
    let online = 0;
    let offline = 0;
    for (const n of this.world.nations.values()) {
      const p = this.world.players.get(n.playerId);
      if (p && this.isOnline(p)) online++;
      else offline++;
    }
    let defeated = 0;
    for (const p of this.world.players.values()) if (p.nationId === null) defeated++;
    return { slotsUsed: COUNTRY_COUNT - this.world.freeCells().length, online, offline, defeated };
  }

  you(p: PlayerRec): You {
    const n = this.world.nationOfPlayer(p);
    return { playerId: p.id, name: p.name, countryId: n ? n.homeCell : -1, nationId: n ? n.id : null, lostReason: n ? null : p.lostReason };
  }

  clientConfig(): ClientConfig {
    const cfg = this.cfg;
    return {
      demoMode: cfg.demoMode,
      timeScale: cfg.timeScale,
      tickMs: tickMs(cfg),
      inactivityMs: inactivityMs(cfg),
      protectionMs: protectionMs(cfg),
      warRoundSeconds: cfg.warRoundSeconds,
      constructionFactor: cfg.constructionFactor,
      clockReal: this.clockAnchor.real,
      clockGame: this.clockAnchor.game,
    };
  }

  /** Changes since the last call that clients need to see (only entries whose wire form changed). */
  drainDiff(): { countries: CountryState[]; nations: NationView[]; removedNations: number[]; log: LogEntry[] } {
    const countries: CountryState[] = [];
    for (const cell of this.dirtyCells) {
      const s = this.countryState(cell);
      const key = JSON.stringify(s);
      if (this.sentCells.get(cell) === key) continue;
      this.sentCells.set(cell, key);
      countries.push(s);
    }
    const nations: NationView[] = [];
    for (const id of this.dirtyNations) {
      const n = this.world.nations.get(id);
      if (!n) continue;
      const v = this.nationView(n);
      const key = JSON.stringify(v);
      if (this.sentNations.get(id) === key) continue;
      this.sentNations.set(id, key);
      nations.push(v);
    }
    const removedNations = [...this.removedNations].filter((id) => !this.world.nations.has(id));
    for (const id of removedNations) this.sentNations.delete(id);
    const log = this.pendingLog;
    this.dirtyCells.clear();
    this.dirtyNations.clear();
    this.removedNations.clear();
    this.pendingLog = [];
    return { countries, nations, removedNations, log };
  }

  // ------------------------------------------------------------------ helpers

  /** Simulation inputs for a nation (its town, founding population and resources). */
  private countryContext(c: Changes, n: Nation): { ctx: Omit<CountryContext, 'at'>; buildings: Building[] } {
    const buildings = c.buildingsOf(n.id);
    const meta = this.meta.countries[n.homeCell];
    return { ctx: { cfg: this.cfg, town: summarizeTown(buildings), basePopulation: meta.population, resources: meta.resources }, buildings };
  }

  /** Per-tick RNG for a nation's citizens: depends only on seed, nation and tick time. */
  private citizenRng = (nationId: number) => (at: number) => mulberry32(deriveSeed(this.seed, `cit:${nationId}:${at}`));

  /**
   * Brings a nation up to `until` in one batch (economy, town, citizens) and
   * stages the result. Returns null if the government fell during the batch.
   */
  private catchUp(c: Changes, n: Nation, until: number): Nation | null {
    const { ctx, buildings } = this.countryContext(c, n);
    const citizens = c.citizensOf(n.id);
    const sim = simulateCountryUntil({ nation: n, citizens }, until, ctx, buildings, tickMs(this.cfg), this.citizenRng(n.id));
    if (sim.state.nation.lastTickAt === n.lastTickAt) return n;
    c.putNation(sim.state.nation);
    if (citizens.length || sim.state.citizens.length) c.putCitizens(n.id, sim.state.citizens);
    this.reportCountryEvents(c, sim.state.nation, sim.events);
    if (sim.overthrownAt !== null) {
      this.loseNation(c, sim.state.nation, 'overthrow', sim.overthrownAt);
      return null;
    }
    return sim.state.nation;
  }

  /** Turns simulation events into inbox alerts and factual country news. */
  private reportCountryEvents(c: Changes, n: Nation, events: { at: number; event: CountryEvent }[]): void {
    const p = c.player(n.playerId);
    const protestsAt = new Map<number, number>();
    for (const { at, event: e } of events) {
      switch (e.kind) {
        case 'warning': {
          const sat = Math.round(e.satisfaction);
          if (p) c.addInbox(p.id, 'warning', `Satisfaction warning: ${sat}%`, `Satisfaction has fallen to ${sat}% (warning level ${e.stage}%). If it stays at or below ${SIM.overthrowAt}% for ${SIM.overthrowTicks} ticks, the citizens will overthrow the government.`, at);
          c.addNews(n.id, `Satisfaction fell to ${sat}%`, at);
          break;
        }
        case 'shortage':
          if (e.on && p) c.addInbox(p.id, 'warning', 'Food shortage', 'The market has run out of food. Build farms or markets to feed the population.', at);
          c.addNews(n.id, e.on ? 'Food supply is low: the market has run out' : 'Food is back on the market stalls', at);
          break;
        case 'citizen': {
          const ce = e.event;
          if (ce.kind === 'protest') protestsAt.set(at, (protestsAt.get(at) ?? 0) + 1);
          else if (ce.kind === 'left') c.addNews(n.id, `${ce.citizen.name} left the country`, at);
          else if (ce.kind === 'arrived') c.addNews(n.id, `${ce.citizen.name} moved to the country`, at);
          else if (ce.kind === 'suspect') {
            c.addNews(n.id, `Police detained ${ce.citizen.name}, who ${ce.citizen.suspect?.reason ?? 'broke the law'}`, at);
            if (p) c.addInbox(p.id, 'warning', 'A citizen was detained', `${ce.citizen.name} ${ce.citizen.suspect?.reason ?? 'broke the law'}. Decide in the Citizen Card: release or exile.`, at);
          }
          break;
        }
        case 'overthrow':
          break;
      }
    }
    // protest news is summarised: at most one item per PROTEST_NEWS_HOURS game hours, with the real count
    const gap = gameHoursToMs(this.cfg, PROTEST_NEWS_HOURS);
    let lastAt = this.lastProtestNews.get(n.id) ?? -Infinity;
    let pendingCount = 0;
    for (const [at, count] of protestsAt) {
      pendingCount += count;
      if (at - lastAt < gap) continue;
      const protesting = c.citizensOf(n.id).filter((x) => x.status === 'protesting' || x.status === 'planning to move').length;
      c.addNews(n.id, n.taxRate > 35 ? `${protesting} of ${c.citizensOf(n.id).length} featured citizens are protesting against the ${n.taxRate}% tax rate` : `${protesting} featured citizens are protesting (${pendingCount} joined recently)`, at);
      lastAt = at;
      pendingCount = 0;
    }
    this.lastProtestNews.set(n.id, lastAt);
  }

  private freeCellFor(c: Changes): number | null {
    const free: number[] = [];
    for (let cell = 0; cell < COUNTRY_COUNT; cell++) if (c.cellOwner(cell) === -1) free.push(cell);
    if (!free.length) return null;
    return free[Math.floor(this.deps.rng() * free.length)];
  }

  // ------------------------------------------------------------------ actions

  /**
   * Founds a country on a random free cell. `existing` is a governor whose last
   * country was lost; they rejoin through the same random assignment.
   */
  join(rawName: string, opts: { existing?: PlayerRec | null; bot?: boolean } = {}): Promise<JoinResult> {
    return this.run(async () => {
      const now = this.deps.clock();
      const existing = opts.existing ? this.world.players.get(opts.existing.id) ?? null : null;
      if (existing && existing.nationId !== null) return { ok: false, code: 'already-joined', message: 'You already govern a country on this Earth.' };
      const name = normalizeName(rawName);
      if (!isValidName(name)) return { ok: false, code: 'invalid-name', message: 'Names must be 2-20 letters, numbers, spaces, _ or -.' };
      const clash = this.world.playerByName(name);
      if (clash && clash.id !== existing?.id) return { ok: false, code: 'invalid-name', message: 'That governor name is already taken on this Earth.' };

      const c = new Changes(this.world, now);
      const cell = this.freeCellFor(c);
      if (cell === null) return { ok: false, code: 'earth-full', message: 'All 200 country slots on this Earth are taken.' };

      const playerId = existing?.id ?? this.deps.newId();
      const nationId = c.nextId('nation');
      const nation = foundNation({ id: nationId, playerId, meta: this.meta.countries[cell], earthSeed: this.seed, now, cfg: this.cfg });
      c.putNation(nation);
      c.setCell(cell, nationId);
      // humans get their starter town right away; bots get it lazily (they never open the view)
      if (!opts.bot) this.addStarterTown(c, nation, now);
      const player: PlayerRec = existing
        ? { ...existing, name, nationId, lostReason: null, away: null }
        : { id: playerId, name, bot: !!opts.bot, createdAt: now, lastSeen: now, nationId, away: null, lostReason: null };
      c.putPlayer(player);
      let token: string | null = null;
      if (!existing) {
        token = this.deps.newToken();
        c.putSession({ tokenHash: hashToken(token), playerId, createdAt: now, lastUsedAt: now });
      }
      const country = this.countryName(cell);
      c.addAudit(playerId, existing ? 'rejoin' : 'join', nationId, `${name} founded ${country} on cell ${cell} with $${nation.funds}`);
      if (!opts.bot) c.addLog(existing ? 'rejoin' : 'join', existing ? `${name} returned and founded ${country}` : `${name} founded ${country}`, [cell]);
      await this.commit(c);
      return { ok: true, player, nation, token };
    });
  }

  /** A socket for this governor opened. Returns the "while you were away" summary on the first one. */
  attach(playerId: string): Promise<AwaySummary | null> {
    return this.run(async () => {
      const count = (this.connections.get(playerId) ?? 0) + 1;
      this.connections.set(playerId, count);
      const p = this.world.players.get(playerId);
      if (!p || count > 1) return null;
      const now = this.deps.clock();
      const c = new Changes(this.world, now);
      let n = this.world.nationOfPlayer(p);
      if (n) {
        n = this.catchUp(c, n, now);
        if (n) {
          n = { ...n, lastActiveAt: now };
          c.putNation(n);
        }
      }
      // the catch-up may have changed the player (e.g. the country was overthrown meanwhile)
      const p2 = c.player(p.id) ?? p;
      const summary = p2.away ? this.summarize(p2, p2.away, n, now) : null;
      c.putPlayer({ ...p2, lastSeen: now, away: null });
      for (const s of this.world.sessions.values()) if (s.playerId === playerId) c.putSession({ ...s, lastUsedAt: now });
      await this.commit(c);
      this.touchNation(p.nationId);
      if (!summary) return null;
      // a quick reload is not "being away"; losing the country always is
      return summary.lost || summary.ticks >= 1 ? summary : null;
    });
  }

  /** A socket closed; when the last one goes the governor is offline and the inactivity clock starts. */
  detach(playerId: string): Promise<void> {
    return this.run(async () => {
      const count = Math.max(0, (this.connections.get(playerId) ?? 0) - 1);
      if (count > 0) {
        this.connections.set(playerId, count);
        return;
      }
      this.connections.delete(playerId);
      const p = this.world.players.get(playerId);
      if (!p) return;
      const c = this.leaveChanges(p, this.deps.clock());
      await this.commit(c);
      this.touchNation(p.nationId);
    });
  }

  private leaveChanges(p: PlayerRec, now: number, c = new Changes(this.world, now)): Changes {
    let n = this.world.nationOfPlayer(p);
    if (n) {
      n = this.catchUp(c, n, now);
      if (n) {
        n = { ...n, lastActiveAt: now };
        c.putNation(n);
      }
    }
    const p2 = c.player(p.id) ?? p;
    c.putPlayer({ ...p2, lastSeen: now, away: n ? snapshotOf(n, now) : p2.away });
    return c;
  }

  /** Change set for a clean shutdown: every connected governor leaves now. */
  shutdownChanges(): ChangeSet {
    const now = this.deps.clock();
    const c = new Changes(this.world, now);
    for (const id of this.connections.keys()) {
      const p = this.world.players.get(id);
      if (p) this.leaveChanges(p, now, c);
    }
    this.connections.clear();
    return c.build();
  }

  setBotOnline(playerId: string, online: boolean): void {
    const p = this.world.players.get(playerId);
    if (!p?.bot || this.botOnline.has(playerId) === online) return;
    if (online) this.botOnline.add(playerId);
    else this.botOnline.delete(playerId);
    this.touchNation(p.nationId);
  }

  // ------------------------------------------------------------------ country view (private data)

  private ownCellsOf(c: Changes, nationId: number): number[] {
    const out: number[] = [];
    for (let cell = 0; cell < COUNTRY_COUNT; cell++) if (c.cellOwner(cell) === nationId) out.push(cell);
    return out;
  }

  /** Server copy of the nation's local terrain (identical to what its client renders). */
  terrainOf(nationId: number): ReturnType<TerrainCache['get']> | null {
    const n = this.world.nations.get(nationId);
    return n ? this.terrain.get(n.homeCell, this.world.cellsOf(n.id)) : null;
  }

  private addStarterTown(c: Changes, n: Nation, now: number): void {
    const t = this.terrain.get(n.homeCell, this.ownCellsOf(c, n.id));
    const town: Building[] = [];
    for (const p of planStarterTown(t, t.capital)) {
      const b: Building = { id: c.nextId('building'), nationId: n.id, kind: p.kind, i: p.i, j: p.j, rot: p.rot, status: 'done', startedAt: now, completesAt: now };
      c.putBuilding(b);
      town.push(b);
    }
    this.addStarterCitizens(c, n, town, now);
    c.addAudit(SYSTEM, 'starter-town', n.id, `starter town founded at tile ${t.capital.i},${t.capital.j}`);
  }

  private addStarterCitizens(c: Changes, n: Nation, buildings: readonly Building[], now: number): void {
    c.putCitizens(n.id, generateCitizens(mulberry32(deriveSeed(this.seed, `citizens:${n.id}`)), buildings, n, now));
  }

  /** Private aggregates for the country view (computed fresh if no tick has run yet). */
  private statsOf(c: Changes, n: Nation): TownStats {
    return n.stats ?? townStats(n, this.countryContext(c, n).ctx);
  }

  /**
   * The local view's private data for the requesting governor's OWN nation.
   * There is deliberately no way to ask for another nation: the nation comes
   * from the player record, never from the request.
   */
  openLocal(playerId: string): Promise<LocalState | null> {
    return this.run(async () => {
      const p = this.world.players.get(playerId);
      const n = p ? this.world.nationOfPlayer(p) : null;
      if (!p || !n) return null;
      const now = this.deps.clock();
      const c = new Changes(this.world, now);
      if (this.world.buildingsOf(n.id).length === 0) this.addStarterTown(c, n, now);
      else if (c.citizensOf(n.id).length === 0) this.addStarterCitizens(c, n, this.world.buildingsOf(n.id), now);
      if (!c.empty) await this.commit(c);
      const nn = this.world.nations.get(n.id) ?? n;
      return {
        nationId: n.id,
        buildings: this.world.buildingsOf(n.id),
        citizens: this.world.citizens.get(n.id) ?? [],
        stats: this.statsOf(new Changes(this.world, now), nn),
        news: this.world.news.get(n.id) ?? [],
        nation: privateNation(nn),
      };
    });
  }

  /** Looks up one of the requesting governor's own featured citizens. */
  private ownCitizen(playerId: string, citizenId: number): { p: PlayerRec; n: Nation; citizen: Citizen } | null {
    const p = this.world.players.get(playerId);
    const n = p ? this.world.nationOfPlayer(p) : null;
    if (!p || !n) return null;
    const citizen = (this.world.citizens.get(n.id) ?? []).find((x) => x.id === citizenId);
    return citizen ? { p, n, citizen } : null;
  }

  /** Answers a preset question from templates and the real current state (no state change). */
  askCitizen(playerId: string, citizenId: number, question: QuestionId): Promise<string | null> {
    return this.run(async () => {
      const own = this.ownCitizen(playerId, citizenId);
      if (!own) return null;
      const { n, citizen } = own;
      const c = new Changes(this.world, this.deps.clock());
      return this.dialogue.answer({
        citizen,
        question,
        nation: n,
        stats: this.statsOf(c, n),
        countryName: this.nationName(n),
        buildingLabel: (id) => {
          const b = id === null ? undefined : this.world.buildings.get(id);
          return b && b.nationId === n.id ? BUILDINGS[b.kind].label.toLowerCase() : null;
        },
      });
    });
  }

  // ------------------------------------------------------------------ government (policies)

  private governed(playerId: string): { p: PlayerRec; n: Nation } | null {
    const p = this.world.players.get(playerId);
    const n = p ? this.world.nationOfPlayer(p) : null;
    return p && n ? { p, n } : null;
  }

  /** Accepts a new tax rate; it takes effect on the next tick. */
  setTax(playerId: string, rate: number): Promise<{ ok: boolean; message: string }> {
    return this.run(async () => {
      const g = this.governed(playerId);
      if (!g) return { ok: false, message: 'You do not govern a country.' };
      if (!Number.isInteger(rate) || rate < ECONOMY.minTaxRate || rate > ECONOMY.maxTaxRate) return { ok: false, message: `Tax must be ${ECONOMY.minTaxRate}-${ECONOMY.maxTaxRate}%.` };
      const now = this.deps.clock();
      const c = new Changes(this.world, now);
      const current = g.n.pending?.taxRate ?? g.n.taxRate;
      c.putNation({ ...g.n, pending: { ...g.n.pending, taxRate: rate } });
      c.addAudit(g.p.id, 'policy-tax', g.n.id, `${g.p.name} set the tax rate from ${current}% to ${rate}% (applies next tick)`);
      if (rate !== current) c.addNews(g.n.id, `The government ${rate > current ? 'raised' : 'cut'} the tax rate to ${rate}%`, now);
      await this.commit(c);
      return { ok: true, message: `Tax rate set to ${rate}% from the next tick.` };
    });
  }

  /** Funds or stops public services; takes effect on the next tick. */
  setServices(playerId: string, services: Services): Promise<{ ok: boolean; message: string }> {
    return this.run(async () => {
      const g = this.governed(playerId);
      if (!g) return { ok: false, message: 'You do not govern a country.' };
      const now = this.deps.clock();
      const c = new Changes(this.world, now);
      const before = g.n.pending?.services ?? g.n.services;
      c.putNation({ ...g.n, pending: { ...g.n.pending, services: { ...services } } });
      const changes = (Object.keys(services) as (keyof Services)[]).filter((k) => services[k] !== before[k]);
      c.addAudit(g.p.id, 'policy-services', g.n.id, `${g.p.name} set services: ${changes.map((k) => `${k} ${services[k] ? 'on' : 'off'}`).join(', ') || 'no change'} (applies next tick)`);
      for (const k of changes) c.addNews(g.n.id, `The government ${services[k] ? 'restored' : 'stopped funding'} ${k === 'police' ? 'police patrols' : k === 'health' ? 'health care' : 'schools'}`, now);
      await this.commit(c);
      return { ok: true, message: 'Service funding updated from the next tick.' };
    });
  }

  /** Publishes a preset policy announcement (documented effect in ANNOUNCEMENTS). */
  announce(playerId: string, id: string): Promise<{ ok: boolean; message: string }> {
    return this.run(async () => {
      const g = this.governed(playerId);
      const a = ANNOUNCEMENTS[id];
      if (!g || !a) return { ok: false, message: g ? 'Unknown announcement.' : 'You do not govern a country.' };
      const now = this.deps.clock();
      if (g.n.announcement && g.n.announcement.until > now) return { ok: false, message: 'An announcement is still in effect.' };
      const c = new Changes(this.world, now);
      c.putNation({ ...g.n, announcement: { id, until: now + gameHoursToMs(this.cfg, a.hours) } });
      c.addAudit(g.p.id, 'policy-announce', g.n.id, `${g.p.name} announced: "${a.text}"`);
      c.addNews(g.n.id, `Government announcement: ${a.text}`, now);
      await this.commit(c);
      return { ok: true, message: 'Announcement published.' };
    });
  }

  /** Game time (ms) at a real moment; continuous across demo-speed changes. */
  gameTime(now: number): number {
    return this.clockAnchor.game + (now - this.clockAnchor.real) * this.cfg.timeScale;
  }

  /** Dev tool: change how fast game time runs (e.g. 1 s = 1 game hour). */
  setTimeScale(playerId: string, scale: number): Promise<{ ok: boolean; message: string }> {
    return this.run(async () => {
      const p = this.world.players.get(playerId);
      if (!p) return { ok: false, message: 'Join the Earth first.' };
      const now = this.deps.clock();
      // keep the game clock continuous, then switch speed
      this.clockAnchor = { real: now, game: this.gameTime(now) };
      const before = this.cfg.timeScale;
      this.deps.cfg.timeScale = scale;
      const c = new Changes(this.world, now);
      c.addAudit(p.id, 'dev-time-scale', p.nationId, `${p.name} changed the time scale from ${before} to ${scale}`);
      await this.commit(c);
      this.onConfigChanged?.();
      return { ok: true, message: scale >= 3600 ? 'Demo speed: 1 s = 1 game hour.' : 'Normal demo speed: 1 s = 1 game minute.' };
    });
  }

  /** Releases or exiles a detained citizen (documented effects in shared/country/citizens.ts JUSTICE). */
  judgeCitizen(playerId: string, citizenId: number, verdict: 'release' | 'exile'): Promise<{ ok: boolean; message: string }> {
    return this.run(async () => {
      const own = this.ownCitizen(playerId, citizenId);
      if (!own) return { ok: false, message: 'No such citizen.' };
      const { p, citizen } = own;
      if (!citizen.suspect) return { ok: false, message: `${citizen.name} is not detained.` };
      const now = this.deps.clock();
      const c = new Changes(this.world, now);
      const n = this.catchUp(c, own.n, now);
      if (!n) {
        await this.commit(c);
        return { ok: false, message: 'Your government has fallen.' };
      }
      const list = c.citizensOf(n.id);
      if (verdict === 'release') {
        const released = releaseCitizen(citizen, now);
        if (!released) return { ok: false, message: `${citizen.name} is not detained.` };
        c.putCitizens(n.id, list.map((x) => (x.id === citizen.id ? released : x)));
        c.putNation({ ...n, satisfaction: Math.min(100, n.satisfaction + JUSTICE.release.satisfaction) });
        c.addNews(n.id, `The government released ${citizen.name}`, now);
      } else {
        c.putCitizens(n.id, list.filter((x) => x.id !== citizen.id));
        c.putNation({ ...n, satisfaction: Math.max(0, n.satisfaction + JUSTICE.exile.satisfaction) });
        c.addNews(n.id, `${citizen.name} was exiled from the country`, now);
      }
      c.addAudit(p.id, `citizen-${verdict}`, n.id, `${p.name} chose to ${verdict} ${citizen.name} (${citizen.suspect.reason})`);
      await this.commit(c);
      return { ok: true, message: verdict === 'release' ? `${citizen.name} was released.` : `${citizen.name} was exiled.` };
    });
  }

  /** Validates and starts a construction for the requesting governor's own nation. */
  build(playerId: string, kind: string, i: number, j: number, rot: 0 | 1): Promise<BuildResult> {
    return this.run(async () => {
      const now = this.deps.clock();
      const p = this.world.players.get(playerId);
      const n0 = p ? this.world.nationOfPlayer(p) : null;
      if (!p || !n0) return { ok: false, reason: 'no-country', message: 'You do not govern a country.' };
      const c = new Changes(this.world, now);
      // bring the treasury up to date first, so the funds check uses current money
      const n = this.catchUp(c, n0, now);
      if (!n) {
        await this.commit(c);
        return { ok: false, reason: 'no-country', message: 'Your government has fallen.' };
      }
      const t = this.terrain.get(n.homeCell, this.world.cellsOf(n.id));
      const locked = n.satisfaction <= UPRISING_THRESHOLD;
      const v = validatePlacement(t, c.buildingsOf(n.id), kind, i, j, rot, n.funds, { locked });
      if (!v.ok) return { ok: false, reason: v.reason, message: PLACEMENT_MESSAGES[v.reason] };
      const k = kind as BuildingKind;
      const spec = BUILDINGS[k];
      const duration = constructionMs(k, gameHoursToMs(this.cfg, 1), this.cfg.constructionFactor);
      const building: Building = { id: c.nextId('building'), nationId: n.id, kind: k, i, j, rot, status: 'building', startedAt: now, completesAt: now + duration };
      c.putNation({ ...n, funds: n.funds - spec.cost });
      c.putBuilding(building);
      c.addAudit(p.id, 'build', n.id, `${p.name} ordered a ${spec.label} at tile ${i},${j} for $${spec.cost}`);
      await this.commit(c);
      return { ok: true, building };
    });
  }

  /** Cancels a construction that is still in progress; 75 % of the cost is refunded. */
  cancelBuild(playerId: string, buildingId: number): Promise<BuildResult> {
    return this.run(async () => {
      const now = this.deps.clock();
      const p = this.world.players.get(playerId);
      const n0 = p ? this.world.nationOfPlayer(p) : null;
      if (!p || !n0) return { ok: false, reason: 'no-country', message: 'You do not govern a country.' };
      const b = this.world.buildings.get(buildingId);
      // another nation's building is indistinguishable from a missing one
      if (!b || b.nationId !== n0.id || b.status !== 'building') return { ok: false, reason: 'not-found', message: 'No such construction site.' };
      const c = new Changes(this.world, now);
      const n = this.catchUp(c, n0, now);
      if (!n) {
        await this.commit(c);
        return { ok: false, reason: 'no-country', message: 'Your government has fallen.' };
      }
      const refund = Math.round(BUILDINGS[b.kind].cost * CANCEL_REFUND);
      c.putNation({ ...n, funds: n.funds + refund });
      c.removeBuilding(b.id);
      c.addAudit(p.id, 'cancel-build', n.id, `${p.name} cancelled the ${BUILDINGS[b.kind].label} at tile ${b.i},${b.j}; refunded $${refund}`);
      await this.commit(c);
      return { ok: true, building: b };
    });
  }

  /** Finishes constructions whose timer has run out (called from tick). */
  private completeConstruction(c: Changes, now: number): number {
    let done = 0;
    for (const b of this.world.buildings.values()) {
      if (b.status !== 'building' || b.completesAt > now) continue;
      c.putBuilding({ ...b, status: 'done' });
      const n = this.world.nations.get(b.nationId);
      const p = n ? this.world.players.get(n.playerId) : undefined;
      if (p) c.addInbox(p.id, 'info', `${BUILDINGS[b.kind].label} completed`, `The new ${BUILDINGS[b.kind].label.toLowerCase()} at tile ${b.i},${b.j} is open.`, b.completesAt);
      c.addAudit(SYSTEM, 'construction-complete', b.nationId, `${BUILDINGS[b.kind].label} at tile ${b.i},${b.j} completed`);
      done++;
    }
    return done;
  }

  /** Removes a player and their country (dev bots). */
  release(playerId: string): Promise<void> {
    return this.run(async () => {
      const p = this.world.players.get(playerId);
      if (!p) return;
      const c = new Changes(this.world, this.deps.clock());
      if (p.nationId !== null) c.removeNation(p.nationId);
      c.removePlayer(p.id);
      c.addAudit(SYSTEM, 'release', p.nationId, `removed ${p.name}${p.bot ? ' (bot)' : ''}`);
      this.botOnline.delete(p.id);
      this.connections.delete(p.id);
      await this.commit(c);
    });
  }

  /**
   * One server tick: online (and bot) nations advance every tick; offline ones
   * are caught up in a batch once `sweepEveryTicks` are due or when their
   * inactivity deadline passes.
   */
  tick(): Promise<void> {
    return this.run(async () => {
      const now = this.deps.clock();
      const cfg = this.cfg;
      const tms = tickMs(cfg);
      const c = new Changes(this.world, now);
      let advanced = 0;
      const expired: Nation[] = [];
      for (const n0 of this.world.nations.values()) {
        const p = this.world.players.get(n0.playerId);
        if (!p) continue;
        const online = this.isOnline(p);
        if (isInactiveExpired(n0, online, p.bot, now, cfg)) {
          const caught = this.catchUp(c, n0, inactivityDeadline(n0, cfg));
          if (caught) expired.push(caught);
          continue;
        }
        const due = Math.floor((now - n0.lastTickAt) / tms);
        if (due < 1 || (!online && !p.bot && due < cfg.sweepEveryTicks)) continue;
        let n = this.catchUp(c, n0, now);
        if (!n) continue; // overthrown during this batch
        if (online && !p.bot) {
          n = { ...n, lastActiveAt: now };
          c.putNation(n);
        }
        advanced++;
      }
      for (const n of expired) this.loseNation(c, n, 'inactivity', now);
      const built = this.completeConstruction(c, now);
      if (advanced || expired.length) c.addAudit(SYSTEM, 'tick', null, `economy advanced for ${advanced} countries; ${expired.length} lost to inactivity; ${built} constructions completed`);
      if (!c.empty) await this.commit(c);
    });
  }

  /** The nation is lost; its treasury and stock go to a random active country. */
  private loseNation(c: Changes, n: Nation, reason: LostReason, now: number): void {
    const p = c.player(n.playerId);
    const name = this.nationName(n);
    const candidates: number[] = [];
    for (const other of this.world.nations.values()) {
      if (other.id === n.id || !c.nation(other.id)) continue;
      const op = c.player(other.playerId);
      if (!op) continue;
      if (this.isOnline(op) || op.bot || !isInactiveExpired(other, false, false, now, this.cfg)) candidates.push(other.id);
    }
    const heirId = chooseHeir(candidates, this.deps.rng);
    const heir = heirId === null ? null : c.nation(heirId);
    let heirText = 'Its assets were lost: no active country could inherit them.';
    if (heir) {
      c.putNation(inheritAssets(heir, n));
      const hp = c.player(heir.playerId);
      heirText = `Its treasury ($${n.funds.toLocaleString('en-US')}) and stock went to ${this.nationName(heir)}.`;
      if (hp) c.addInbox(hp.id, 'info', `Inheritance from ${name}`, `${name} was lost (${reason}). You received $${n.funds.toLocaleString('en-US')} and its stored resources.`);
      c.addAudit(SYSTEM, 'inherit', heir.id, `received $${n.funds} and stock from ${name} (${reason})`);
    }
    const cells: number[] = [];
    for (let cell = 0; cell < COUNTRY_COUNT; cell++) if (c.cellOwner(cell) === n.id) cells.push(cell);
    c.removeNation(n.id);
    const why =
      reason === 'inactivity'
        ? `${p?.name ?? 'its governor'} was inactive for ${this.cfg.inactivityGameHours} game hours`
        : reason === 'overthrow'
          ? `its citizens overthrew the government after satisfaction stayed at or below ${SIM.overthrowAt}%`
          : 'it was conquered';
    if (p) {
      c.putPlayer({ ...p, nationId: null, lostReason: reason });
      c.addInbox(p.id, 'danger', `${name} was lost`, `${name} was lost because ${why}. ${heirText}`, now);
      this.onPlayerChanged?.(p.id);
    }
    c.addAudit(SYSTEM, 'lose-country', n.id, `${name} lost (${reason}); cells ${cells.join(',')} freed`);
    c.addLog(reason === 'overthrow' ? 'overthrow' : 'inactivity', `${name} was lost: ${why}. ${heirText}`, cells);
  }

  private summarize(p: PlayerRec, away: AwaySnapshot, n: Nation | null, now: number): AwaySummary {
    const events = (this.world.inbox.get(p.id) ?? []).filter((m) => m.at >= away.at);
    const names = new Set<string>([...Object.keys(away.stock), ...(n ? Object.keys(n.stock) : [])]);
    return {
      since: away.at,
      until: now,
      ticks: Math.floor((now - away.at) / tickMs(this.cfg)),
      funds: [away.funds, n?.funds ?? 0],
      population: [away.population, n?.population ?? 0],
      satisfaction: [away.satisfaction, n?.satisfaction ?? 0],
      resources: [...names].sort().map((name) => ({
        name,
        before: away.stock[name as ResourceName] ?? 0,
        after: n?.stock[name as ResourceName] ?? 0,
      })),
      events,
      lost: n ? null : p.lostReason,
    };
  }
}

function snapshotOf(n: Nation, at: number): AwaySnapshot {
  return { at, funds: n.funds, population: n.population, satisfaction: n.satisfaction, stock: { ...n.stock } };
}
