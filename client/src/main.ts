import './style.css';
import { Globe, QUALITY_LOW } from './render/globe.ts';
import { generateEarthMap, type EarthMap } from './gen/generate.ts';
import { drawFlag, flagColors } from './render/flags.ts';
import { NetClient, resolveServerUrl, type NetStatus } from './net/net.ts';
import { OwnerMarkers } from './ui/markers.ts';
import { $, escapeHtml, formatArea, formatDuration, formatInt, formatMoney, formatPopulation, timeAgo } from './ui/format.ts';
import { renderAwaySummary } from './ui/away.ts';
import { CountryController } from './country/controller.ts';
import type { CountryStats } from './country/view.ts';
import type { Building, BuildingKind } from '../../shared/country/buildings.ts';
import type { Citizen } from '../../shared/country/citizens.ts';
import type { NewsItem, TownStats } from '../../shared/model.ts';
import { deriveSeed, formatSeed, mulberry32, parseSeed, randomSeed } from '../../shared/rng.ts';
import { DEFAULT_FACE_SIZE } from '../../shared/cube.ts';
import { isValidName, normalizeName, NAME_MAX, NAME_MIN, type CountryState, type NationView, type You } from '../../shared/protocol.ts';

type Mode = 'shared' | 'local';

declare global {
  interface Window {
    __wt?: {
      ready: boolean;
      seed: () => number;
      genMs: () => number;
      fps: () => number;
      setView: (lat: number, lon: number, dist: number) => void;
      select: (id: number, fly?: boolean) => void;
      hover: (id: number) => void;
      pickCenter: () => number;
      centroid: (id: number) => [number, number, number];
      neighbors: (id: number) => number[];
      owners: () => (string | null)[];
      net: () => { status: NetStatus; you: You | null; nations: NationView[]; countries: CountryState[] };
      enterCountry: () => Promise<void>;
      exitCountry: () => Promise<void>;
      country: () => { inside: boolean; busy: boolean; stats: CountryStats | null };
      countryOrbit: (azimuth: number, polar: number, dist: number) => void;
      pickBuilding: (kind: BuildingKind | null) => void;
      findBuildSpot: (kind: BuildingKind, valid: boolean) => { x: number; y: number; i: number; j: number } | null;
      setHour: (hour: number | null) => void;
      citizens: () => Citizen[];
      localStats: () => TownStats | null;
      news: () => NewsItem[];
      citizenScreen: (id: number) => { x: number; y: number } | null;
      openCitizen: (id: number) => boolean;
      countryLookAt: (x: number, z: number, dist: number) => void;
      crowd: () => { agents: number; protesters: number; queue: number };
      local: () => Building[];
      memory: () => { geometries: number; textures: number; programs: number };
      globeDistance: () => number;
    };
  }
}

const params = new URLSearchParams(location.search);
const forcedSeed = params.get('seed') ? parseSeed(params.get('seed') ?? '') : null;

// ---------- elements ----------
const stage = $('stage');
const loader = $('loader');
const loaderFill = $('loader-fill');
const loaderText = $('loader-text');
const seedValue = $('seed-value');
const banner = $('banner');
const toastEl = $('toast');
const statsEl = $('stats');
const profile = $('profile');
const searchInput = $('search-input') as HTMLInputElement;
const searchList = $('search-list') as HTMLUListElement;
const btnJoin = $('btn-join') as HTMLButtonElement;
const btnMy = $('btn-my-country') as HTMLButtonElement;
const btnNew = $('btn-new-earth') as HTMLButtonElement;
const joinDialog = $('join-dialog') as HTMLDialogElement;
const joinName = $('join-name') as HTMLInputElement;
const joinError = $('join-error');
const botsRow = $('bots-row');
const botsToggle = $('bots-toggle') as HTMLInputElement;
const awayDialog = $('away-dialog') as HTMLDialogElement;

// ---------- core objects ----------
const globe = new Globe(stage);
const markers = new OwnerMarkers($('markers'), globe);
const net = new NetClient(forcedSeed === null ? resolveServerUrl() : null);

let map: EarthMap | null = null;
let mode: Mode = 'local';
let faceSize = DEFAULT_FACE_SIZE;
let loadToken = 0;
let selected = -1;
let bookmarks = new Set<number>();
let mockOnline: boolean[] = [];
/** true once the user deliberately opened a local preview Earth */
let userChoseLocal = false;

