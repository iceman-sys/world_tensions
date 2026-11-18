// Visual check: `npm run shots [filter]`.
// Renders the globe at several zoom levels with headless Chromium (SwiftShader WebGL)
// and saves PNGs to ./screenshots. Exits non-zero on console errors.
// SwiftShader renders on the CPU, so each shot uses a fresh page and a modest viewport.
import { chromium } from 'playwright';
import { mkdirSync } from 'node:fs';

let vite = null;
let BASE = process.env.SHOTS_URL;
if (!BASE) {
  const { createServer } = await import('vite');
  vite = await createServer({ configFile: 'vite.config.ts', server: { port: 5199, strictPort: false, host: '127.0.0.1' } });
  await vite.listen();
  BASE = vite.resolvedUrls.local[0];
  console.log(`started vite at ${BASE}`);
}
const SEED = process.env.SHOTS_SEED ?? '1234ABCD';
const OUT = 'screenshots';
mkdirSync(OUT, { recursive: true });

const browser = await chromium.launch({
  args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'],
});
const errors = [];

/**
 * One screenshot on a fresh page. `setup` runs after the camera is placed.
 * fallback=off: the low-FPS fallback would always fire under SwiftShader.
 */
async function shot(name, { query = '', lat = 18, lon = 30, dist = 3.3, size = [1280, 800], setup } = {}) {
  const page = await browser.newPage({ viewport: { width: size[0], height: size[1] } });
  page.setDefaultTimeout(240000);
  page.on('console', (m) => {
    if (m.type() === 'error' || m.type() === 'warning') errors.push(`${name} ${m.type()}: ${m.text()}`);
  });
  page.on('pageerror', (e) => errors.push(`${name} pageerror: ${e.message}`));
  await page.goto(`${BASE}?seed=${SEED}&fallback=off${query}`);
  await page.waitForFunction(() => window.__wt?.ready === true);
  const genMs = await page.evaluate(() => window.__wt.genMs());
  await page.evaluate(([la, lo, d]) => window.__wt.setView(la, lo, d), [lat, lon, dist]);
  if (setup) await setup(page);
  await page.waitForTimeout(1200);
  await page.screenshot({ path: `${OUT}/${name}.png` });
  console.log(`saved ${OUT}/${name}.png (generation ${genMs.toFixed(0)} ms)`);
  await page.close();
}

const selectCenter = async (page) => {
  const id = await page.evaluate(() => window.__wt.pickCenter());
  await page.evaluate((i) => window.__wt.select(i, false), id);
};

const SHOTS = {
  '01-globe': {},
  '02-mid': { dist: 1.9, size: [960, 600] },
  '03-close': { dist: 1.3, size: [960, 600] },
  '04-closest': { dist: 1.13, size: [960, 600] },
  '05-north-pole': { lat: 88, lon: 0, dist: 2.0, size: [960, 600] },
  '06-selected': { dist: 2.0, size: [1280, 800], setup: selectCenter },
  '07-hover': { lat: -25, lon: 140, dist: 2.2, size: [960, 600], setup: (p) => p.mouse.move(480, 300) },
  '08-mobile': { lat: 10, lon: 60, size: [390, 844], setup: selectCenter },
  '09-debug-ids': { query: '&debug=ids' },
  '10-debug-mismatch': { query: '&debug=mismatch', dist: 1.6, size: [960, 600] },
};

const filter = process.argv[2];
for (const [name, opts] of Object.entries(SHOTS)) {
  if (filter && !name.includes(filter)) continue;
  try {
    await shot(name, opts);
  } catch (e) {
    errors.push(`${name} failed: ${e.message.split('\n')[0]}`);
  }
}

await browser.close();
await vite?.close();
if (errors.length) {
  console.error(`\n${errors.length} problems:`);
  for (const e of [...new Set(errors)]) console.error(`  ${e}`);
  process.exit(1);
}
console.log('no console errors');
