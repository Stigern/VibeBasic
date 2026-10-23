// MSChart: an SVG chart in the look of MS Chart 6 (white chart area, grey plot area, the default series colours).
// The data is the prop `ChartLines` (model/chart.ts); without it the control shows the 5 x 4 sample data, as VB6 does at design time.
//
// Every data point has `data-series` and `data-point` (1-based). In run mode a click on one dispatches `vbpointselect`
// ({ series, point, flags }) on inputEl; formWindow.ts turns it into PointSelected (and the click itself becomes Click).

import {
  AXIS_X, AXIS_Y, barSegments, chartKind, decodeChart, lineValues, niceScale, pieSweeps, sampleChart, seriesColor, tickText, valueRange,
  type ChartModel,
} from '../model/chart';
import { CONTROL_TYPES } from '../model/controls';
import { twipsToPx } from '../model/twips';
import { h } from '../ui98/dom';
import type { Ctx, Renderer } from './render';

const NS = 'http://www.w3.org/2000/svg';
type Attrs = Record<string, string | number>;
function s(tag: string, attrs: Attrs = {}, ...kids: (Node | string)[]): SVGElement {
  const e = document.createElementNS(NS, tag);
  for (const [k, v] of Object.entries(attrs)) e.setAttribute(k, String(v));
  for (const k of kids) e.append(k);
  return e;
}
const f = (n: number): string => String(Math.round(n * 100) / 100);

const SHADOW = 4;            // px: the offset of the shadow that stands for 3-D
const FONT = 11;             // px
const TEXT_W = 6;            // px per character, for the room labels need
const rad = (deg: number): number => (deg * Math.PI) / 180;
const clip = (t: string, n: number): string => (t.length > n ? `${t.slice(0, Math.max(1, n - 1))}.` : t);

