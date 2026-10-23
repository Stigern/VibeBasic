// @vitest-environment jsdom
import { afterEach, describe, expect, test } from 'vitest';
import { renderControl } from '../../src/controls/render';
import { dateFrom } from '../../src/lang/values';
import { CONTROL_TYPES } from '../../src/model/controls';
import { adjustField, formatDtp, monthGrid, parseCustomFormat, systemStartOfWeek, typeField, weekdayOf, weekNumberOf } from '../../src/model/dateControls';
import { backspace, clipText, emptyText, fitText, fromText, isComplete, parseMask, typeChar } from '../../src/model/mask';
import { formatPropertyValue, parsePropertyInput } from '../../src/ide/propertyEditors';
import { getPropDef } from '../../src/model/controls';
import type { ControlDef, ControlType, PropValue } from '../../src/model/types';

afterEach(() => { document.body.innerHTML = ''; });

const serial = (y: number, m: number, d: number, h = 0, n = 0, s = 0) => dateFrom(y, m, d, h, n, s).serial;
let n = 0;
function mk(type: Exclude<ControlType, 'Form'>, props: Record<string, PropValue> = {}): ControlDef {
  const base: Record<string, PropValue> = {};
  for (const pd of CONTROL_TYPES[type].props) if (pd.designTime) base[pd.name] = pd.default;
  n++;
  return { id: `id${n}`, type, name: `${type}${n}`, index: null, parentId: null, props: { ...base, ...props } };
}
const view = (d: ControlDef) => { const v = renderControl(d, 'run', () => null); document.body.appendChild(v.el); return v; };

