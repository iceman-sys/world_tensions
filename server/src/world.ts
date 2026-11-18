import type { AuditEntry, InboxItem, InboxKind, LogEntry, LogKind, Nation, NewsItem, PlayerRec, SessionRec } from '../../shared/model.ts';
import type { Citizen } from '../../shared/country/citizens.ts';
import type { Building } from '../../shared/country/buildings.ts';
import { COUNTRY_COUNT } from '../../shared/resources.ts';
import { INBOX_MEMORY, LOG_MEMORY, NEWS_MEMORY, type ChangeSet, type WorldSnapshot } from './db/repository.ts';

export type SeqKind = 'nation' | 'log' | 'audit' | 'inbox' | 'building' | 'news';

/**
 * In-memory authoritative world. It is only ever modified through `apply`, with
 * the same ChangeSet that was committed to the repository, so memory and
 * storage cannot drift apart.
 */
export class World {
  readonly meta = new Map<string, string>();
  readonly players = new Map<string, PlayerRec>();
  readonly sessions = new Map<string, SessionRec>();
  readonly nations = new Map<number, Nation>();
  /** nation id per cell, -1 = unclaimed */
  readonly territory = new Int32Array(COUNTRY_COUNT).fill(-1);
  log: LogEntry[] = [];
  readonly inbox = new Map<string, InboxItem[]>();
  readonly buildings = new Map<number, Building>();
  /** featured citizens per nation */
  readonly citizens = new Map<number, Citizen[]>();
  /** recent country news per nation (oldest first) */
  readonly news = new Map<number, NewsItem[]>();

  static fromSnapshot(s: WorldSnapshot): World {
    const w = new World();
    for (const [k, v] of s.meta) w.meta.set(k, v);
    for (const p of s.players) w.players.set(p.id, p);
    for (const x of s.sessions) w.sessions.set(x.tokenHash, x);
    for (const n of s.nations) w.nations.set(n.id, n);
    s.territory.forEach((n, cell) => (w.territory[cell] = n ?? -1));
    w.log = s.log.slice(-LOG_MEMORY);
    for (const m of s.inbox) w.pushInbox(m);
    for (const b of s.buildings) w.buildings.set(b.id, b);
    for (const [nid, list] of s.citizens) w.citizens.set(nid, list);
    for (const item of s.news) w.pushNews(item);
    return w;
  }

  buildingsOf(nationId: number): Building[] {
    const out: Building[] = [];
    for (const b of this.buildings.values()) if (b.nationId === nationId) out.push(b);
    return out;
  }

  apply(cs: ChangeSet): void {
    if (cs.meta) for (const [k, v] of Object.entries(cs.meta)) this.meta.set(k, v);
    for (const p of cs.players ?? []) this.players.set(p.id, p);
    for (const s of cs.sessions ?? []) this.sessions.set(s.tokenHash, s);
    for (const id of cs.deleteSessionsOf ?? []) {
      for (const [h, s] of this.sessions) if (s.playerId === id) this.sessions.delete(h);
    }
    for (const n of cs.nations ?? []) this.nations.set(n.id, n);
    for (const [cell, nation] of cs.territory ?? []) this.territory[cell] = nation ?? -1;
    for (const [nid, list] of cs.citizens ?? []) this.citizens.set(nid, list);
    for (const item of cs.news ?? []) this.pushNews(item);
    for (const b of cs.buildings ?? []) this.buildings.set(b.id, b);
    for (const id of cs.deleteBuildings ?? []) this.buildings.delete(id);
    for (const id of cs.deleteNations ?? []) {
      this.nations.delete(id);
      for (let c = 0; c < COUNTRY_COUNT; c++) if (this.territory[c] === id) this.territory[c] = -1;
      // the database cascades; mirror it in memory
      for (const [bid, b] of this.buildings) if (b.nationId === id) this.buildings.delete(bid);
      this.citizens.delete(id);
      this.news.delete(id);
    }
    for (const id of cs.deletePlayers ?? []) {
      this.players.delete(id);
      this.inbox.delete(id);
      for (const [h, s] of this.sessions) if (s.playerId === id) this.sessions.delete(h);
    }
    if (cs.log?.length) {
      this.log.push(...cs.log);
      if (this.log.length > LOG_MEMORY) this.log = this.log.slice(-LOG_MEMORY);
    }
    for (const m of cs.inbox ?? []) this.pushInbox(m);
  }

