/**
 * Game constants and time scaling. Pure: the server passes its environment in,
 * so rules and tests never read process.env or the wall clock themselves.
 */

export interface GameConfig {
  /** DEMO_MODE: 1 real second = 1 game minute (timeScale 60) */
  demoMode: boolean;
  /** game milliseconds that elapse per real millisecond */
  timeScale: number;
  /** length of one economy tick, in game minutes */
  tickGameMinutes: number;
  /** offline governors lose their country after this many game hours */
  inactivityGameHours: number;
  /** new countries cannot declare war or be targeted for this many game hours */
  protectionGameHours: number;
  /** offline countries are caught up in one batch once this many ticks are due */
  sweepEveryTicks: number;
  /** upper bound for one catch-up batch (protects the server after very long downtime) */
  maxCatchUpTicks: number;
  /** real seconds each war round lasts (UX timer, not scaled) */
  warRoundSeconds: number;
}

export const NORMAL_CONFIG: GameConfig = {
  demoMode: false,
  timeScale: 1,
  tickGameMinutes: 5,
  inactivityGameHours: 72,
  protectionGameHours: 24,
  sweepEveryTicks: 12,
  maxCatchUpTicks: 100_000,
  warRoundSeconds: 20,
};

export const DEMO_CONFIG: GameConfig = { ...NORMAL_CONFIG, demoMode: true, timeScale: 60 };

const MS_PER_GAME_MINUTE = 60_000;
const MS_PER_GAME_HOUR = 3_600_000;

/** Real milliseconds per economy tick. */
export function tickMs(cfg: GameConfig): number {
  return (cfg.tickGameMinutes * MS_PER_GAME_MINUTE) / cfg.timeScale;
}

/** Real milliseconds for a duration given in game hours. */
export function gameHoursToMs(cfg: GameConfig, hours: number): number {
  return (hours * MS_PER_GAME_HOUR) / cfg.timeScale;
}

export function inactivityMs(cfg: GameConfig): number {
  return gameHoursToMs(cfg, cfg.inactivityGameHours);
}

export function protectionMs(cfg: GameConfig): number {
  return gameHoursToMs(cfg, cfg.protectionGameHours);
}

type Env = Readonly<Record<string, string | undefined>>;

function num(env: Env, key: string, fallback: number, min: number, max: number, warnings: string[]): number {
  const raw = env[key];
  if (raw === undefined || raw === '') return fallback;
  const v = Number(raw);
  if (!Number.isFinite(v) || v < min || v > max) {
    warnings.push(`${key}=${raw} is invalid (expected ${min}..${max}); using ${fallback}`);
    return fallback;
  }
  return v;
}

/**
 * Builds the config from environment variables. DEMO_MODE defaults to on for
 * development servers; every constant can still be overridden individually.
 */
export function configFromEnv(env: Env, isProduction: boolean): { config: GameConfig; warnings: string[] } {
  const warnings: string[] = [];
  const demoRaw = env.DEMO_MODE?.toLowerCase();
  const demoMode = demoRaw === undefined || demoRaw === '' ? !isProduction : demoRaw === 'true' || demoRaw === '1';
  const base = demoMode ? DEMO_CONFIG : NORMAL_CONFIG;
  const config: GameConfig = {
    demoMode,
    timeScale: num(env, 'TIME_SCALE', base.timeScale, 0.001, 100_000, warnings),
    tickGameMinutes: num(env, 'TICK_GAME_MINUTES', base.tickGameMinutes, 0.01, 1440, warnings),
    inactivityGameHours: num(env, 'INACTIVITY_GAME_HOURS', base.inactivityGameHours, 0.001, 10_000, warnings),
    protectionGameHours: num(env, 'PROTECTION_GAME_HOURS', base.protectionGameHours, 0, 10_000, warnings),
    sweepEveryTicks: Math.round(num(env, 'SWEEP_EVERY_TICKS', base.sweepEveryTicks, 1, 10_000, warnings)),
    maxCatchUpTicks: Math.round(num(env, 'MAX_CATCH_UP_TICKS', base.maxCatchUpTicks, 1, 10_000_000, warnings)),
    warRoundSeconds: num(env, 'WAR_ROUND_SECONDS', base.warRoundSeconds, 2, 600, warnings),
  };
  return { config, warnings };
}
