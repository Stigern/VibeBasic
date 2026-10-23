// DTPicker, MonthView and MaskedEdit: their renderers (the shared contract is in render.ts) and the month calendar they share.
//
// DOM events the run mode dispatches on inputEl (formWindow.ts turns them into VB events):
//  - DTPicker: `change` (Value in dataset.value; '' = Null), `vbdropdown`, `vbcloseup`
//  - MonthView: `vbmvselect` ({ start, end } serials), `vbdateclick` / `vbdatedblclick` ({ serial })
//  - MaskedEdit: `input` (the Text), `vbvalidationerror` ({ text, pos }), `vbautotab`; formWindow sends typed characters to it as `vbmaskkey`.

import { formatValue, monthName, weekdayNameOf } from '../lang/builtins/format';
import { dateParts } from '../lang/values';
import {
  MAX_DATE, MIN_DATE, addMonths, adjustField, clampDate, dayOf, daysInMonth, dtSegments, fieldDigits, fieldText, monthGrid,
  nowSerial, systemStartOfWeek, typeField, weekNumberOf, withDate,
} from '../model/dateControls';
import { backspace, clearRange, clipText, deleteForward, fitText, isComplete, parseMask, typeChar, type TypeResult } from '../model/mask';
import { h } from '../ui98/dom';
import type { Ctx, Renderer } from './render';

const LOCALE = Intl.DateTimeFormat().resolvedOptions().locale;
type Keys = ReadonlySet<string> | null;
const has = (k: Keys, ...names: string[]): boolean => k === null || names.some(n => k.has(n));
const dateProp = (c: Ctx, n: string): number | null => { const v = c.props[n]; return typeof v === 'number' ? v : null; };
const todayText = (): string => formatValue({ kind: 'date', serial: nowSerial(true) }, 'Short Date', LOCALE);

// ---------------------------------------------------------------------------------------------------------------
// The month calendar (MonthView and the DTPicker's drop-down)

export interface CalState {
  /** The selected days (serials; whole days) and the range the control accepts. */
  start: number; end: number; min: number; max: number;
  /** 1 (Sunday) ... 7. */
  startOfWeek: number;
  showToday: boolean; weekNumbers: boolean;
  rows: number; cols: number;
  multi: boolean; maxSel: number;
}
export interface CalHooks {
  /** The user changed the selection (click, drag or key). */
  select(start: number, end: number): void;
  /** The mouse was released on a day. */
  click(serial: number): void;
  dblclick(serial: number): void;
}
export interface Calendar { el: HTMLElement; set(s: CalState): void; key(e: KeyboardEvent): boolean }

const IDLE: CalState = { start: 0, end: 0, min: 0, max: 0, startOfWeek: 1, showToday: true, weekNumbers: false, rows: 1, cols: 1, multi: false, maxSel: 1 };

