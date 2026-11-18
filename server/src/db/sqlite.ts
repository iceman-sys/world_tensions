import Database from 'better-sqlite3';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import type { AuditEntry, InboxItem, InboxKind, LogEntry, LogKind, LostReason, Nation, NationHistory, PlayerRec, ResourceAmounts, SessionRec } from '../../../shared/model.ts';
import { COUNTRY_COUNT, RESOURCE_CATALOG, type ResourceName } from '../../../shared/resources.ts';
import { INBOX_MEMORY, LOG_MEMORY, type ChangeSet, type Repository, type WorldSnapshot } from './repository.ts';
import { BUILDING_KINDS, type Building, type BuildingKind } from '../../../shared/country/buildings.ts';

/** Ordered schema migrations; PRAGMA user_version records how many have run. */
const MIGRATIONS: string[] = [
  /* sql */ `
  CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);

  CREATE TABLE players (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL UNIQUE COLLATE NOCASE,
    bot INTEGER NOT NULL DEFAULT 0,
    created_at INTEGER NOT NULL,
    last_seen INTEGER NOT NULL,
    country_id INTEGER,
    away TEXT,
    lost_reason TEXT
  );

  CREATE TABLE sessions (
    token_hash TEXT PRIMARY KEY,
    player_id TEXT NOT NULL REFERENCES players(id) ON DELETE CASCADE,
    created_at INTEGER NOT NULL,
    last_used_at INTEGER NOT NULL
  );
  CREATE INDEX sessions_player ON sessions(player_id);

  CREATE TABLE countries (
    id INTEGER PRIMARY KEY,
    player_id TEXT NOT NULL REFERENCES players(id) ON DELETE CASCADE,
    home_cell INTEGER NOT NULL,
    funds INTEGER NOT NULL,
    population INTEGER NOT NULL,
    satisfaction REAL NOT NULL,
    tax_rate REAL NOT NULL,
    military_size INTEGER NOT NULL,
    military_readiness REAL NOT NULL,
    created_at INTEGER NOT NULL,
    protected_until INTEGER NOT NULL,
    last_active_at INTEGER NOT NULL,
    last_tick_at INTEGER NOT NULL,
    low_sat_ticks INTEGER NOT NULL DEFAULT 0,
    warn_stage INTEGER NOT NULL DEFAULT 0,
    history TEXT NOT NULL
  );

  CREATE TABLE country_resources (
    country_id INTEGER NOT NULL REFERENCES countries(id) ON DELETE CASCADE,
    resource TEXT NOT NULL,
    stock REAL NOT NULL DEFAULT 0,
    production REAL NOT NULL DEFAULT 0,
    PRIMARY KEY (country_id, resource)
  );

  CREATE TABLE territory (
    cell INTEGER PRIMARY KEY,
    country_id INTEGER REFERENCES countries(id) ON DELETE SET NULL
  );

  CREATE TABLE market_offers (
    id INTEGER PRIMARY KEY,
    seller_id INTEGER NOT NULL,
    resource TEXT NOT NULL,
    quantity INTEGER NOT NULL,
    remaining INTEGER NOT NULL,
    price INTEGER NOT NULL,
    status TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    closed_at INTEGER
  );
  CREATE INDEX market_offers_open ON market_offers(status, resource);

  CREATE TABLE transactions (
    id INTEGER PRIMARY KEY,
    at INTEGER NOT NULL,
    offer_id INTEGER NOT NULL,
    buyer_id INTEGER NOT NULL,
    seller_id INTEGER NOT NULL,
    resource TEXT NOT NULL,
    quantity INTEGER NOT NULL,
    price INTEGER NOT NULL,
    total INTEGER NOT NULL
  );

  CREATE TABLE wars (
    id INTEGER PRIMARY KEY,
    attacker_id INTEGER NOT NULL,
    defender_id INTEGER NOT NULL,
    status TEXT NOT NULL,
    started_at INTEGER NOT NULL,
    ended_at INTEGER,
    winner_id INTEGER,
    state TEXT NOT NULL
  );

  CREATE TABLE world_log (
    id INTEGER PRIMARY KEY,
    at INTEGER NOT NULL,
    kind TEXT NOT NULL,
    text TEXT NOT NULL,
    cells TEXT NOT NULL
  );

  CREATE TABLE audit_log (
    id INTEGER PRIMARY KEY,
    at INTEGER NOT NULL,
    actor TEXT NOT NULL,
    action TEXT NOT NULL,
    country_id INTEGER,
    detail TEXT NOT NULL
  );
  CREATE INDEX audit_country ON audit_log(country_id, id);

  CREATE TABLE inbox (
    id INTEGER PRIMARY KEY,
    player_id TEXT NOT NULL,
    at INTEGER NOT NULL,
    kind TEXT NOT NULL,
    title TEXT NOT NULL,
    body TEXT NOT NULL
  );
  CREATE INDEX inbox_player ON inbox(player_id, id);
  `,
  /* sql */ `
  CREATE TABLE buildings (
    id INTEGER PRIMARY KEY,
    country_id INTEGER NOT NULL REFERENCES countries(id) ON DELETE CASCADE,
    kind TEXT NOT NULL,
    i INTEGER NOT NULL,
    j INTEGER NOT NULL,
    rot INTEGER NOT NULL,
    status TEXT NOT NULL,
    started_at INTEGER NOT NULL,
    completes_at INTEGER NOT NULL
  );
  CREATE INDEX buildings_country ON buildings(country_id);
  ALTER TABLE audit_log ADD COLUMN actor_name TEXT NOT NULL DEFAULT '';
  `,
];