describe('DTPicker format', () => {
  test('a custom format "dd.MM.yyyy" renders the Value in its fields', () => {
    const v = view(mk('DTPicker', { Format: 3, CustomFormat: 'dd.MM.yyyy', Value: serial(2026, 10, 2) }));
    expect(v.el.querySelector('.dtp-fields')!.textContent).toBe('02.10.2026');
    expect([...v.el.querySelectorAll('.dtp-f')].map(e => (e as HTMLElement).dataset.tok)).toEqual(['dd', 'MM', 'yyyy']);
    v.update({ Value: serial(2027, 12, 31) });
    expect(v.el.querySelector('.dtp-fields')!.textContent).toBe('31.12.2027');
  });

  test('tokens: minutes vs months, 12-hour clock, quoted text', () => {
    const d = serial(2026, 3, 4, 15, 7, 9);
    expect(formatDtp(d, 3, "d/M/yy H:mm:ss", 'en-US')).toBe('4/3/26 15:07:09');
    expect(formatDtp(d, 3, "h:m t 'at' hh tt", 'en-US')).toBe('3:7 P at 03 PM');
    expect(formatDtp(d, 3, 'dddd d MMMM yyyy', 'en-US')).toBe('Wednesday 4 March 2026');
    expect(formatDtp(d, 3, 'ddd MMM', 'en-US')).toBe('Wed Mar');
    expect(parseCustomFormat("yyyy'-'MM")).toEqual([{ tok: 'yyyy' }, { lit: '-' }, { tok: 'MM' }]);
  });

  test('standard formats follow the locale', () => {
    const d = serial(2026, 10, 22, 14, 5, 9);
    expect(formatDtp(d, 1, '', 'nb-NO')).toBe('22.10.2026');
    expect(formatDtp(d, 2, '', 'nb-NO')).toBe('14:05:09');
    expect(formatDtp(d, 0, '', 'en-US')).toBe('Thursday, October 22, 2026');
  });

  test('Up/Down and typed digits edit a field; the month is clamped, the clock wraps', () => {
    expect(adjustField(serial(2026, 1, 31), 'MM', 1)).toBe(serial(2026, 2, 28));
    expect(adjustField(serial(2026, 12, 15), 'MM', 1)).toBe(serial(2026, 1, 15));
    expect(adjustField(serial(2026, 5, 30), 'dd', 2)).toBe(serial(2026, 5, 1));
    expect(adjustField(serial(2026, 5, 30, 23), 'HH', 1)).toBe(serial(2026, 5, 30, 0));
    expect(adjustField(serial(2026, 5, 30, 10), 'tt', 1)).toBe(serial(2026, 5, 30, 22));
    expect(typeField(serial(2026, 5, 30), 'dd', 31)).toBe(serial(2026, 5, 31));
    expect(typeField(serial(2026, 5, 30), 'dd', 32)).toBeNull();
    expect(typeField(serial(2026, 5, 30), 'yy', 31)).toBe(serial(1931, 5, 30));
  });

  test('Value Null with CheckBox: the box is empty and the fields are grey; a click on the box restores the last date', () => {
    const v = view(mk('DTPicker', { Format: 1, CheckBox: true, Value: null }));
    expect(v.el.querySelector('.dtp-chk')!.classList.contains('on')).toBe(false);
    expect(v.el.querySelector('.dtp-fields')!.classList.contains('dtp-off')).toBe(true);
    expect((v.inputEl as HTMLElement).dataset.value).toBe('');
    let changes = 0;
    v.inputEl!.addEventListener('change', () => changes++);
    v.el.querySelector('.dtp-chk')!.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));
    expect(changes).toBe(1);
    expect((v.inputEl as HTMLElement).dataset.value).not.toBe('');
    expect(v.el.querySelector('.dtp-chk')!.classList.contains('on')).toBe(true);
    v.el.querySelector('.dtp-chk')!.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));
    expect((v.inputEl as HTMLElement).dataset.value).toBe('');
  });

  test('MinDate and MaxDate clamp what the user sets', () => {
    const v = view(mk('DTPicker', { Format: 3, CustomFormat: 'yyyy-MM-dd', Value: serial(2026, 5, 10), MinDate: serial(2026, 5, 5), MaxDate: serial(2026, 5, 12) }));
    const key = (k: string) => v.inputEl!.dispatchEvent(new KeyboardEvent('keydown', { key: k, bubbles: true }));
    key('ArrowRight'); key('ArrowRight');   // the day field
    for (let i = 0; i < 9; i++) key('ArrowUp');
    expect(v.el.querySelector('.dtp-fields')!.textContent).toBe('2026-05-12');
    for (let i = 0; i < 20; i++) key('ArrowDown');
    expect(v.el.querySelector('.dtp-fields')!.textContent).toBe('2026-05-05');
    v.update({ Value: serial(2030, 1, 1) });   // set by code outside the range
    expect(v.el.querySelector('.dtp-fields')!.textContent).toBe('2026-05-12');
  });

  test('the drop-down calendar opens and a click on a day sets the date, keeping the time', () => {
    const v = view(mk('DTPicker', { Format: 3, CustomFormat: 'yyyy-MM-dd HH:mm', Value: serial(2026, 5, 10, 13, 45) }));
    const events: string[] = [];
    v.inputEl!.addEventListener('vbdropdown', () => events.push('drop'));
    v.inputEl!.addEventListener('vbcloseup', () => events.push('up'));
    v.el.querySelector('.dtp-btn')!.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));
    expect(v.el.querySelector('.dtp-pop')!.classList.contains('open')).toBe(true);
    const day = v.el.querySelector<HTMLElement>(`.mv-d[data-serial="${serial(2026, 5, 20)}"]`)!;
    day.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, button: 0 }));
    document.dispatchEvent(new MouseEvent('mouseup', { bubbles: true }));
    expect(v.el.querySelector('.dtp-fields')!.textContent).toBe('2026-05-20 13:45');
    expect(events).toEqual(['drop', 'up']);
    expect(v.el.querySelector('.dtp-pop')!.classList.contains('open')).toBe(false);
  });
});

