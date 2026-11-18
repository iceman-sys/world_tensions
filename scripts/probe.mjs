// GPU vs CPU precision probe: renders ?debug=probe* and compares the centre pixel
// with the JS value. `npx tsx scripts/probe.mjs`
import { chromium } from 'playwright';
import { createServer } from 'vite';
import { generateEarthMeta } from '../shared/earth.ts';
import { warpDir } from '../shared/warp.ts';
import { snoise3 } from '../shared/noise.ts';

const vite = await createServer({ configFile: 'vite.config.ts', server: { port: 5198, host: '127.0.0.1' } });
await vite.listen();
const base = vite.resolvedUrls.local[0];
const browser = await chromium.launch({ args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader'] });

async function readCentre(page) {
  const buf = await page.screenshot({ clip: { x: 400, y: 300, width: 1, height: 1 }, timeout: 120000 });
  const rgb = await page.evaluate(async (b64) => {
    const img = new Image();
    img.src = `data:image/png;base64,${b64}`;
    await img.decode();
    const c = document.createElement('canvas');
    c.width = c.height = 1;
    const x = c.getContext('2d');
    x.drawImage(img, 0, 0);
    return [...x.getImageData(0, 0, 1, 1).data.slice(0, 3)];
  }, buf.toString('base64'));
  return (rgb[0] / 255 + rgb[1] / 65025 + rgb[2] / 16581375) * 2 - 1;
}

const mode = process.argv[2] ?? 'probeconst';
const seeds = mode === 'probeconst' ? ['1234ABCD', '00000001', 'DEADBEEF', '7F00AA11', '0BADC0DE'] : ['1234ABCD'];
const views = mode === 'probeconst' ? [[0, 0]] : [[18, 30], [-40, 100], [60, -70], [5, 170]];

for (const seed of seeds) {
  const off = generateEarthMeta(parseInt(seed, 16)).warpOffset;
  const page = await browser.newPage({ viewport: { width: 800, height: 600 } });
  await page.goto(`${base}?seed=${seed}&fallback=off&debug=${mode}`);
  await page.waitForFunction(() => window.__wt?.ready === true, null, { timeout: 120000 });
  for (const [lat, lon] of views) {
    await page.evaluate(([la, lo]) => window.__wt.setView(la, lo, 3.3), [lat, lon]);
    await page.waitForTimeout(500);
    const gpu = await readCentre(page);
    const la = (lat * Math.PI) / 180, lo = (lon * Math.PI) / 180;
    const d = [Math.cos(la) * Math.sin(lo), Math.sin(la), Math.cos(la) * Math.cos(lo)];
    let cpu;
    if (mode === 'probe') {
      const w = [0, 0, 0];
      warpDir(d[0], d[1], d[2], off, w);
      cpu = w[0];
    } else if (mode === 'probenoise') {
      cpu = snoise3(d[0] * 1.6 + off[0], d[1] * 1.6 + off[1], d[2] * 1.6 + off[2]);
    } else {
      cpu = snoise3(off[0], off[1], off[2]);
    }
    console.log(`${mode} seed ${seed} view ${lat},${lon}  in=(${off.map((v) => v.toFixed(3)).join(', ')})  gpu ${gpu.toFixed(5)}  cpu ${cpu.toFixed(5)}  diff ${(gpu - cpu).toExponential(2)}`);
  }
  await page.close();
}
await browser.close();
await vite.close();
