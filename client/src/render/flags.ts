import { PRIMARIES, ACCENTS, contrastingAccent, colorDistance } from '../../../shared/palette.ts';
import type { FlagDesign } from '../../../shared/earth.ts';

export const FLAG_W = 120;
export const FLAG_H = 80;
const PAD = 4;
export const FLAG_CELL_W = FLAG_W + PAD * 2;
export const FLAG_CELL_H = FLAG_H + PAD * 2;
export const FLAG_COLS = 20;

export interface FlagColors {
  primary: string;
  secondary: string;
  tertiary: string;
}

export function flagColors(design: FlagDesign, primaryIndex: number): FlagColors {
  const primary = PRIMARIES[primaryIndex];
  const secondary = contrastingAccent(primary, design.secondary);
  let tertiary = contrastingAccent(primary, design.tertiary);
  if (colorDistance(tertiary, secondary) < 120) {
    tertiary = ACCENTS.map(String).find((c) => colorDistance(c, secondary) > 200 && colorDistance(c, primary) > 200) ?? '#f4f1e8';
  }
  return { primary, secondary, tertiary };
}

function star(ctx: CanvasRenderingContext2D, cx: number, cy: number, r: number, points = 5): void {
  ctx.beginPath();
  for (let i = 0; i < points * 2; i++) {
    const rad = i % 2 === 0 ? r : r * 0.45;
    const a = -Math.PI / 2 + (i * Math.PI) / points;
    const x = cx + Math.cos(a) * rad;
    const y = cy + Math.sin(a) * rad;
    if (i === 0) ctx.moveTo(x, y);
    else ctx.lineTo(x, y);
  }
  ctx.closePath();
  ctx.fill();
}

function emblem(ctx: CanvasRenderingContext2D, kind: number, cx: number, cy: number, r: number, color: string): void {
  ctx.fillStyle = color;
  ctx.strokeStyle = color;
  switch (kind) {
    case 0:
      star(ctx, cx, cy, r);
      break;
    case 1:
      ctx.beginPath();
      ctx.arc(cx, cy, r * 0.8, 0, Math.PI * 2);
      ctx.fill();
      break;
    case 2:
      ctx.lineWidth = r * 0.32;
      ctx.beginPath();
      ctx.arc(cx, cy, r * 0.7, 0, Math.PI * 2);
      ctx.stroke();
      break;
    default:
      ctx.beginPath();
      ctx.moveTo(cx, cy - r);
      ctx.lineTo(cx + r * 0.75, cy);
      ctx.lineTo(cx, cy + r);
      ctx.lineTo(cx - r * 0.75, cy);
      ctx.closePath();
      ctx.fill();
  }
}

/**
 * Draws a fictional flag. The primary colour always covers at least half of the
 * flag, because it is the colour that must contrast with neighbouring countries.
 */
