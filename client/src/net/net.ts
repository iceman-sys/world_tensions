import type { AwaySummary, ClientConfig, ClientMessage, CountryState, EarthCounts, ErrorCode, NationView, ServerMessage, You } from '../../../shared/protocol.ts';
import type { LogEntry } from '../../../shared/model.ts';
import type { Building, BuildingKind } from '../../../shared/country/buildings.ts';
import { COUNTRY_COUNT } from '../../../shared/resources.ts';

const emptyCell = (id: number): CountryState => ({ id, owner: null, online: false, lastSeen: 0, bot: false, nationId: null, homeCell: id, lostAt: null });
const LOG_KEEP = 200;

export type NetStatus = 'disabled' | 'connecting' | 'online' | 'reconnecting';

const TOKEN_KEY = 'wt.session';

function readToken(): string | null {
  try {
    return localStorage.getItem(TOKEN_KEY);
  } catch {
    return null;
  }
}

function writeToken(token: string | null): void {
  try {
    if (token) localStorage.setItem(TOKEN_KEY, token);
    else localStorage.removeItem(TOKEN_KEY);
  } catch {
    /* storage unavailable: session just won't survive a reload */
  }
}

/** WebSocket client with automatic reconnect and session restore. */
export class NetClient {
  status: NetStatus;
  you: You | null = null;
  seed: number | null = null;
  devTools = false;
  readonly countries: CountryState[] = Array.from({ length: COUNTRY_COUNT }, (_, id) => emptyCell(id));
  readonly nations = new Map<number, NationView>();
  /** authoritative neighbour graph from the server (null until welcomed) */
  neighbors: number[][] | null = null;
  config: ClientConfig | null = null;
  log: LogEntry[] = [];
  counts: EarthCounts = { slotsUsed: 0, online: 0, offline: 0, defeated: 0 };
  /** server clock minus local clock, for countdowns */
  private clockOffset = 0;

  onStatus: ((s: NetStatus) => void) | null = null;
  onWelcome: ((seed: number) => void) | null = null;
  onCountries: ((changed: number[]) => void) | null = null;
  onNations: ((changed: number[]) => void) | null = null;
  onJoined: ((you: You) => void) | null = null;
  onYou: ((you: You) => void) | null = null;
  onAway: ((summary: AwaySummary) => void) | null = null;
  onLog: ((entries: LogEntry[]) => void) | null = null;
  onError: ((code: ErrorCode, message: string) => void) | null = null;
  /** private country-view data for your own nation (only ever sent to you) */
  readonly localBuildings = new Map<number, Building>();
  localNationId: number | null = null;
  onLocal: ((changed: Building[], removed: number[], full: boolean) => void) | null = null;
  onBuildResult: ((ok: boolean, message: string) => void) | null = null;
  private wantLocal = false;

  private ws: WebSocket | null = null;
  private retry = 0;
  private retryTimer = 0;
  private pingTimer = 0;
  private everConnected = false;

  constructor(private readonly url: string | null) {
    this.status = url ? 'connecting' : 'disabled';
  }

  get enabled(): boolean {
    return this.url !== null;
  }

  /** Current time on the server's clock (epoch ms). */
  serverNow(): number {
    return Date.now() + this.clockOffset;
  }

  /** Nation holding a cell, if any. */
  nationAt(cell: number): NationView | null {
    const id = this.countries[cell]?.nationId;
    return id === null || id === undefined ? null : this.nations.get(id) ?? null;
  }

  myNation(): NationView | null {
    const id = this.you?.nationId;
    return id === null || id === undefined ? null : this.nations.get(id) ?? null;
  }

  connect(): void {
    if (!this.url) return;
    this.setStatus(this.everConnected ? 'reconnecting' : 'connecting');
    let ws: WebSocket;
    try {
      ws = new WebSocket(this.url);
    } catch {
      this.scheduleReconnect();
      return;
    }
    this.ws = ws;
    ws.onopen = () => {
      this.retry = 0;
      this.send({ t: 'hello', token: readToken() });
      window.clearInterval(this.pingTimer);
      this.pingTimer = window.setInterval(() => this.send({ t: 'ping' }), 20000);
    };
    ws.onmessage = (e) => {
      if (typeof e.data !== 'string') return;
      let msg: ServerMessage;
      try {
        msg = JSON.parse(e.data) as ServerMessage;
      } catch {
        return;
      }
      this.handle(msg);
    };
    ws.onclose = () => {
      window.clearInterval(this.pingTimer);
      if (this.ws === ws) this.ws = null;
      this.scheduleReconnect();
    };
    ws.onerror = () => {
      /* onclose follows and handles reconnection */
    };
  }

  join(name: string): void {
    this.send({ t: 'join', name });
  }

  setBots(on: boolean): void {
    this.send({ t: 'dev:bots', on });
  }

