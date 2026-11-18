import { BUILDING_KINDS, BUILDINGS, type BuildingKind, type BuildingSpec } from '../../../shared/country/buildings.ts';
import { escapeHtml, formatDuration, formatMoney } from '../ui/format.ts';

function effects(s: BuildingSpec): string[] {
  const out: string[] = [];
  if (s.housing) out.push(`+${s.housing} homes`);
  if (s.jobs) out.push(`+${s.jobs} jobs`);
  if (s.food) out.push(`+${s.food} food/h`);
  if (s.education) out.push(`education ${s.education}`);
  if (s.health) out.push(`health care ${s.health}`);
  if (s.safety) out.push(`safety ${s.safety}`);
  if (s.leisure) out.push(`leisure ${s.leisure}`);
  if (s.satisfaction) out.push(`${s.satisfaction > 0 ? '+' : ''}${s.satisfaction} satisfaction`);
  return out;
}

/** Tooltip HTML for a building type (cost, time, upkeep and effects). */
export function buildingTooltip(kind: BuildingKind, buildMs: number): string {
  const s = BUILDINGS[kind];
  return (
    `<b>${escapeHtml(s.label)}</b><span class="muted">${escapeHtml(s.description)}</span>` +
    `<span>Cost <b>${formatMoney(s.cost)}</b> · builds in <b>${formatDuration(buildMs)}</b></span>` +
    `<span>Upkeep ${formatMoney(s.upkeepPerHour)} / game hour</span>` +
    `<span class="fx">${effects(s).map(escapeHtml).join(' · ') || 'no direct effects'}</span>`
  );
}

/**
 * The build bar shown in the country view. Selecting a type starts placement;
 * the server still validates every request.
 */
export class BuildMenu {
  selected: BuildingKind | null = null;
  onSelect: ((kind: BuildingKind | null) => void) | null = null;
  private readonly buttons = new Map<BuildingKind, HTMLButtonElement>();

  constructor(root: HTMLElement, private readonly tip: HTMLElement, private readonly buildMs: (kind: BuildingKind) => number) {
    root.replaceChildren();
    for (const kind of BUILDING_KINDS) {
      const s = BUILDINGS[kind];
      if (!s.buildable) continue;
      const b = document.createElement('button');
      b.type = 'button';
      b.className = 'bm-item';
      b.dataset.kind = kind;
      b.innerHTML = `<span class="bm-swatch" style="background:${s.color}"></span><span class="bm-label">${escapeHtml(s.label)}</span><span class="bm-cost">$${(s.cost / 1e6).toFixed(1)}M</span>`;
      b.setAttribute('aria-pressed', 'false');
      b.addEventListener('click', () => this.select(this.selected === kind ? null : kind));
      b.addEventListener('pointerenter', () => this.showTip(kind, b));
      b.addEventListener('pointerleave', () => (this.tip.hidden = true));
      b.addEventListener('focus', () => this.showTip(kind, b));
      b.addEventListener('blur', () => (this.tip.hidden = true));
      root.append(b);
      this.buttons.set(kind, b);
    }
  }

  private showTip(kind: BuildingKind, anchor: HTMLElement): void {
    this.tip.innerHTML = buildingTooltip(kind, this.buildMs(kind));
    this.tip.hidden = false;
    const r = anchor.getBoundingClientRect();
    this.tip.style.left = `${Math.max(8, Math.min(window.innerWidth - 268, r.left + r.width / 2 - 130))}px`;
    this.tip.style.bottom = `${window.innerHeight - r.top + 8}px`;
  }

  select(kind: BuildingKind | null): void {
    this.selected = kind;
    for (const [k, b] of this.buttons) {
      b.classList.toggle('on', k === kind);
      b.setAttribute('aria-pressed', String(k === kind));
    }
    this.onSelect?.(kind);
  }

  /** Greys out what the treasury cannot pay for. */
  setFunds(funds: number): void {
    for (const [k, b] of this.buttons) b.classList.toggle('poor', funds < BUILDINGS[k].cost);
  }
}