export function createCalendar(interactive: boolean, hooks: CalHooks): Calendar {
  const el = h('div', { class: 'mv-cal' });
  let st = IDLE, vy = 2000, vm = 1, first = true;
  let anchor = 0, dragging = false, lastDay = 0;

  const monthIndex = (serial: number): number => { const p = dateParts(serial); return p.y * 12 + p.m - 1; };
  const inView = (serial: number): boolean => { const i = monthIndex(serial) - (vy * 12 + vm - 1); return i >= 0 && i < st.rows * st.cols; };
  const show = (serial: number): void => { const p = dateParts(serial); vy = p.y; vm = p.m; };
  const isDay = (e: Element | null): HTMLElement | null => {
    const d = e?.closest<HTMLElement>('.mv-d') ?? null;
    return d && el.contains(d) && !d.classList.contains('hide') && !d.classList.contains('off') ? d : null;
  };

  function paint(): void {
    const today = nowSerial(true), lo = Math.min(st.start, st.end), hi = Math.max(st.start, st.end);
    const n = st.rows * st.cols;
    const names = [0, 1, 2, 3, 4, 5, 6].map(k => weekdayNameOf((st.startOfWeek - 1 + k) % 7, false, LOCALE).charAt(0).toUpperCase());
    const blocks: HTMLElement[] = [];
    for (let i = 0; i < n; i++) {
      const { y, m } = addMonths(vy, vm, i);
      const grid = monthGrid(y, m, st.startOfWeek);
      const gap = () => h('span', { class: 'mv-nav-gap' });
      const title = h('div', { class: 'mv-title' },
        i === 0 ? h('span', { class: 'mv-nav prev', dataset: { nav: '-1' } }) : gap(),
        h('span', { class: 'mv-ttl' }, `${monthName(m, true, LOCALE)} ${y}`),
        i === st.cols - 1 ? h('span', { class: 'mv-nav next', dataset: { nav: '1' } }) : gap());
      const rows: HTMLElement[] = [h('div', { class: 'mv-row mv-head' }, ...(st.weekNumbers ? [h('span', { class: 'mv-wk' })] : []),
        ...names.map(nm => h('span', { class: 'mv-dn' }, nm)))];
      for (let r = 0; r < 6; r++) {
        const days = grid.slice(r * 7, r * 7 + 7).map(g => {
          const cls = ['mv-d'];
          if (!g.inMonth) cls.push(n > 1 ? 'hide' : 'out');
          if (g.serial >= lo && g.serial <= hi) cls.push('sel');
          if (g.serial === today) cls.push('today');
          if (g.serial < st.min || g.serial > st.max) cls.push('off');
          return h('span', { class: cls.join(' '), dataset: { serial: String(g.serial) } }, String(dateParts(g.serial).d));
        });
        rows.push(h('div', { class: 'mv-row' }, ...(st.weekNumbers ? [h('span', { class: 'mv-wk' }, String(weekNumberOf(grid[r * 7].serial)))] : []), ...days));
      }
      blocks.push(h('div', { class: 'mv-month' }, title, ...rows));
    }
    const months = h('div', { class: 'mv-months', style: { gridTemplateColumns: `repeat(${st.cols}, auto)` } }, ...blocks);
    const foot = st.showToday ? h('div', { class: 'mv-today' }, h('span', { class: 'mv-todaybox' }), `Today: ${todayText()}`) : '';
    el.replaceChildren(months, foot);
  }

  /** The selection classes only (a repaint under the mouse would lose the click). */
  function paintSel(): void {
    const lo = Math.min(st.start, st.end), hi = Math.max(st.start, st.end);
    el.querySelectorAll<HTMLElement>('.mv-d').forEach(d => { const s = Number(d.dataset.serial); d.classList.toggle('sel', s >= lo && s <= hi); });
  }

  /** The user selects a..b (a single day when the control is not MultiSelect). */
  function choose(a: number, b: number): void {
    b = clampDate(b, st.min, st.max);
    let lo = Math.min(a, b), hi = Math.max(a, b);
    if (!st.multi) { lo = hi = b; }
    else if (hi - lo + 1 > st.maxSel) { if (b >= a) hi = lo + st.maxSel - 1; else lo = hi - st.maxSel + 1; }
    lastDay = b;
    if (lo === st.start && hi === st.end) return;
    st = { ...st, start: lo, end: hi };
    hooks.select(lo, hi);
    if (!inView(b)) { show(b); paint(); } else paintSel();
  }

  function navigate(delta: number): void {
    const { y, m } = addMonths(vy, vm, delta);
    if (y < 1601 || y > 9999) return;
    vy = y; vm = m;
    paint();
  }

  if (interactive) {
    el.addEventListener('mousedown', e => {
      if (e.button !== 0) return;
      const nav = (e.target as Element).closest<HTMLElement>('.mv-nav');
      if (nav) { e.preventDefault(); navigate(Number(nav.dataset.nav)); return; }
      const d = isDay(e.target as Element);
      if (!d) return;
      const s = Number(d.dataset.serial);
      anchor = e.shiftKey && st.multi ? st.start : s;
      dragging = true;
      choose(anchor, s);
      el.ownerDocument.addEventListener('mouseup', () => {
        if (!dragging) return;
        dragging = false;
        hooks.click(lastDay);
      }, { once: true });
    });
    el.addEventListener('mouseover', e => {
      if (!dragging || !st.multi) return;
      const d = isDay(e.target as Element);
      if (d) choose(anchor, Number(d.dataset.serial));
    });
    el.addEventListener('dblclick', e => {
      const d = isDay(e.target as Element);
      hooks.dblclick(d ? Number(d.dataset.serial) : st.start);
    });
  }

  return {
    el,
    set(s) {
      const changed = first || s.start !== st.start || s.rows * s.cols !== st.rows * st.cols;
      st = s;
      if (changed && (first || !inView(s.start))) show(s.start);
      first = false;
      paint();
    },
    key(e) {
      const cur = st.multi && e.shiftKey ? st.end : st.start;
      const p = dateParts(cur);
      let to: number;
      switch (e.key) {
        case 'ArrowLeft': to = cur - 1; break;
        case 'ArrowRight': to = cur + 1; break;
        case 'ArrowUp': to = cur - 7; break;
        case 'ArrowDown': to = cur + 7; break;
        case 'PageUp': case 'PageDown': {
          const { y, m } = addMonths(p.y, p.m, e.key === 'PageUp' ? -1 : 1);
          to = withDate(0, y, m, Math.min(p.d, daysInMonth(y, m)));
          break;
        }
        case 'Home': to = withDate(0, p.y, p.m, 1); break;
        case 'End': to = withDate(0, p.y, p.m, daysInMonth(p.y, p.m)); break;
        default: return false;
      }
      choose(st.multi && e.shiftKey ? st.start : to, to);
      return true;
    },
  };
}

