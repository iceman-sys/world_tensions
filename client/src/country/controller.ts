import type { Globe } from '../render/globe.ts';
import type { EarthMap } from '../gen/generate.ts';
import { generateTerrain } from '../gen/generate.ts';
import type { NetClient } from '../net/net.ts';
import { PRIMARIES } from '../../../shared/palette.ts';
import { terrainInputFor, type LocalTerrain } from '../../../shared/country/terrain.ts';
import { BUILDINGS, constructionMs, type BuildingKind } from '../../../shared/country/buildings.ts';
import { CountryView, type CountryStats } from './view.ts';
import { BuildMenu } from './buildMenu.ts';
import { CitizenCard } from './citizenCard.ts';
import { GovPanel, unrestStage } from './govPanel.ts';
import { NewsTicker } from './newsTicker.ts';
import { placementText, type PlacementHint } from './placement.ts';
import { formatMoney } from '../ui/format.ts';

/** Camera distance below which zooming onto your own country enters it. */
export const AUTO_ENTER_DIST = 1.2;
/** Auto-enter re-arms only after zooming back out past this distance. */
const AUTO_REARM_DIST = 1.32;
/** Globe phase of the ~1.2 s transition (fly in + fade), then the local intro. */
const FLY_MS = 750;
const FADE_MS = 300;
const INTRO_MS = 450;

const wait = (ms: number) => new Promise<void>((r) => window.setTimeout(r, ms));

export interface CountryControllerDeps {
  globe: Globe;
  net: NetClient;
  map: () => EarthMap | null;
  /** true when the shared (server) Earth is shown */
  shared: () => boolean;
  flagCanvas: (cell: number, w: number, h: number) => HTMLCanvasElement;
  toast: (text: string) => void;
  /** called when the view is entered or left */
  onChange: (inCountry: boolean) => void;
}

/**
 * Owns the globe <-> country-view transition and the entry points (button,
 * double-click, zooming in close). Only your own country can be entered.
 */
export class CountryController {
  private view: CountryView | null = null;
  private busy = false;
  private armed = true;
  private frameCounter = 0;
  private cache: { key: string; terrain: LocalTerrain } | null = null;
  private readonly fade: HTMLElement;
  private readonly labels: HTMLElement;
  private readonly hint: HTMLElement;
  private menu: BuildMenu | null = null;
  private readonly card: CitizenCard;
  private panel: GovPanel | null = null;
  private readonly ticker = new NewsTicker(document.getElementById('news-ticker') as HTMLElement);
  private readonly unrest = document.getElementById('unrest-overlay') as HTMLElement;
  /** test/dev override of the hour of day (null = follow the server's game clock) */
  hourOverride: number | null = null;

  constructor(private readonly deps: CountryControllerDeps) {
    this.fade = document.getElementById('country-fade') as HTMLElement;
    this.labels = document.getElementById('country-labels') as HTMLElement;
    this.hint = document.getElementById('build-hint') as HTMLElement;
    const { net } = deps;
    this.card = new CitizenCard(document.getElementById('citizen-card') as HTMLElement, (id) => this.buildingLabel(id));
    this.card.onAsk = (id, q) => net.ask(id, q);
    this.card.onJudge = (id, verdict) => net.judge(id, verdict);
    net.onLocal = () => {
      this.view?.setBuildings([...net.localBuildings.values()]);
      this.refreshCrowd();
    };
    net.onCitizens = () => {
      this.refreshCrowd();
      this.card.update(net.citizens);
    };
    net.onLocalStats = () => {
      this.refreshCrowd();
      this.refreshPanel();
    };
    net.onNews = () => this.ticker.render(net.news);
    net.onInbox = () => this.panel?.setInbox(net.inbox);
    net.onConfig = () => this.refreshPanel();
    net.onAnswer = (id, q, text) => this.card.answer(id, q, text);
    net.onActionResult = (_ok, message) => deps.toast(message);
    net.onBuildResult = (ok, message) => {
      if (!ok) deps.toast(message);
    };
  }

  private buildingLabel(id: number | null): string | null {
    const b = id === null ? undefined : this.deps.net.localBuildings.get(id);
    return b ? BUILDINGS[b.kind].label.toLowerCase() : null;
  }

  /** The crowd follows the server's citizens and mood. */
  private refreshCrowd(): void {
    const { net } = this.deps;
    const n = net.myNation();
    this.view?.setCrowd([...net.localBuildings.values()], {
      population: n?.population ?? 0,
      satisfaction: n?.satisfaction ?? 50,
      stats: net.localStats,
      citizens: net.citizens,
    });
  }

  /** Government panel + unrest effect from the server's numbers. */
  private refreshPanel(): void {
    const { net } = this.deps;
    const pub = net.myNation();
    this.panel?.update(pub, net.myNationPrivate, net.localStats, (net.config?.timeScale ?? 60) >= 3600, net.serverNow());
    const stage = pub ? unrestStage(pub.satisfaction) : 0;
    this.unrest.dataset.stage = String(this.view ? stage : 0);
  }

