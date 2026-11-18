/**
 * Plain-data game model shared by the rules (/shared), the server and the
 * repository. Everything is JSON-serialisable; money is whole dollars.
 */
import type { ResourceName } from './resources.ts';

export type ResourceAmounts = Partial<Record<ResourceName, number>>;

export interface Military {
  /** troops */
  size: number;
  /** 0..100 */
  readiness: number;
}

/** Recent per-tick values for the dashboard sparklines (oldest first). */
export interface NationHistory {
  funds: number[];
  population: number[];
  satisfaction: number[];
}

export interface Nation {
  id: number;
  playerId: string;
  /** the cell this nation was founded on; its flag is drawn over all of its land */
  homeCell: number;
  /** whole dollars */
  funds: number;
  population: number;
  /** 0..100 */
  satisfaction: number;
  /** percent, 0..60 */
  taxRate: number;
  /** units in storage (stock offered on the market is held in escrow, not here) */
  stock: ResourceAmounts;
  /** units produced per game hour, for the natural resources this nation owns */
  production: ResourceAmounts;
  military: Military;
  createdAt: number;
  protectedUntil: number;
  lastActiveAt: number;
  /** epoch ms up to which the economy has been simulated */
  lastTickAt: number;
  /** consecutive ticks at or below the overthrow threshold */
  lowSatTicks: number;
  /** highest satisfaction warning stage already sent (0 = none) */
  warnStage: number;
  history: NationHistory;
}

export interface AwaySnapshot {
  at: number;
  funds: number;
  population: number;
  satisfaction: number;
  stock: ResourceAmounts;
}

export type LostReason = 'inactivity' | 'overthrow' | 'conquest';

export interface PlayerRec {
  id: string;
  name: string;
  bot: boolean;
  createdAt: number;
  lastSeen: number;
  nationId: number | null;
  /** state of the nation when the governor last left, for the "while you were away" summary */
  away: AwaySnapshot | null;
  /** why the governor's last country was lost (cleared when they found a new one) */
  lostReason: LostReason | null;
}

export interface SessionRec {
  /** sha-256 of the session token; raw tokens are never stored */
  tokenHash: string;
  playerId: string;
  createdAt: number;
  lastUsedAt: number;
}

export type LogKind =
  | 'join'
  | 'rejoin'
  | 'inactivity'
  | 'overthrow'
  | 'trade'
  | 'war-start'
  | 'war-end'
  | 'conquest'
  | 'peace';

export interface LogEntry {
  id: number;
  at: number;
  kind: LogKind;
  text: string;
  /** cells to highlight / fly to */
  cells: number[];
}

export interface AuditEntry {
  id: number;
  at: number;
  /** player id, or "system" for rule-driven changes */
  actor: string;
  /** governor name at the time of the action ("system" for rules) */
  actorName: string;
  action: string;
  nationId: number | null;
  detail: string;
}

export type InboxKind = 'info' | 'warning' | 'danger' | 'trade' | 'war';

export interface InboxItem {
  id: number;
  playerId: string;
  at: number;
  kind: InboxKind;
  title: string;
  body: string;
}
