import type { InboxItem, NationHistory, Services, TownStats } from '../../../shared/model.ts';
import type { MyNation, NationView } from '../../../shared/protocol.ts';
import { ANNOUNCEMENTS } from '../../../shared/country/sim.ts';
import { SIM } from '../../../shared/country/config.ts';
import { escapeHtml, formatMoney, formatPopulation } from '../ui/format.ts';

export interface GovActions {
  setTax: (rate: number) => void;
  setServices: (s: Services) => void;
  announce: (id: string) => void;
  /** dev only */
  setTimeScale: ((scale: number) => void) | null;
  scenario: () => void;
}

/** Small canvas sparkline (no allocation beyond the canvas itself). */
function sparkline(canvas: HTMLCanvasElement, values: readonly number[], color: string, min?: number, max?: number): void {
  const ctx = canvas.getContext('2d');
  if (!ctx) return;
  const w = canvas.width, h = canvas.height;
  ctx.clearRect(0, 0, w, h);
  if (values.length < 2) return;
  let lo = min ?? Infinity, hi = max ?? -Infinity;
  if (min === undefined || max === undefined) for (const v of values) {
    if (min === undefined) lo = Math.min(lo, v);
    if (max === undefined) hi = Math.max(hi, v);
  }
  if (hi - lo < 1e-9) {
    hi += 1;
    lo -= 1;
  }
  ctx.strokeStyle = color;
  ctx.lineWidth = 1.6;
  ctx.beginPath();
  values.forEach((v, k) => {
    const x = (k / (values.length - 1)) * (w - 2) + 1;
    const y = h - 2 - ((v - lo) / (hi - lo)) * (h - 4);
    if (k === 0) ctx.moveTo(x, y);
    else ctx.lineTo(x, y);
  });
  ctx.stroke();
}

/** Warning stage (0 none .. 4 uprising imminent) from satisfaction. */
export function unrestStage(satisfaction: number): number {
  if (satisfaction <= SIM.overthrowAt) return 4;
  const idx = SIM.warningStages.findIndex((lvl) => satisfaction > lvl);
  return idx === -1 ? 3 : idx;
}

/**
 * The government panel of the country view. Every control sends an intent;
 * the server validates it, applies it on the next tick and audits it.
 */
export class GovPanel {
  private readonly canvases: Record<'population' | 'satisfaction' | 'employment' | 'funds', HTMLCanvasElement>;
  private taxTimer = 0;
  private dragging = false;

  constructor(private readonly root: HTMLElement, actions: GovActions) {
    const dev = actions.setTimeScale !== null;
    root.innerHTML = `
      <details class="gp" open>
        <summary>Government</summary>
        <div class="gp-unrest" data-stage="0"><b class="gp-sat">—</b><span class="gp-stage">Calm</span></div>
        <label class="gp-tax">Tax rate <b class="gp-tax-v">20%</b> <span class="gp-pending" hidden>applies next tick</span>
          <input type="range" min="0" max="60" step="1" value="20" aria-label="Tax rate" /></label>
        <fieldset class="gp-services"><legend>Public services</legend>
          <label><input type="checkbox" data-svc="health" checked /> Health care</label>
          <label><input type="checkbox" data-svc="education" checked /> Schools</label>
          <label><input type="checkbox" data-svc="police" checked /> Police</label>
        </fieldset>
        <div class="gp-announce"><span class="gp-label">Announce</span>${Object.entries(ANNOUNCEMENTS)
          .map(([id, a]) => `<button type="button" class="gp-chip" data-ann="${id}" title="${escapeHtml(a.text)} (+${a.satisfaction} satisfaction for ${a.hours} game hours)">${escapeHtml(a.text.split(' ').slice(0, 4).join(' '))}…</button>`)
          .join('')}</div>
        <div class="gp-sparks">
          <div><span>Population <b data-v="population">—</b></span><canvas data-c="population" width="132" height="26"></canvas></div>
          <div><span>Satisfaction <b data-v="satisfaction">—</b></span><canvas data-c="satisfaction" width="132" height="26"></canvas></div>
          <div><span>Employment <b data-v="employment">—</b></span><canvas data-c="employment" width="132" height="26"></canvas></div>
          <div><span>Treasury <b data-v="funds">—</b></span><canvas data-c="funds" width="132" height="26"></canvas></div>
        </div>
        <div class="gp-facts"></div>
        <h4 class="p-sub">Inbox</h4>
        <ul class="gp-inbox"><li class="muted">No messages yet.</li></ul>
        ${dev ? `<div class="gp-dev"><label><input type="checkbox" class="gp-speed" /> Demo speed <span class="muted">(1 s = 1 game hour)</span></label><button type="button" class="btn btn-danger gp-scenario" title="Raises taxes to 60% so you can watch the citizens react">Scenario: tax shock</button></div>` : ''}
      </details>`;
    const q = <T extends HTMLElement>(sel: string) => root.querySelector(sel) as T;
    this.canvases = {
      population: q<HTMLCanvasElement>('canvas[data-c="population"]'),
      satisfaction: q<HTMLCanvasElement>('canvas[data-c="satisfaction"]'),
      employment: q<HTMLCanvasElement>('canvas[data-c="employment"]'),
      funds: q<HTMLCanvasElement>('canvas[data-c="funds"]'),
    };
    const slider = q<HTMLInputElement>('.gp-tax input');
    slider.addEventListener('input', () => {
      this.dragging = true;
      q('.gp-tax-v').textContent = `${slider.value}%`;
      window.clearTimeout(this.taxTimer);
      // one intent per settled change (and never faster than the rate limit allows)
      this.taxTimer = window.setTimeout(() => {
        this.dragging = false;
        actions.setTax(Number(slider.value));
      }, 350);
    });
    root.querySelectorAll<HTMLInputElement>('[data-svc]').forEach((box) =>
      box.addEventListener('change', () => {
        const get = (k: string) => (root.querySelector(`[data-svc="${k}"]`) as HTMLInputElement).checked;
        actions.setServices({ health: get('health'), education: get('education'), police: get('police') });
      }),
    );
    root.querySelectorAll<HTMLButtonElement>('[data-ann]').forEach((b) => b.addEventListener('click', () => b.dataset.ann && actions.announce(b.dataset.ann)));
    root.querySelector<HTMLInputElement>('.gp-speed')?.addEventListener('change', (e) => actions.setTimeScale?.((e.target as HTMLInputElement).checked ? 3600 : 60));
    root.querySelector('.gp-scenario')?.addEventListener('click', () => {
      slider.value = '60';
      q('.gp-tax-v').textContent = '60%';
      actions.scenario();
    });
  }