  /** Hour of the game day from the server clock (DEMO_MODE: one game day = 24 real minutes). */
  gameHour(): number {
    if (this.hourOverride !== null) return this.hourOverride;
    return (this.deps.net.gameTime() / 3_600_000) % 24;
  }

  /** Real milliseconds a construction takes on this server. */
  private buildMs(kind: BuildingKind): number {
    const cfg = this.deps.net.config;
    if (!cfg) return 0;
    return constructionMs(kind, 3_600_000 / cfg.timeScale, cfg.constructionFactor);
  }

  private funds(): number {
    return this.deps.net.myNation()?.funds ?? 0;
  }

  private showHint(h: PlacementHint | null): void {
    if (!h) {
      this.hint.hidden = true;
      return;
    }
    this.hint.hidden = false;
    this.hint.classList.toggle('bad', !h.result.ok);
    this.hint.textContent = `${placementText(h.kind, h.result)} · ${formatMoney(BUILDINGS[h.kind].cost)} · R rotate · right-click cancel`;
    this.hint.style.transform = `translate(${Math.round(h.x + 16)}px, ${Math.round(h.y + 18)}px)`;
  }

  /** Keys while in the country view. Returns true if the key was used. */
  handleKey(e: KeyboardEvent): boolean {
    if (!this.view) return false;
    const placing = this.view.placement?.active ?? false;
    if (e.key === 'Escape' && placing) {
      this.menu?.select(null);
      return true;
    }
    if (e.key === 'Escape' && this.card.open) {
      this.card.close();
      return true;
    }
    if ((e.key === 'r' || e.key === 'R') && placing) {
      this.view.placement?.rotate();
      return true;
    }
    return false;
  }

  /** Treasury changed: refresh the menu and the HUD. */
  refreshFunds(): void {
    const f = this.funds();
    this.menu?.setFunds(f);
    this.view?.placement?.refresh();
    const el = document.getElementById('cv-funds');
    if (el) el.textContent = formatMoney(f);
    this.refreshPanel();
  }

  get inCountry(): boolean {
    return this.view !== null;
  }

  get transitioning(): boolean {
    return this.busy;
  }

  /** Your nation's home cell, or -1. */
  private homeCell(): number {
    const you = this.deps.net.you;
    return this.deps.shared() && you && you.countryId >= 0 ? you.countryId : -1;
  }

  /** True if the cell belongs to your nation. */
  isMine(cell: number): boolean {
    const nid = this.deps.net.you?.nationId;
    return cell >= 0 && nid !== null && nid !== undefined && this.deps.net.countries[cell]?.nationId === nid;
  }

  private ownCells(): number[] {
    const nid = this.deps.net.you?.nationId;
    return this.deps.net.countries.filter((c) => c.nationId !== null && c.nationId === nid).map((c) => c.id);
  }

  private terrainFor(map: EarthMap, home: number): Promise<LocalTerrain> {
    const own = this.ownCells();
    const key = `${map.meta.seed}:${home}:${own.join(',')}`;
    if (this.cache?.key === key) return Promise.resolve(this.cache.terrain);
    return generateTerrain(terrainInputFor(map.meta, home, own.length ? own : [home], map.meta.countries[home].resources)).then((terrain) => {
      this.cache = { key, terrain };
      return terrain;
    });
  }

  /** Enter attempt for a specific cell (double-click / auto): only your own is allowed. */
  requestEnter(cell: number): void {
    if (cell < 0) return;
    if (!this.isMine(cell)) {
      if (this.deps.net.countries[cell]?.owner) this.deps.toast('You can only enter your own country. Other countries show land and flag only.');
      return;
    }
    void this.enter();
  }

