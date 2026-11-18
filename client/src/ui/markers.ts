import type { Globe } from '../render/globe.ts';
import type { EarthMap } from '../gen/generate.ts';
import type { CountryState } from '../../../shared/protocol.ts';

interface Marker {
  el: HTMLDivElement;
  dot: HTMLSpanElement;
  label: HTMLSpanElement;
  visible: boolean;
}

/** HTML badges (owner name + online dot) pinned to owned countries. */
export class OwnerMarkers {
  private markers = new Map<number, Marker>();
  private readonly p = { x: 0, y: 0, facing: 0 };

  constructor(private readonly root: HTMLElement, private readonly globe: Globe) {}

  clear(): void {
    for (const m of this.markers.values()) m.el.remove();
    this.markers.clear();
  }

  update(state: CountryState, mine: boolean): void {
    let m = this.markers.get(state.id);
    if (!state.owner) {
      if (m) {
        m.el.remove();
        this.markers.delete(state.id);
      }
      return;
    }
    if (!m) {
      const el = document.createElement('div');
      el.className = 'marker';
      const dot = document.createElement('span');
      dot.className = 'dot';
      const label = document.createElement('span');
      el.append(dot, label);
      el.style.opacity = '0';
      this.root.appendChild(el);
      m = { el, dot, label, visible: false };
      this.markers.set(state.id, m);
    }
    m.label.textContent = state.bot ? `${state.owner} · bot` : state.owner;
    m.dot.classList.toggle('on', state.online);
    m.el.classList.toggle('me', mine);
  }

  /** Called once per frame; only touches transform/opacity. */
  layout(map: EarthMap | null): void {
    if (!map) return;
    const dist = this.globe.camera.position.length();
    const show = dist < 4.2;
    for (const [id, m] of this.markers) {
      const c = map.centroids;
      const vis = show && this.globe.project(c[id * 3], c[id * 3 + 1], c[id * 3 + 2], this.p) && this.p.facing > 0.35;
      if (vis) {
        m.el.style.transform = `translate3d(${this.p.x.toFixed(1)}px, ${(this.p.y - 12).toFixed(1)}px, 0) translate(-50%, -100%)`;
      }
      if (vis !== m.visible) {
        m.visible = vis;
        m.el.style.opacity = vis ? '1' : '0';
      }
    }
  }
}