interface PlayerRow { id: string; name: string; bot: number; created_at: number; last_seen: number; country_id: number | null; away: string | null; lost_reason: string | null }
interface SessionRow { token_hash: string; player_id: string; created_at: number; last_used_at: number }
interface CountryRow {
  id: number; player_id: string; home_cell: number; funds: number; population: number; satisfaction: number; tax_rate: number;
  military_size: number; military_readiness: number; created_at: number; protected_until: number; last_active_at: number;
  last_tick_at: number; low_sat_ticks: number; warn_stage: number; history: string;
}
interface ResourceRow { country_id: number; resource: string; stock: number; production: number }
interface LogRow { id: number; at: number; kind: string; text: string; cells: string }
interface AuditRow { id: number; at: number; actor: string; actor_name: string; action: string; country_id: number | null; detail: string }
interface BuildingRow { id: number; country_id: number; kind: string; i: number; j: number; rot: number; status: string; started_at: number; completes_at: number }
interface InboxRow { id: number; player_id: string; at: number; kind: string; title: string; body: string }

const RESOURCES = new Set<string>(RESOURCE_CATALOG);
const isResource = (r: string): r is ResourceName => RESOURCES.has(r);

function parseJson<T>(text: string | null, fallback: T): T {
  if (!text) return fallback;
  try {
    return JSON.parse(text) as T;
  } catch {
    return fallback;
  }
}

/** better-sqlite3 implementation of the repository (synchronous under the hood). */
export class SqliteRepository implements Repository {
  private readonly db: Database.Database;

  constructor(file: string) {
    if (file !== ':memory:') mkdirSync(dirname(file), { recursive: true });
    this.db = new Database(file);
    this.db.pragma('journal_mode = WAL');
    this.db.pragma('synchronous = NORMAL');
    this.db.pragma('foreign_keys = ON');
    this.migrate();
  }

  private migrate(): void {
    const version = this.db.pragma('user_version', { simple: true }) as number;
    for (let v = version; v < MIGRATIONS.length; v++) {
      this.db.transaction(() => {
        this.db.exec(MIGRATIONS[v]);
        this.db.pragma(`user_version = ${v + 1}`);
      })();
    }
  }