// ---------------------------------------------------------------------------------------------------------------
// MonthView

/** MonthView: the calendar (Value / SelStart / SelEnd, MinDate, MaxDate, StartOfWeek, ShowToday, ShowWeekNumbers, MonthRows, MonthColumns,
 *  MultiSelect, MaxSelCount). Run mode: a click on a day selects it and dispatches `vbmvselect` ({ start, end }) when the selection changed,
 *  then `vbdateclick` ({ serial }). */
export function monthView(c: Ctx): Renderer {
  let root: HTMLElement, cal: Calendar;
  const state = (): CalState => {
    const v = dateProp(c, 'Value') ?? nowSerial(true);
    const s = dateProp(c, 'SelStart') ?? v, e = dateProp(c, 'SelEnd') ?? s;
    return {
      start: dayOf(s), end: dayOf(e), min: dayOf(dateProp(c, 'MinDate') ?? MIN_DATE), max: dayOf(dateProp(c, 'MaxDate') ?? MAX_DATE),
      startOfWeek: c.num('StartOfWeek') || 1, showToday: c.bool('ShowToday'), weekNumbers: c.bool('ShowWeekNumbers'),
      rows: Math.max(1, c.num('MonthRows')), cols: Math.max(1, c.num('MonthColumns')), multi: c.bool('MultiSelect'), maxSel: Math.max(1, c.num('MaxSelCount')),
    };
  };
  return {
    build() {
      cal = createCalendar(c.mode === 'run', {
        select: (a, b) => { c.props.SelStart = a; c.props.SelEnd = b; c.props.Value = a; c.fire('vbmvselect', { start: a, end: b }); },
        click: serial => c.fire('vbdateclick', { serial }),
        dblclick: serial => c.fire('vbdatedblclick', { serial }),
      });
      root = h('div', { class: 'vb-mv', tabindex: '0' }, cal.el);
      c.el.replaceChildren(root);
      c.setInput(root);
      if (c.mode === 'run') root.addEventListener('keydown', e => { if (cal.key(e)) e.preventDefault(); });
    },
    patch(k) {
      if (has(k, 'Value', 'SelStart', 'SelEnd', 'MinDate', 'MaxDate', 'StartOfWeek', 'ShowToday', 'ShowWeekNumbers', 'MonthRows', 'MonthColumns', 'MultiSelect', 'MaxSelCount')) cal.set(state());
    },
    bg: () => null,
  };
}

// ---------------------------------------------------------------------------------------------------------------
// DTPicker

/** DTPicker: the fields of the date (Format / CustomFormat), a CheckBox, and a drop-down calendar or UpDown arrows. Run mode: the
 *  Up and Down keys and the digits edit the field that is current, a click on a field makes it current; every change of Value dispatches
 *  `change` (dataset.value). The drop-down dispatches `vbdropdown` and `vbcloseup`. */
