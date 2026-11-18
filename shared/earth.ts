import { deriveSeed, mulberry32, randInt, shuffle, type Rng } from './rng.ts';
import { warpDir, type Vec3Tuple } from './warp.ts';
import { generateCountryNames } from './names.ts';
import { COUNTRY_COUNT, RESOURCE_CATALOG, STARTING_FUNDS } from './resources.ts';
import { FLAG_PATTERN_COUNT, EMBLEM_COUNT, ACCENTS } from './palette.ts';

export interface FlagDesign {
  pattern: number;
  /** index into ACCENTS */
  secondary: number;
  /** index into ACCENTS */
  tertiary: number;
  emblem: number;
}

export interface CountryMeta {
  id: number;
  name: string;
  /** seed point in warped space (unit vector) */
  seed: Vec3Tuple;
  /** additive power-diagram weight (bigger = larger territory) */
  weight: number;
  flag: FlagDesign;
  resources: string[];
  population: number;
  satisfaction: number;
  militarySize: number;
  militaryStrength: number;
  funds: number;
}

export interface EarthMeta {
  seed: number;
  warpOffset: Vec3Tuple;
  countries: CountryMeta[];
}

export interface EarthGenOptions {
  /** sample count used for Lloyd relaxation and size balancing */
  samples?: number;
  lloydIterations?: number;
  balanceIterations?: number;
}

function fibonacciSphere(count: number, out: Float64Array, rng?: Rng, jitter = 0): void {
  const golden = Math.PI * (3 - Math.sqrt(5));
  for (let i = 0; i < count; i++) {
    let y = 1 - ((i + 0.5) / count) * 2;
    let theta = golden * i;
    if (rng && jitter > 0) {
      y = Math.max(-1, Math.min(1, y + (rng() - 0.5) * jitter * (2 / count) * 6));
      theta += (rng() - 0.5) * jitter * 1.2;
    }
    const r = Math.sqrt(1 - y * y);
    out[i * 3] = Math.cos(theta) * r;
    out[i * 3 + 1] = y;
    out[i * 3 + 2] = Math.sin(theta) * r;
  }
}

function gaussian(rng: Rng): number {
  const u = Math.max(1e-9, rng());
  const v = rng();
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
}

/**
 * Deterministically generates the country layout and per-country data for a seed.
 * Runs on both client and server, so it must stay pure and fast (~100-200 ms).
 */
