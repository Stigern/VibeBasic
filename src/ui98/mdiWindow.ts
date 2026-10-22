import { createTitleBar, h } from './dom';

export interface MdiWindow {
  el: HTMLElement;
  body: HTMLElement;
  setTitle(t: string): void;
  activate(): void;
  /** Runs `onClose` first; closing is cancelled when it returns false. */
  close(): void;
  onClose?: () => boolean;
}

export interface MdiOptions {
  title: string;
  /** URL of a 16x16 icon shown left of the title. */
  icon?: string;
  x: number; y: number; width: number; height: number;
  resizable?: boolean;
}

const MIN_W = 80;
const MIN_H = 40;
/** How much of a window must stay inside the host when dragged. */
const KEEP_W = 60;
const KEEP_H = 22;

const zCounters = new WeakMap<HTMLElement, number>();

function windowsOf(host: HTMLElement): HTMLElement[] {
  return [...host.children].filter(c => c.classList.contains('mdi98')) as HTMLElement[];
}

/**
 * A Win98 child window inside `host` (which should be position:relative/absolute).
 * Active window: blue gradient title; others grey. Dragged by the title bar, kept inside the host.
 * Dispatches `mdiresize` on `el` while the grip is dragged.
 */
export function createMdiWindow(host: HTMLElement, o: MdiOptions): MdiWindow {
  const doc = host.ownerDocument;
  const title = createTitleBar(o.title, { icon: o.icon, onClose: () => win.close() });
  const body = h('div', { class: 'window-body mdi98-body' });
  const el = h('div', {
    class: 'window mdi98',
    style: { left: `${o.x}px`, top: `${o.y}px`, width: `${o.width}px`, height: `${o.height}px` },
  }, title.bar, body);
  if (o.resizable) el.appendChild(h('div', { class: 'mdi98-grip' }));

  const win: MdiWindow = {
    el, body,
    setTitle(t) { title.text.textContent = t; },
    activate() {
      const z = (zCounters.get(host) ?? 0) + 1;
      zCounters.set(host, z);
      for (const w of windowsOf(host)) {
        const on = w === el;
        w.classList.toggle('active', on);
        w.querySelector(':scope > .title-bar')?.classList.toggle('inactive', !on);
      }
      el.style.zIndex = String(z);
    },
    close() {
      if (win.onClose && win.onClose() === false) return;
      const wasActive = el.classList.contains('active');
      el.remove();
      if (wasActive) {
        const rest = windowsOf(host).sort((a, b) => Number(a.style.zIndex || 0) - Number(b.style.zIndex || 0));
        const top = rest[rest.length - 1];
        if (top) {
          top.classList.add('active');
          top.querySelector(':scope > .title-bar')?.classList.remove('inactive');
        }
      }
    },
  };

  host.appendChild(el);
  win.activate();
  el.addEventListener('mousedown', () => { if (!el.classList.contains('active')) win.activate(); }, true);

  /** Tracks a mouse drag on the document; `move` gets the total delta since mousedown. */
  const drag = (e: MouseEvent, move: (dx: number, dy: number) => void) => {
    const sx = e.clientX, sy = e.clientY;
    const onMove = (ev: MouseEvent) => move(ev.clientX - sx, ev.clientY - sy);
    const onUp = () => {
      doc.removeEventListener('mousemove', onMove, true);
      doc.removeEventListener('mouseup', onUp, true);
    };
    doc.addEventListener('mousemove', onMove, true);
    doc.addEventListener('mouseup', onUp, true);
  };

  title.bar.addEventListener('mousedown', e => {
    if (e.button !== 0 || (e.target as Element).closest('.title-bar-controls')) return;
    e.preventDefault();
    const x0 = parseInt(el.style.left) || 0, y0 = parseInt(el.style.top) || 0;
    drag(e, (dx, dy) => {
      let x = x0 + dx, y = y0 + dy;
      if (host.clientWidth > 0 && host.clientHeight > 0) {
        const w = el.offsetWidth || parseInt(el.style.width) || 0;
        x = Math.min(host.clientWidth - KEEP_W, Math.max(KEEP_W - w, x));
        y = Math.min(host.clientHeight - KEEP_H, Math.max(0, y));
      }
      el.style.left = `${x}px`;
      el.style.top = `${y}px`;
    });
  });

  el.querySelector('.mdi98-grip')?.addEventListener('mousedown', ev => {
    const e = ev as MouseEvent;
    if (e.button !== 0) return;
    e.preventDefault();
    e.stopPropagation();
    const w0 = parseInt(el.style.width) || 0, h0 = parseInt(el.style.height) || 0;
    drag(e, (dx, dy) => {
      el.style.width = `${Math.max(MIN_W, w0 + dx)}px`;
      el.style.height = `${Math.max(MIN_H, h0 + dy)}px`;
      el.dispatchEvent(new CustomEvent('mdiresize'));
    });
  });

  return win;
}