// ---------- helpers ----------
let toastTimer = 0;
function toast(text: string, ms = 3200): void {
  toastEl.textContent = text;
  toastEl.hidden = false;
  window.clearTimeout(toastTimer);
  toastTimer = window.setTimeout(() => (toastEl.hidden = true), ms);
}

function setBanner(text: string | null, kind: 'warn' | 'info' = 'warn'): void {
  banner.hidden = !text;
  banner.textContent = text ?? '';
  banner.classList.toggle('info', kind === 'info');
}

function flagCanvas(id: number, w: number, h: number, existing?: HTMLCanvasElement): HTMLCanvasElement {
  const canvas = existing ?? document.createElement('canvas');
  const dpr = Math.min(2, window.devicePixelRatio || 1);
  canvas.width = Math.round(w * dpr);
  canvas.height = Math.round(h * dpr);
  const ctx = canvas.getContext('2d');
  if (ctx && map) {
    const c = map.meta.countries[id];
    drawFlag(ctx, 0, 0, canvas.width, canvas.height, c.flag, flagColors(c.flag, map.primaries[id]));
  }
  canvas.setAttribute('aria-hidden', 'true');
  return canvas;
}

function countryName(id: number): string {
  return map ? map.meta.countries[id].name : '';
}

function bookmarkKey(): string {
  return `wt.bookmarks.${map ? formatSeed(map.meta.seed) : ''}`;
}

function loadBookmarks(): void {
  bookmarks = new Set();
  try {
    const raw = localStorage.getItem(bookmarkKey());
    if (raw) for (const v of JSON.parse(raw) as unknown[]) if (typeof v === 'number' && v >= 0 && v < 200) bookmarks.add(v);
  } catch {
    /* ignore unavailable/corrupt storage */
  }
}

function saveBookmarks(): void {
  try {
    localStorage.setItem(bookmarkKey(), JSON.stringify([...bookmarks]));
  } catch {
    /* ignore */
  }
}

// ---------- Earth loading ----------
async function loadEarth(seed: number, newMode: Mode): Promise<void> {
  const token = ++loadToken;
  if (country.inCountry) await country.exit();
  loader.classList.remove('done');
  loader.hidden = false;
  loaderText.textContent = `Generating Earth ${formatSeed(seed)}…`;
  const progress = (p: number) => {
    if (token !== loadToken) return;
    const pct = Math.round(p * 100);
    loaderFill.style.width = `${pct}%`;
    loader.setAttribute('aria-valuenow', String(pct));
  };
  let result: EarthMap;
  try {
    result = await generateEarthMap(seed, faceSize, progress);
  } catch (err) {
    loaderText.textContent = `Generation failed: ${err instanceof Error ? err.message : String(err)}`;
    return;
  }
  if (token !== loadToken) return; // a newer request superseded this one

  map = result;
  mode = newMode;
  globe.setEarth(map);
  seedValue.textContent = formatSeed(seed);
  const rng = mulberry32(deriveSeed(seed, 'mock-online'));
  mockOnline = map.meta.countries.map(() => rng() < 0.32);
  selected = -1;
  closeProfile();
  loadBookmarks();
  renderBookmarks();
  markers.clear();
  if (mode === 'shared') for (const c of net.countries) markers.update(c, c.nationId !== null && c.nationId === net.you?.nationId);
  updateDashboard();
  updateModeUi();
  console.info(`[world-tensions] Earth ${formatSeed(seed)} generated in ${map.genMs.toFixed(0)} ms (${faceSize}px faces)`);

  loader.classList.add('done');
  window.setTimeout(() => {
    if (token === loadToken) loader.hidden = true;
  }, 450);
  globe.start();
  if (window.__wt) window.__wt.ready = true;
}

function hasCountry(): boolean {
  return !!net.you && net.you.countryId >= 0;
}

