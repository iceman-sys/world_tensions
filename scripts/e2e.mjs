// End-to-end checks against the real server + client: `npm run e2e [scenario]`.
// Starts the game server on a throw-away database and Vite, drives headless Chromium
// (SwiftShader WebGL), saves screenshots to ./screenshots/e2e and fails on console errors.
import { chromium } from 'playwright';
import { spawn } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const PORT = 8899;
const OUT = 'screenshots/e2e';
mkdirSync(OUT, { recursive: true });
const dataDir = mkdtempSync(join(tmpdir(), 'wt-e2e-'));
const DB_FILE = join(dataDir, 'world.db');

// ---------- processes ----------
let server = null;
let serverLog = '';
/** expected noise while the server is deliberately down */
let serverDown = false;
let restartedAt = 0;

export async function startServer(extraEnv = {}) {
  serverLog = '';
  server = spawn(process.execPath, ['--import', 'tsx', 'server/src/index.ts'], {
    env: { ...process.env, PORT: String(PORT), DB_FILE, STATE_FILE: join(dataDir, 'none.json'), EARTH_SEED: '1234ABCD', DEMO_MODE: 'true', ...extraEnv },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  server.stdout.on('data', (d) => (serverLog += d));
  server.stderr.on('data', (d) => (serverLog += d));
  const deadline = Date.now() + 60000;
  while (!serverLog.includes('listening on')) {
    if (Date.now() > deadline) throw new Error(`server did not start:\n${serverLog}`);
    if (server.exitCode !== null) throw new Error(`server exited:\n${serverLog}`);
    await new Promise((r) => setTimeout(r, 100));
  }
  serverDown = false;
  restartedAt = Date.now();
}

/** Hard kill (no shutdown hook), like a crash or a `tsx watch` restart. */
export async function killServer() {
  serverDown = true;
  const s = server;
  server = null;
  if (!s || s.exitCode !== null) return;
  await new Promise((r) => {
    s.once('exit', r);
    s.kill('SIGKILL');
  });
}

process.env.VITE_WS_URL = `ws://127.0.0.1:${PORT}`;
const { createServer } = await import('vite');
const vite = await createServer({ configFile: 'vite.config.ts', server: { port: 5197, strictPort: false, host: '127.0.0.1' } });
await vite.listen();
const BASE = vite.resolvedUrls.local[0];

const browser = await chromium.launch({ args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'] });
const errors = [];

/** A browser profile (own localStorage = own governor). */
export async function profile(label, size = [1024, 640]) {
  const p = { ctx: null, open: null, close: null };
  /** saved localStorage (the session token) carried over when the profile reopens */
  let state;
  p.close = async () => {
    if (!p.ctx) return;
    state = await p.ctx.storageState();
    await p.ctx.close();
    p.ctx = null;
  };
  p.open = async () => {
    // a fresh context per visit: reusing one after its page closed can stall under SwiftShader
    await p.close();
    p.ctx = await browser.newContext({ viewport: { width: size[0], height: size[1] }, storageState: state });
    const page = await p.ctx.newPage();
    page.setDefaultTimeout(240000);
    page.on('console', (m) => {
      const text = m.text();
      if (process.env.E2E_VERBOSE) console.log(`  [${label} ${m.type()}] ${text}`);
      if (m.type() !== 'error' && m.type() !== 'warning') return;
      // the browser logs failed WebSocket connects while we deliberately restart the server
      if ((serverDown || Date.now() - restartedAt < 15000) && /WebSocket|ERR_CONNECTION_REFUSED/i.test(text)) return;
      // Chromium/SwiftShader readback noise caused by page.screenshot (also seen by npm run shots)
      if (/GL Driver Message|glBlitFramebuffer: Blit feedback loop/.test(text)) return;
      errors.push(`${label} ${m.type()}: ${text}`);
    });
    page.on('pageerror', (e) => errors.push(`${label} pageerror: ${e.message}`));
    await step(`${label}: open`, () => page.goto(`${BASE}?fallback=off`, { waitUntil: 'domcontentloaded', timeout: 60000 }));
    await step(`${label}: ready`, () =>
      page.waitForFunction(() => window.__wt?.ready === true && window.__wt.net().status === 'online', null, { timeout: 120000, polling: 250 }),
    );
    return page;
  };
  return p;
}

export async function shot(page, name) {
  await page.waitForTimeout(700);
  await page.screenshot({ path: `${OUT}/${name}.png` });
  console.log(`  saved ${OUT}/${name}.png`);
}

export async function step(label, fn) {
  const t = Date.now();
  try {
    return await fn();
  } catch (e) {
    throw new Error(`step '${label}' failed after ${Date.now() - t} ms: ${e.message.split('\n')[0]}`);
  }
}

export function check(cond, message) {
  if (!cond) throw new Error(`check failed: ${message}`);
  console.log(`  ok: ${message}`);
}

export async function joinViaUi(page, name) {
  await page.click('#btn-join');
  await page.fill('#join-name', name);
  await page.click('#join-submit');
  await step('join: wait for country', () => page.waitForFunction(() => (window.__wt.net().you?.countryId ?? -1) >= 0, null, { timeout: 120000, polling: 250 }));
  return page.evaluate(() => window.__wt.net().you);
}

// ---------- scenarios ----------
const SCENARIOS = {
  /** Milestone 1: persistence, resume after restart, inactivity countdown, away summary. */
  async m1() {
    await startServer();
    const alice = await profile('alice');
    const bob = await profile('bob');
    const a1 = await alice.open();
    const you = await joinViaUi(a1, 'Alice');
    check(you.countryId >= 0, `Alice was assigned cell ${you.countryId}`);
    await a1.evaluate(() => window.__wt.setView(0, 0, 3.3));
    await shot(a1, 'm1-01-joined');

    const b1 = await bob.open();
    await b1.evaluate((id) => window.__wt.select(id, true), you.countryId);
    await b1.waitForFunction((id) => window.__wt.net().countries[id].owner === 'Alice' && window.__wt.net().countries[id].online, you.countryId, { polling: 250 });
    check(true, 'second tab sees Alice online');

    await alice.close(); // Alice leaves: offline + inactivity countdown for everyone
    await b1.waitForFunction((id) => window.__wt.net().countries[id].lostAt !== null, you.countryId, { polling: 250 });
    const status = await b1.textContent('#p-status');
    check(/lost in/.test(status ?? ''), `countdown shown: "${status}"`);
    await shot(b1, 'm1-02-offline-countdown');

    const fundsBefore = await b1.evaluate((id) => window.__wt.net().nations.find((n) => n.homeCell === id)?.funds, you.countryId);
    await killServer();
    await b1.waitForFunction(() => window.__wt.net().status === 'reconnecting', null, { polling: 250 });
    check(true, 'clients notice the server going away');
    await new Promise((r) => setTimeout(r, 11000)); // two economy ticks of downtime
    await startServer();
    await b1.waitForFunction(() => window.__wt.net().status === 'online', null, { timeout: 120000, polling: 250 });
    const owner = await b1.evaluate((id) => window.__wt.net().countries[id].owner, you.countryId);
    check(owner === 'Alice', 'ownership survived the restart');

    const a2 = await alice.open(); // same profile = same session token
    const resumed = await a2.evaluate(() => window.__wt.net().you);
    check(resumed?.playerId === you.playerId && resumed.countryId === you.countryId, 'Alice resumed her session and country');
    await a2.waitForSelector('#away-dialog[open]');
    const period = await a2.textContent('#away-period');
    check(/economy ticks simulated/.test(period ?? ''), `away summary: "${period}"`);
    await shot(a2, 'm1-03-away-summary');
    const fundsAfter = await a2.evaluate(() => window.__wt.net().nations.find((n) => n.id === window.__wt.net().you?.nationId)?.funds);
    check(fundsAfter > fundsBefore, `treasury grew while away (${fundsBefore} -> ${fundsAfter})`);
    await a2.click('#away-ok');
    await alice.close();
    await bob.close();
  },

  /** Country View CV1: transition, terrain from several angles, entry rules, no leaks. */
  async cv1() {
    await startServer();
    const carla = await profile('carla', [1280, 720]);
    const page = await carla.open();
    const you = await joinViaUi(page, 'Carla');
    await page.waitForTimeout(1500);
    const until = (fn, arg, timeout = 120000) => page.waitForFunction(fn, arg, { timeout, polling: 200 });
    const inside = () => until(() => window.__wt.country().inside && !window.__wt.country().busy);
    const outside = () => until(() => !window.__wt.country().inside && !window.__wt.country().busy);

    await page.evaluate((id) => window.__wt.select(id, true), you.countryId);
    await page.waitForTimeout(1800);
    check(await page.isVisible('#p-enter'), 'own profile offers "Enter country view"');
    await shot(page, 'cv1-01-globe-own-country');
    const baseline = await page.evaluate(() => window.__wt.memory());

    // other countries cannot be entered (double-click on a neighbour)
    const other = await page.evaluate((id) => window.__wt.neighbors(id).find((n) => true), you.countryId);
    if (other !== undefined) {
      await page.evaluate((id) => window.__wt.select(id, false), other);
      check(!(await page.isVisible('#p-enter')), 'a neighbour\'s profile has no enter button');
    }

    // button entry with a mid-transition frame
    await page.click('#btn-enter');
    await page.waitForTimeout(550);
    await page.screenshot({ path: `${OUT}/cv1-02-transition.png` });
    console.log(`  saved ${OUT}/cv1-02-transition.png`);
    await step('enter via button', inside);
    const stats = await page.evaluate(() => window.__wt.country().stats);
    check(stats.drawCalls > 0 && stats.instances > 100, `country scene renders (${stats.drawCalls} draw calls, ${stats.instances} instances, ${stats.triangles} triangles)`);
    await shot(page, 'cv1-03-terrain-capital');
    for (const [name, az, polar, dist] of [['cv1-04-overview', 0, 12, 230], ['cv1-05-low-angle', 140, 72, 75], ['cv1-06-side', 260, 55, 140]]) {
      await page.evaluate(([a, p, d]) => window.__wt.countryOrbit(a, p, d), [az, polar, dist]);
      await shot(page, name);
    }

    await page.keyboard.press('Escape');
    await step('Esc returns to the globe', outside);
    await shot(page, 'cv1-07-back-on-globe');

    // auto-enter: zoom the globe right onto the own country
    const c = await page.evaluate((id) => window.__wt.centroid(id), you.countryId);
    const lat = (Math.asin(c[1]) * 180) / Math.PI;
    const lon = (Math.atan2(c[0], c[2]) * 180) / Math.PI;
    await page.evaluate(([la, lo]) => window.__wt.setView(la, lo, 1.5), [lat, lon]);
    await page.waitForTimeout(300);
    await page.evaluate(([la, lo]) => window.__wt.setView(la, lo, 1.15), [lat, lon]);
    await step('zooming in close enters automatically', inside);
    check(true, 'auto-enter on zoom works');
    await page.evaluate(() => window.__wt.exitCountry());
    await outside();

    // leak check: after the first visit (three.js creates a few one-time shared resources),
    // repeated enter/exit must return GPU memory to exactly the same numbers
    const firstVisit = await page.evaluate(() => window.__wt.memory());
    console.log(`  globe only: ${JSON.stringify(baseline)}, after first visits: ${JSON.stringify(firstVisit)}`);
    for (let i = 0; i < 5; i++) {
      await page.evaluate(() => window.__wt.enterCountry());
      await inside();
      await page.evaluate(() => window.__wt.exitCountry());
      await outside();
    }
    const after = await page.evaluate(() => window.__wt.memory());
    check(
      after.geometries === firstVisit.geometries && after.textures === firstVisit.textures && after.geometries === baseline.geometries,
      `no GPU leaks over 5 more enter/exit cycles (geometries ${firstVisit.geometries} -> ${after.geometries}, textures ${firstVisit.textures} -> ${after.textures})`,
    );
    await carla.close();
  },
};

const wanted = process.argv[2];
let failed = false;
try {
  for (const [name, run] of Object.entries(SCENARIOS)) {
    if (wanted && name !== wanted) continue;
    console.log(`scenario ${name}`);
    await run();
    await killServer();
  }
} catch (e) {
  failed = true;
  console.error(`\nFAILED: ${e.message}`);
  if (serverLog) console.error(`--- server log ---\n${serverLog.slice(-3000)}`);
} finally {
  await killServer().catch(() => {});
  await browser.close();
  await vite.close();
  rmSync(dataDir, { recursive: true, force: true });
}
if (errors.length) {
  console.error(`\n${errors.length} console problems:`);
  for (const e of [...new Set(errors)]) console.error(`  ${e}`);
  failed = true;
}
if (failed) process.exit(1);
console.log('\ne2e passed, no console errors');
