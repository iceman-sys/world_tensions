/**
 * Citizen conversations. Players pick from PRESET questions only (no free text);
 * answers are composed from templates using the citizen's traits and the REAL
 * simulation state. Every fact in an answer comes from the inputs, nothing is
 * invented. A different backend (e.g. a language model) can implement
 * DialogueBackend later, but only the templates ship.
 */
import type { Nation, TownStats } from '../model.ts';
import type { Citizen } from './citizens.ts';
import type { Rng } from '../rng.ts';
import { mulberry32 } from '../rng.ts';

export const PRESET_QUESTIONS = [
  { id: 'feeling', text: 'How are you feeling?' },
  { id: 'food', text: 'Do you have enough food?' },
  { id: 'taxes', text: 'What do you think about taxes?' },
  { id: 'job', text: 'Do you have a good job?' },
  { id: 'moving', text: 'Would you consider moving away?' },
  { id: 'home', text: 'How is your home?' },
  { id: 'safety', text: 'Do you feel safe?' },
] as const;

export type QuestionId = (typeof PRESET_QUESTIONS)[number]['id'];
export const QUESTION_IDS = PRESET_QUESTIONS.map((q) => q.id) as readonly QuestionId[];

export interface DialogueContext {
  citizen: Citizen;
  question: QuestionId;
  nation: Nation;
  stats: TownStats;
  countryName: string;
  /** names of buildings by id (home / workplace) */
  buildingLabel: (id: number | null) => string | null;
}

/** Swappable answer source. The game ships TemplateBackend only. */
export interface DialogueBackend {
  answer(ctx: DialogueContext): Promise<string>;
}

const pick = <T>(rng: Rng, list: readonly T[]): T => list[Math.floor(rng() * list.length)];
const has = (c: Citizen, t: string) => (c.traits as readonly string[]).includes(t);

function mood(c: Citizen): 'great' | 'good' | 'meh' | 'bad' | 'awful' {
  const h = c.happiness;
  return h >= 75 ? 'great' : h >= 55 ? 'good' : h >= 40 ? 'meh' : h >= 25 ? 'bad' : 'awful';
}

const OPENERS: Record<ReturnType<typeof mood>, string[]> = {
  great: ['Honestly? Things are going really well.', 'I feel great these days!', 'Life is good right now.'],
  good: ['Pretty good, thanks for asking.', 'Not bad at all.', 'I am doing fine.'],
  meh: ['So-so, if I am honest.', 'Could be better, could be worse.', 'I am getting by.'],
  bad: ['Not great, to be honest.', 'Times are hard right now.', 'I have been worried lately.'],
  awful: ['Very unhappy, I am afraid.', 'Things feel really bad at the moment.', 'I am close to giving up on this place.'],
};

const pct = (v: number) => `${Math.round(v * 100)}%`;