export function dtPicker(c: Ctx): Renderer {
  let root: HTMLElement, fieldsEl: HTMLElement, chk: HTMLElement | null, pop: HTMLElement, cal: Calendar;
  let value: number | null = null, last = nowSerial();
  let active = 0, count = 0, buf = '', open = false;
  const doc = () => c.el.ownerDocument;
  const min = () => dateProp(c, 'MinDate') ?? MIN_DATE, max = () => dateProp(c, 'MaxDate') ?? MAX_DATE;
  const segs = () => dtSegments(c.num('Format'), c.str('CustomFormat'), LOCALE);
  const checked = () => !c.bool('CheckBox') || value !== null;

  function paintFields(): void {
    const shown = value ?? last;
    let fi = 0;
    const nodes = segs().map(s => 'lit' in s ? h('span', { class: 'dtp-l' }, s.lit)
      : h('span', { class: `dtp-f${fi === active ? ' sel' : ''}`, dataset: { f: String(fi++), tok: s.tok } }, fieldText(s.tok, shown, LOCALE)));
    count = fi;
    active = Math.max(0, Math.min(active, count - 1));
    fieldsEl.replaceChildren(...nodes);
    fieldsEl.classList.toggle('dtp-off', !checked());
    chk?.classList.toggle('on', value !== null);
  }

  function setValue(v: number | null, user: boolean): void {
    if (v !== null) { v = clampDate(v, min(), max()); last = v; }
    if (v === value) return;
    value = v;
    c.props.Value = v;
    root.dataset.value = v === null ? '' : String(v);
    paintFields();
    if (user) c.fire('change');
  }

  const calState = (): CalState => {
    const d = dayOf(value ?? last);
    return { start: d, end: d, min: dayOf(min()), max: dayOf(max()), startOfWeek: systemStartOfWeek(LOCALE), showToday: true, weekNumbers: false, rows: 1, cols: 1, multi: false, maxSel: 1 };
  };
  const onOutside = (e: Event) => { if (!c.el.contains(e.target as Node)) closePop(); };
  function openPop(): void {
    if (c.mode !== 'run' || open || !checked()) return;
    open = true;
    cal.set(calState());
    pop.classList.add('open');
    doc().addEventListener('mousedown', onOutside, true);
    c.fire('vbdropdown');
  }
  function closePop(): void {
    if (!open) return;
    open = false;
    pop.classList.remove('open');
    doc().removeEventListener('mousedown', onOutside, true);
    c.fire('vbcloseup');
  }

  const fieldTok = (): string => (fieldsEl.querySelector<HTMLElement>(`.dtp-f[data-f="${active}"]`)?.dataset.tok) ?? '';
  function step(dir: number): void {
    if (value === null) return;
    const tok = fieldTok();
    if (tok) setValue(adjustField(value, tok, dir), true);
  }
  const MAXV: Record<string, number> = { d: 31, M: 12, y: 99, h: 12, H: 23, m: 59, s: 59 };
  function digit(ch: string): void {
    const tok = fieldTok(), digits = fieldDigits(tok);
    if (value === null || !tok || !digits) return;
    const tryApply = (text: string): boolean => { const v = typeField(value!, tok, Number(text)); if (v === null) return false; setValue(v, true); return true; };
    let text = buf + ch;
    if (!tryApply(text)) { text = ch; if (!tryApply(text)) { buf = ''; return; } }
    const lim = tok === 'yyyy' ? 9999 : MAXV[tok[0]] ?? 99;
    if (text.length >= digits || Number(text) * 10 > lim) { buf = ''; active = Math.min(count - 1, active + 1); paintFields(); } else buf = text;
  }

  return {
    structural: ['UpDown', 'CheckBox'],
    build() {
      if (open) closePop();
      chk = c.bool('CheckBox') ? h('span', { class: 'dtp-chk' }) : null;
      fieldsEl = h('div', { class: 'dtp-fields' });
      const up = h('div', { class: 'ud-btn up' }), down = h('div', { class: 'ud-btn down' });
      const btn = c.bool('UpDown') ? h('div', { class: 'dtp-spin' }, up, down) : h('div', { class: 'vb-combo-btn dtp-btn' }, h('span', { class: 'vb-glyph' }));
      cal = createCalendar(c.mode === 'run', {
        select: start => { const p = dateParts(start); setValue(withDate(value ?? last, p.y, p.m, p.d), true); },
        click: () => { closePop(); root.focus(); },
        dblclick: () => { /* the first click closed the calendar */ },
      });
      pop = h('div', { class: 'dtp-pop' }, cal.el);
      root = h('div', { class: 'vb-dtp', tabindex: '0', role: 'combobox' }, ...(chk ? [chk] : []), fieldsEl, btn);
      c.el.replaceChildren(root, pop);
      c.setInput(root);
      value = dateProp(c, 'Value');
      if (value !== null) last = value;
      root.dataset.value = value === null ? '' : String(value);
      if (c.mode !== 'run') return;
      const dis = () => root.getAttribute('aria-disabled') === 'true';
      chk?.addEventListener('mousedown', e => { e.preventDefault(); if (dis()) return; root.focus(); setValue(value === null ? last : null, true); });
      fieldsEl.addEventListener('mousedown', e => {
        const f = (e.target as Element).closest<HTMLElement>('.dtp-f');
        if (dis()) return;
        e.preventDefault();
        root.focus();
        if (f) { active = Number(f.dataset.f); buf = ''; paintFields(); }
      });
      if (c.bool('UpDown')) {
        for (const [b, dir] of [[up, 1], [down, -1]] as const) b.addEventListener('mousedown', e => { e.preventDefault(); if (dis()) return; root.focus(); step(dir); });
      } else btn.addEventListener('mousedown', e => { e.preventDefault(); if (dis()) return; root.focus(); open ? closePop() : openPop(); });
      root.addEventListener('keydown', e => {
        if (dis()) return;
        if (open) {
          if (e.key === 'Escape' || e.key === 'Enter' || e.key === 'F4') { e.preventDefault(); e.stopPropagation(); closePop(); }
          else if (cal.key(e)) e.preventDefault();
          return;
        }
        if (e.key === 'F4' || (e.altKey && e.key === 'ArrowDown')) { e.preventDefault(); if (!c.bool('UpDown')) openPop(); }
        else if (e.key === 'ArrowUp' || e.key === 'ArrowDown') { e.preventDefault(); step(e.key === 'ArrowUp' ? 1 : -1); }
        else if (e.key === 'ArrowLeft' || e.key === 'ArrowRight') {
          e.preventDefault();
          buf = '';
          active = Math.max(0, Math.min(count - 1, active + (e.key === 'ArrowRight' ? 1 : -1)));
          paintFields();
        } else if (e.key === ' ' && chk) { e.preventDefault(); setValue(value === null ? last : null, true); }
        else if (/^\d$/.test(e.key) && !e.ctrlKey && !e.metaKey && !e.altKey) { e.preventDefault(); digit(e.key); }
      });
      root.addEventListener('blur', () => { buf = ''; });
    },
    patch(k) {
      if (has(k, 'Value', 'MinDate', 'MaxDate')) {
        const v = dateProp(c, 'Value');
        value = v === null ? null : clampDate(v, min(), max());
        if (value !== null) last = value;
        root.dataset.value = value === null ? '' : String(value);
        if (open) cal.set(calState());
      }
      if (has(k, 'Value', 'MinDate', 'MaxDate', 'Format', 'CustomFormat', 'CheckBox', 'UpDown')) {
        paintFields();
      }
    },
    bg: () => null,
  };
}