function updateModeUi(): void {
  const shared = mode === 'shared';
  btnMy.hidden = !(shared && hasCountry());
  $('btn-enter').hidden = !(shared && hasCountry());
  btnJoin.hidden = shared && hasCountry();
  btnJoin.textContent = shared ? (net.you ? 'Found new country' : 'Join Earth') : net.enabled ? 'Back to shared Earth' : 'Join Earth';
  btnJoin.disabled = !net.enabled;
  btnJoin.title = net.enabled ? '' : 'No server configured for this build';
  botsRow.hidden = !(import.meta.env.DEV && net.devTools && shared);
  if (!shared && net.enabled) setBanner('Local preview Earth: not synced with other players', 'info');
  else if (net.status === 'reconnecting') setBanner('Connection lost: reconnecting…');
  else if (net.status === 'connecting' && net.enabled && mode === 'shared') setBanner('Connecting to server…');
  else setBanner(null);
}

// ---------- dashboard ----------
function updateDashboard(): void {
  let slots: number, online: number, offline: number, defeated: number;
  if (mode === 'shared' && net.status === 'online') {
    ({ slotsUsed: slots, online, offline, defeated } = net.counts);
  } else {
    // mock counters for a local preview Earth
    slots = 200;
    online = mockOnline.filter(Boolean).length;
    offline = 200 - online;
    defeated = 0;
  }
  $('d-slots').textContent = String(slots);
  $('d-online').textContent = String(online);
  $('d-offline').textContent = String(offline);
  $('d-defeated').textContent = String(defeated);
  $('d-slot-fill').style.width = `${(slots / 200) * 100}%`;
}

function updateNetDot(s: NetStatus): void {
  const dot = $('net-dot');
  dot.classList.toggle('on', s === 'online');
  dot.classList.toggle('wait', s === 'connecting' || s === 'reconnecting');
  dot.title = s === 'disabled' ? 'No server (offline build)' : `Server: ${s}`;
}

// ---------- profile ----------
const profileFlag = $('profile-flag') as HTMLCanvasElement;

/** Live server values for a governed cell; generated starting values otherwise. */
function renderProfileStats(id: number): void {
  if (!map) return;
  const c = map.meta.countries[id];
  const n = mode === 'shared' ? net.nationAt(id) : null;
  const sat = n ? n.satisfaction : c.satisfaction;
  $('p-pop').textContent = formatPopulation(n ? n.population : c.population);
  $('p-area').textContent = formatArea(map.areaKm2[id]);
  $('p-sat').textContent = `${Number.isInteger(sat) ? sat : sat.toFixed(1)}%`;
  $('p-sat-bar').style.width = `${Math.max(0, Math.min(100, sat))}%`;
  $('p-funds').textContent = formatMoney(n ? n.funds : c.funds);
  $('p-mil-size').textContent = `${formatInt(n ? n.military.size : c.militarySize)} troops`;
  $('p-mil-str').textContent = `${Math.round(n ? n.military.readiness : c.militaryStrength)} / 100`;
  const resources = n ? n.resources : c.resources;
  $('p-resources').replaceChildren(...resources.map((r) => Object.assign(document.createElement('li'), { textContent: r })));
}

function neighborsOf(id: number): number[] {
  if (mode === 'shared' && net.neighbors) return net.neighbors[id] ?? [];
  return map ? map.neighbors[id] : [];
}

function openProfile(id: number): void {
  if (!map) return;
  const c = map.meta.countries[id];
  flagCanvas(id, 72, 48, profileFlag);
  $('p-name').textContent = c.name;
  renderProfileStats(id);
  const nb = $('p-neighbors');
  const neighbors = [...neighborsOf(id)].sort((a, b) => countryName(a).localeCompare(countryName(b)));
  $('p-ncount').textContent = `(${neighbors.length})`;
  nb.replaceChildren(
    ...neighbors.map((n) => {
      const li = document.createElement('li');
      const b = document.createElement('button');
      b.type = 'button';
      b.append(flagCanvas(n, 24, 16), document.createTextNode(countryName(n)));
      b.setAttribute('aria-label', `Fly to ${countryName(n)}`);
      b.addEventListener('click', () => select(n, true));
      li.append(b);
      return li;
    }),
  );
  updateProfileStatus(id);
  updateBookmarkButton(id);
  profile.hidden = false;
}

