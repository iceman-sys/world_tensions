import type { AwaySummary } from '../../../shared/protocol.ts';
import { escapeHtml, formatDuration, formatInt, formatMoney, formatPopulation, formatSigned } from './format.ts';

const LOST_TEXT: Record<string, string> = {
  inactivity: 'Your country was lost because you were away too long. You can found a new one.',
  overthrow: 'Your citizens overthrew the government. You can found a new country.',
  conquest: 'Your country was conquered. You can found a new one.',
};

function row(label: string, before: string, after: string, delta: string, cls: string): string {
  return `<tr><th scope="row">${label}</th><td>${before}</td><td>${after}</td><td class="${cls}">${delta}</td></tr>`;
}

const tone = (d: number) => (d > 0 ? 'up' : d < 0 ? 'down' : '');

/** HTML for the "while you were away" dialog. All values come from the server. */
export function renderAwaySummary(s: AwaySummary): { period: string; html: string } {
  const period = `Away for ${formatDuration(s.until - s.since)} · ${formatInt(s.ticks)} economy ticks simulated on your return`;
  const parts: string[] = [];
  if (s.lost) parts.push(`<p class="lost">${escapeHtml(LOST_TEXT[s.lost] ?? 'Your country was lost.')}</p>`);
  if (!s.lost) {
    const [f0, f1] = s.funds;
    const [p0, p1] = s.population;
    const [s0, s1] = s.satisfaction;
    const rows = [
      row('Treasury', formatMoney(f0), formatMoney(f1), formatSigned(f1 - f0, formatMoney), tone(f1 - f0)),
      row('Population', formatPopulation(p0), formatPopulation(p1), formatSigned(p1 - p0, formatPopulation), tone(p1 - p0)),
      row('Satisfaction', `${s0.toFixed(1)}%`, `${s1.toFixed(1)}%`, formatSigned(s1 - s0, (v) => `${v.toFixed(1)} pts`), tone(s1 - s0)),
      ...s.resources
        .filter((r) => r.before !== r.after || r.after > 0)
        .map((r) => row(escapeHtml(r.name), formatInt(r.before), formatInt(r.after), formatSigned(r.after - r.before, formatInt), tone(r.after - r.before))),
    ];
    parts.push(`<table class="away-table"><thead><tr><th></th><th>Before</th><th>Now</th><th>Change</th></tr></thead><tbody>${rows.join('')}</tbody></table>`);
  }
  if (s.events.length) {
    parts.push(
      `<h3 class="p-sub">Messages</h3><ul class="away-events">${s.events
        .slice(-8)
        .map((e) => `<li class="${e.kind}"><b>${escapeHtml(e.title)}</b><span>${escapeHtml(e.body)}</span></li>`)
        .join('')}</ul>`,
    );
  }
  return { period, html: parts.join('') };
}
