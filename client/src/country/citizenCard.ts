import type { Citizen } from '../../../shared/country/citizens.ts';
import { PRESET_QUESTIONS, type QuestionId } from '../../../shared/country/dialogue.ts';
import { JUSTICE } from '../../../shared/country/citizens.ts';
import { escapeHtml, formatMoney } from '../ui/format.ts';
import { drawPortrait } from './portrait.ts';

function opinionLabel(o: number): string {
  return o >= 50 ? 'Very supportive' : o >= 15 ? 'Supportive' : o > -15 ? 'Neutral' : o > -50 ? 'Critical' : 'Very critical';
}

function meter(label: string, value: number, cls = ''): string {
  const v = Math.max(0, Math.min(100, value));
  return `<div class="cc-meter ${cls}"><span>${escapeHtml(label)}</span><b>${Math.round(v)}</b><i><em style="width:${v}%"></em></i></div>`;
}

/**
 * The Citizen Card: a featured citizen's profile, mood and life history, with
 * PRESET question buttons only. Answers come from the server, which composes
 * them from templates and the real simulation state.
 */
export class CitizenCard {
  citizenId = 0;
  private readonly portrait: HTMLCanvasElement;
  private answers = new Map<string, string>();
  onAsk: ((citizenId: number, q: QuestionId) => void) | null = null;
  onJudge: ((citizenId: number, verdict: 'release' | 'exile') => void) | null = null;
  onClose: (() => void) | null = null;

  constructor(private readonly root: HTMLElement, private readonly buildingLabel: (id: number | null) => string | null) {
    this.portrait = document.createElement('canvas');
    this.portrait.width = this.portrait.height = 192;
    this.portrait.className = 'cc-portrait';
    root.addEventListener('click', this.click);
  }

  get open(): boolean {
    return !this.root.hidden;
  }

  show(c: Citizen): void {
    if (c.id !== this.citizenId) this.answers.clear();
    this.citizenId = c.id;
    this.render(c);
    this.root.hidden = false;
  }

  /** Refresh with the latest server state (or close if the citizen left). */
  update(list: readonly Citizen[]): void {
    if (!this.open) return;
    const c = list.find((x) => x.id === this.citizenId);
    if (!c) {
      this.root.querySelector('.cc-body')?.insertAdjacentHTML('afterbegin', '<p class="cc-gone">This citizen has left the country.</p>');
      return;
    }
    this.render(c);
  }

  answer(citizenId: number, q: QuestionId, text: string): void {
    if (citizenId !== this.citizenId) return;
    this.answers.set(q, text);
    const el = this.root.querySelector(`[data-answer="${q}"]`);
    if (el) {
      el.textContent = text;
      el.classList.add('shown');
    }
  }

  close(): void {
    this.root.hidden = true;
    this.citizenId = 0;
    this.answers.clear();
    this.onClose?.();
  }

  private readonly click = (e: Event): void => {
    const t = e.target as HTMLElement | null;
    const btn = t?.closest('button');
    if (!btn) return;
    if (btn.dataset.action === 'close') this.close();
    else if (btn.dataset.q) this.onAsk?.(this.citizenId, btn.dataset.q as QuestionId);
    else if (btn.dataset.verdict === 'release' || btn.dataset.verdict === 'exile') this.onJudge?.(this.citizenId, btn.dataset.verdict);
  };

  private render(c: Citizen): void {
    drawPortrait(this.portrait, c);
    const age = Math.floor(c.age);
    const family = [
      c.partner ? `Partner: ${escapeHtml(c.partner)}` : 'No partner',
      c.children.length ? `Children: ${c.children.map(escapeHtml).join(', ')}` : 'No children',
    ].join('<br>');
    const home = this.buildingLabel(c.homeId);
    const work = this.buildingLabel(c.workplaceId);
    const statusCls = c.status === 'content' ? 'ok' : c.status === 'complaining' ? 'meh' : 'bad';
    const suspect = c.suspect
      ? `<section class="cc-suspect"><h4>Detained by the police</h4><p>${escapeHtml(c.name)} ${escapeHtml(c.suspect.reason)}.</p>
         <div class="cc-row"><button type="button" class="btn" data-verdict="release" title="Satisfaction +${JUSTICE.release.satisfaction}, loyalty +${JUSTICE.release.loyalty}">Release</button>
         <button type="button" class="btn btn-danger" data-verdict="exile" title="Satisfaction ${JUSTICE.exile.satisfaction}">Exile</button></div></section>`
      : '';
    this.root.innerHTML = `
      <button type="button" class="icon-btn close" data-action="close" aria-label="Close citizen card">✕</button>
      <header class="cc-head">
        <div class="cc-portrait-slot"></div>
        <div>
          <h3 class="cc-name">${escapeHtml(c.name)}</h3>
          <div class="cc-sub">${age} years · ${escapeHtml(c.job)}${work ? ` at the ${escapeHtml(work)}` : ''}</div>
          <div class="cc-status ${statusCls}">${escapeHtml(c.status)}${c.notable ? ` · <b>${escapeHtml(c.notable)}</b>` : ''}</div>
        </div>
      </header>
      <div class="cc-body">
        <dl class="cc-facts">
          <div><dt>Income</dt><dd>${c.income > 0 ? `${formatMoney(c.income)}/month` : 'none (in school)'}</dd></div>
          <div><dt>Education</dt><dd>${escapeHtml(c.education)}</dd></div>
          <div><dt>Home</dt><dd>${home ? escapeHtml(home) : 'none'}</dd></div>
          <div><dt>Needs</dt><dd>${escapeHtml(c.need)}</dd></div>
          <div class="wide"><dt>Family</dt><dd>${family}</dd></div>
          <div class="wide"><dt>Traits</dt><dd>${c.traits.map((t) => `<span class="tag">${escapeHtml(t)}</span>`).join(' ')}</dd></div>
        </dl>
        ${meter('Mood', c.happiness, 'mood')}
        ${meter('Loyalty', c.loyalty, 'loyal')}
        <div class="cc-opinion">Opinion of the government: <b>${opinionLabel(c.opinion)}</b></div>
        ${suspect}
        <h4 class="p-sub">Ask a question</h4>
        <div class="cc-questions">${PRESET_QUESTIONS.map((q) => `<button type="button" class="cc-q" data-q="${q.id}">${escapeHtml(q.text)}</button><p class="cc-answer${this.answers.has(q.id) ? ' shown' : ''}" data-answer="${q.id}">${escapeHtml(this.answers.get(q.id) ?? '')}</p>`).join('')}</div>
        <h4 class="p-sub">Life history</h4>
        <ol class="cc-history">${[...c.history].reverse().map((h) => `<li>${escapeHtml(h.text)}</li>`).join('')}</ol>
      </div>`;
    this.root.querySelector('.cc-portrait-slot')?.append(this.portrait);
  }
}