function updateProfileStatus(id: number): void {
  const dot = $('p-dot');
  const status = $('p-status');
  const owner = $('p-owner');
  if (mode === 'shared' && net.status !== 'disabled') {
    const s = net.countries[id];
    if (s.owner) {
      const now = net.serverNow();
      dot.classList.toggle('on', s.online);
      let text = s.online ? 'Online' : `Offline · seen ${timeAgo(s.lastSeen - (now - Date.now()))}`;
      if (s.lostAt !== null) text += s.lostAt > now ? ` · lost in ${formatDuration(s.lostAt - now)}` : ' · expiring';
      status.textContent = text;
      status.classList.toggle('warn', s.lostAt !== null);
      const mine = s.nationId !== null && net.you?.nationId === s.nationId;
      $('p-enter').hidden = !mine;
      const n = net.nationAt(id);
      const prot = n && n.protectedUntil > now ? ` <span class="pill shield" title="New countries cannot declare war or be attacked">Protected ${formatDuration(n.protectedUntil - now)}</span>` : '';
      owner.innerHTML = `<span class="badge"><span class="dot ${s.online ? 'on' : ''}"></span>${escapeHtml(s.owner)}${s.bot ? ' <span class="muted">(bot)</span>' : ''}${mine ? ' <span class="muted">(you)</span>' : ''}</span>${prot}`;
    } else {
      $('p-enter').hidden = true;
      dot.classList.remove('on');
      status.classList.remove('warn');
      status.textContent = 'Unclaimed';
      owner.innerHTML = '<span class="muted">Unclaimed. Join to be assigned a random country.</span>';
    }
  } else {
    $('p-enter').hidden = true;
    const on = mockOnline[id];
    dot.classList.toggle('on', on);
    status.textContent = on ? 'Online (mock)' : 'Offline (mock)';
    owner.innerHTML = '<span class="muted">Local preview: no owners</span>';
  }
}

function updateBookmarkButton(id: number): void {
  const b = $('p-bookmark');
  const on = bookmarks.has(id);
  b.textContent = on ? '★' : '☆';
  b.setAttribute('aria-pressed', String(on));
  b.setAttribute('aria-label', on ? 'Remove bookmark' : 'Bookmark country');
}

function closeProfile(): void {
  profile.hidden = true;
}

function select(id: number, fly = false): void {
  selected = id;
  globe.setSelected(id);
  if (id < 0) {
    closeProfile();
    return;
  }
  openProfile(id);
  if (fly) globe.flyToCountry(id);
}

// ---------- bookmarks ----------
function renderBookmarks(): void {
  const list = $('bookmark-list');
  const ids = [...bookmarks].sort((a, b) => countryName(a).localeCompare(countryName(b)));
  list.replaceChildren(
    ...ids.map((id) => {
      const li = document.createElement('li');
      const b = document.createElement('button');
      b.type = 'button';
      b.append(flagCanvas(id, 24, 16), document.createTextNode(countryName(id)));
      b.setAttribute('aria-label', `Fly to ${countryName(id)}`);
      b.addEventListener('click', () => select(id, true));
      li.append(b);
      return li;
    }),
  );
  $('bookmark-empty').hidden = ids.length > 0;
}

$('p-bookmark').addEventListener('click', () => {
  if (selected < 0) return;
  if (bookmarks.has(selected)) bookmarks.delete(selected);
  else bookmarks.add(selected);
  saveBookmarks();
  renderBookmarks();
  updateBookmarkButton(selected);
});
$('profile-close').addEventListener('click', () => select(-1));

// ---------- search ----------
let searchResults: number[] = [];
let searchActive = -1;

function highlight(name: string, q: string): string {
  const i = name.toLowerCase().indexOf(q);
  if (i < 0 || !q) return escapeHtml(name);
  return `${escapeHtml(name.slice(0, i))}<mark>${escapeHtml(name.slice(i, i + q.length))}</mark>${escapeHtml(name.slice(i + q.length))}`;
}

function runSearch(): void {
  const q = searchInput.value.trim().toLowerCase();
  if (!map || !q) {
    searchResults = [];
    renderSearch(q);
    return;
  }
  const starts: number[] = [];
  const contains: number[] = [];
  for (const c of map.meta.countries) {
    const n = c.name.toLowerCase();
    const core = n.replace(/^(republic|kingdom|federation|free state|union) of /, '');
    if (core.startsWith(q) || n.startsWith(q)) starts.push(c.id);
    else if (n.includes(q)) contains.push(c.id);
  }
  const byName = (a: number, b: number) => countryName(a).localeCompare(countryName(b));
  searchResults = [...starts.sort(byName), ...contains.sort(byName)].slice(0, 8);
  searchActive = searchResults.length ? 0 : -1;
  renderSearch(q);
}

