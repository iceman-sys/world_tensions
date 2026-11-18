import { createHash } from 'node:crypto';
import { generateEarthMeta, type EarthMeta } from '../../shared/earth.ts';
import { gameHoursToMs, inactivityMs, protectionMs, tickMs, type GameConfig } from '../../shared/config.ts';
import { cellCapacity, foundNation, simulateUntil } from '../../shared/economy.ts';
import { chooseHeir, inactivityDeadline, inheritAssets, isInactiveExpired } from '../../shared/inactivity.ts';
import type { AwaySnapshot, LogEntry, LostReason, Nation, PlayerRec } from '../../shared/model.ts';
import type { AwaySummary, ClientConfig, CountryState, EarthCounts, ErrorCode, NationView, You } from '../../shared/protocol.ts';
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

export interface LocalState {
  nationId: number;
  buildings: Building[];
}

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
  private readonly capacity: number[];
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
  /** per-nation local changes (buildings), delivered only to that nation's governors */
  private readonly localDirty = new Map<number, { changed: Set<number>; removed: Set<number> }>();
  private readonly terrain: TerrainCache;
  /** private notifications for a player (e.g. their country was lost) */
  onPlayerChanged: ((playerId: string) => void) | null = null;
  onDirty: (() => void) | null = null;

  private constructor(private readonly deps: GameDeps, world: World, meta: EarthMeta, neighbors: number[][]) {
    this.world = world;
    this.meta = meta;
    this.seed = meta.seed;
    this.neighbors = neighbors;
    this.capacity = meta.countries.map(cellCapacity);
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

  private localFor(nationId: number): { changed: Set<number>; removed: Set<number> } {
    let d = this.localDirty.get(nationId);
    if (!d) {
      d = { changed: new Set(), removed: new Set() };
      this.localDirty.set(nationId, d);
    }
    return d;
  }

  /**
   * Local (private) changes per nation since the last call. The network layer
   * sends each entry only to that nation's own governors.
   */
  drainLocal(): Map<number, { buildings: Building[]; removed: number[] }> {
    const out = new Map<number, { buildings: Building[]; removed: number[] }>();
    for (const [nid, d] of this.localDirty) {
      const buildings: Building[] = [];
      for (const id of d.changed) {
        const b = this.world.buildings.get(id);
        if (b) buildings.push(b);
      }
      out.set(nid, { buildings, removed: [...d.removed] });
    }
    this.localDirty.clear();
    return out;
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

  private capacityOf(c: Changes, nationId: number): number {
    let cap = 0;
    for (let cell = 0; cell < COUNTRY_COUNT; cell++) if (c.cellOwner(cell) === nationId) cap += this.capacity[cell];
    return cap;
  }

  /** Brings a nation's economy up to `until` in one batch and stages the result. */
  private catchUp(c: Changes, n: Nation, until: number): Nation {
    const r = simulateUntil(n, until, { cfg: this.cfg, capacity: this.capacityOf(c, n.id) }, tickMs(this.cfg));
    if (r.nation.lastTickAt !== n.lastTickAt) c.putNation(r.nation);
    return r.nation;
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
        n = { ...n, lastActiveAt: now };
        c.putNation(n);
      }
      const summary = p.away ? this.summarize(p, p.away, n, now) : null;
      c.putPlayer({ ...p, lastSeen: now, away: null });
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
      n = { ...n, lastActiveAt: now };
      c.putNation(n);
    }
    c.putPlayer({ ...p, lastSeen: now, away: n ? snapshotOf(n, now) : p.away });
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
    for (const p of planStarterTown(t, t.capital)) {
      c.putBuilding({ id: c.nextId('building'), nationId: n.id, kind: p.kind, i: p.i, j: p.j, rot: p.rot, status: 'done', startedAt: now, completesAt: now });
    }
    c.addAudit(SYSTEM, 'starter-town', n.id, `starter town founded at tile ${t.capital.i},${t.capital.j}`);
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
      if (this.world.buildingsOf(n.id).length === 0) {
        const c = new Changes(this.world, this.deps.clock());
        this.addStarterTown(c, n, this.deps.clock());
        await this.commit(c);
      }
      return { nationId: n.id, buildings: this.world.buildingsOf(n.id) };
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
          expired.push(this.catchUp(c, n0, inactivityDeadline(n0, cfg)));
          continue;
        }
        const due = Math.floor((now - n0.lastTickAt) / tms);
        if (due < 1 || (!online && !p.bot && due < cfg.sweepEveryTicks)) continue;
        let n = this.catchUp(c, n0, now);
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
    if (p) {
      c.putPlayer({ ...p, nationId: null, lostReason: reason });
      c.addInbox(p.id, 'danger', `${name} was lost`, reason === 'inactivity' ? `You were away longer than ${this.cfg.inactivityGameHours} game hours. ${heirText}` : heirText);
      this.onPlayerChanged?.(p.id);
    }
    c.addAudit(SYSTEM, 'lose-country', n.id, `${name} lost (${reason}); cells ${cells.join(',')} freed`);
    c.addLog('inactivity', `${name} was lost: ${p?.name ?? 'its governor'} was inactive for ${this.cfg.inactivityGameHours} game hours. ${heirText}`, cells);
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