  async load(): Promise<WorldSnapshot> {
    const db = this.db;
    const meta = new Map<string, string>();
    for (const r of db.prepare<[], { key: string; value: string }>('SELECT key, value FROM meta').all()) meta.set(r.key, r.value);

    const players = db.prepare<[], PlayerRow>('SELECT * FROM players').all().map(
      (r): PlayerRec => ({
        id: r.id,
        name: r.name,
        bot: r.bot === 1,
        createdAt: r.created_at,
        lastSeen: r.last_seen,
        nationId: r.country_id,
        away: parseJson(r.away, null),
        lostReason: (r.lost_reason as LostReason | null) ?? null,
      }),
    );
    const sessions = db.prepare<[], SessionRow>('SELECT * FROM sessions').all().map(
      (r): SessionRec => ({ tokenHash: r.token_hash, playerId: r.player_id, createdAt: r.created_at, lastUsedAt: r.last_used_at }),
    );

    const stock = new Map<number, ResourceAmounts>();
    const production = new Map<number, ResourceAmounts>();
    for (const r of db.prepare<[], ResourceRow>('SELECT * FROM country_resources').all()) {
      if (!isResource(r.resource)) continue;
      const s = stock.get(r.country_id) ?? {};
      const p = production.get(r.country_id) ?? {};
      if (r.stock !== 0) s[r.resource] = r.stock;
      if (r.production !== 0) p[r.resource] = r.production;
      stock.set(r.country_id, s);
      production.set(r.country_id, p);
    }
    const nations = db.prepare<[], CountryRow>('SELECT * FROM countries').all().map(
      (r): Nation => ({
        id: r.id,
        playerId: r.player_id,
        homeCell: r.home_cell,
        funds: r.funds,
        population: r.population,
        satisfaction: r.satisfaction,
        taxRate: r.tax_rate,
        stock: stock.get(r.id) ?? {},
        production: production.get(r.id) ?? {},
        military: { size: r.military_size, readiness: r.military_readiness },
        createdAt: r.created_at,
        protectedUntil: r.protected_until,
        lastActiveAt: r.last_active_at,
        lastTickAt: r.last_tick_at,
        lowSatTicks: r.low_sat_ticks,
        warnStage: r.warn_stage,
        history: parseJson<NationHistory>(r.history, { funds: [], population: [], satisfaction: [] }),
      }),
    );

    const territory = new Array<number | null>(COUNTRY_COUNT).fill(null);
    for (const r of db.prepare<[], { cell: number; country_id: number | null }>('SELECT cell, country_id FROM territory').all()) {
      if (r.cell >= 0 && r.cell < COUNTRY_COUNT) territory[r.cell] = r.country_id;
    }

    const log = db
      .prepare<[number], LogRow>('SELECT * FROM (SELECT * FROM world_log ORDER BY id DESC LIMIT ?) ORDER BY id')
      .all(LOG_MEMORY)
      .map((r): LogEntry => ({ id: r.id, at: r.at, kind: r.kind as LogKind, text: r.text, cells: parseJson<number[]>(r.cells, []) }));

    const inbox = db
      .prepare<[number], InboxRow>(
        `SELECT id, player_id, at, kind, title, body FROM (
           SELECT *, ROW_NUMBER() OVER (PARTITION BY player_id ORDER BY id DESC) AS rn FROM inbox
         ) WHERE rn <= ? ORDER BY id`,
      )
      .all(INBOX_MEMORY)
      .map((r): InboxItem => ({ id: r.id, playerId: r.player_id, at: r.at, kind: r.kind as InboxKind, title: r.title, body: r.body }));

    const buildings = db
      .prepare<[], BuildingRow>('SELECT * FROM buildings ORDER BY id')
      .all()
      .filter((r) => (BUILDING_KINDS as readonly string[]).includes(r.kind))
      .map(
        (r): Building => ({
          id: r.id,
          nationId: r.country_id,
          kind: r.kind as BuildingKind,
          i: r.i,
          j: r.j,
          rot: r.rot === 1 ? 1 : 0,
          status: r.status === 'done' ? 'done' : 'building',
          startedAt: r.started_at,
          completesAt: r.completes_at,
        }),
      );

    return { meta, players, sessions, nations, territory, log, inbox, buildings };
  }

