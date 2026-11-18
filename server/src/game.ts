import { createHash } from 'node:crypto';
import { generateEarthMeta, type EarthMeta } from '../../shared/earth.ts';
import { inactivityMs, protectionMs, tickMs, type GameConfig } from '../../shared/config.ts';
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
  /** private notifications for a player (e.g. their country was lost) */
  onPlayerChanged: ((playerId: string) => void) | null = null;
  onDirty: (() => void) | null = null;

  private constructor(private readonly deps: GameDeps, world: World, meta: EarthMeta, neighbors: number[][]) {
    this.world = world;
    this.meta = meta;
    this.seed = meta.seed;
    this.neighbors = neighbors;
    this.capacity = meta.countries.map(cellCapacity);
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
    this.world.apply(cs);
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
      if (advanced || expired.length) c.addAudit(SYSTEM, 'tick', null, `economy advanced for ${advanced} countries; ${expired.length} lost to inactivity`);
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
