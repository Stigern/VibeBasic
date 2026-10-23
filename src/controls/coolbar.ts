// CoolBar (COMCT332.OCX): a rebar of bands, each with a gripper, an optional picture and caption, and a child control of the form (run mode:
// the form surface hands the child's element over with `adopt`; see render.ts). The pure layout is in model/coolbar.ts.
//
// DOM events the run mode dispatches on inputEl: `vbbandresize` ({ lines }: the Bands lines with the widths the user dragged).
import { BAND_GRIP, bandLine, coolbarHeight, dragGripper, layoutBands, parseBand, type BandContent, type BandData } from '../model/coolbar';
import { twipsToPx } from '../model/twips';
import { h } from '../ui98/dom';
import type { BandChild, Ctx, Renderer } from './render';

type Keys = ReadonlySet<string> | null;
const has = (k: Keys, ...names: string[]): boolean => k === null || names.some(n => k.has(n));
const IMAGES_CHANGED = '*images';
const CHAR_PX = 6;

export function coolBar(c: Ctx): Renderer {
  let root: HTMLElement;
  let bands: BandData[] = [];
  let find: ((name: string) => BandChild | null) | null = null;
  let drag: { index: number; startX: number; before: number; at: number; wBefore: number; wThis: number; minBefore: number; minThis: number } | null = null;

  const childOf = (b: BandData): BandChild | null => (b.child && find ? find(b.child) : null);
  function content(): BandContent[] {
    return bands.map(b => {
      const img = b.image ? c.image('ImageList', b.image) : null;
      const ch = childOf(b);
      return { image: img ? img.width + 4 : 0, caption: b.caption ? b.caption.length * CHAR_PX + 6 : 0, childWidth: ch?.width ?? 0, childHeight: ch?.height ?? 0 };
    });
  }
  const widthPx = (): number => parseFloat(c.el.style.width) || twipsToPx(c.num('Width'));

  function paint(): void {
    const cont = content();
    const boxes = layoutBands(bands, cont, widthPx());
    const rows = new Map<number, HTMLElement>();
    let top = 0;
    const run = c.mode === 'run';
    for (const box of boxes) {
      let row = rows.get(box.row);
      if (!row) {
        row = h('div', { class: `cbr-row${c.bool('BandBorders') ? ' cbr-borders' : ''}`, style: { top: `${top}px`, height: `${box.height}px` } });
        rows.set(box.row, row);
        top += box.height;
      }
      const b = bands[box.index];
      const img = b.image ? c.image('ImageList', b.image) : null;
      const body = h('div', { class: 'cbr-body' });
      const band = h('div', { class: 'cbr-band', dataset: { index: String(box.index) }, style: { left: `${box.left}px`, width: `${box.width}px`, height: `${box.height}px` } },
        h('div', { class: 'cbr-grip', style: { width: `${BAND_GRIP}px` } }),
        ...(img ? [h('img', { class: 'cbr-img', src: img.url, draggable: 'false', style: { width: `${img.width}px`, height: `${img.height}px` } })] : []),
        ...(b.caption ? [h('span', { class: 'cbr-cap' }, b.caption)] : []), body);
      row.appendChild(band);
      const ch = run ? childOf(b) : null;
      if (ch) {
        const used = BAND_GRIP + cont[box.index].image + cont[box.index].caption;
        const bw = Math.max(0, box.width - used - 2);
        Object.assign(ch.el.style, { position: 'absolute', left: '0px', top: '0px', width: `${bw}px`, height: `${Math.max(0, box.height - 4)}px` });
        body.style.left = `${used}px`; body.style.width = `${bw}px`; body.style.top = '2px';
        body.appendChild(ch.el);
      }
    }
    root.replaceChildren(...rows.values());
    root.style.minHeight = `${coolbarHeight(bands, cont)}px`;
  }

  return {
    build() {
      root = h('div', { class: 'vb-cbr' });
      c.el.replaceChildren(root);
      c.setInput(root);
      if (c.mode !== 'run') return;
      root.addEventListener('mousedown', e => {
        const grip = (e.target as Element).closest<HTMLElement>('.cbr-grip');
        const band = grip?.parentElement;
        if (!grip || !band || root.getAttribute('aria-disabled') === 'true') return;
        const i = Number(band.dataset.index), row = band.parentElement!;
        const mates = [...row.children].map(x => Number((x as HTMLElement).dataset.index));
        const at = mates.indexOf(i);
        if (at < 1 || bands[i].style === 1) return;   // the first band of a row, a fixed-size band
        const prev = bands[mates[at - 1]];
        if (prev.style === 1) return;
        e.preventDefault();
        const widths = (n: number) => parseFloat((row.children[n] as HTMLElement).style.width) || 0;
        drag = { index: i, startX: e.clientX, before: mates[at - 1], at, wBefore: widths(at - 1), wThis: widths(at),
          minBefore: Math.round(prev.minWidth / 15), minThis: Math.round(bands[i].minWidth / 15) };
        const doc = c.el.ownerDocument;
        const move = (m: MouseEvent) => {
          if (!drag) return;
          const r = dragGripper(drag.wBefore, drag.wThis, Math.max(BAND_GRIP + 4, drag.minBefore), Math.max(BAND_GRIP + 4, drag.minThis), m.clientX - drag.startX);
          if (!r) return;
          bands[drag.before].width = Math.round(r[0] * 15);
          bands[drag.index].width = Math.round(r[1] * 15);
          paint();
        };
        const up = () => {
          doc.removeEventListener('mousemove', move);
          if (drag) c.fire('vbbandresize', { lines: bands.map(bandLine) });
          drag = null;
        };
        doc.addEventListener('mousemove', move);
        doc.addEventListener('mouseup', up, { once: true });
      });
    },
    patch(k) {
      if (has(k, 'Bands')) bands = c.list('Bands').map(parseBand);
      if (has(k, 'Bands', 'ImageList', 'BandBorders', 'Width', IMAGES_CHANGED)) paint();
    },
    adopt(f) { find = f; paint(); },
    bg: () => c.color('BackColor'),
  };
}