  /** Reflects the server's view of your nation. */
  update(pub: NationView | null, own: MyNation | null, stats: TownStats | null, demoSpeed: boolean, serverNow: number): void {
    if (!pub || !own) return;
    const q = (sel: string) => this.root.querySelector(sel) as HTMLElement;
    const pendingTax = own.pending?.taxRate;
    const shownTax = pendingTax ?? own.taxRate;
    if (!this.dragging) {
      (q('.gp-tax input') as HTMLInputElement).value = String(shownTax);
      q('.gp-tax-v').textContent = `${shownTax}%`;
    }
    q('.gp-pending').hidden = pendingTax === undefined;
    const services = own.pending?.services ?? own.services;
    for (const k of ['health', 'education', 'police'] as const) (q(`[data-svc="${k}"]`) as HTMLInputElement).checked = services[k];
    const speed = this.root.querySelector<HTMLInputElement>('.gp-speed');
    if (speed) speed.checked = demoSpeed;

    const sat = pub.satisfaction;
    const stage = unrestStage(sat);
    const box = q('.gp-unrest');
    box.dataset.stage = String(stage);
    q('.gp-sat').textContent = `${sat.toFixed(1)}%`;
    q('.gp-stage').textContent = ['Calm', `Warning: below ${SIM.warningStages[0]}%`, `Warning: below ${SIM.warningStages[1]}%`, `Warning: below ${SIM.warningStages[2]}%`, `UPRISING: ${own.lowSatTicks}/${SIM.overthrowTicks} ticks at ≤${SIM.overthrowAt}%`][stage];

    const h: NationHistory = own.history;
    sparkline(this.canvases.population, h.population, '#4fb3ff');
    sparkline(this.canvases.satisfaction, h.satisfaction, sat <= 30 ? '#ff6b6b' : '#3ddc84', 0, 100);
    sparkline(this.canvases.employment, h.employment ?? [], '#ffd36b', 0, 100);
    sparkline(this.canvases.funds, h.funds, '#c8a2ff');
    q('[data-v="population"]').textContent = formatPopulation(pub.population);
    q('[data-v="satisfaction"]').textContent = `${sat.toFixed(1)}%`;
    q('[data-v="employment"]').textContent = stats ? `${Math.round(stats.employment * 100)}%` : '—';
    q('[data-v="funds"]').textContent = formatMoney(pub.funds);
    if (stats) {
      q('.gp-facts').innerHTML = [
        `Homes ${Math.round(stats.housing * 100)}%`,
        `Food ${stats.shortage ? '<b class="bad">SHORTAGE</b>' : `${Math.round(own.food)} (${stats.foodBalance >= 0 ? '+' : ''}${stats.foodBalance.toFixed(1)}/h)`}`,
        `Safety ${Math.round(stats.safety * 100)}%`,
        `Target ${Math.round(stats.target)}%`,
      ].join(' · ');
    }
    const announce = own.announcement && own.announcement.until > serverNow ? own.announcement.id : null;
    this.root.querySelectorAll<HTMLButtonElement>('[data-ann]').forEach((b) => b.classList.toggle('on', b.dataset.ann === announce));
  }

  setInbox(items: readonly InboxItem[]): void {
    const list = this.root.querySelector('.gp-inbox');
    if (!list) return;
    const recent = items.slice(-6).reverse();
    list.innerHTML = recent.length
      ? recent.map((m) => `<li class="${m.kind}"><b>${escapeHtml(m.title)}</b><span>${escapeHtml(m.body)}</span></li>`).join('')
      : '<li class="muted">No messages yet.</li>';
  }
}
