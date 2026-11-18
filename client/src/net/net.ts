import type { ClientMessage, CountryState, EarthCounts, ErrorCode, ServerMessage, You } from '../../../shared/protocol.ts';
import { COUNTRY_COUNT } from '../../../shared/resources.ts';

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
  readonly countries: CountryState[] = Array.from({ length: COUNTRY_COUNT }, (_, id) => ({
    id,
    owner: null,
    online: false,
    lastSeen: 0,
    bot: false,
  }));
  counts: EarthCounts = { slotsUsed: 0, online: 0, offline: 0, defeated: 0 };

  onStatus: ((s: NetStatus) => void) | null = null;
  onWelcome: ((seed: number) => void) | null = null;
  onCountries: ((changed: number[]) => void) | null = null;
  onJoined: ((you: You) => void) | null = null;
  onError: ((code: ErrorCode, message: string) => void) | null = null;

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
        if (!msg.you) writeToken(null);
        for (const c of this.countries) {
          c.owner = null;
          c.online = false;
          c.bot = false;
        }
        this.applyCountries(msg.countries);
        this.counts = msg.counts;
        this.setStatus('online');
        this.onWelcome?.(msg.seed);
        this.onCountries?.(this.countries.map((c) => c.id));
        break;
      }
      case 'joined':
        this.you = msg.you;
        writeToken(msg.token);
        this.onJoined?.(msg.you);
        break;
      case 'diff':
        this.counts = msg.counts;
        this.onCountries?.(this.applyCountries(msg.countries));
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
