// Calendar (MSCAL.OCX, the Access calendar): a title, the month and year selectors, the day names and a grid of the 42 days of the month with grid
// lines and a cell effect. Different from MonthView (calendar.ts); the date arithmetic is shared (model/dateControls.ts).
//
// DOM events the run mode dispatches on inputEl: `vbuseraction` ({ verb: 'select', serial, click? }): the user picked a day (click: 1), moved with the
// keys or chose another month or year; ({ verb: 'click' }): a click elsewhere. formWindow.ts hands them to the run session, which raises
// BeforeUpdate / AfterUpdate, sends the new Value and raises Click.
import { monthName, weekdayNameOf } from '../lang/builtins/format';
import { dateFrom, dateParts } from '../lang/values';
import { dayOf, daysInMonth, monthGrid, nowSerial } from '../model/dateControls';
import { cutName, inRange, stepDate } from '../model/mscal';
import type { FontValue } from '../model/types';
import { h } from '../ui98/dom';
import type { Ctx, Renderer } from './render';

const LOCALE = Intl.DateTimeFormat().resolvedOptions().locale;
type Keys = ReadonlySet<string> | null;
const has = (k: Keys, ...names: string[]): boolean => k === null || names.some(n => k.has(n));
const PAINT_KEYS = ['Value', 'FirstDay', 'DayLength', 'MonthLength', 'GridCellEffect', 'ShowDateSelectors', 'ShowDays', 'ShowHorizontalGrid', 'ShowTitle',
  'ShowVerticalGrid', 'BackColor', 'ForeColor', 'GridLinesColor', 'DayFontColor', 'TitleFontColor', 'TitleFont', 'DayFont', 'GridFont'];

function fontStyle(el: HTMLElement, f: unknown): void {
  const v = f as FontValue | null;
  if (!v || typeof v !== 'object' || !('size' in v)) return;
  el.style.fontFamily = !v.name || /^ms sans serif$/i.test(v.name) ? '"Pixelated MS Sans Serif", Tahoma, Geneva, sans-serif' : `"${v.name.replace(/["\\]/g, '')}", sans-serif`;
  el.style.fontSize = `${Math.round(v.size * 96 / 72)}px`;
  el.style.fontWeight = v.bold ? '700' : '400';
  el.style.fontStyle = v.italic ? 'italic' : 'normal';
  el.style.textDecoration = v.underline ? 'underline' : 'none';
}

export function calendar(c: Ctx): Renderer {
  let root: HTMLElement;

  const value = (): number => (typeof c.props.Value === 'number' ? dayOf(c.props.Value) : nowSerial(true));
  /** The date of the same day number in another month and year (the day shrinks to the month's length). */
  const moved = (year: number, month: number): number => { const p = dateParts(value()); return dateFrom(year, month, Math.min(p.d, daysInMonth(year, month))).serial; };

  function paint(): void {
    const v = value(), p = dateParts(v);
    const firstDay = c.num('FirstDay') || 1;
    root.className = `vb-mscal mc-eff${c.num('GridCellEffect')}`;
    root.style.backgroundColor = c.color('BackColor');
    root.style.color = c.color('ForeColor');
    const lines = c.color('GridLinesColor');
    const parts: HTMLElement[] = [];
    if (c.bool('ShowDateSelectors')) {
      const month = h('select', { class: 'mc-month', 'aria-label': 'Month' }, ...Array.from({ length: 12 }, (_, i) =>
        h('option', { value: String(i + 1) }, monthName(i + 1, true, LOCALE)))) as HTMLSelectElement;
      const years: HTMLElement[] = [];
      for (let y = Math.max(100, p.y - 50); y <= Math.min(9999, p.y + 50); y++) years.push(h('option', { value: String(y) }, String(y)));
      const year = h('select', { class: 'mc-year', 'aria-label': 'Year' }, ...years) as HTMLSelectElement;
      month.value = String(p.m); year.value = String(p.y);
      const changed = () => c.fire('vbuseraction', { verb: 'select', serial: moved(Number(year.value), Number(month.value)) });
      month.addEventListener('change', changed);
      year.addEventListener('change', changed);
      parts.push(h('div', { class: 'mc-sel' }, month, year));
    }
    if (c.bool('ShowTitle')) {
      const title = h('div', { class: 'mc-title' }, `${cutName(c.num('MonthLength'), monthName(p.m, false, LOCALE), monthName(p.m, true, LOCALE))} ${p.y}`);
      fontStyle(title, c.props.TitleFont);
      title.style.color = c.color('TitleFontColor');
      parts.push(title);
    }
    const days: HTMLElement[] = [];
    if (c.bool('ShowDays')) {
      for (let i = 0; i < 7; i++) {
        const dow = (firstDay - 1 + i) % 7;
        const d = h('div', { class: 'mc-dow' }, cutName(c.num('DayLength'), weekdayNameOf(dow, false, LOCALE), weekdayNameOf(dow, true, LOCALE)));
        fontStyle(d, c.props.DayFont);
        d.style.color = c.color('DayFontColor');
        days.push(d);
      }
    }
    const cells = monthGrid(p.y, p.m, firstDay).map(g => {
      const cell = h('div', { class: `mc-d${g.inMonth ? '' : ' out'}${g.serial === v ? ' sel' : ''}`, dataset: { serial: String(g.serial) } }, String(dateParts(g.serial).d));
      fontStyle(cell, c.props.GridFont);
      if (c.bool('ShowHorizontalGrid')) cell.style.borderBottom = `1px solid ${lines}`;
      if (c.bool('ShowVerticalGrid')) cell.style.borderRight = `1px solid ${lines}`;
      return cell;
    });
    const grid = h('div', { class: 'mc-grid' }, ...days, ...cells);
    grid.style.gridTemplateRows = `${c.bool('ShowDays') ? 'auto ' : ''}repeat(6, 1fr)`;
    parts.push(grid);
    root.replaceChildren(...parts);
  }

  return {
    build() {
      root = h('div', { class: 'vb-mscal', tabindex: '0' });
      c.el.replaceChildren(root);
      c.setInput(root);
      if (c.mode !== 'run') return;
      root.addEventListener('mousedown', e => { if (!(e.target as Element).closest('select')) root.focus(); });
      root.addEventListener('click', e => {   // a day is the user's update, then Click (the run session raises both, in that order)
        if (root.getAttribute('aria-disabled') === 'true' || (e.target as Element).closest('select')) return;
        const d = (e.target as Element).closest<HTMLElement>('.mc-d');
        c.fire('vbuseraction', d ? { verb: 'select', serial: Number(d.dataset.serial), click: 1 } : { verb: 'click' });
      });
      root.addEventListener('keydown', e => {
        if ((e.target as Element).closest('select')) return;
        const v = value();
        const next = e.key === 'ArrowLeft' ? stepDate(v, 'Day', -1) : e.key === 'ArrowRight' ? stepDate(v, 'Day', 1)
          : e.key === 'ArrowUp' ? stepDate(v, 'Week', -1) : e.key === 'ArrowDown' ? stepDate(v, 'Week', 1)
          : e.key === 'PageUp' ? stepDate(v, e.ctrlKey ? 'Year' : 'Month', -1) : e.key === 'PageDown' ? stepDate(v, e.ctrlKey ? 'Year' : 'Month', 1) : null;
        if (next === null || !inRange(next)) return;
        e.preventDefault();
        c.fire('vbuseraction', { verb: 'select', serial: next });
      });
    },
    patch(k) { if (has(k, ...PAINT_KEYS)) paint(); },
    bg: () => null,
  };
}