  /** Subscribe to your own nation's country-view data (re-sent after reconnects). */
  openLocal(): void {
    this.wantLocal = true;
    this.send({ t: 'local:open' });
  }

  closeLocal(): void {
    this.wantLocal = false;
    this.localBuildings.clear();
    this.localNationId = null;
    this.send({ t: 'local:close' });
  }

  build(kind: BuildingKind, i: number, j: number, rot: 0 | 1): void {
    this.send({ t: 'build', kind, i, j, rot });
  }

  cancelBuild(id: number): void {
    this.send({ t: 'build:cancel', id });
  }

  private send(msg: ClientMessage): void {
    if (this.ws && this.ws.readyState === WebSocket.OPEN) this.ws.send(JSON.stringify(msg));
  }

  private scheduleReconnect(): void {
    window.clearTimeout(this.retryTimer);
    this.setStatus(this.everConnected ? 'reconnecting' : 'connecting');
    const delay = Math.min(8000, 800 * 2 ** this.retry);
    this.retry = Math.min(this.retry + 1, 4);
    this.retryTimer = window.setTimeout(() => this.connect(), delay);
  }

  private setStatus(s: NetStatus): void {
    if (s === this.status) return;
    this.status = s;
    this.onStatus?.(s);
  }

  private applyCountries(list: CountryState[]): number[] {
    const changed: number[] = [];
    for (const c of list) {
      if (c.id < 0 || c.id >= COUNTRY_COUNT) continue;
      this.countries[c.id] = c;
      changed.push(c.id);
    }
    return changed;
  }

  private handle(msg: ServerMessage): void {
    switch (msg.t) {
      case 'welcome': {
        this.everConnected = true;
        this.seed = msg.seed;
        this.you = msg.you;
        this.devTools = msg.devTools;
        this.config = msg.config;
        this.neighbors = msg.neighbors;
        this.clockOffset = msg.now - Date.now();
        this.log = msg.log.slice(-LOG_KEEP);
        if (!msg.you) writeToken(null);
        for (let id = 0; id < COUNTRY_COUNT; id++) this.countries[id] = emptyCell(id);
        this.applyCountries(msg.countries);
        this.nations.clear();
        for (const n of msg.nations) this.nations.set(n.id, n);
        this.counts = msg.counts;
        this.setStatus('online');
        this.onWelcome?.(msg.seed);
        this.onCountries?.(this.countries.map((c) => c.id));
        this.onNations?.([...this.nations.keys()]);
        this.onLog?.(this.log);
        if (this.wantLocal && msg.you && msg.you.countryId >= 0) this.send({ t: 'local:open' });
        break;
      }
      case 'local:state': {
        this.clockOffset = msg.now - Date.now();
        this.localNationId = msg.state.nationId;
        this.localBuildings.clear();
        for (const b of msg.state.buildings) this.localBuildings.set(b.id, b);
        this.onLocal?.(msg.state.buildings, [], true);
        break;
      }
      case 'local:diff': {
        if (msg.nationId !== this.localNationId) break;
        this.clockOffset = msg.now - Date.now();
        for (const b of msg.buildings) this.localBuildings.set(b.id, b);
        for (const id of msg.removed) this.localBuildings.delete(id);
        this.onLocal?.(msg.buildings, msg.removed, false);
        break;
      }
      case 'build:result':
        this.onBuildResult?.(msg.ok, msg.message);
        break;
      case 'joined':
        this.you = msg.you;
        writeToken(msg.token);
        this.onJoined?.(msg.you);
        break;
      case 'you': {
        const hadCountry = (this.you?.countryId ?? -1) >= 0;
        this.you = msg.you;
        if (!hadCountry && msg.you.countryId >= 0) this.onJoined?.(msg.you);
        else this.onYou?.(msg.you);
        break;
      }
      case 'diff': {
        this.counts = msg.counts;
        this.clockOffset = msg.now - Date.now();
        for (const n of msg.nations) this.nations.set(n.id, n);
        for (const id of msg.removedNations) this.nations.delete(id);
        this.onCountries?.(this.applyCountries(msg.countries));
        if (msg.nations.length || msg.removedNations.length) this.onNations?.([...msg.nations.map((n) => n.id), ...msg.removedNations]);
        break;
      }
      case 'away':
        this.onAway?.(msg.summary);
        break;
      case 'log':
        this.log = [...this.log, ...msg.entries].slice(-LOG_KEEP);
        this.onLog?.(msg.entries);
        break;
      case 'error':
        this.onError?.(msg.code, msg.message);
        break;
      case 'pong':
        break;
    }
  }
}

/** Server URL: VITE_WS_URL at build time, or the local dev server during development. */
export function resolveServerUrl(): string | null {
  const configured = import.meta.env.VITE_WS_URL as string | undefined;
  if (configured) return configured;
  if (import.meta.env.DEV) return `ws://${location.hostname || 'localhost'}:8787`;
  return null;
}