function renderSearch(q: string): void {
  if (!searchResults.length) {
    searchList.hidden = true;
    searchInput.setAttribute('aria-expanded', 'false');
    if (q) {
      searchList.replaceChildren(Object.assign(document.createElement('li'), { textContent: 'No matching country' }));
      searchList.hidden = false;
    }
    return;
  }
  searchList.replaceChildren(
    ...searchResults.map((id, i) => {
      const li = document.createElement('li');
      li.id = `search-opt-${id}`;
      li.setAttribute('role', 'option');
      li.setAttribute('aria-selected', String(i === searchActive));
      const label = document.createElement('span');
      label.innerHTML = highlight(countryName(id), q);
      li.append(flagCanvas(id, 27, 18), label);
      li.addEventListener('mousedown', (e) => {
        e.preventDefault();
        chooseSearch(id);
      });
      return li;
    }),
  );
  searchList.hidden = false;
  searchInput.setAttribute('aria-expanded', 'true');
  if (searchActive >= 0) searchInput.setAttribute('aria-activedescendant', `search-opt-${searchResults[searchActive]}`);
}

function chooseSearch(id: number): void {
  searchInput.value = countryName(id);
  searchResults = [];
  searchList.hidden = true;
  searchInput.setAttribute('aria-expanded', 'false');
  searchInput.blur();
  select(id, true);
}

searchInput.addEventListener('input', runSearch);
searchInput.addEventListener('focus', runSearch);
searchInput.addEventListener('blur', () => window.setTimeout(() => (searchList.hidden = true), 120));
searchInput.addEventListener('keydown', (e) => {
  if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
    e.preventDefault();
    if (!searchResults.length) return;
    searchActive = (searchActive + (e.key === 'ArrowDown' ? 1 : -1) + searchResults.length) % searchResults.length;
    renderSearch(searchInput.value.trim().toLowerCase());
  } else if (e.key === 'Enter') {
    e.preventDefault();
    const id = searchResults[Math.max(0, searchActive)];
    if (id !== undefined) chooseSearch(id);
  } else if (e.key === 'Escape') {
    searchInput.value = '';
    runSearch();
    searchInput.blur();
  }
});

// ---------- country view ----------
const country = new CountryController({
  globe,
  net,
  map: () => map,
  shared: () => mode === 'shared',
  flagCanvas: (cell, w, h) => flagCanvas(cell, w, h),
  toast: (text) => toast(text, 4200),
  onChange: (inside) => {
    if (inside && net.you && net.you.countryId >= 0) {
      $('cv-name').textContent = countryName(net.you.countryId);
      flagCanvas(net.you.countryId, 54, 36, $('cv-flag') as HTMLCanvasElement);
    }
    if (!inside) updateModeUi();
  },
});
$('btn-enter').addEventListener('click', () => void country.enter());
$('p-enter').addEventListener('click', () => void country.enter());
$('btn-back').addEventListener('click', () => void country.exit());

// ---------- globe callbacks ----------
globe.onSelect = (id) => select(id);
globe.onHover = (id) => {
  stage.title = id >= 0 ? countryName(id) : '';
};
globe.onFrame = () => {
  markers.layout(mode === 'shared' ? map : null);
  if (mode === 'shared') country.checkAutoEnter();
};
globe.onDoubleSelect = (id) => {
  if (mode === 'shared') country.requestEnter(id);
};
globe.onLowPerformance = () => {
  if (faceSize <= 512 || !map || params.get('fallback') === 'off') return;
  faceSize = 512;
  globe.setQuality(QUALITY_LOW);
  toast('Low frame rate detected: switched to performance mode');
  void loadEarth(map.meta.seed, mode);
};
globe.onContextChange = (lost) => setBanner(lost ? 'Graphics context lost: restoring…' : null);

// ---------- top bar ----------
$('seed-chip').addEventListener('click', () => {
  if (!map) return;
  const text = formatSeed(map.meta.seed);
  navigator.clipboard?.writeText(text).then(
    () => toast(`Seed ${text} copied`),
    () => toast(`Seed ${text}`),
  );
});

btnNew.addEventListener('click', () => {
  userChoseLocal = true;
  void loadEarth(randomSeed(), 'local');
});