export function msChart(c: Ctx): Renderer {
  let root: HTMLElement;
  let selected: string | null = null;

  const model = (): ChartModel => decodeChart(c.list('ChartLines')) ?? sampleChart(Math.max(1, c.num('RowCount')), Math.max(1, c.num('ColumnCount')));

  function paint(): void {
    const td = CONTROL_TYPES.MSChart;
    const W = Math.max(40, twipsToPx(typeof c.props.Width === 'number' && c.props.Width > 0 ? c.props.Width : td.defaultWidth));
    const H = Math.max(30, twipsToPx(typeof c.props.Height === 'number' && c.props.Height > 0 ? c.props.Height : td.defaultHeight));
    const m = model();
    const { kind, threeD } = chartKind(c.num('chartType'));
    const stacking = c.bool('Stacking') && (kind === 'bar' || kind === 'line' || kind === 'area');
    const titles = c.list('AxisTitles');
    const title = c.str('TitleText');
    const svg = s('svg', { width: W, height: H, viewBox: `0 0 ${W} ${H}`, class: 'ch-svg', 'font-family': 'MS Sans Serif, Tahoma, Arial, sans-serif', 'font-size': FONT });
    svg.append(s('rect', { class: 'ch-bg', x: 0, y: 0, width: W, height: H, fill: '#ffffff' }));

    // series (legend entries): the columns, the rows of a pie, the columns after the X column of an XY chart
    const keys = kind === 'pie' ? m.rowLabels.map((l, i) => ({ label: l, color: seriesColor(i) }))
      : (kind === 'xy' ? m.colLabels.slice(1) : m.colLabels).map((l, i) => ({ label: l, color: seriesColor(i) }));

    let top = 6, right = W - 8, left = 8, bottom = H - 6;
    if (title) {
      svg.append(s('text', { class: 'ch-title', x: W / 2, y: top + FONT, 'text-anchor': 'middle', 'font-weight': 'bold' }, title));
      top += FONT + 8;
    }
    if (c.bool('ShowLegend') && keys.length && W > 120) {
      const lw = Math.min(Math.max(...keys.map(k => k.label.length)) * TEXT_W + 24, Math.floor(W / 3));
      const lh = keys.length * 14 + 6;
      const lx = right - lw, ly = top + Math.max(0, ((bottom - top) - lh) / 2);
      const g = s('g', { class: 'ch-legend' }, s('rect', { class: 'ch-legend-box', x: lx, y: ly, width: lw, height: lh, fill: '#fff', stroke: '#000' }));
      keys.forEach((k, i) => {
        g.append(s('rect', { class: 'ch-key', x: lx + 5, y: ly + 5 + i * 14, width: 8, height: 8, fill: k.color, stroke: '#000' }));
        g.append(s('text', { x: lx + 18, y: ly + 13 + i * 14 }, clip(k.label, Math.floor((lw - 20) / TEXT_W))));
      });
      svg.append(g);
      right = lx - 8;
    }

    if (kind === 'pie') pies(svg, m, { left, top, right, bottom });
    else {
      const xTitle = titles[AXIS_X] ?? '', yTitle = titles[AXIS_Y] ?? '';
      const yRange = valueRange(m, kind, stacking);
      const ys = niceScale(yRange.lo, yRange.hi);
      const yText = ys.ticks.map(tickText);
      const xs = kind === 'xy' ? niceScale(Math.min(...m.values.map(r => r[0] ?? 0)), Math.max(...m.values.map(r => r[0] ?? 0))) : null;
      left += Math.max(...yText.map(t => t.length)) * TEXT_W + 8 + (yTitle ? FONT + 4 : 0);
      bottom -= FONT + 8 + (xTitle ? FONT + 4 : 0);
      const d = threeD ? SHADOW : 0;
      const px0 = left, px1 = right - d, py0 = top + d, py1 = bottom;
      const pw = Math.max(10, px1 - px0), ph = Math.max(10, py1 - py0);
      svg.append(s('rect', { class: 'ch-plot', x: px0, y: py0, width: pw, height: ph, fill: '#c0c0c0', stroke: '#808080' }));
      const sy = (v: number): number => py1 - ((v - ys.min) / (ys.max - ys.min)) * ph;
      for (const t of ys.ticks) {
        svg.append(s('path', { class: 'ch-grid', d: `M${f(px0)} ${f(sy(t))}H${f(px1)}`, stroke: t === 0 ? '#000' : '#808080', fill: 'none' }));
        svg.append(s('text', { class: 'ch-ytick', x: px0 - 4, y: sy(t) + 4, 'text-anchor': 'end' }, tickText(t)));
      }
      if (yTitle) svg.append(s('text', { class: 'ch-ytitle', transform: `translate(${f(8 + FONT)} ${f(py0 + ph / 2)}) rotate(-90)`, 'text-anchor': 'middle' }, yTitle));
      if (xTitle) svg.append(s('text', { class: 'ch-xtitle', x: px0 + pw / 2, y: H - 8, 'text-anchor': 'middle' }, xTitle));

      const cat = pw / m.rows;
      const cx = (r: number): number => px0 + (r + 0.5) * cat;
      if (kind !== 'xy') {
        const every = Math.max(1, Math.ceil((Math.max(...m.rowLabels.map(l => l.length)) * TEXT_W + 4) / cat));
        m.rowLabels.forEach((l, r) => { if (r % every === 0) svg.append(s('text', { class: 'ch-xtick', x: cx(r), y: py1 + FONT + 3, 'text-anchor': 'middle' }, l)); });
      } else if (xs) {
        for (const t of xs.ticks) svg.append(s('text', { class: 'ch-xtick', x: px0 + ((t - xs.min) / (xs.max - xs.min)) * pw, y: py1 + FONT + 3, 'text-anchor': 'middle' }, tickText(t)));
      }

      const mark = (e: SVGElement, series: number, point: number): SVGElement => {
        e.setAttribute('data-series', String(series + 1));
        e.setAttribute('data-point', String(point + 1));
        if (selected === `${series + 1}.${point + 1}`) e.classList.add('ch-sel');
        return e;
      };
      if (kind === 'bar') {
        const segs = barSegments(m, stacking);
        const shadows = s('g', { class: 'ch-shadows' }), bars = s('g', { class: 'ch-bars' });
        for (const g of segs) {
          const slotW = (cat * 0.72) / g.slots, x = px0 + g.point * cat + cat * 0.14 + g.slot * slotW;
          const y = sy(g.y1), hh = Math.max(0, sy(g.y0) - sy(g.y1));
          if (threeD) shadows.append(s('rect', { class: 'ch-shadow', x: f(x + d), y: f(y - d), width: f(slotW), height: f(hh), fill: '#000', opacity: 0.35 }));
          bars.append(mark(s('rect', { class: 'ch-bar', x: f(x), y: f(y), width: f(slotW), height: f(hh), fill: seriesColor(g.series), stroke: '#000' }), g.series, g.point));
        }
        svg.append(shadows, bars);
      } else if (kind === 'xy' && xs) {
        const sx = (v: number): number => px0 + ((v - xs.min) / (xs.max - xs.min)) * pw;
        for (let col = 1; col < m.cols; col++) {
          const g = s('g', { class: 'ch-series' });
          m.values.forEach((row, r) => g.append(mark(s('circle', { class: 'ch-pt', cx: f(sx(row[0])), cy: f(sy(row[col])), r: 3.5, fill: seriesColor(col - 1), stroke: '#000' }), col - 1, r)));
          svg.append(g);
        }
      } else {
        const lv = lineValues(m, stacking);
        const order = kind === 'area' ? lv.map((_, i) => lv.length - 1 - i) : lv.map((_, i) => i);   // areas: the first series in front
        for (const i of order) {
          const vals = lv[i], color = seriesColor(i);
          const pts = kind === 'step' ? vals.flatMap((v, r) => [[px0 + r * cat, sy(v)], [px0 + (r + 1) * cat, sy(v)]]) : vals.map((v, r) => [cx(r), sy(v)]);
          const path = pts.map(([x, y], k) => `${k ? 'L' : 'M'}${f(x)} ${f(y)}`).join('');
          const g = s('g', { class: 'ch-series' });
          if (kind === 'area') {
            const base = sy(Math.max(ys.min, Math.min(0, ys.max)));
            const poly = `${path}L${f(pts[pts.length - 1][0])} ${f(base)}L${f(pts[0][0])} ${f(base)}Z`;
            if (threeD) g.append(s('path', { class: 'ch-shadow', d: poly, transform: `translate(${d} ${-d})`, fill: '#000', opacity: 0.35 }));
            g.append(s('path', { class: 'ch-area', d: poly, fill: color, stroke: '#000' }));
          } else {
            if (threeD) g.append(s('path', { class: 'ch-shadow', d: path, transform: `translate(${d} ${-d})`, fill: 'none', stroke: '#000', 'stroke-width': 2, opacity: 0.35 }));
            g.append(s('path', { class: 'ch-line', d: path, fill: 'none', stroke: color, 'stroke-width': 2 }));
          }
          vals.forEach((v, r) => g.append(mark(s('circle', { class: 'ch-pt', cx: f(cx(r)), cy: f(sy(v)), r: 3, fill: color, stroke: '#000' }), i, r)));
          svg.append(g);
        }
      }
    }
    root.replaceChildren(svg);
  }

  /** A pie for every column, side by side in a grid; the slices are the rows. */
  function pies(svg: SVGElement, m: ChartModel, box: { left: number; top: number; right: number; bottom: number }): void {
    const n = m.cols, nc = n <= 2 ? n : Math.ceil(Math.sqrt(n)), nr = Math.ceil(n / nc);
    const cw = (box.right - box.left) / nc, ch = (box.bottom - box.top) / nr;
    const threeD = chartKind(c.num('chartType')).threeD;
    for (let col = 0; col < n; col++) {
      const x = box.left + (col % nc) * cw + cw / 2, y = box.top + Math.floor(col / nc) * ch + (ch - FONT - 4) / 2 + 2;
      const r = Math.max(4, Math.min(cw / 2, (ch - FONT - 4) / 2) - 4);
      const sweeps = pieSweeps(m.values.map(row => row[col]));
      const g = s('g', { class: 'ch-pie', 'data-series': col + 1 });
      if (threeD) g.append(s('circle', { class: 'ch-shadow', cx: f(x + SHADOW), cy: f(y + SHADOW), r: f(r), fill: '#000', opacity: 0.35 }));
      g.append(s('circle', { class: 'ch-pie-bg', cx: f(x), cy: f(y), r: f(r), fill: '#c0c0c0', stroke: '#808080' }));
      let a = -90;
      sweeps.forEach((sw, row) => {
        if (sw <= 0) return;
        const sel = selected === `${col + 1}.${row + 1}`;
        const slice = s('path', {
          class: `ch-slice${sel ? ' ch-sel' : ''}`, d: slicePath(x, y, r, a, a + sw), fill: seriesColor(row), stroke: '#000',
          'data-series': col + 1, 'data-point': row + 1, 'data-sweep': Math.round(sw * 1e4) / 1e4,
        });
        g.append(slice);
        a += sw;
      });
      g.append(s('text', { class: 'ch-pie-label', x: f(x), y: f(y + r + FONT + 2), 'text-anchor': 'middle' }, clip(m.colLabels[col], Math.floor((cw - 4) / TEXT_W))));
      svg.append(g);
    }
  }

  return {
    build() {
      root = h('div', { class: 'vb-chart', tabindex: '0' });
      c.el.replaceChildren(root);
      c.setInput(root);
      if (c.mode !== 'run') return;
      root.addEventListener('click', e => {
        const t = (e.target as Element).closest<SVGElement>('[data-series][data-point]');
        if (!t || !root.contains(t) || !c.bool('AllowSelections') || root.getAttribute('aria-disabled') === 'true') return;
        const series = Number(t.getAttribute('data-series')), point = Number(t.getAttribute('data-point'));
        selected = `${series}.${point}`;
        paint();
        c.fire('vbpointselect', { series, point, flags: 0 });
      });
    },
    patch(k) {
      if (k === null || [...k].some(n => n !== 'Left' && n !== 'Top' && n !== 'Visible' && n !== 'Enabled' && n !== 'TabIndex' && n !== 'TabStop' && n !== 'Tag' && n !== 'ToolTipText')) {
        if (k !== null && (k.has('RowCount') || k.has('ColumnCount') || k.has('ChartLines'))) selected = null;
        paint();
      }
    },
    bg: () => null,
  };
}

/** The path of a pie slice from angle `a0` to `a1` (degrees, 0 = to the right, clockwise on the screen). */
export function slicePath(cx: number, cy: number, r: number, a0: number, a1: number): string {
  const pt = (a: number): string => `${f(cx + r * Math.cos(rad(a)))} ${f(cy + r * Math.sin(rad(a)))}`;
  if (a1 - a0 >= 359.999) return `M${pt(a0)}A${f(r)} ${f(r)} 0 1 1 ${pt(a0 + 180)}A${f(r)} ${f(r)} 0 1 1 ${pt(a0)}Z`;
  return `M${f(cx)} ${f(cy)}L${pt(a0)}A${f(r)} ${f(r)} 0 ${a1 - a0 > 180 ? 1 : 0} 1 ${pt(a1)}Z`;
}