  private pushNews(item: NewsItem): void {
    const list = this.news.get(item.nationId) ?? [];
    list.push(item);
    if (list.length > NEWS_MEMORY) list.splice(0, list.length - NEWS_MEMORY);
    this.news.set(item.nationId, list);
  }

  private pushInbox(m: InboxItem): void {
    const list = this.inbox.get(m.playerId) ?? [];
    list.push(m);
    if (list.length > INBOX_MEMORY) list.splice(0, list.length - INBOX_MEMORY);
    this.inbox.set(m.playerId, list);
  }

  seq(kind: SeqKind): number {
    return Number(this.meta.get(`seq.${kind}`) ?? 0);
  }

  cellsOf(nationId: number): number[] {
    const out: number[] = [];
    for (let c = 0; c < COUNTRY_COUNT; c++) if (this.territory[c] === nationId) out.push(c);
    return out;
  }

  freeCells(): number[] {
    const out: number[] = [];
    for (let c = 0; c < COUNTRY_COUNT; c++) if (this.territory[c] === -1) out.push(c);
    return out;
  }

  nationOfPlayer(p: PlayerRec): Nation | null {
    return p.nationId === null ? null : this.nations.get(p.nationId) ?? null;
  }

  playerByName(name: string): PlayerRec | null {
    const lower = name.toLowerCase();
    for (const p of this.players.values()) if (p.name.toLowerCase() === lower) return p;
    return null;
  }
}

/**
 * Accumulates one atomic ChangeSet. Later writes of the same entity replace
 * earlier ones, and id sequences are allocated here so the whole action can be
 * computed before anything is committed.
 */
export class Changes {
  private readonly players = new Map<string, PlayerRec>();
  private readonly nations = new Map<number, Nation>();
  private readonly territory = new Map<number, number | null>();
  private readonly sessions: SessionRec[] = [];
  private readonly deleteSessionsOf: string[] = [];
  private readonly deleteNations: number[] = [];
  private readonly deletePlayers: string[] = [];
  private readonly meta: Record<string, string> = {};
  private readonly log: LogEntry[] = [];
  private readonly audit: AuditEntry[] = [];
  private readonly inbox: InboxItem[] = [];
  private readonly buildings = new Map<number, Building>();
  private readonly deleteBuildings: number[] = [];
  private readonly citizens = new Map<number, Citizen[]>();
  private readonly news: NewsItem[] = [];
  private readonly seqs = new Map<SeqKind, number>();

  constructor(private readonly world: World, private readonly now: number) {}

  /** Current (possibly already changed in this set) view of a nation. */
  nation(id: number): Nation | null {
    if (this.deleteNations.includes(id)) return null;
    return this.nations.get(id) ?? this.world.nations.get(id) ?? null;
  }

  player(id: string): PlayerRec | null {
    if (this.deletePlayers.includes(id)) return null;
    return this.players.get(id) ?? this.world.players.get(id) ?? null;
  }

  /** Nation id per cell including pending territory changes (-1 = unclaimed). */
  cellOwner(cell: number): number {
    if (this.territory.has(cell)) return this.territory.get(cell) ?? -1;
    const n = this.world.territory[cell];
    return n >= 0 && this.deleteNations.includes(n) ? -1 : n;
  }

  nextId(kind: SeqKind): number {
    const v = (this.seqs.get(kind) ?? this.world.seq(kind)) + 1;
    this.seqs.set(kind, v);
    this.meta[`seq.${kind}`] = String(v);
    return v;
  }

  putPlayer(p: PlayerRec): void {
    this.players.set(p.id, p);
  }

  putNation(n: Nation): void {
    this.nations.set(n.id, n);
  }