btnMy.addEventListener('click', () => {
  if (net.you) select(net.you.countryId, true);
});

btnJoin.addEventListener('click', () => {
  if (!net.enabled) {
    toast('No server configured for this build');
    return;
  }
  if (mode === 'local') {
    if (net.seed !== null) void loadEarth(net.seed, 'shared');
    else toast('Waiting for the server…');
    return;
  }
  if (net.status !== 'online') {
    toast('Not connected to the server yet');
    return;
  }
  joinError.textContent = '';
  if (net.you && !joinName.value) joinName.value = net.you.name;
  joinDialog.showModal();
  joinName.focus();
});

$('join-cancel').addEventListener('click', () => joinDialog.close());
$('join-form').addEventListener('submit', (e) => {
  e.preventDefault();
  const name = normalizeName(joinName.value);
  if (!isValidName(name)) {
    joinError.textContent = `Use ${NAME_MIN}-${NAME_MAX} letters, numbers, spaces, _ or -.`;
    return;
  }
  joinError.textContent = '';
  net.join(name);
});

botsToggle.addEventListener('change', () => net.setBots(botsToggle.checked));

// ---------- keyboard ----------
window.addEventListener('keydown', (e) => {
  const target = e.target as HTMLElement | null;
  if (target && (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || joinDialog.open)) return;
  if (e.ctrlKey || e.metaKey || e.altKey) return;
  if (country.inCountry || country.transitioning) {
    if (country.handleKey(e)) return;
    if (e.key === 'Escape') void country.exit();
    else if (e.key === 'f' || e.key === 'F') statsEl.hidden = !statsEl.hidden;
    return;
  }
  if (e.key === 'Escape') select(-1);
  else if (e.key === 'f' || e.key === 'F') statsEl.hidden = !statsEl.hidden;
  else if (e.key === 'r' || e.key === 'R') globe.resetCamera();
  else if (e.key === '/') {
    e.preventDefault();
    searchInput.focus();
  }
});

// ---------- stats overlay ----------
window.setInterval(() => {
  if (statsEl.hidden) return;
  const cs = country.stats();
  if (cs) {
    statsEl.textContent = [
      `COUNTRY VIEW`,
      `FPS        ${country.fps.toFixed(0)}`,
      `draw calls ${cs.drawCalls}`,
      `triangles  ${formatInt(cs.triangles)}`,
      `instances  ${formatInt(cs.instances)}`,
      `citizens   ${country.crowdCounts().agents} shown / ${net.citizens.length} featured`,
      `buildings  ${net.localBuildings.size}`,
      `geometries ${cs.geometries}`,
      `textures   ${cs.textures}`,
      `pixelRatio ${globe.renderer.getPixelRatio()}`,
    ].join('\n');
    return;
  }
  const info = globe.renderer.info;
  const mb = (globe.textureBytes() / (1024 * 1024)).toFixed(1);
  const l = map?.layout;
  statsEl.textContent = [
    `FPS        ${globe.fps.toFixed(0)}`,
    `frame      ${globe.frameMs.toFixed(2)} ms (CPU)`,
    `draw calls ${info.render.calls}`,
    `countries  ${map?.meta.countries.length ?? 0}`,
    `id atlas   ${l ? `${l.width}x${l.height} (${l.N}/face)` : '-'}`,
    `tex memory ${mb} MB`,
    `generation ${map ? map.genMs.toFixed(0) : '-'} ms`,
    `pixelRatio ${globe.renderer.getPixelRatio()}`,
  ].join('\n');
}, 250);

// ---------- networking ----------
net.onStatus = (s) => {
  updateNetDot(s);
  updateModeUi();
  updateDashboard();
};
net.onWelcome = (seed) => {
  updateModeUi();
  // follow the server's Earth unless the user is exploring a local preview
  if (!map || (mode === 'shared' && map.meta.seed !== seed) || (mode === 'local' && !userChoseLocal)) {
    userChoseLocal = false;
    if (!map || map.meta.seed !== seed) void loadEarth(seed, 'shared');
    else {
      mode = 'shared';
      updateModeUi();
    }
  }
  updateDashboard();
};
const isMine = (cell: number) => net.countries[cell].nationId !== null && net.countries[cell].nationId === net.you?.nationId;