// ---------------------------------------------------------------------------------------------------------------
// MaskedEdit

/** MaskedEdit: a text field that follows its Mask. `Text` is the display string (literals, entries, PromptChar for empty positions). In run
 *  mode the characters typed arrive as `vbmaskkey` ({ ascii }: formWindow routes them here after KeyPress) and are put in by model/mask.ts;
 *  the text is changed by `input` events, a character that does not fit dispatches `vbvalidationerror` ({ text, pos }) and a full mask with
 *  AutoTab dispatches `vbautotab`. */
export function maskedEdit(c: Ctx): Renderer {
  let input: HTMLInputElement;
  const mask = () => c.str('Mask');
  const prompt = () => c.str('PromptChar').charAt(0) || '_';
  const slots = () => parseMask(mask());
  const display = (): string => fitText(mask(), prompt(), c.str('Text'));
  const focused = () => c.el.ownerDocument.activeElement === input;
  function show(): void {
    const d = display();
    const fmt = c.str('Format');
    const text = c.mode === 'run' && fmt !== '' && !focused() ? formatValue(mask() ? clipText(slots(), d, prompt()) : d, fmt, LOCALE) : d;
    if (input.value !== text) {
      input.value = text;
      if (mask() && c.mode === 'run') input.setSelectionRange(0, 0);   // typing starts at the first position
    }
  }

  /** Puts the result of an edit in the field; the `input` event carries it to the program. */
  function apply(r: TypeResult, was: string): void {
    const s = slots();
    if (r.error) c.fire('vbvalidationerror', { text: r.error.text, pos: r.error.pos });
    if (r.text === was) { input.setSelectionRange(r.caret, r.caret); return; }
    c.props.Text = r.text;
    input.value = r.text;
    input.setSelectionRange(r.caret, r.caret);
    input.dispatchEvent(new Event('input', { bubbles: true }));
    if (c.bool('AutoTab') && r.caret >= s.length && isComplete(s, r.text, prompt())) c.fire('vbautotab');
  }
  const sel = () => ({ pos: input.selectionStart ?? 0, len: Math.max(0, (input.selectionEnd ?? 0) - (input.selectionStart ?? 0)) });

  function typeText(text: string): void {
    const s = slots();
    const was = display();
    let { pos, len } = sel();
    let r: TypeResult = { text: was, caret: pos };
    for (const ch of text) {
      r = typeChar(s, r.text, prompt(), pos, len, ch, c.bool('AllowPrompt'));
      if (r.error) c.fire('vbvalidationerror', { text: r.error.text, pos: r.error.pos });
      pos = r.caret; len = 0;
    }
    apply({ text: r.text, caret: r.caret }, was);
  }

  return {
    build() {
      input = h('input', { type: 'text', class: 'vb-input vb-single', spellcheck: false, autocomplete: 'off' });
      c.el.replaceChildren(input);
      c.setInput(input);
      if (c.mode !== 'run') return;
      input.addEventListener('vbmaskkey', e => {
        const ascii = (e as CustomEvent<{ ascii: number }>).detail.ascii;
        const s = slots(), was = display(), { pos, len } = sel();
        if (ascii === 8) apply(backspace(s, was, prompt(), pos, len), was);
        else if (ascii >= 32 && ascii !== 127) typeText(String.fromCharCode(ascii));
      });
      input.addEventListener('keydown', e => {
        if (e.key !== 'Delete' || !mask()) return;
        e.preventDefault();
        const was = display(), { pos, len } = sel();
        apply(deleteForward(slots(), was, prompt(), pos, len), was);
      });
      input.addEventListener('paste', e => {
        if (!mask()) return;
        e.preventDefault();
        typeText(e.clipboardData?.getData('text') ?? '');
      });
      input.addEventListener('cut', e => {
        if (!mask()) return;
        e.preventDefault();
        const was = display(), { pos, len } = sel();
        e.clipboardData?.setData('text/plain', was.slice(pos, pos + len));
        if (len > 0) apply({ text: clearRange(slots(), was, prompt(), pos, pos + len), caret: pos }, was);
      });
      input.addEventListener('beforeinput', e => { if (mask()) e.preventDefault(); });   // drops, IME: only the mask puts characters in
      input.addEventListener('focus', show);
      input.addEventListener('blur', show);
    },
    patch(k) {
      if (has(k, 'Mask')) { if (mask()) input.dataset.mask = '1'; else delete input.dataset.mask; }
      if (has(k, 'Mask', 'MaxLength')) {
        if (!mask() && c.num('MaxLength') > 0) input.maxLength = c.num('MaxLength'); else input.removeAttribute('maxlength');
      }
      if (has(k, 'Text', 'Mask', 'PromptChar', 'Format')) show();
      if (has(k, 'BorderStyle')) c.el.classList.toggle('vb-bordered', c.num('BorderStyle') === 1);
      if (has(k, 'HideSelection')) input.classList.toggle('keep-sel', !c.bool('HideSelection'));
    },
  };
}
