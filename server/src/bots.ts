import { generateCountryNames } from '../../shared/names.ts';
import { mulberry32, randomSeed } from '../../shared/rng.ts';
import type { Game } from './game.ts';

/** Development bots: join a few dozen countries and flicker online/offline. */
export class DevBots {
  private timers: NodeJS.Timeout[] = [];
  private readonly flicker: NodeJS.Timeout;
  private readonly rng = mulberry32(randomSeed());

  constructor(private readonly game: Game) {
    // persisted bots come back online after a restart
    for (const p of game.world.players.values()) if (p.bot) game.setBotOnline(p.id, this.rng() < 0.7);
    this.flicker = setInterval(() => {
      const bots = [...game.world.players.values()].filter((p) => p.bot);
      if (!bots.length) return;
      const b = bots[Math.floor(this.rng() * bots.length)];
      game.setBotOnline(b.id, !game.isOnline(b));
    }, 1500);
  }

  start(): void {
    this.stop();
    const count = 20 + Math.floor(this.rng() * 31);
    const names = generateCountryNames(this.rng, count + 10).map((n) => `${n.replace(/^.* of /, '')}Bot`.slice(0, 20));
    let delay = 0;
    for (let i = 0; i < count; i++) {
      delay += 150 + this.rng() * 900;
      this.timers.push(
        setTimeout(() => {
          void this.game.join(names[i], { bot: true }).then((r) => {
            if (r.ok) this.game.setBotOnline(r.player.id, this.rng() < 0.7);
          });
        }, delay),
      );
    }
  }

  stop(): void {
    this.timers.forEach(clearTimeout);
    this.timers = [];
    for (const p of [...this.game.world.players.values()]) if (p.bot) void this.game.release(p.id);
  }

  dispose(): void {
    this.timers.forEach(clearTimeout);
    clearInterval(this.flicker);
  }
}