net.onCountries = (changed) => {
  if (mode === 'shared' && map) for (const id of changed) markers.update(net.countries[id], isMine(id));
  updateDashboard();
  if (selected >= 0 && changed.includes(selected)) {
    updateProfileStatus(selected);
    renderProfileStats(selected);
  }
};
net.onNations = (changed) => {
  if (country.inCountry && net.you?.nationId !== null && net.you?.nationId !== undefined && changed.includes(net.you.nationId)) country.refreshFunds();
  if (selected < 0 || mode !== 'shared') return;
  const n = net.countries[selected].nationId;
  if (n !== null && changed.includes(n)) renderProfileStats(selected);
};
net.onJoined = (you) => {
  joinDialog.close();
  updateModeUi();
  for (const c of net.countries) markers.update(c, isMine(c.id));
  toast(`Welcome, ${you.name}. You govern ${countryName(you.countryId)}.`, 4500);
  select(you.countryId, true);
};
net.onYou = (you) => {
  if (you.countryId < 0 && country.inCountry) void country.exit();
  updateModeUi();
  for (const c of net.countries) markers.update(c, isMine(c.id));
  if (you.countryId < 0 && you.lostReason && !awayDialog.open) toast('Your country was lost. Use "Found new country" to start again.', 6000);
};
net.onAway = (summary) => {
  const { period, html } = renderAwaySummary(summary);
  $('away-period').textContent = period;
  $('away-body').innerHTML = html;
  if (!awayDialog.open) awayDialog.showModal();
};

// live countdowns (inactivity, protection) in the open profile
window.setInterval(() => {
  if (selected >= 0 && !profile.hidden && mode === 'shared') updateProfileStatus(selected);
}, 1000);
net.onError = (code, message) => {
  if (joinDialog.open) joinError.textContent = message;
  else toast(message);
  if (code === 'already-joined') joinDialog.close();
};

// ---------- boot ----------
updateNetDot(net.status);
if (import.meta.env.DEV || params.has('test')) {
  window.__wt = {
    ready: false,
    seed: () => map?.meta.seed ?? 0,
    genMs: () => map?.genMs ?? 0,
    fps: () => globe.fps,
    setView: (lat, lon, dist) => globe.setView(lat, lon, dist),
    select: (id, fly) => select(id, fly),
    hover: (id) => globe.setHover(id),
    pickCenter: () => globe.pickAtNdc(0, 0),
    centroid: (id) => (map ? [map.centroids[id * 3], map.centroids[id * 3 + 1], map.centroids[id * 3 + 2]] : [0, 0, 0]),
    neighbors: (id) => (map ? map.neighbors[id] : []),
    owners: () => net.countries.map((c) => c.owner),
    net: () => ({ status: net.status, you: net.you, nations: [...net.nations.values()], countries: net.countries }),
    enterCountry: () => country.enter(),
    exitCountry: () => country.exit(),
    country: () => ({ inside: country.inCountry, busy: country.transitioning, stats: country.stats() }),
    countryOrbit: (az, polar, dist) => country.setOrbit(az, polar, dist),
    pickBuilding: (kind) => country.pickBuilding(kind),
    findBuildSpot: (kind, valid) => country.findSpot(kind, valid),
    setHour: (hour) => (country.hourOverride = hour),
    citizens: () => net.citizens,
    localStats: () => net.localStats,
    news: () => net.news,
    citizenScreen: (id) => country.citizenScreen(id),
    openCitizen: (id) => country.openCitizen(id),
    countryLookAt: (x, z, dist) => country.lookAt(x, z, dist),
    crowd: () => country.crowdCounts(),
    local: () => [...net.localBuildings.values()],
    memory: () => ({ geometries: globe.renderer.info.memory.geometries, textures: globe.renderer.info.memory.textures, programs: globe.renderer.info.programs?.length ?? 0 }),
    globeDistance: () => globe.distance,
  };
}

if (forcedSeed !== null) {
  userChoseLocal = true;
  void loadEarth(forcedSeed, 'local');
} else if (net.enabled) {
  net.connect();
  // if the server doesn't answer quickly, show a local Earth meanwhile
  window.setTimeout(() => {
    if (!map && net.status !== 'online') void loadEarth(randomSeed(), 'local');
  }, 2500);
} else {
  void loadEarth(randomSeed(), 'local');
}
