import type { Rng } from './rng.ts';

/**
 * Primary flag colours. Neighbouring countries get primaries chosen to be as far
 * apart as possible (greedy graph colouring that maximises colour distance).
 */
export const PRIMARIES = [
  '#c8202f', // crimson
  '#e8772a', // orange
  '#f0c233', // gold
  '#83b836', // lime
  '#1d8a4e', // green
  '#11908f', // teal
  '#2f9ad8', // sky
  '#2443a0', // royal
  '#6c3d9c', // purple
  '#c51f6b', // magenta
  '#8a5a2c', // brown
  '#3a4a57', // slate
] as const;

/** Accent colours used for secondary/tertiary flag elements. */
export const ACCENTS = [
  '#f4f1e8', // off-white
  '#1b1b1f', // near-black
  '#e7b522', // gold
  '#c8202f', // red
  '#2443a0', // blue
  '#1d8a4e', // green
  '#f4f1e8', // off-white (weighted)
  '#7fc8f0', // pale blue
  '#e8772a', // orange
  '#6c3d9c', // purple
] as const;

export const FLAG_PATTERN_COUNT = 11;
export const EMBLEM_COUNT = 4;

export function hexToRgb(hex: string): [number, number, number] {
  const v = parseInt(hex.slice(1), 16);
  return [(v >> 16) & 255, (v >> 8) & 255, v & 255];
}

/** Weighted RGB distance ("redmean"), cheap and good enough for picking contrasting colours. */
export function colorDistance(a: string, b: string): number {
  const [r1, g1, b1] = hexToRgb(a);
  const [r2, g2, b2] = hexToRgb(b);
  const rm = (r1 + r2) / 2;
  const dr = r1 - r2, dg = g1 - g2, db = b1 - b2;
  return Math.sqrt((2 + rm / 256) * dr * dr + 4 * dg * dg + (2 + (255 - rm) / 256) * db * db);
}

export function luminance(hex: string): number {
  const [r, g, b] = hexToRgb(hex);
  return (0.2126 * r + 0.7152 * g + 0.0722 * b) / 255;
}

/**
 * Assigns a primary colour index to every country so that neighbours contrast.
 * Countries are processed by descending degree; each takes the colour that
 * maximises its minimum distance to already-coloured neighbours, preferring
 * colours not used by any neighbour at all.
 */
export function colorCountries(neighbors: number[][], rng: Rng): number[] {
  const n = neighbors.length;
  const colors = new Array<number>(n).fill(-1);
  const order = Array.from({ length: n }, (_, i) => i).sort((a, b) => neighbors[b].length - neighbors[a].length || a - b);
  for (const c of order) {
    let bestColor = 0;
    let bestScore = -Infinity;
    const offset = Math.floor(rng() * PRIMARIES.length);
    for (let k = 0; k < PRIMARIES.length; k++) {
      const col = (k + offset) % PRIMARIES.length;
      let minDist = Infinity;
      let shared = 0;
      for (const nb of neighbors[c]) {
        const nc = colors[nb];
        if (nc < 0) continue;
        if (nc === col) shared++;
        minDist = Math.min(minDist, colorDistance(PRIMARIES[col], PRIMARIES[nc]));
      }
      const score = (shared > 0 ? -1e6 * shared : 0) + (minDist === Infinity ? 1e3 : minDist);
      if (score > bestScore) {
        bestScore = score;
        bestColor = col;
      }
    }
    colors[c] = bestColor;
  }
  return colors;
}

/** Picks an accent that contrasts with the primary (falls back through the list). */
export function contrastingAccent(primary: string, preferred: number): string {
  for (let k = 0; k < ACCENTS.length; k++) {
    const accent = ACCENTS[(preferred + k) % ACCENTS.length];
    if (colorDistance(primary, accent) > 260 && Math.abs(luminance(primary) - luminance(accent)) > 0.12) return accent;
  }
  return luminance(primary) > 0.5 ? '#1b1b1f' : '#f4f1e8';
}
