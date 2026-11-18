/**
 * Storage boundary. The game keeps the authoritative world in memory and sends
 * every change through `commit` as one atomic ChangeSet, so a backend only has
 * to implement load + atomic commit. SQLite implements it today; a PostgreSQL
 * adapter would implement the same interface (see README, "Path to production").
 */
import type { AuditEntry, InboxItem, LogEntry, Nation, PlayerRec, SessionRec } from '../../../shared/model.ts';

export interface ChangeSet {
  meta?: Record<string, string>;
  players?: PlayerRec[];
  deletePlayers?: string[];
  sessions?: SessionRec[];
  /** removes every session of these player ids */
  deleteSessionsOf?: string[];
  nations?: Nation[];
  deleteNations?: number[];
  /** [cell, nationId | null] */
  territory?: [number, number | null][];
  log?: LogEntry[];
  audit?: AuditEntry[];
  inbox?: InboxItem[];
}

export interface WorldSnapshot {
  meta: Map<string, string>;
  players: PlayerRec[];
  sessions: SessionRec[];
  nations: Nation[];
  /** nation id per cell (null = unclaimed) */
  territory: (number | null)[];
  /** most recent world log entries, oldest first */
  log: LogEntry[];
  /** most recent inbox items per player, oldest first */
  inbox: InboxItem[];
}

export interface Repository {
  /** Loads the persisted world (empty collections for a fresh database). */
  load(): Promise<WorldSnapshot>;
  /** Applies every change in one transaction: all or nothing. */
  commit(changes: ChangeSet): Promise<void>;
  /** Most recent audit entries, newest first (optionally for one nation). */
  audit(limit: number, nationId?: number): Promise<AuditEntry[]>;
  close(): Promise<void>;
}

export const LOG_MEMORY = 300;
export const INBOX_MEMORY = 100;
