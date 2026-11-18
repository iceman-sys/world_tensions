/** Emulates the GLSL snoise in float32 (Math.fround after every op) and prints
 * intermediate hash values next to the float64 JS version, to find divergence.
 * `npx tsx scripts/f32-noise.ts x y z` */
import { snoise3 } from '../shared/noise.ts';

const F = Math.fround;
const mod289 = (x: number) => F(x - F(Math.floor(F(F(x + 0.5) * F(1 / 289))) * 289));
const permute = (x: number) => mod289(F(F(F(x * 34) + 10) * x));
const mod289d = (x: number) => x - Math.floor((x + 0.5) * (1 / 289)) * 289;
const permuted = (x: number) => mod289d((x * 34 + 10) * x);

const [x, y, z] = process.argv.slice(2).map(Number);
const s = F(F(F(x + y) + z) * F(1 / 3));
const i0 = Math.floor(F(x + s)), j0 = Math.floor(F(y + s)), k0 = Math.floor(F(z + s));
console.log('cell', i0, j0, k0);
const ii = mod289(i0), jj = mod289(j0), kk = mod289(k0);
const ii2 = mod289d(i0), jj2 = mod289d(j0), kk2 = mod289d(k0);
console.log('mod f32', ii, jj, kk, ' f64', ii2, jj2, kk2);
const a = permute(kk), a2 = permuted(kk2);
const b = permute(mod289(F(a + jj))), b2 = permuted(mod289d(a2 + jj2));
const c = permute(mod289(F(b + ii))), c2 = permuted(mod289d(b2 + ii2));
console.log('p0 chain f32', a, b, c, ' f64', a2, b2, c2);
console.log('snoise f64', snoise3(x, y, z));