export function drawFlag(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, design: FlagDesign, colors: FlagColors): void {
  const { primary: p, secondary: s, tertiary: t } = colors;
  ctx.save();
  ctx.beginPath();
  ctx.rect(x, y, w, h);
  ctx.clip();
  ctx.fillStyle = p;
  ctx.fillRect(x, y, w, h);
  const cx = x + w / 2;
  const cy = y + h / 2;
  const u = h / 10;

  switch (design.pattern) {
    case 0: // horizontal bicolour, primary on top 60%
      ctx.fillStyle = s;
      ctx.fillRect(x, y + h * 0.6, w, h * 0.4);
      emblem(ctx, design.emblem, x + w * 0.18, y + h * 0.3, u * 1.8, t);
      break;
    case 1: // vertical triband primary-secondary-primary
      ctx.fillStyle = s;
      ctx.fillRect(x + w / 3, y, w / 3, h);
      emblem(ctx, design.emblem, cx, cy, u * 2, t);
      break;
    case 2: // horizontal triband with a wide primary centre
      ctx.fillStyle = s;
      ctx.fillRect(x, y, w, h * 0.22);
      ctx.fillRect(x, y + h * 0.78, w, h * 0.22);
      emblem(ctx, design.emblem, cx, cy, u * 2.2, t);
      break;
    case 3: { // off-centre cross
      ctx.fillStyle = s;
      ctx.fillRect(x + w * 0.3, y, h * 0.2, h);
      ctx.fillRect(x, y + h * 0.4, w, h * 0.2);
      ctx.fillStyle = t;
      ctx.fillRect(x + w * 0.3 + h * 0.06, y, h * 0.08, h);
      ctx.fillRect(x, y + h * 0.46, w, h * 0.08);
      break;
    }
    case 4: // centred disc
      ctx.fillStyle = s;
      ctx.beginPath();
      ctx.arc(cx, cy, h * 0.3, 0, Math.PI * 2);
      ctx.fill();
      emblem(ctx, design.emblem, cx, cy, h * 0.16, t);
      break;
    case 5: // hoist triangle
      ctx.fillStyle = s;
      ctx.beginPath();
      ctx.moveTo(x, y);
      ctx.lineTo(x + w * 0.42, cy);
      ctx.lineTo(x, y + h);
      ctx.closePath();
      ctx.fill();
      emblem(ctx, design.emblem, x + w * 0.13, cy, u * 1.5, t);
      break;
    case 6: // chevron band
      ctx.fillStyle = s;
      ctx.beginPath();
      ctx.moveTo(x, y);
      ctx.lineTo(x + w * 0.22, y);
      ctx.lineTo(x + w * 0.52, cy);
      ctx.lineTo(x + w * 0.22, y + h);
      ctx.lineTo(x, y + h);
      ctx.lineTo(x + w * 0.3, cy);
      ctx.closePath();
      ctx.fill();
      break;
    case 7: // diagonal band
      ctx.fillStyle = s;
      ctx.beginPath();
      ctx.moveTo(x, y + h);
      ctx.lineTo(x, y + h * 0.72);
      ctx.lineTo(x + w * 0.8, y);
      ctx.lineTo(x + w, y);
      ctx.lineTo(x + w, y + h * 0.28);
      ctx.lineTo(x + w * 0.2, y + h);
      ctx.closePath();
      ctx.fill();
      emblem(ctx, design.emblem, x + w * 0.16, y + h * 0.24, u * 1.5, t);
      break;
    case 8: // saltire
      ctx.strokeStyle = s;
      ctx.lineWidth = h * 0.16;
      ctx.beginPath();
      ctx.moveTo(x, y);
      ctx.lineTo(x + w, y + h);
      ctx.moveTo(x + w, y);
      ctx.lineTo(x, y + h);
      ctx.stroke();
      emblem(ctx, design.emblem, cx, cy, u * 1.6, t);
      break;
    case 9: // canton with emblem
      ctx.fillStyle = s;
      ctx.fillRect(x, y, w * 0.4, h * 0.5);
      emblem(ctx, design.emblem, x + w * 0.2, y + h * 0.25, u * 1.6, t);
      break;
    default: // framed field
      ctx.strokeStyle = s;
      ctx.lineWidth = h * 0.14;
      ctx.strokeRect(x + h * 0.07, y + h * 0.07, w - h * 0.14, h - h * 0.14);
      emblem(ctx, design.emblem, cx, cy, u * 2.2, t);
      break;
  }
  ctx.restore();
}

/** Builds the 20 x 10 flag atlas used by the planet shader. Each cell has an edge-extended pad. */
export function buildFlagAtlas(designs: FlagDesign[], primaries: number[]): HTMLCanvasElement {
  const rows = Math.ceil(designs.length / FLAG_COLS);
  const canvas = document.createElement('canvas');
  canvas.width = FLAG_COLS * FLAG_CELL_W;
  canvas.height = rows * FLAG_CELL_H;
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('2D canvas unavailable');
  designs.forEach((design, i) => {
    const cx = (i % FLAG_COLS) * FLAG_CELL_W;
    const cy = Math.floor(i / FLAG_COLS) * FLAG_CELL_H;
    const colors = flagColors(design, primaries[i]);
    // draw oversized into the padding so mip-mapped sampling never bleeds a neighbour
    drawFlag(ctx, cx, cy, FLAG_CELL_W, FLAG_CELL_H, design, colors);
    drawFlag(ctx, cx + PAD, cy + PAD, FLAG_W, FLAG_H, design, colors);
  });
  return canvas;
}

/** Padding as a fraction of a cell, so the shader samples only the inner flag. */
export const FLAG_INSET: [number, number] = [PAD / FLAG_CELL_W, PAD / FLAG_CELL_H];
