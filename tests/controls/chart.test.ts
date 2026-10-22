// @vitest-environment jsdom
import { afterEach, describe, expect, test } from 'vitest';
import { renderControl } from '../../src/controls/render';
import { CONTROL_TYPES } from '../../src/model/controls';
import {
  barSegments, chartFromMatrix, decodeChart, encodeChart, niceScale, pieSweeps, resizeChart, sampleChart,
} from '../../src/model/chart';
import type { ControlDef, PropValue } from '../../src/model/types';

afterEach(() => { document.body.innerHTML = ''; });

let n = 0;
function mk(props: Record<string, PropValue> = {}): ControlDef {
  const base: Record<string, PropValue> = {};
  for (const pd of CONTROL_TYPES.MSChart.props) if (pd.designTime) base[pd.name] = pd.default;
  n++;
  return { id: `c${n}`, type: 'MSChart', name: `MSChart${n}`, index: null, parentId: null, props: { ...base, ...props } };
}
const view = (d: ControlDef, mode: 'design' | 'run' = 'run') => { const v = renderControl(d, mode, () => null); document.body.appendChild(v.el); return v; };
const lines = (m = sampleChart()) => encodeChart(m);

describe('MSChart model', () => {
  test('ChartData: strings in the first row and column are the labels', () => {
    const m = chartFromMatrix([['', 'A', 'B'], ['x', 1, 2], ['y', 3, 4], ['z', 5, 6]]);
    expect([m.rows, m.cols]).toEqual([3, 2]);
    expect(m.colLabels).toEqual(['A', 'B']);
    expect(m.rowLabels).toEqual(['x', 'y', 'z']);
    expect(m.values).toEqual([[1, 2], [3, 4], [5, 6]]);
    // numbers only: no labels, all of it is data, the default names stay
    const d = chartFromMatrix([[1, 2, 3], [4, 5, 6]]);
    expect([d.rows, d.cols]).toEqual([2, 3]);
    expect(d.rowLabels).toEqual(['Row 1', 'Row 2']);
    // only column labels
    expect(chartFromMatrix([['a', 'b'], [1, 2], [3, 4]]).values).toEqual([[1, 2], [3, 4]]);
  });

  test('the lines the window gets round-trip; resize keeps what fits', () => {
    const m = chartFromMatrix([['', 'a|b', 'B'], ['x', 1.5, -2], ['y', 3, 4]]);
    expect(decodeChart(encodeChart(m))).toEqual(m);
    const r = resizeChart(m, 3, 1);
    expect(r.values).toEqual([[1.5], [3], [0]]);
    expect(r.rowLabels).toEqual(['x', 'y', 'Row 3']);
    expect(decodeChart([])).toBeNull();
  });

  test('pie slices add up to 360 degrees; negatives count as 0', () => {
    for (const v of [[1, 2, 3, 4], [0.1, 0.2, 0.7], [5], [3, -4, 1]]) {
      const s = pieSweeps(v);
      expect(s.reduce((a, b) => a + b, 0)).toBeCloseTo(360, 9);
    }
    expect(pieSweeps([1, 1])).toEqual([180, 180]);
    expect(pieSweeps([0, 0])).toEqual([0, 0]);
  });

  test('nice scales and stacked bars', () => {
    expect(niceScale(0, 9)).toMatchObject({ min: 0, max: 10, step: 2 });
    expect(niceScale(-3, 7).ticks).toEqual([-4, -2, 0, 2, 4, 6, 8]);
    expect(niceScale(0, 0).max).toBeGreaterThan(0);
    const m = chartFromMatrix([[1, -2], [3, 4]]);
    const st = barSegments(m, true).map(s => [s.y0, s.y1]);
    expect(st).toEqual([[0, 1], [-2, 0], [0, 3], [3, 7]]);
  });
});