  async enter(): Promise<void> {
    const map = this.deps.map();
    const home = this.homeCell();
    if (this.busy || this.view || !map || home < 0) return;
    this.busy = true;
    this.armed = false;
    const { globe } = this.deps;
    try {
      const terrainP = this.terrainFor(map, home);
      const c = map.centroids;
      globe.flyTo(c[home * 3], c[home * 3 + 1], c[home * 3 + 2], 1.16, FLY_MS);
      await wait(FLY_MS - FADE_MS);
      this.fade.classList.add('on');
      const [terrain] = await Promise.all([terrainP, wait(FADE_MS)]);
      if (this.homeCell() !== home) throw new Error('country changed during transition');
      const view = new CountryView(globe.renderer, this.labels);
      view.build({
        terrain,
        seed: map.meta.seed ^ home,
        name: map.meta.countries[home].name,
        flag: this.deps.flagCanvas(home, 240, 160),
        neighborTint: (cell) => (cell >= 0 && cell < map.primaries.length ? PRIMARIES[map.primaries[cell]] : null),
        serverNow: () => this.deps.net.serverNow(),
        funds: () => this.funds(),
        onPlace: (kind, i, j, rot) => {
          // an intent only: the server validates and answers with build:result + local:diff
          this.deps.net.build(kind, i, j, rot);
          this.menu?.select(null);
        },
        onHint: (h) => this.showHint(h),
        gameHour: () => this.gameHour(),
        citizenName: (id) => this.deps.net.citizens.find((c) => c.id === id)?.name ?? null,
        onCitizenClick: (id) => {
          const c = this.deps.net.citizens.find((x) => x.id === id);
          if (c) this.card.show(c);
        },
      });
      globe.suspend();
      view.start(globe.canvas);
      view.playIntro(INTRO_MS);
      this.view = view;
      if (this.deps.net.localBuildings.size) {
        view.setBuildings([...this.deps.net.localBuildings.values()]);
        this.refreshCrowd();
      }
      this.deps.net.openLocal();
      const menuRoot = document.getElementById('build-menu');
      const tip = document.getElementById('build-tip');
      if (menuRoot && tip) {
        this.menu = new BuildMenu(menuRoot, tip, (k) => this.buildMs(k));
        this.menu.onSelect = (k) => view.startPlacement(k);
      }
      const panelRoot = document.getElementById('gov-panel');
      if (panelRoot) {
        const net = this.deps.net;
        this.panel = new GovPanel(panelRoot, {
          setTax: (r) => net.setTax(r),
          setServices: (s) => net.setServices(s),
          announce: (id) => net.announce(id),
          setTimeScale: net.devTools ? (s) => net.setTimeScale(s) : null,
          // the scenario only uses normal intents: a sharp tax rise (and demo speed on dev servers)
          scenario: () => {
            net.setTax(60);
            if (net.devTools && (net.config?.timeScale ?? 60) < 3600) net.setTimeScale(3600);
          },
        });
        this.panel.setInbox(net.inbox);
      }
      this.ticker.render(this.deps.net.news);
      this.refreshFunds();
      document.body.classList.add('in-country');
      this.deps.onChange(true);
      this.fade.classList.remove('on');
      await wait(INTRO_MS);
    } catch (err) {
      this.fade.classList.remove('on');
      if (!this.view) globe.resume();
      this.deps.toast(`Could not open the country view: ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      this.busy = false;
    }
  }

  async exit(): Promise<void> {
    if (this.busy || !this.view) return;
    this.busy = true;
    const { globe } = this.deps;
    const map = this.deps.map();
    const home = this.homeCell();
    this.fade.classList.add('on');
    await wait(FADE_MS);
    this.menu?.select(null);
    this.menu = null;
    this.hint.hidden = true;
    if (this.card.open) this.card.close();
    this.panel = null;
    this.unrest.dataset.stage = '0';
    this.deps.net.closeLocal();
    this.view.dispose(globe.canvas);
    this.view = null;
    document.body.classList.remove('in-country');
    this.deps.onChange(false);
    globe.resume();
    if (map && home >= 0) {
      const c = map.centroids;
      globe.flyTo(c[home * 3], c[home * 3 + 1], c[home * 3 + 2], 1.16, 1);
      window.setTimeout(() => globe.flyTo(c[home * 3], c[home * 3 + 1], c[home * 3 + 2], 2.3, FLY_MS), 30);
    }
    this.fade.classList.remove('on');
    await wait(FLY_MS);
    this.busy = false;
  }

  /** Called every globe frame: zooming close onto your own country enters it. */
  checkAutoEnter(): void {
    const { globe } = this.deps;
    if (this.view || this.busy) return;
    const d = globe.distance;
    if (d > AUTO_REARM_DIST) this.armed = true;
    if (!this.armed || globe.flying || d > AUTO_ENTER_DIST) return;
    if (++this.frameCounter % 10 !== 0) return;
    const center = globe.pickAtNdc(0, 0);
    if (this.isMine(center)) void this.enter();
  }

  stats(): CountryStats | null {
    return this.view ? this.view.stats() : null;
  }

  get fps(): number {
    return this.view?.fps ?? 0;
  }

  /** Test hook. */
  setOrbit(az: number, polar: number, dist: number): void {
    this.view?.setOrbit(az, polar, dist);
  }

  /** Test hooks for the citizen scenes. */
  citizenScreen(id: number): { x: number; y: number } | null {
    return this.view?.citizenScreen(id) ?? null;
  }

  openCitizen(id: number): boolean {
    const c = this.deps.net.citizens.find((x) => x.id === id);
    if (!c) return false;
    this.card.show(c);
    return true;
  }

  lookAt(x: number, z: number, dist: number): void {
    this.view?.lookAt(x, z, dist);
  }

  crowdCounts(): { agents: number; protesters: number; queue: number } {
    return this.view?.crowdCounts() ?? { agents: 0, protesters: 0, queue: 0 };
  }

  /** Test hook. */
  findSpot(kind: BuildingKind, valid: boolean): { x: number; y: number; i: number; j: number } | null {
    return this.view?.findSpot(kind, valid) ?? null;
  }

  /** Test hook: start placement of a kind (as if picked in the build menu). */
  pickBuilding(kind: BuildingKind | null): void {
    this.menu?.select(kind);
  }
}
