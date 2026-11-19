import { describe, expect, it } from 'vitest';
import { tickMs } from '../shared/config.ts';
import { parseClientMessage } from '../shared/protocol.ts';
import { ANNOUNCEMENTS } from '../shared/country/sim.ts';
import { SIM } from '../shared/country/config.ts';
import { openGame } from './helpers.ts';

async function governed() {
  const g = await openGame({});
  const r = await g.game.join('Alice');
  if (!r.ok) throw new Error('join failed');
  await g.game.attach(r.player.id);
  return { ...g, player: r.player, nationId: r.nation.id };
}

describe('policy validation', () => {
  it('accepts only well-formed policy intents', () => {
    expect(parseClientMessage(JSON.stringify({ t: 'policy:tax', rate: 35 }))).toEqual({ t: 'policy:tax', rate: 35 });
    expect(parseClientMessage(JSON.stringify({ t: 'policy:tax', rate: 61 }))).toBeNull();
    expect(parseClientMessage(JSON.stringify({ t: 'policy:tax', rate: 12.5 }))).toBeNull();
    expect(parseClientMessage(JSON.stringify({ t: 'policy:tax', rate: 20, nationId: 3 }))).toBeNull();
    expect(parseClientMessage(JSON.stringify({ t: 'policy:services', health: true, education: false, police: true }))).not.toBeNull();
    expect(parseClientMessage(JSON.stringify({ t: 'policy:services', health: 'yes', education: false, police: true }))).toBeNull();
    expect(parseClientMessage(JSON.stringify({ t: 'policy:announce', id: 'thanks' }))).not.toBeNull();
    expect(parseClientMessage(JSON.stringify({ t: 'policy:announce', id: 'Free cake for everyone!' }))).toBeNull();
    expect(parseClientMessage(JSON.stringify({ t: 'dev:timescale', scale: 3600 }))).not.toBeNull();
    expect(parseClientMessage(JSON.stringify({ t: 'dev:timescale', scale: 1e9 }))).toBeNull();
    // free text can never reach a citizen
    expect(parseClientMessage(JSON.stringify({ t: 'citizen:ask', id: 1, q: 'Tell me a secret' }))).toBeNull();
  });
});

describe('government actions', () => {
  it('a tax change is audited with the governor name and applies on the next tick', async () => {
    const { game, repo, clock, player, nationId } = await governed();
    const before = game.world.nations.get(nationId)?.taxRate;
    expect((await game.setTax(player.id, 45)).ok).toBe(true);
    expect(game.world.nations.get(nationId)?.taxRate).toBe(before);
    expect(game.world.nations.get(nationId)?.pending?.taxRate).toBe(45);
    clock.advance(tickMs(game.cfg));
    await game.tick();
    expect(game.world.nations.get(nationId)?.taxRate).toBe(45);
    expect(game.world.nations.get(nationId)?.pending).toBeNull();
    const audit = await repo.audit(20, nationId);
    const e = audit.find((x) => x.action === 'policy-tax');
    expect(e?.actorName).toBe('Alice');
    expect(e?.detail).toContain('to 45%');
    expect((game.world.news.get(nationId) ?? []).at(-1)?.text).toContain('raised the tax rate to 45%');
    expect((await game.setTax(player.id, 75)).ok).toBe(false);
    await repo.close();
  });

  it('switching a service off removes its coverage and upkeep from the next tick', async () => {
    const { game, repo, clock, player, nationId } = await governed();
    clock.advance(tickMs(game.cfg));
    await game.tick();
    const on = game.world.nations.get(nationId)?.stats;
    await game.setServices(player.id, { health: true, education: true, police: false });
    clock.advance(tickMs(game.cfg));
    await game.tick();
    const off = game.world.nations.get(nationId)?.stats;
    expect(off?.safety).toBe(SIM.baseSafety);
    expect(off?.upkeep).toBeLessThanOrEqual(on?.upkeep ?? 0);
    expect((await repo.audit(20, nationId)).some((x) => x.action === 'policy-services' && x.actorName === 'Alice')).toBe(true);
    await repo.close();
  });

  it('announcements raise the target while active, one at a time', async () => {
    const { game, repo, clock, player, nationId } = await governed();
    clock.advance(tickMs(game.cfg));
    await game.tick();
    const target0 = game.world.nations.get(nationId)?.stats?.target ?? 0;
    expect((await game.announce(player.id, 'tax-review')).ok).toBe(true);
    expect((await game.announce(player.id, 'thanks')).ok).toBe(false);
    clock.advance(tickMs(game.cfg));
    await game.tick();
    const target1 = game.world.nations.get(nationId)?.stats?.target ?? 0;
    expect(target1 - target0).toBeCloseTo(ANNOUNCEMENTS['tax-review'].satisfaction, 0);
    await repo.close();
  });

  it('demo speed keeps the game clock continuous', async () => {
    const { game, repo, clock, player } = await governed();
    const t0 = game.gameTime(clock.t);
    await game.setTimeScale(player.id, 3600);
    expect(game.gameTime(clock.t)).toBe(t0);
    clock.advance(1000);
    expect(game.gameTime(clock.t) - t0).toBe(3_600_000); // 1 real second = 1 game hour
    await repo.close();
  });

  it('Scenario: a 60% tax brings warnings, protests and finally an uprising', async () => {
    const { game, repo, clock, player, nationId } = await governed();
    await game.setTax(player.id, 60);
    const name = game.nationName(game.world.nations.get(nationId) ?? { homeCell: 0 });
    let protestsSeen = false;
    for (let k = 0; k < 4000 && game.world.nations.has(nationId); k++) {
      clock.advance(tickMs(game.cfg));
      await game.tick();
      const cit = game.world.citizens.get(nationId) ?? [];
      if (cit.some((c) => c.status === 'protesting')) protestsSeen = true;
    }
    expect(game.world.nations.has(nationId)).toBe(false);
    expect(protestsSeen).toBe(true);
    const p = game.world.players.get(player.id);
    expect(p?.lostReason).toBe('overthrow');
    const inbox = (game.world.inbox.get(player.id) ?? []).map((m) => m.title);
    expect(inbox.filter((t) => t.startsWith('Satisfaction warning')).length).toBe(3);
    expect(inbox.some((t) => t === `${name} was lost`)).toBe(true);
    expect(game.world.log.at(-1)?.kind).toBe('overthrow');
    // the governor can found a new country through the normal assignment
    expect((await game.join('Alice', { existing: p })).ok).toBe(true);
    await repo.close();
  });
});