describe('MonthView', () => {
  test('the grid starts on the StartOfWeek day (Monday first, Sunday first)', () => {
    for (const [sow, first] of [[2, 'M'], [1, 'S'], [7, 'S']] as const) {
      const grid = monthGrid(2026, 10, sow);
      expect(grid.length).toBe(42);
      expect(weekdayOf(grid[0].serial)).toBe(sow);
      expect(grid.filter(g => g.inMonth).length).toBe(31);
      const v = view(mk('MonthView', { StartOfWeek: sow, Value: serial(2026, 10, 22) }));
      const head = [...v.el.querySelectorAll('.mv-head .mv-dn')].map(e => e.textContent);
      expect(head.length).toBe(7);
      expect(weekdayOf(Number((v.el.querySelector('.mv-row:not(.mv-head) .mv-d') as HTMLElement).dataset.serial))).toBe(sow);
      if (sow === 2) expect(head[0]!.toUpperCase()).toBe(first);
      document.body.innerHTML = '';
    }
    expect(weekdayOf(serial(2026, 10, 22))).toBe(5);   // a Thursday
    expect(systemStartOfWeek('nb-NO')).toBe(2);
    expect(systemStartOfWeek('en-US')).toBe(1);
  });

  test('title, selection, today and week numbers', () => {
    const v = view(mk('MonthView', { StartOfWeek: 2, Value: serial(2026, 10, 22), ShowWeekNumbers: true }));
    expect(v.el.querySelector('.mv-ttl')!.textContent).toMatch(/2026/);
    expect([...v.el.querySelectorAll('.mv-d.sel')].map(e => e.textContent)).toEqual(['22']);
    expect(v.el.querySelectorAll('.mv-wk').length).toBe(7);
    expect(weekNumberOf(serial(2026, 10, 19))).toBe(43);
    expect(weekNumberOf(serial(2026, 1, 1) - 3)).toBe(1);   // Monday 29 Dec 2025 starts ISO week 1 of 2026
    v.update({ MonthRows: 1, MonthColumns: 2 });
    expect(v.el.querySelectorAll('.mv-month').length).toBe(2);
  });

  test('a click selects the day (SelChange, then DateClick on the release); MinDate and MaxDate disable days', () => {
    const v = view(mk('MonthView', { Value: serial(2026, 10, 22), MinDate: serial(2026, 10, 5), MaxDate: serial(2026, 10, 25) }));
    const log: string[] = [];
    v.inputEl!.addEventListener('vbmvselect', e => log.push(`sel ${(e as CustomEvent).detail.start}`));
    v.inputEl!.addEventListener('vbdateclick', e => log.push(`click ${(e as CustomEvent).detail.serial}`));
    const day = (d: number) => v.el.querySelector<HTMLElement>(`.mv-d[data-serial="${serial(2026, 10, d)}"]`)!;
    expect(day(3).classList.contains('off')).toBe(true);
    day(3).dispatchEvent(new MouseEvent('mousedown', { bubbles: true, button: 0 }));
    document.dispatchEvent(new MouseEvent('mouseup', { bubbles: true }));
    expect(log).toEqual([]);
    day(12).dispatchEvent(new MouseEvent('mousedown', { bubbles: true, button: 0 }));
    document.dispatchEvent(new MouseEvent('mouseup', { bubbles: true }));
    expect(log).toEqual([`sel ${serial(2026, 10, 12)}`, `click ${serial(2026, 10, 12)}`]);
    expect([...v.el.querySelectorAll('.mv-d.sel')].map(e => e.textContent)).toEqual(['12']);
  });

  test('MultiSelect: a drag selects a range, at most MaxSelCount days', () => {
    const v = view(mk('MonthView', { Value: serial(2026, 10, 1), MultiSelect: true, MaxSelCount: 4 }));
    const day = (d: number) => v.el.querySelector<HTMLElement>(`.mv-d[data-serial="${serial(2026, 10, d)}"]`)!;
    const sels: number[][] = [];
    v.inputEl!.addEventListener('vbmvselect', e => sels.push([(e as CustomEvent).detail.start, (e as CustomEvent).detail.end]));
    day(6).dispatchEvent(new MouseEvent('mousedown', { bubbles: true, button: 0 }));
    day(8).dispatchEvent(new MouseEvent('mouseover', { bubbles: true }));
    day(14).dispatchEvent(new MouseEvent('mouseover', { bubbles: true }));
    document.dispatchEvent(new MouseEvent('mouseup', { bubbles: true }));
    expect(sels.at(-1)).toEqual([serial(2026, 10, 6), serial(2026, 10, 9)]);
    expect([...v.el.querySelectorAll('.mv-d.sel')].map(e => e.textContent)).toEqual(['6', '7', '8', '9']);
  });
});

