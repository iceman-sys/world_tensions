import type { Rng } from './rng.ts';

const STARTS = [
  'Ka', 'Vel', 'Mor', 'Tal', 'Zan', 'Or', 'Ery', 'Bra', 'Sel', 'Ast', 'Dun', 'Fen', 'Gal', 'Ith', 'Kor', 'Lum',
  'Nar', 'Pel', 'Quen', 'Rho', 'Sar', 'Tor', 'Ul', 'Var', 'Wes', 'Xan', 'Yor', 'Zir', 'Ael', 'Cal', 'Dra', 'Eld',
  'Hal', 'Ix', 'Jor', 'Kel', 'Mal', 'Nev', 'Ost', 'Pra', 'Ruv', 'Sha', 'Tev', 'Vor', 'Ys', 'Zel', 'Bel', 'Cor',
];
const MIDDLES = ['', '', '', 'a', 'e', 'i', 'o', 'an', 'el', 'or', 'ir', 'ad', 'em', 'ur', 'is', 'av'];
const ENDS = [
  'ia', 'ora', 'heim', 'mark', 'esh', 'ar', 'oria', 'ane', 'ova', 'is', 'onia', 'uth', 'ell', 'ara', 'enne',
  'ost', 'avia', 'und', 'eth', 'ira', 'osa', 'ion', 'ezia', 'aris', 'ond', 'ay', 'uria', 'ekh', 'ania', 'orn',
];
const FORMS = ['', '', '', '', '', '', 'Republic of ', 'Kingdom of ', 'Federation of ', 'Free State of ', 'Union of '];

/** Real-world names the generator could plausibly produce; never emit these. */
const BLOCKED = new Set(['oman', 'mali', 'chad', 'iran', 'iraq', 'peru', 'cuba', 'fiji', 'togo', 'laos', 'malta', 'samoa', 'tonga', 'nauru', 'india', 'kenya']);

function oneName(rng: Rng): string {
  const start = STARTS[Math.floor(rng() * STARTS.length)];
  const mid = MIDDLES[Math.floor(rng() * MIDDLES.length)];
  const end = ENDS[Math.floor(rng() * ENDS.length)];
  let core = start + mid + end;
  // avoid doubled vowels at joins such as "Kaaria"
  core = core.replace(/([aeiou])\1/gi, '$1');
  return core.charAt(0).toUpperCase() + core.slice(1).toLowerCase();
}

/** Generates `count` unique fictional country names (unique on the core word too). */
export function generateCountryNames(rng: Rng, count: number): string[] {
  const used = new Set<string>();
  const names: string[] = [];
  let guard = 0;
  while (names.length < count) {
    if (++guard > count * 200) throw new Error('name generator exhausted');
    const core = oneName(rng);
    const key = core.toLowerCase();
    if (core.length < 4 || core.length > 12 || used.has(key) || BLOCKED.has(key)) continue;
    used.add(key);
    const form = FORMS[Math.floor(rng() * FORMS.length)];
    names.push(form + core);
  }
  return names;
}