describe('MSChart drawing', () => {
  test('design time shows the 5 x 4 sample data as 20 bars with a legend of 4', () => {
    const v = view(mk(), 'design');
    expect(v.el.querySelectorAll('rect.ch-bar').length).toBe(20);
    expect(v.el.querySelectorAll('rect.ch-key').length).toBe(4);
    expect(v.el.querySelector('rect.ch-plot')!.getAttribute('fill')).toBe('#c0c0c0');
    expect(v.el.querySelector('rect.ch-bar')!.getAttribute('fill')).toBe('#000080');   // the first series is dark blue
  });

  test('a bar chart renders RowCount x ColumnCount rects, stacked or not; ShowLegend hides the legend', () => {
    const data = lines(chartFromMatrix([['', 'A', 'B', 'C'], ['p', 1, 2, 3], ['q', 4, 5, 6]]));
    const v = view(mk({ ChartLines: data }));
    expect(v.el.querySelectorAll('rect.ch-bar').length).toBe(6);
    expect(v.el.querySelectorAll('rect.ch-shadow').length).toBe(0);
    v.update({ Stacking: true });
    expect(v.el.querySelectorAll('rect.ch-bar').length).toBe(6);
    v.update({ ShowLegend: false });
    expect(v.el.querySelectorAll('rect.ch-key').length).toBe(0);
    v.update({ chartType: 0 });   // 3-D bars: the same bars with a shadow each
    expect(v.el.querySelectorAll('rect.ch-bar').length).toBe(6);
    expect(v.el.querySelectorAll('rect.ch-shadow').length).toBe(6);
    v.update({ RowCount: 2, ChartLines: lines(chartFromMatrix([[1, 2], [3, 4], [5, 6]])) });
    expect(v.el.querySelectorAll('rect.ch-bar').length).toBe(6);
  });

  test('a pie chart draws a pie per column whose slices add up to 360 degrees', () => {
    const v = view(mk({ chartType: 14, ChartLines: lines(chartFromMatrix([[1, 10], [2, 20], [3, 30]])) }));
    const pies = v.el.querySelectorAll('g.ch-pie');
    expect(pies.length).toBe(2);
    for (const g of pies) {
      const sweeps = [...g.querySelectorAll('path.ch-slice')].map(p => Number(p.getAttribute('data-sweep')));
      expect(sweeps.length).toBe(3);
      expect(sweeps.reduce((a, b) => a + b, 0)).toBeCloseTo(360, 3);
    }
    expect(v.el.querySelectorAll('rect.ch-key').length).toBe(3);   // the legend names the rows (the slices)
  });

  test('line, area, step and XY charts draw one point per cell (XY: the first column is X)', () => {
    const data = lines(chartFromMatrix([[1, 5, 6], [2, 7, 8], [3, 6, 9]]));
    const v = view(mk({ chartType: 3, ChartLines: data }));
    expect(v.el.querySelectorAll('circle.ch-pt').length).toBe(9);
    expect(v.el.querySelectorAll('path.ch-line').length).toBe(3);
    v.update({ chartType: 5 });
    expect(v.el.querySelectorAll('path.ch-area').length).toBe(3);
    v.update({ chartType: 7 });
    expect(v.el.querySelectorAll('path.ch-line').length).toBe(3);
    v.update({ chartType: 16 });
    expect(v.el.querySelectorAll('circle.ch-pt').length).toBe(6);
    expect(v.el.querySelectorAll('rect.ch-key').length).toBe(2);
  });

  test('titles: TitleText and the axis titles', () => {
    const v = view(mk({ TitleText: 'Sales', AxisTitles: ['Month', 'Units', '', ''] }));
    expect(v.el.querySelector('.ch-title')!.textContent).toBe('Sales');
    expect(v.el.querySelector('.ch-xtitle')!.textContent).toBe('Month');
    expect(v.el.querySelector('.ch-ytitle')!.textContent).toBe('Units');
  });

  test('a click on a bar dispatches vbpointselect (series = column, point = row, from 1) in run mode only', () => {
    const got: unknown[] = [];
    const v = view(mk());
    v.inputEl!.addEventListener('vbpointselect', e => got.push((e as CustomEvent).detail));
    v.el.querySelector<SVGElement>('rect.ch-bar[data-series="3"][data-point="2"]')!.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    expect(got).toEqual([{ series: 3, point: 2, flags: 0 }]);
    expect(v.el.querySelectorAll('.ch-sel').length).toBe(1);
    v.update({ AllowSelections: false });
    v.el.querySelector<SVGElement>('rect.ch-bar')!.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    expect(got.length).toBe(1);
    const d = view(mk(), 'design');
    expect(d.inputEl!.style.pointerEvents).toBe('none');
  });
});
