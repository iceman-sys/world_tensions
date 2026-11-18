import type { Citizen } from '../../../shared/country/citizens.ts';
import { mulberry32 } from '../../../shared/rng.ts';

const SKIN = ['#f1d3b8', '#e0b48f', '#c99470', '#a8714f', '#7d5038', '#5b3a28'];
const HAIR = ['#2b1d14', '#4a3020', '#7a4b2a', '#b07a3c', '#d9b26a', '#1b1b1f', '#8a3b28'];
const BG: Record<string, string> = {
  frugal: '#cfe0c8', 'family-oriented': '#f2d9c4', ambitious: '#d8cdf0', cautious: '#cdd9e6', cheerful: '#f7e7a8', grumpy: '#c9c3bd',
  loyal: '#c9dcf2', independent: '#e3d2bd', curious: '#c8ece3', 'hard-working': '#e8d3a8', generous: '#f0cfd6', worried: '#d6d6e6',
};

/**
 * Draws a friendly cartoon portrait from the citizen's traits, age, job and mood.
 * Deterministic per citizen (seeded); only the expression follows the happiness.
 */
export function drawPortrait(canvas: HTMLCanvasElement, c: Citizen): void {
  const ctx = canvas.getContext('2d');
  if (!ctx) return;
  const W = canvas.width, H = canvas.height;
  const rng = mulberry32(c.seed);
  const skin = SKIN[Math.floor(rng() * SKIN.length)];
  const gray = c.age > 62;
  const hair = gray ? (rng() < 0.5 ? '#d8d8d8' : '#a9a9a9') : HAIR[Math.floor(rng() * HAIR.length)];
  const style = Math.floor(rng() * 4);
  const child = c.age < 14;
  ctx.clearRect(0, 0, W, H);
  ctx.fillStyle = BG[c.traits[0]] ?? '#dde3ea';
  ctx.fillRect(0, 0, W, H);
  const cx = W / 2;
  const s = W / 100;
  const faceR = (child ? 24 : 27) * s;
  const cy = H * (child ? 0.56 : 0.52);

  // shoulders / clothes coloured by job
  const shirt: Record<string, string> = { Farmer: '#5f8f3a', Miner: '#5b5b63', Teacher: '#c8553d', Shopkeeper: '#e0b84f', Nurse: '#f2f2f2', 'Police officer': '#2f4f8f', 'Town clerk': '#6c3d9c', Gardener: '#3f8a45', Caretaker: '#8a6a4a', Student: '#2f9ad8', Retired: '#9b8a7a', Unemployed: '#7d8590' };
  ctx.fillStyle = shirt[c.job] ?? '#7d8590';
  ctx.beginPath();
  ctx.ellipse(cx, H + 6 * s, 38 * s, 30 * s, 0, Math.PI, 0);
  ctx.fill();
  ctx.fillStyle = skin;
  ctx.fillRect(cx - 7 * s, cy + faceR * 0.75, 14 * s, 12 * s);

  // hair behind the face (long styles)
  ctx.fillStyle = hair;
  if (style === 2) {
    ctx.beginPath();
    ctx.ellipse(cx, cy + 6 * s, faceR * 1.12, faceR * 1.25, 0, 0, Math.PI * 2);
    ctx.fill();
  }
  // face
  ctx.fillStyle = skin;
  ctx.beginPath();
  ctx.ellipse(cx, cy, faceR, faceR * 1.08, 0, 0, Math.PI * 2);
  ctx.fill();
  // hair on top
  ctx.fillStyle = hair;
  ctx.beginPath();
  if (style === 0) ctx.ellipse(cx, cy - faceR * 0.62, faceR * 0.98, faceR * 0.5, 0, Math.PI, 0);
  else if (style === 1) {
    ctx.ellipse(cx, cy - faceR * 0.55, faceR * 1.02, faceR * 0.62, 0, Math.PI, 0);
    ctx.rect(cx - faceR * 1.02, cy - faceR * 0.6, faceR * 0.28, faceR * 0.7);
  } else if (style === 2) ctx.ellipse(cx, cy - faceR * 0.6, faceR * 1.05, faceR * 0.55, 0, Math.PI, 0);
  else if (!gray || rng() < 0.6) ctx.ellipse(cx, cy - faceR * 0.75, faceR * 0.8, faceR * 0.35, 0, Math.PI, 0);
  ctx.fill();

  // eyes
  const eyeY = cy - faceR * 0.05;
  ctx.fillStyle = '#1b1b1f';
  for (const dx of [-0.38, 0.38]) {
    ctx.beginPath();
    ctx.ellipse(cx + dx * faceR, eyeY, 2.6 * s, (c.traits.includes('worried') ? 3.4 : 3) * s, 0, 0, Math.PI * 2);
    ctx.fill();
  }
  // brows: grumpy/worried tilt
  ctx.strokeStyle = gray ? '#8a8a8a' : hair;
  ctx.lineWidth = 2.2 * s;
  const tilt = c.traits.includes('grumpy') ? 3 : c.traits.includes('worried') ? -3 : 0;
  for (const side of [-1, 1]) {
    ctx.beginPath();
    ctx.moveTo(cx + side * faceR * 0.2, eyeY - 8 * s + (side === -1 ? tilt : -tilt) * s * 0.4 + tilt * s * 0.3);
    ctx.lineTo(cx + side * faceR * 0.58, eyeY - 8 * s - tilt * s * 0.3);
    ctx.stroke();
  }
  // glasses for curious minds
  if (c.traits.includes('curious')) {
    ctx.strokeStyle = '#33363d';
    ctx.lineWidth = 1.6 * s;
    for (const dx of [-0.38, 0.38]) {
      ctx.beginPath();
      ctx.arc(cx + dx * faceR, eyeY, 6 * s, 0, Math.PI * 2);
      ctx.stroke();
    }
  }
  // mouth follows the mood
  const mood = (c.happiness - 50) / 50; // -1..1
  ctx.strokeStyle = '#6b2f2a';
  ctx.lineWidth = 2.4 * s;
  ctx.beginPath();
  const my = cy + faceR * 0.48;
  ctx.moveTo(cx - faceR * 0.32, my);
  ctx.quadraticCurveTo(cx, my + mood * 9 * s, cx + faceR * 0.32, my);
  ctx.stroke();
  // cheeks for cheerful people
  if (c.traits.includes('cheerful') || c.happiness > 75) {
    ctx.fillStyle = 'rgba(230, 110, 110, 0.35)';
    for (const dx of [-0.55, 0.55]) {
      ctx.beginPath();
      ctx.arc(cx + dx * faceR, cy + faceR * 0.28, 4.2 * s, 0, Math.PI * 2);
      ctx.fill();
    }
  }
  // job hats
  if (c.job === 'Farmer' || c.job === 'Gardener') {
    ctx.fillStyle = '#d9b26a';
    ctx.fillRect(cx - faceR * 1.25, cy - faceR * 0.85, faceR * 2.5, 4 * s);
    ctx.fillRect(cx - faceR * 0.65, cy - faceR * 1.35, faceR * 1.3, faceR * 0.55);
  } else if (c.job === 'Miner') {
    ctx.fillStyle = '#e0b84f';
    ctx.beginPath();
    ctx.ellipse(cx, cy - faceR * 0.8, faceR * 0.95, faceR * 0.5, 0, Math.PI, 0);
    ctx.fill();
    ctx.fillStyle = '#fff7c2';
    ctx.beginPath();
    ctx.arc(cx, cy - faceR * 1.0, 4 * s, 0, Math.PI * 2);
    ctx.fill();
  } else if (c.job === 'Police officer') {
    ctx.fillStyle = '#1d2c4a';
    ctx.fillRect(cx - faceR * 0.95, cy - faceR * 1.1, faceR * 1.9, faceR * 0.45);
    ctx.fillRect(cx - faceR * 1.1, cy - faceR * 0.7, faceR * 2.2, 3 * s);
  } else if (c.job === 'Nurse') {
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(cx - faceR * 0.55, cy - faceR * 1.15, faceR * 1.1, faceR * 0.4);
    ctx.fillStyle = '#d9302c';
    ctx.fillRect(cx - 1.5 * s, cy - faceR * 1.1, 3 * s, faceR * 0.3);
  }
}