export function generateEarthMeta(seed: number, opts: EarthGenOptions = {}): EarthMeta {
  const samplesCount = opts.samples ?? 16000;
  const lloyd = opts.lloydIterations ?? 4;
  const balance = opts.balanceIterations ?? 10;
  const n = COUNTRY_COUNT;

  const layoutRng = mulberry32(deriveSeed(seed, 'layout'));
  const warpOffset: Vec3Tuple = [
    (layoutRng() - 0.5) * 80,
    (layoutRng() - 0.5) * 80,
    (layoutRng() - 0.5) * 80,
  ];

  // --- seeds: jittered Fibonacci sphere, randomly rotated ---
  const seeds = new Float64Array(n * 3);
  fibonacciSphere(n, seeds, layoutRng, 0.8);
  rotateRandom(seeds, layoutRng);

  // --- samples in warped space (the space where the Voronoi diagram lives) ---
  const samples = new Float64Array(samplesCount * 3);
  fibonacciSphere(samplesCount, samples);
  const tmp = new Float64Array(3);
  for (let i = 0; i < samplesCount; i++) {
    warpDir(samples[i * 3], samples[i * 3 + 1], samples[i * 3 + 2], warpOffset, tmp);
    samples[i * 3] = tmp[0];
    samples[i * 3 + 1] = tmp[1];
    samples[i * 3 + 2] = tmp[2];
  }

  const weights = new Float64Array(n);
  const assign = new Int32Array(samplesCount);
  const counts = new Float64Array(n);
  const sums = new Float64Array(n * 3);

  const assignAll = () => {
    counts.fill(0);
    sums.fill(0);
    for (let s = 0; s < samplesCount; s++) {
      const sx = samples[s * 3], sy = samples[s * 3 + 1], sz = samples[s * 3 + 2];
      let best = 0;
      let bestScore = -Infinity;
      for (let c = 0; c < n; c++) {
        const score = sx * seeds[c * 3] + sy * seeds[c * 3 + 1] + sz * seeds[c * 3 + 2] + weights[c];
        if (score > bestScore) { bestScore = score; best = c; }
      }
      assign[s] = best;
      counts[best]++;
      sums[best * 3] += sx;
      sums[best * 3 + 1] += sy;
      sums[best * 3 + 2] += sz;
    }
  };

  // --- Lloyd relaxation on the sphere for even spacing ---
  for (let it = 0; it < lloyd; it++) {
    assignAll();
    for (let c = 0; c < n; c++) {
      const len = Math.hypot(sums[c * 3], sums[c * 3 + 1], sums[c * 3 + 2]);
      if (counts[c] > 0 && len > 0) {
        seeds[c * 3] = sums[c * 3] / len;
        seeds[c * 3 + 1] = sums[c * 3 + 1] / len;
        seeds[c * 3 + 2] = sums[c * 3 + 2] / len;
      }
    }
  }

  // --- size variety: steer weights towards random target areas (power-diagram balancing) ---
  const sizeRng = mulberry32(deriveSeed(seed, 'sizes'));
  const targets = new Float64Array(n);
  let targetSum = 0;
  for (let c = 0; c < n; c++) {
    targets[c] = Math.min(2.0, Math.max(0.55, Math.exp(gaussian(sizeRng) * 0.38)));
    targetSum += targets[c];
  }
  for (let c = 0; c < n; c++) targets[c] = (targets[c] / targetSum) * samplesCount;

  for (let it = 0; it < balance; it++) {
    assignAll();
    for (let c = 0; c < n; c++) {
      const err = (targets[c] - counts[c]) / targets[c];
      weights[c] += Math.max(-0.004, Math.min(0.004, err * 0.004));
    }
  }

  // --- per-country data ---
  const names = generateCountryNames(mulberry32(deriveSeed(seed, 'names')), n);
  const dataRng = mulberry32(deriveSeed(seed, 'data'));
  const countries: CountryMeta[] = [];
  for (let c = 0; c < n; c++) {
    const pattern = Math.floor(dataRng() * FLAG_PATTERN_COUNT);
    const secondary = Math.floor(dataRng() * ACCENTS.length);
    let tertiary = Math.floor(dataRng() * ACCENTS.length);
    if (tertiary === secondary) tertiary = (tertiary + 3) % ACCENTS.length;
    const resources = shuffle(dataRng, [...RESOURCE_CATALOG]).slice(0, 4);
    const militarySize = randInt(dataRng, 8, 120) * 1000;
    countries.push({
      id: c,
      name: names[c],
      seed: [seeds[c * 3], seeds[c * 3 + 1], seeds[c * 3 + 2]],
      weight: weights[c],
      flag: { pattern, secondary, tertiary, emblem: Math.floor(dataRng() * EMBLEM_COUNT) },
      resources,
      population: randInt(dataRng, 18, 420) * 100_000,
      satisfaction: randInt(dataRng, 52, 88),
      militarySize,
      militaryStrength: randInt(dataRng, 18, 64),
      funds: STARTING_FUNDS,
    });
  }

  return { seed: seed >>> 0, warpOffset, countries };
}

function rotateRandom(points: Float64Array, rng: Rng): void {
  // random rotation from a random unit quaternion
  const u1 = rng(), u2 = rng(), u3 = rng();
  const qx = Math.sqrt(1 - u1) * Math.sin(2 * Math.PI * u2);
  const qy = Math.sqrt(1 - u1) * Math.cos(2 * Math.PI * u2);
  const qz = Math.sqrt(u1) * Math.sin(2 * Math.PI * u3);
  const qw = Math.sqrt(u1) * Math.cos(2 * Math.PI * u3);
  const m00 = 1 - 2 * (qy * qy + qz * qz), m01 = 2 * (qx * qy - qz * qw), m02 = 2 * (qx * qz + qy * qw);
  const m10 = 2 * (qx * qy + qz * qw), m11 = 1 - 2 * (qx * qx + qz * qz), m12 = 2 * (qy * qz - qx * qw);
  const m20 = 2 * (qx * qz - qy * qw), m21 = 2 * (qy * qz + qx * qw), m22 = 1 - 2 * (qx * qx + qy * qy);
  for (let i = 0; i < points.length; i += 3) {
    const x = points[i], y = points[i + 1], z = points[i + 2];
    points[i] = m00 * x + m01 * y + m02 * z;
    points[i + 1] = m10 * x + m11 * y + m12 * z;
    points[i + 2] = m20 * x + m21 * y + m22 * z;
  }
}

/** Packs seeds + weights into flat float arrays for workers / shaders. */
export function packSeeds(meta: EarthMeta): { seeds: Float32Array; weights: Float32Array } {
  const n = meta.countries.length;
  const seeds = new Float32Array(n * 3);
  const weights = new Float32Array(n);
  for (const c of meta.countries) {
    seeds[c.id * 3] = c.seed[0];
    seeds[c.id * 3 + 1] = c.seed[1];
    seeds[c.id * 3 + 2] = c.seed[2];
    weights[c.id] = c.weight;
  }
  return { seeds, weights };
}