  async commit(cs: ChangeSet): Promise<void> {
    this.commitSync(cs);
  }

  /** Synchronous commit, used on shutdown where awaiting is not possible. */
  commitSync(cs: ChangeSet): void {
    this.applyTx(cs);
  }

  private readonly applyTx = (cs: ChangeSet): void => {
    const db = this.db;
    db.transaction(() => {
      if (cs.meta) {
        const st = db.prepare('INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value');
        for (const [k, v] of Object.entries(cs.meta)) st.run(k, v);
      }
      if (cs.players?.length) {
        const st = db.prepare(
          `INSERT INTO players (id, name, bot, created_at, last_seen, country_id, away, lost_reason)
           VALUES (@id, @name, @bot, @created_at, @last_seen, @country_id, @away, @lost_reason)
           ON CONFLICT(id) DO UPDATE SET name = excluded.name, bot = excluded.bot, last_seen = excluded.last_seen,
             country_id = excluded.country_id, away = excluded.away, lost_reason = excluded.lost_reason`,
        );
        for (const p of cs.players) {
          st.run({
            id: p.id,
            name: p.name,
            bot: p.bot ? 1 : 0,
            created_at: p.createdAt,
            last_seen: p.lastSeen,
            country_id: p.nationId,
            away: p.away ? JSON.stringify(p.away) : null,
            lost_reason: p.lostReason,
          });
        }
      }
      if (cs.sessions?.length) {
        const st = db.prepare(
          `INSERT INTO sessions (token_hash, player_id, created_at, last_used_at) VALUES (?, ?, ?, ?)
           ON CONFLICT(token_hash) DO UPDATE SET last_used_at = excluded.last_used_at`,
        );
        for (const s of cs.sessions) st.run(s.tokenHash, s.playerId, s.createdAt, s.lastUsedAt);
      }
      if (cs.deleteSessionsOf?.length) {
        const st = db.prepare('DELETE FROM sessions WHERE player_id = ?');
        for (const id of cs.deleteSessionsOf) st.run(id);
      }
      if (cs.nations?.length) {
        const st = db.prepare(
          `INSERT INTO countries (id, player_id, home_cell, funds, population, satisfaction, tax_rate, military_size, military_readiness,
             created_at, protected_until, last_active_at, last_tick_at, low_sat_ticks, warn_stage, history)
           VALUES (@id, @player_id, @home_cell, @funds, @population, @satisfaction, @tax_rate, @military_size, @military_readiness,
             @created_at, @protected_until, @last_active_at, @last_tick_at, @low_sat_ticks, @warn_stage, @history)
           ON CONFLICT(id) DO UPDATE SET player_id = excluded.player_id, home_cell = excluded.home_cell, funds = excluded.funds,
             population = excluded.population, satisfaction = excluded.satisfaction, tax_rate = excluded.tax_rate,
             military_size = excluded.military_size, military_readiness = excluded.military_readiness,
             protected_until = excluded.protected_until, last_active_at = excluded.last_active_at, last_tick_at = excluded.last_tick_at,
             low_sat_ticks = excluded.low_sat_ticks, warn_stage = excluded.warn_stage, history = excluded.history`,
        );
        const delRes = db.prepare('DELETE FROM country_resources WHERE country_id = ?');
        const insRes = db.prepare('INSERT INTO country_resources (country_id, resource, stock, production) VALUES (?, ?, ?, ?)');
        for (const n of cs.nations) {
          st.run({
            id: n.id,
            player_id: n.playerId,
            home_cell: n.homeCell,
            funds: n.funds,
            population: n.population,
            satisfaction: n.satisfaction,
            tax_rate: n.taxRate,
            military_size: n.military.size,
            military_readiness: n.military.readiness,
            created_at: n.createdAt,
            protected_until: n.protectedUntil,
            last_active_at: n.lastActiveAt,
            last_tick_at: n.lastTickAt,
            low_sat_ticks: n.lowSatTicks,
            warn_stage: n.warnStage,
            history: JSON.stringify(n.history),
          });
          delRes.run(n.id);
          const names = new Set<string>([...Object.keys(n.stock), ...Object.keys(n.production)]);
          for (const r of names) {
            if (!isResource(r)) continue;
            insRes.run(n.id, r, n.stock[r] ?? 0, n.production[r] ?? 0);
          }
        }
      }
      if (cs.territory?.length) {
        const st = db.prepare('INSERT INTO territory (cell, country_id) VALUES (?, ?) ON CONFLICT(cell) DO UPDATE SET country_id = excluded.country_id');
        for (const [cell, nation] of cs.territory) st.run(cell, nation);
      }
      if (cs.deleteNations?.length) {
        const st = db.prepare('DELETE FROM countries WHERE id = ?');
        for (const id of cs.deleteNations) st.run(id);
      }
      if (cs.deletePlayers?.length) {
        const st = db.prepare('DELETE FROM players WHERE id = ?');
        for (const id of cs.deletePlayers) st.run(id);
      }
      if (cs.log?.length) {
        const st = db.prepare('INSERT INTO world_log (id, at, kind, text, cells) VALUES (?, ?, ?, ?, ?)');
        for (const e of cs.log) st.run(e.id, e.at, e.kind, e.text, JSON.stringify(e.cells));
      }
      if (cs.audit?.length) {
        const st = db.prepare('INSERT INTO audit_log (id, at, actor, actor_name, action, country_id, detail) VALUES (?, ?, ?, ?, ?, ?, ?)');
        for (const e of cs.audit) st.run(e.id, e.at, e.actor, e.actorName, e.action, e.nationId, e.detail);
      }
      if (cs.buildings?.length) {
        const st = db.prepare(
          `INSERT INTO buildings (id, country_id, kind, i, j, rot, status, started_at, completes_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
           ON CONFLICT(id) DO UPDATE SET status = excluded.status, started_at = excluded.started_at, completes_at = excluded.completes_at`,
        );
        for (const b of cs.buildings) st.run(b.id, b.nationId, b.kind, b.i, b.j, b.rot, b.status, b.startedAt, b.completesAt);
      }
      if (cs.deleteBuildings?.length) {
        const st = db.prepare('DELETE FROM buildings WHERE id = ?');
        for (const id of cs.deleteBuildings) st.run(id);
      }
      if (cs.inbox?.length) {
        const st = db.prepare('INSERT INTO inbox (id, player_id, at, kind, title, body) VALUES (?, ?, ?, ?, ?, ?)');
        for (const m of cs.inbox) st.run(m.id, m.playerId, m.at, m.kind, m.title, m.body);
      }
    })();
  };

  async audit(limit: number, nationId?: number): Promise<AuditEntry[]> {
    const rows =
      nationId === undefined
        ? this.db.prepare<[number], AuditRow>('SELECT * FROM audit_log ORDER BY id DESC LIMIT ?').all(limit)
        : this.db.prepare<[number, number], AuditRow>('SELECT * FROM audit_log WHERE country_id = ? ORDER BY id DESC LIMIT ?').all(nationId, limit);
    return rows.map((r) => ({ id: r.id, at: r.at, actor: r.actor, actorName: r.actor_name, action: r.action, nationId: r.country_id, detail: r.detail }));
  }

  async close(): Promise<void> {
    this.db.close();
  }
}
