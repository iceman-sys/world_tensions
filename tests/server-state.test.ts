import { describe, expect, it } from 'vitest';
import { EarthState } from '../server/src/state.ts';
import { parseClientMessage } from '../shared/protocol.ts';
import { mulberry32 } from '../shared/rng.ts';

const seededRand = (seed: number) => {
  const rng = mulberry32(seed);
  return (max: number) => Math.floor(rng() * max);
};

describe('EarthState claims', () => {
  it('assigns distinct random countries to players', () => {
    const s = new EarthState(1, seededRand(1));
    const a = s.join('Alice');
    const b = s.join('Bob');
    expect(a.ok && b.ok).toBe(true);
    if (!a.ok || !b.ok) return;
    expect(a.player.countryId).not.toBe(b.player.countryId);
    expect(s.ownerOf(a.player.countryId)?.name).toBe('Alice');
  });

  it('rejects double claims of the same country', () => {
    const s = new EarthState(1, seededRand(2));
    const a = s.join('Alice');
    const b = s.join('Bob');
    if (!a.ok || !b.ok) throw new Error('join failed');
    // Bob tries to also take Alice's country: rejected (already owned, and Bob already has one)
    expect(s.claim(b.player.id, a.player.countryId)).toBe(false);
    expect(s.ownerOf(a.player.countryId)?.name).toBe('Alice');
  });

  it('enforces one country per player', () => {
    const s = new EarthState(1, seededRand(3));
    const a = s.join('Alice');
    if (!a.ok) throw new Error('join failed');
    const freeCountry = [...Array(200).keys()].find((id) => !s.ownerOf(id)) ?? -1;
    expect(s.claim(a.player.id, freeCountry)).toBe(false);
  });

  it('rejects duplicate and invalid names', () => {
    const s = new EarthState(1, seededRand(4));
    expect(s.join('Alice').ok).toBe(true);
    const dup = s.join('alice');
    expect(dup.ok).toBe(false);
    const bad = s.join('<script>');
    expect(bad.ok).toBe(false);
    expect(s.join('x').ok).toBe(false);
  });

  it('fills exactly 200 slots, never assigning a country twice', () => {
    const s = new EarthState(1, seededRand(5));
    const owned = new Set<number>();
    for (let i = 0; i < 200; i++) {
      const r = s.join(`Player ${i}`);
      expect(r.ok).toBe(true);
      if (r.ok) owned.add(r.player.countryId);
    }
    expect(owned.size).toBe(200);
    const full = s.join('Latecomer');
    expect(full.ok).toBe(false);
    if (!full.ok) expect(full.code).toBe('earth-full');
  });

  it('persists and restores ownership and sessions', () => {
    const s = new EarthState(42, seededRand(6));
    const a = s.join('Alice');
    if (!a.ok) throw new Error('join failed');
    const restored = EarthState.fromJSON(JSON.parse(JSON.stringify(s.toJSON())));
    expect(restored?.seed).toBe(42);
    const p = restored?.byTokenLookup(a.player.token);
    expect(p?.countryId).toBe(a.player.countryId);
    expect(p?.online).toBe(false);
  });
});

describe('protocol validation', () => {
  it('rejects client-chosen countries and unknown fields', () => {
    expect(parseClientMessage(JSON.stringify({ t: 'join', name: 'Alice', countryId: 3 }))).toBeNull();
    expect(parseClientMessage(JSON.stringify({ t: 'claim', countryId: 3 }))).toBeNull();
  });

  it('rejects malformed input', () => {
    expect(parseClientMessage('not json')).toBeNull();
    expect(parseClientMessage('[]')).toBeNull();
    expect(parseClientMessage(JSON.stringify({ t: 'hello', token: 'short' }))).toBeNull();
    expect(parseClientMessage('x'.repeat(5000))).toBeNull();
  });

  it('accepts valid messages', () => {
    expect(parseClientMessage(JSON.stringify({ t: 'join', name: 'Alice' }))).toEqual({ t: 'join', name: 'Alice' });
    expect(parseClientMessage(JSON.stringify({ t: 'hello', token: null }))).toEqual({ t: 'hello', token: null });
  });
});
