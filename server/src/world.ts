import type { AuditEntry, InboxItem, InboxKind, LogEntry, LogKind, Nation, PlayerRec, SessionRec } from '../../shared/model.ts';
import { COUNTRY_COUNT } from '../../shared/resources.ts';
import { INBOX_MEMORY, LOG_MEMORY, type ChangeSet, type WorldSnapshot } from './db/repository.ts';

export type SeqKind = 'nation' | 'log' | 'audit' | 'inbox';

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

  static fromSnapshot(s: WorldSnapshot): World {
    const w = new World();
    for (const [k, v] of s.meta) w.meta.set(k, v);
    for (const p of s.players) w.players.set(p.id, p);
    for (const x of s.sessions) w.sessions.set(x.tokenHash, x);
    for (const n of s.nations) w.nations.set(n.id, n);
    s.territory.forEach((n, cell) => (w.territory[cell] = n ?? -1));
    w.log = s.log.slice(-LOG_MEMORY);
    for (const m of s.inbox) w.pushInbox(m);
    return w;
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
    for (const id of cs.deleteNations ?? []) {
      this.nations.delete(id);
      for (let c = 0; c < COUNTRY_COUNT; c++) if (this.territory[c] === id) this.territory[c] = -1;
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

  addAudit(actor: string, action: string, nationId: number | null, detail: string): void {
    this.audit.push({ id: this.nextId('audit'), at: this.now, actor, action, nationId, detail });
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
      !this.audit.length && !this.inbox.length
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
    };
  }
}
