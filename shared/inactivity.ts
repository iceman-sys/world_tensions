/** Inactivity rule: offline governors lose their country after a configurable time. */
import type { GameConfig } from './config.ts';
import { inactivityMs } from './config.ts';
import type { Nation, ResourceAmounts } from './model.ts';
import type { Rng } from './rng.ts';
import type { ResourceName } from './resources.ts';
import { round3 } from './economy.ts';

/** Epoch ms at which an offline nation is lost. */
export function inactivityDeadline(n: Pick<Nation, 'lastActiveAt'>, cfg: GameConfig): number {
  return n.lastActiveAt + inactivityMs(cfg);
}

/** Bots and connected governors never expire. */
export function isInactiveExpired(n: Pick<Nation, 'lastActiveAt'>, online: boolean, bot: boolean, now: number, cfg: GameConfig): boolean {
  return !online && !bot && now >= inactivityDeadline(n, cfg);
}

/** Picks the heir uniformly from the candidate ids (sorted first, so the result depends only on the RNG). */
export function chooseHeir(candidates: readonly number[], rng: Rng): number | null {
  if (candidates.length === 0) return null;
  const sorted = [...candidates].sort((a, b) => a - b);
  return sorted[Math.floor(rng() * sorted.length)];
}

export function addAmounts(a: ResourceAmounts, b: ResourceAmounts): ResourceAmounts {
  const out: ResourceAmounts = { ...a };
  for (const [r, v] of Object.entries(b) as [ResourceName, number][]) out[r] = round3((out[r] ?? 0) + v);
  return out;
}

/** The heir receives all funds and stored resources of the lost nation. Returns the updated heir. */
export function inheritAssets(heir: Nation, lost: Pick<Nation, 'funds' | 'stock'>, extraStock: ResourceAmounts = {}): Nation {
  return { ...heir, funds: heir.funds + Math.max(0, lost.funds), stock: addAmounts(addAmounts(heir.stock, lost.stock), extraStock) };
}