describe('MaskedEdit mask engine', () => {
  const mask = '##.##.####';
  const slots = parseMask(mask);
  const type = (text: string, keys: string) => {
    let t = text, pos = 0;
    const errors: [string, number][] = [];
    for (const ch of keys) {
      const r = typeChar(slots, t, '_', pos, 0, ch);
      if (r.error) errors.push([r.error.text, r.error.pos]);
      t = r.text; pos = r.caret;
    }
    return { t, pos, errors };
  };

  test('typing "01022024" skips the literals: Text "01.02.2024", ClipText "01022024"', () => {
    const r = type(emptyText(slots, '_'), '01022024');
    expect(r.t).toBe('01.02.2024');
    expect(clipText(slots, r.t, '_')).toBe('01022024');
    expect(isComplete(slots, r.t, '_')).toBe(true);
    expect(r.errors).toEqual([]);
  });

  test('a letter in a digit position is refused with its position; typing a literal steps over it', () => {
    expect(type(emptyText(slots, '_'), '0a')).toMatchObject({ t: '0_.__.____', errors: [['a', 1]] });
    expect(type(emptyText(slots, '_'), '1.2')).toMatchObject({ t: '1_.2_.____', errors: [] });
    expect(clipText(slots, '01.0_.____', '_')).toBe('010');
    expect(isComplete(slots, '01.0_.____', '_')).toBe(false);
  });

  test('? A & C 9 # and escapes', () => {
    const s = parseMask('?A&C9#\\#(-)');
    expect(s.map(x => (x.lit ? x.ch : x.type))).toEqual(['?', 'A', '&', 'C', '9', '#', '#', '(', '-', ')']);
    expect(fromText(s, '_', 'x1!')).toBe('x1!___#(-)');
    expect(typeChar(parseMask('?'), '_', '_', 0, 0, '5').error).toBeDefined();
    expect(typeChar(parseMask('?'), '_', '_', 0, 0, 'é').error).toBeUndefined();
    expect(isComplete(parseMask('9C'), '__', '_')).toBe(true);
    expect(typeChar(parseMask('>?<?'), '__', '_', 0, 0, 'a').text).toBe('A_');
    expect(typeChar(parseMask('>?<?'), 'A_', '_', 1, 0, 'B').text).toBe('Ab');
  });

  test('backspace empties the entry before the caret, over literals; fromText takes the full text or just the entries', () => {
    expect(backspace(slots, '01.0_.____', '_', 4, 0)).toMatchObject({ text: '01.__.____', caret: 3 });
    expect(backspace(slots, '01.0_.____', '_', 3, 0)).toMatchObject({ text: '0_.0_.____', caret: 1 });
    expect(fromText(slots, '_', '01.02.2024')).toBe('01.02.2024');
    expect(fromText(slots, '_', '01022024')).toBe('01.02.2024');
    expect(fromText(slots, '_', '01 02.2024')).toBeNull();
    expect(fromText(slots, '_', '0102ab24')).toBeNull();
    expect(fitText('', '_', 'plain')).toBe('plain');
    expect(fitText(mask, '_', 'zz')).toBe('__.__.____');
  });
});

describe('Properties window', () => {
  test('a date property is shown and read as text', () => {
    const pd = getPropDef('DTPicker', 'MinDate')!;
    expect(pd.kind).toBe('date');
    const text = formatPropertyValue(pd, serial(2026, 10, 22));
    expect(parsePropertyInput(pd, text)).toEqual({ ok: true, value: serial(2026, 10, 22) });
    expect(parsePropertyInput(pd, '2026-10-22')).toEqual({ ok: true, value: serial(2026, 10, 22) });
    expect(parsePropertyInput(pd, 'nonsense')).toEqual({ ok: false });
    expect(parsePropertyInput(getPropDef('DTPicker', 'Value')!, '')).toEqual({ ok: true, value: null });
  });
});