/** Builds an answer from templates. Deterministic for a given citizen, question and state. */
export function templateAnswer(ctx: DialogueContext): string {
  const { citizen: c, nation: n, stats: s, countryName } = ctx;
  // stable phrasing per citizen/question/hour so repeated clicks feel consistent
  const rng = mulberry32((c.seed ^ (ctx.question.length * 7919) ^ Math.floor(n.lastTickAt / 3_600_000)) >>> 0);
  const m = mood(c);
  const parts: string[] = [];
  const tax = n.taxRate;
  switch (ctx.question) {
    case 'feeling': {
      parts.push(pick(rng, OPENERS[m]));
      if (c.need !== 'nothing urgent') parts.push(`What I need most right now is ${c.need}.`);
      else parts.push(has(c, 'cheerful') ? 'Nothing big is missing, I just enjoy the days.' : 'Nothing urgent is missing for me.');
      if (c.status === 'protesting') parts.push('That is why I have been joining the protests.');
      else if (c.status === 'planning to move') parts.push('I have started thinking about leaving.');
      break;
    }
    case 'food': {
      if (s.shortage) {
        parts.push('No. The market has run out of food and the shelves are empty.');
        if (c.children.length) parts.push(`It is hard to feed ${c.children.length === 1 ? 'my child' : `my ${c.children.length} children`}.`);
      } else if (s.foodBalance < 0) {
        parts.push('For now, yes, but the stores are shrinking: the farms grow less than we eat.');
      } else {
        parts.push(pick(rng, ['Yes, there is enough at the market.', 'We have enough to eat, thankfully.']));
        if (has(c, 'generous')) parts.push('I even share some with the neighbours.');
      }
      break;
    }
    case 'taxes': {
      if (tax >= 45) parts.push(`A ${tax}% tax is far too high. ${has(c, 'frugal') ? 'Every coin counts in my house.' : 'People cannot keep up.'}`);
      else if (tax >= 30) parts.push(`At ${tax}%, taxes feel heavy${has(c, 'loyal') ? ', but I trust the government knows why' : ''}.`);
      else if (tax >= 15) parts.push(`${tax}% seems fair to me${has(c, 'frugal') ? ', though I always watch my spending' : ''}.`);
      else parts.push(`Only ${tax}%? I like it, but I hope there is still money for schools and clinics.`);
      if (c.job !== 'Retired' && c.job !== 'Student' && c.job !== 'Unemployed') parts.push(`I take home about $${c.income.toLocaleString('en-US')} a month.`);
      break;
    }
    case 'job': {
      if (c.job === 'Student') parts.push('I am still at school. I want to learn as much as I can.');
      else if (c.job === 'Retired') parts.push('I am retired now. I worked hard for many years.');
      else if (c.job === 'Unemployed') {
        parts.push(`No, I am looking for work. ${s.employment < 0.8 ? `Jobs are scarce: only ${pct(s.employment)} of people who want work have it.` : 'I hope something opens up soon.'}`);
      } else {
        const where = ctx.buildingLabel(c.workplaceId);
        parts.push(`I work as a ${c.job.toLowerCase()}${where ? ` at the ${where}` : ''}.`);
        parts.push(has(c, 'ambitious') ? 'It is a start, but I want to go further.' : has(c, 'hard-working') ? 'I like being busy.' : 'It is a decent job.');
      }
      break;
    }
    case 'moving': {
      if (c.status === 'planning to move') parts.push(`Yes. If nothing changes I will leave ${countryName}.`);
      else if (c.happiness < 40) parts.push('I have thought about it. Things would have to get better for me to stay.');
      else parts.push(has(c, 'loyal') ? `Never! ${countryName} is my home.` : `No, I am happy to stay in ${countryName}.`);
      break;
    }
    case 'home': {
      const home = ctx.buildingLabel(c.homeId);
      if (!home) parts.push(`I do not have a proper home right now. ${s.housing < 1 ? 'There are not enough homes for everyone.' : 'I hope to find one soon.'}`);
      else parts.push(`I live in a ${home}${c.partner ? ` with ${c.partner.split(' ')[0]}` : ''}${c.children.length ? ` and ${c.children.length === 1 ? 'our child' : 'our children'}` : ''}.`);
      if (home && s.housing < 0.95) parts.push('It is crowded, though: the town needs more homes.');
      break;
    }
    case 'safety': {
      if (s.safety >= 0.75) parts.push('Yes, the streets feel safe.');
      else if (s.safety >= 0.5) parts.push(`Mostly. ${n.services.police ? 'A police station nearby would help.' : 'I miss the police patrols.'}`);
      else parts.push('Not really. There is not enough policing around here.');
      if (has(c, 'cautious')) parts.push('I always lock my door anyway.');
      break;
    }
  }
  return parts.join(' ');
}

export class TemplateBackend implements DialogueBackend {
  async answer(ctx: DialogueContext): Promise<string> {
    return templateAnswer(ctx);
  }
}
