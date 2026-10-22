// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import { newControl, newForm, newProject } from '../../src/model/controls';
import type { ControlType, Project, PropValue } from '../../src/model/types';
import { InlineFormHost } from '../../src/run/inlineFormHost';
import { RunSession } from '../../src/run/session';

let container: HTMLElement;
let session: RunSession | undefined;
beforeEach(() => { container = document.createElement('div'); document.body.appendChild(container); });
afterEach(() => { if (session && session.state !== 'ended') session.end(); session = undefined; document.body.innerHTML = ''; });
const tick = () => new Promise(r => setTimeout(r, 0));
const settle = async () => { for (let i = 0; i < 20; i++) await tick(); };

async function run(code: string, props: Record<string, PropValue> = {}) {
  const p: Project = newProject();
  p.forms = [newForm('Form1', code)];
  p.startupForm = 'Form1';
  const c = newControl(p.forms[0], 'MSChart' as Exclude<ControlType, 'Form'>, { left: 120, top: 120 }, null);
  c.name = 'MSChart1'; Object.assign(c.props, props);
  p.forms[0].controls.push(c);
  const out: string[] = [];
  session = new RunSession(p, new InlineFormHost(container), {
    debugPrint: t => { out.push(t); }, onBreak: async () => 'end', onEnded: () => {},
    readFile: async () => new Uint8Array(), appPath: '/app',
  }, 'ide');
  await session.start();
  await settle();
  return { out, el: container.querySelector<HTMLElement>(`[data-control-id="${c.id}"]`)! };
}

describe('MSChart in a running program', () => {
  test('starts with the 5 x 4 sample data; Row, Column and Data address a cell; counts follow RowCount / ColumnCount', async () => {
    const r = await run([
      'Private Sub Form_Load()',
      '  Debug.Print MSChart1.RowCount; MSChart1.ColumnCount; MSChart1.Row; MSChart1.Column; MSChart1.Data; MSChart1.RowLabel; MSChart1.ColumnLabel',
      '  MSChart1.Row = 3: MSChart1.Column = 2',
      '  Debug.Print MSChart1.Data',
      '  MSChart1.Data = 42.5',
      '  MSChart1.RowLabel = "March"',
      '  MSChart1.Row = 1: MSChart1.Row = 3',
      '  Debug.Print MSChart1.Data; MSChart1.RowLabel',
      '  MSChart1.RowCount = 2',
      '  Debug.Print MSChart1.Row; MSChart1.RowCount',
      '  MSChart1.ColumnCount = 6: MSChart1.Column = 6: MSChart1.Row = 2',
      '  Debug.Print MSChart1.Data; MSChart1.ColumnLabel',
      '  On Error Resume Next',
      '  MSChart1.Row = 3',
      '  Debug.Print Err.Number: Err.Clear',
      '  MSChart1.RowCount = 0',
      '  Debug.Print Err.Number: Err.Clear',
      '  MSChart1.Data = "x"',
      '  Debug.Print Err.Number',
      'End Sub', '',
    ].join('\n'));
    expect(r.out).toEqual([' 5  4  1  1  9 Row 1Column 1', ' 8 ', ' 42.5 March', ' 2  2 ', ' 0 Column 6', ' 380 ', ' 380 ', ' 13 ']);
    expect(r.el.querySelectorAll('rect.ch-bar').length).toBe(12);
  });

  test('ChartData = a 2-D Variant array sets RowCount, ColumnCount and the labels; reading gives it back', async () => {
    const r = await run([
      'Private Sub Form_Load()',
      '  Dim v(1 To 4, 1 To 3) As Variant',
      '  v(1, 2) = "East": v(1, 3) = "West"',
      '  v(2, 1) = "Jan": v(2, 2) = 10: v(2, 3) = 20',
      '  v(3, 1) = "Feb": v(3, 2) = 30: v(3, 3) = 40',
      '  v(4, 1) = "Mar": v(4, 2) = 50: v(4, 3) = 60',
      '  MSChart1.ChartData = v',
      '  Debug.Print MSChart1.RowCount; MSChart1.ColumnCount',
      '  MSChart1.Row = 3: MSChart1.Column = 2',
      '  Debug.Print MSChart1.Data; MSChart1.RowLabel; MSChart1.ColumnLabel',
      '  Dim w As Variant',
      '  w = MSChart1.ChartData',
      '  Debug.Print UBound(w, 1); UBound(w, 2); w(1, 3); w(4, 1); w(4, 3)',
      '  MSChart1.ChartData = Array(4, 5, 6)',
      '  Debug.Print MSChart1.RowCount; MSChart1.ColumnCount',
      '  On Error Resume Next',
      '  MSChart1.ChartData = 5',
      '  Debug.Print Err.Number',
      'End Sub', '',
    ].join('\n'));
    expect(r.out).toEqual([' 3  2 ', ' 60 MarWest', ' 4  3 WestMar 60 ', ' 3  1 ', ' 13 ']);
    expect(r.el.querySelectorAll('rect.ch-bar').length).toBe(3);
  });

  test('Plot.Axis(VtChAxisIdX / Y).AxisTitle.Text and the constants', async () => {
    const r = await run([
      'Private Sub Form_Load()',
      '  MSChart1.Plot.Axis(VtChAxisIdX).AxisTitle.Text = "Month"',
      '  MSChart1.Plot.Axis(1).AxisTitle.Text = "Units"',
      '  Debug.Print MSChart1.Plot.Axis(0).AxisTitle.Text; MSChart1.Plot.Axis(VtChAxisIdY).AxisTitle.Text',
      '  Debug.Print VtChChartType2dBar; VtChChartType3dBar; VtChChartType2dLine; VtChChartType2dArea; VtChChartType2dStep; VtChChartType2dPie; VtChChartType2dXY; VtChAxisIdX; VtChAxisIdY',
      '  MSChart1.chartType = VtChChartType2dPie',
      '  MSChart1.TitleText = "Pies"',
      '  Debug.Print MSChart1.chartType; MSChart1.TitleText; MSChart1.ShowLegend; MSChart1.Stacking',
      'End Sub', '',
    ].join('\n'));
    expect(r.out).toEqual(['MonthUnits', ' 1  0  3  5  7  14  16  0  1 ', ' 14 PiesTrueFalse']);
    expect(r.el.querySelector('.ch-xtitle')).toBeNull();   // a pie has no axes
    expect(r.el.querySelectorAll('g.ch-pie').length).toBe(4);
  });

  test('a click on a bar raises PointSelected(Series, DataPoint, MouseFlags, Cancel), then Click', async () => {
    const r = await run([
      'Private Sub MSChart1_PointSelected(Series As Integer, DataPoint As Integer, MouseFlags As Integer, Cancel As Integer)',
      '  Debug.Print "point"; Series; DataPoint; MouseFlags',
      'End Sub',
      'Private Sub MSChart1_Click()',
      '  Debug.Print "click"',
      'End Sub', '',
    ].join('\n'));
    r.el.querySelector<SVGElement>('rect.ch-bar[data-series="2"][data-point="4"]')!.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    await settle();
    expect(r.out).toEqual(['point 2  4  0 ', 'click']);
  });
});
