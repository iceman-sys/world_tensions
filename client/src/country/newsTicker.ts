import type { NewsItem } from '../../../shared/model.ts';
import { escapeHtml } from '../ui/format.ts';

/**
 * Country News: a scrolling ticker of items the SERVER reported from real
 * simulation events. Every item is labelled; the client never adds its own.
 */
export class NewsTicker {
  private last = '';

  constructor(private readonly root: HTMLElement) {}

  render(items: readonly NewsItem[]): void {
    const recent = items.slice(-8).reverse();
    const key = recent.map((i) => i.id).join(',');
    if (key === this.last) return;
    this.last = key;
    if (!recent.length) {
      this.root.innerHTML = '<span class="nt-label">Country News</span><div class="nt-track"><span class="nt-item muted">No news yet: things are quiet.</span></div>';
      return;
    }
    const html = recent
      .map((i) => `<span class="nt-item"><em class="nt-tag ${i.kind}">${i.kind === 'fact' ? 'FACT' : 'FLAVOR'}</em>${escapeHtml(i.text)}</span>`)
      .join('<span class="nt-sep">•</span>');
    // duplicated so the marquee loops seamlessly
    this.root.innerHTML = `<span class="nt-label">Country News</span><div class="nt-track"><div class="nt-run">${html}<span class="nt-sep">•</span>${html}</div></div>`;
  }
}