  setCell(cell: number, nationId: number | null): void {
    this.territory.set(cell, nationId);
  }

  removeNation(id: number): void {
    this.nations.delete(id);
    this.deleteNations.push(id);
    for (let c = 0; c < COUNTRY_COUNT; c++) if (this.cellOwner(c) === id) this.territory.set(c, null);
  }

  removePlayer(id: string): void {
    this.players.delete(id);
    this.deletePlayers.push(id);
  }

  putSession(s: SessionRec): void {
    this.sessions.push(s);
  }

  dropSessionsOf(playerId: string): void {
    this.deleteSessionsOf.push(playerId);
  }

  setMeta(key: string, value: string): void {
    this.meta[key] = value;
  }

  addLog(kind: LogKind, text: string, cells: number[] = []): LogEntry {
    const e: LogEntry = { id: this.nextId('log'), at: this.now, kind, text, cells };
    this.log.push(e);
    return e;
  }

  /** Audit entry; the actor's governor name is recorded alongside the id. */
  addAudit(actor: string, action: string, nationId: number | null, detail: string): void {
    const actorName = actor === 'system' ? 'system' : this.player(actor)?.name ?? actor;
    this.audit.push({ id: this.nextId('audit'), at: this.now, actor, actorName, action, nationId, detail });
  }

  building(id: number): Building | null {
    if (this.deleteBuildings.includes(id)) return null;
    return this.buildings.get(id) ?? this.world.buildings.get(id) ?? null;
  }

  /** Buildings of a nation including pending changes. */
  buildingsOf(nationId: number): Building[] {
    const out = new Map<number, Building>();
    for (const b of this.world.buildings.values()) if (b.nationId === nationId) out.set(b.id, b);
    for (const b of this.buildings.values()) if (b.nationId === nationId) out.set(b.id, b);
    for (const id of this.deleteBuildings) out.delete(id);
    return [...out.values()];
  }

  citizensOf(nationId: number): Citizen[] {
    return this.citizens.get(nationId) ?? this.world.citizens.get(nationId) ?? [];
  }

  putCitizens(nationId: number, list: Citizen[]): void {
    this.citizens.set(nationId, list);
  }

  addNews(nationId: number, text: string, at = this.now, kind: NewsItem['kind'] = 'fact'): void {
    this.news.push({ id: this.nextId('news'), nationId, at, kind, text });
  }

  putBuilding(b: Building): void {
    this.buildings.set(b.id, b);
  }

  removeBuilding(id: number): void {
    this.buildings.delete(id);
    this.deleteBuildings.push(id);
  }

  addInbox(playerId: string, kind: InboxKind, title: string, body: string, at = this.now): InboxItem {
    const m: InboxItem = { id: this.nextId('inbox'), playerId, at, kind, title, body };
    this.inbox.push(m);
    return m;
  }

  get empty(): boolean {
    return (
      !this.players.size && !this.nations.size && !this.territory.size && !this.sessions.length && !this.deleteSessionsOf.length &&
      !this.deleteNations.length && !this.deletePlayers.length && !Object.keys(this.meta).length && !this.log.length &&
      !this.audit.length && !this.inbox.length && !this.buildings.size && !this.deleteBuildings.length && !this.citizens.size && !this.news.length
    );
  }

  build(): ChangeSet {
    return {
      meta: this.meta,
      players: [...this.players.values()],
      deletePlayers: this.deletePlayers,
      sessions: this.sessions,
      deleteSessionsOf: this.deleteSessionsOf,
      nations: [...this.nations.values()],
      deleteNations: this.deleteNations,
      territory: [...this.territory.entries()],
      log: this.log,
      audit: this.audit,
      inbox: this.inbox,
      buildings: [...this.buildings.values()],
      deleteBuildings: this.deleteBuildings,
      citizens: [...this.citizens.entries()].filter(([nid]) => !this.deleteNations.includes(nid)),
      news: this.news.filter((e) => !this.deleteNations.includes(e.nationId)),
    };
  }
}
