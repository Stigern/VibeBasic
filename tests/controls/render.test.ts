// @vitest-environment jsdom
import { afterEach, describe, expect, test, vi } from 'vitest';
import { CONTROL_TYPES } from '../../src/model/controls';
import type { ControlDef, ControlType, FormDef, PropValue } from '../../src/model/types';
import { formMetrics, formScaleSize, renderControl, renderFormSurface, type AssetResolver } from '../../src/controls/render';

afterEach(() => { document.body.innerHTML = ''; });

const none: AssetResolver = () => null;
const PIC = 'data:image/png;base64,AAAA';
const withPic: AssetResolver = ref => (ref.asset === 'pic' ? PIC : null);

let n = 0;
/** A control with the registry defaults for its design-time props, overridden by `props`. */
function mk(type: Exclude<ControlType, 'Form'>, props: Record<string, PropValue> = {}, extra: Partial<ControlDef> = {}): ControlDef {
  const base: Record<string, PropValue> = {};
  for (const pd of CONTROL_TYPES[type].props) if (pd.designTime) base[pd.name] = pd.default;
  n++;
  return { id: `id${n}`, type, name: `${type}${n}`, index: null, parentId: null, props: { ...base, ...props }, ...extra };
}
const cmd = (p: Record<string, PropValue> = {}) => mk('CommandButton', p);
const lbl = (p: Record<string, PropValue> = {}) => mk('Label', p);
const txt = (p: Record<string, PropValue> = {}) => mk('TextBox', p);
const tmr = (p: Record<string, PropValue> = {}) => mk('Timer', p);
const pb = (p: Record<string, PropValue> = {}) => mk('ProgressBar', p);

function form(controls: ControlDef[], props: Record<string, PropValue> = {}): FormDef {
  const base: Record<string, PropValue> = {};
  for (const pd of CONTROL_TYPES.Form.props) if (pd.designTime) base[pd.name] = pd.default;
  return { id: 'form1', name: 'Form1', props: { ...base, Caption: 'Form1', ...props }, controls, code: '' };
}

const ALL_TYPES = (Object.keys(CONTROL_TYPES) as ControlType[]).filter((t): t is Exclude<ControlType, 'Form'> => t !== 'Form');

describe('brief', () => {
  test('position in px', () => {
    const v = renderControl(cmd({ Left: 150, Top: 300, Width: 1215, Height: 495 }), 'run', none);
    expect(v.el.style.left).toBe('10px'); expect(v.el.style.top).toBe('20px');
    expect(v.el.style.width).toBe('81px'); expect(v.el.style.height).toBe('33px');
  });
  test('progressbar fill', () => {
    const v = renderControl(pb({ Min: 0, Max: 200, Value: 50 }), 'run', none);
    expect((v.el.querySelector('.pb-fill') as HTMLElement).style.width).toBe('25%');
  });
  test('update caption', () => {
    const v = renderControl(cmd({ Caption: 'A' }), 'run', none);
    v.update({ Caption: 'B' });
    expect(v.el.textContent).toBe('B');
  });
  test('design mode textbox not focusable', () => {
    const v = renderControl(txt({}), 'design', none);
    expect(v.inputEl!.tabIndex).toBe(-1);
    expect(v.inputEl!.style.pointerEvents).toBe('none');
  });
  test('timer hidden at runtime', () => expect(renderControl(tmr({}), 'run', none).el.style.display).toBe('none'));
  test('frame hosts children', () => {
    const frame = mk('Frame', {}, { id: 'Frame1' });
    const c = mk('CommandButton', {}, { id: 'Command1', parentId: 'Frame1' });
    const s = renderFormSurface(form([frame, c]), 'run', none);
    expect(s.views.get('Command1')!.el.parentElement).toBe(s.views.get('Frame1')!.childHost);
    expect(s.views.get('Frame1')!.el.parentElement).toBe(s.clientEl);
  });
  test('backcolor', () => expect(renderControl(lbl({ BackColor: 0xff }), 'run', none).el.style.backgroundColor).toBe('rgb(255, 0, 0)'));
});

describe('every control type', () => {
  test.each(ALL_TYPES)('%s renders in both modes with id and absolute position', type => {
    for (const mode of ['design', 'run'] as const) {
      const def = mk(type, type === 'Line' ? { X1: 300, Y1: 150, X2: 600, Y2: 450 } : { Left: 300, Top: 150 });
      const v = renderControl(def, mode, none);
      expect(v.el.dataset.controlId).toBe(def.id);
      expect(v.el.classList.contains('vb-ctl')).toBe(true);
      expect(v.el.classList.contains(`vb-${type}`)).toBe(true);
      expect(v.el.classList.contains(`vb-${mode}`)).toBe(true);
      expect(v.el.style.left).toBe('20px'); expect(v.el.style.top).toBe('10px');
      expect(typeof v.update).toBe('function');
    }
  });
  test.each(ALL_TYPES)('%s renders with no props at all (registry defaults)', type => {
    const v = renderControl({ id: 'x', type, name: 'x', index: null, parentId: null, props: {} }, 'run', none);
    expect(v.el.dataset.controlId).toBe('x');
  });
  test('Frame, PictureBox, SSPanel and SSFrame expose childHost; others do not', () => {
    for (const t of ALL_TYPES) {
      const v = renderControl(mk(t), 'run', none);
      expect(!!v.childHost).toBe(t === 'Frame' || t === 'PictureBox' || t === 'SSPanel' || t === 'SSFrame');
    }
  });
  test('interactive element exposed as inputEl', () => {
    const tag = (t: Exclude<ControlType, 'Form'>) => renderControl(mk(t), 'run', none).inputEl?.tagName;
    expect(tag('CommandButton')).toBe('BUTTON');
    expect(tag('TextBox')).toBe('INPUT');
    expect(tag('CheckBox')).toBe('INPUT');
    expect(tag('OptionButton')).toBe('INPUT');
    expect(tag('ListBox')).toBe('SELECT');
    expect(tag('ComboBox')).toBe('INPUT');
    expect(renderControl(mk('TextBox', { MultiLine: true }), 'run', none).inputEl!.tagName).toBe('TEXTAREA');
    expect(renderControl(mk('HScrollBar'), 'run', none).inputEl).toBeTruthy();
    expect(renderControl(mk('Label'), 'run', none).inputEl).toBeUndefined();
  });
  test('update does not mutate the definition', () => {
    const def = cmd({ Caption: 'A' });
    renderControl(def, 'run', none).update({ Caption: 'B' });
    expect(def.props.Caption).toBe('A');
  });
});

describe('design vs run', () => {
  test('design: inner elements non-interactive, run: interactive', () => {
    for (const t of ['CommandButton', 'TextBox', 'CheckBox', 'OptionButton', 'ListBox', 'ComboBox', 'HScrollBar', 'VScrollBar'] as const) {
      const d = renderControl(mk(t), 'design', none);
      expect(d.inputEl!.tabIndex, t).toBe(-1);
      expect(d.inputEl!.style.pointerEvents, t).toBe('none');
      const r = renderControl(mk(t), 'run', none);
      expect(r.inputEl!.style.pointerEvents, t).toBe('');
      expect(r.inputEl!.tabIndex, t).toBeGreaterThanOrEqual(0);
    }
  });
  test('design: Visible=False and Enabled=False still look normal (VB designer); run: hidden / disabled', () => {
    const d = renderControl(cmd({ Visible: false, Enabled: false }), 'design', none);
    expect(d.el.style.display).not.toBe('none');
    expect(d.inputEl!.hasAttribute('disabled')).toBe(false);
    const r = renderControl(cmd({ Visible: false, Enabled: false }), 'run', none);
    expect(r.el.style.display).toBe('none');
    expect((r.inputEl as HTMLButtonElement).disabled).toBe(true);
    expect(r.el.classList.contains('vb-disabled')).toBe(true);
  });
  test('update Visible / Enabled in run mode', () => {
    const v = renderControl(txt(), 'run', none);
    v.update({ Visible: false });
    expect(v.el.style.display).toBe('none');
    v.update({ Visible: true });
    expect(v.el.style.display).toBe('');
    v.update({ Enabled: false });
    expect((v.inputEl as HTMLInputElement).disabled).toBe(true);
    v.update({ Enabled: true });
    expect((v.inputEl as HTMLInputElement).disabled).toBe(false);
  });
  test('TabStop=False removes from the tab order in run mode; ToolTipText becomes title', () => {
    const v = renderControl(cmd({ TabStop: false, ToolTipText: 'Tip' }), 'run', none);
    expect(v.inputEl!.tabIndex).toBe(-1);
    expect(v.el.title).toBe('Tip');
  });
  test('timer is a 28x28 icon in design mode and ignores Width/Height', () => {
    const v = renderControl(tmr({ Left: 150, Top: 300 }), 'design', none);
    expect(v.el.style.width).toBe('28px'); expect(v.el.style.height).toBe('28px');
    expect(v.el.style.left).toBe('10px'); expect(v.el.style.top).toBe('20px');
    expect(v.el.style.display).not.toBe('none');
    expect(v.el.querySelector('svg')).toBeTruthy();
  });
  test('timer update: Left moves it, Enabled does not hide it in design', () => {
    const v = renderControl(tmr(), 'design', none);
    v.update({ Left: 300, Enabled: false });
    expect(v.el.style.left).toBe('20px');
    expect(v.el.style.display).not.toBe('none');
  });
});

describe('common property updates', () => {
  test('Left/Top/Width/Height', () => {
    const v = renderControl(cmd(), 'run', none);
    v.update({ Left: 30, Top: 45, Width: 150, Height: 300 });
    expect([v.el.style.left, v.el.style.top, v.el.style.width, v.el.style.height]).toEqual(['2px', '3px', '10px', '20px']);
  });
  test('Font: MS Sans Serif maps to the pixel font; size in points becomes px; styles', () => {
    const v = renderControl(lbl(), 'run', none);
    v.update({ Font: { name: 'MS Sans Serif', size: 8, bold: true, italic: true, underline: true } });
    expect(v.el.style.fontFamily).toContain('Pixelated MS Sans Serif');
    expect(v.el.style.fontSize).toBe('11px');
    expect(v.el.style.fontWeight).toBe('700');
    expect(v.el.style.fontStyle).toBe('italic');
    expect(v.el.style.textDecoration).toContain('underline');
    v.update({ Font: { name: 'Courier New', size: 12, bold: false, italic: false, underline: false } });
    expect(v.el.style.fontFamily).toContain('Courier New');
    expect(v.el.style.fontFamily).toContain('Pixelated MS Sans Serif');   // fallback kept
    expect(v.el.style.fontSize).toBe('16px');
    expect(v.el.style.fontWeight).toBe('400');
  });
  test('ForeColor and BackColor (signed and system colours)', () => {
    const v = renderControl(txt(), 'run', none);
    v.update({ ForeColor: 0xff0000, BackColor: 0x80000005 | 0 });
    expect(v.el.style.color).toBe('rgb(0, 0, 255)');           // BGR 0xff0000 is blue
    expect(v.el.style.backgroundColor).toBe('rgb(255, 255, 255)');
    v.update({ BackColor: 0x8000000f | 0 });
    expect(v.el.style.backgroundColor).toBe('rgb(192, 192, 192)');
  });
});

describe('CommandButton', () => {
  test('Default gets the default class (thick black frame)', () => {
    const v = renderControl(cmd({ Default: true }), 'run', none);
    expect(v.inputEl!.classList.contains('default')).toBe(true);
    v.update({ Default: false });
    expect(v.inputEl!.classList.contains('default')).toBe(false);
  });
  test('& mnemonic is underlined, textContent has no ampersand', () => {
    const v = renderControl(cmd({ Caption: '&Save' }), 'run', none);
    expect(v.el.textContent).toBe('Save');
    expect(v.el.querySelector('u')!.textContent).toBe('S');
  });
  test('BackColor only applies to the Graphical style; Picture shows as background', () => {
    const v = renderControl(cmd({ BackColor: 0xff }), 'run', withPic);
    expect(v.inputEl!.style.backgroundColor).toBe('');
    v.update({ Style: 1 });
    expect(v.inputEl!.style.backgroundColor).toBe('rgb(255, 0, 0)');
    v.update({ Picture: { asset: 'pic' } });
    expect(v.inputEl!.style.backgroundImage).toContain(PIC);
  });
});

describe('Label', () => {
  test('Caption, Alignment, WordWrap, BorderStyle, BackStyle', () => {
    const v = renderControl(lbl({ Caption: 'Hello' }), 'run', none);
    expect(v.el.textContent).toBe('Hello');
    v.update({ Alignment: 1 }); expect(v.el.style.textAlign).toBe('right');
    v.update({ Alignment: 2 }); expect(v.el.style.textAlign).toBe('center');
    v.update({ Alignment: 0 }); expect(v.el.style.textAlign).toBe('left');
    v.update({ BorderStyle: 1 }); expect(v.el.classList.contains('vb-bordered')).toBe(true);
    v.update({ BorderStyle: 0 }); expect(v.el.classList.contains('vb-bordered')).toBe(false);
    v.update({ BackStyle: 0, BackColor: 0xff }); expect(v.el.style.backgroundColor).toBe('transparent');
    v.update({ BackStyle: 1 }); expect(v.el.style.backgroundColor).toBe('rgb(255, 0, 0)');
    v.update({ WordWrap: true }); expect(v.el.classList.contains('vb-wrap')).toBe(true);
  });
  test('AutoSize lets the browser size the label', () => {
    const v = renderControl(lbl({ AutoSize: true, Width: 1215, Height: 255 }), 'run', none);
    expect(v.el.style.width).toBe('auto');
    expect(v.el.style.height).toBe('auto');
    v.update({ AutoSize: false });
    expect(v.el.style.width).toBe('81px');
  });
  test('moving an AutoSize label keeps it auto-sized', () => {
    const v = renderControl(lbl({ AutoSize: true, Width: 1215, Height: 255 }), 'run', none);
    v.update({ Left: 300, Top: 150 });
    expect(v.el.style.left).toBe('20px');
    expect(v.el.style.width).toBe('auto');
    expect(v.el.style.height).toBe('auto');
  });
  test('"&&" renders a literal ampersand', () => {
    expect(renderControl(lbl({ Caption: 'a && b' }), 'run', none).el.textContent).toBe('a & b');
  });
  test('Enabled=False in run mode greys it', () => {
    const v = renderControl(lbl({ Enabled: false }), 'run', none);
    expect(v.el.classList.contains('vb-disabled')).toBe(true);
  });
});

describe('TextBox', () => {
  test('Text goes into the input, update changes it', () => {
    const v = renderControl(txt({ Text: 'abc' }), 'run', none);
    expect((v.inputEl as HTMLInputElement).value).toBe('abc');
    v.update({ Text: 'xyz' });
    expect((v.inputEl as HTMLInputElement).value).toBe('xyz');
  });
  test('update with the same Text keeps the same element (focus is not lost)', () => {
    const v = renderControl(txt({ Text: 'abc' }), 'run', none);
    const el = v.inputEl;
    v.update({ Text: 'abcd', ForeColor: 0 });
    expect(v.inputEl).toBe(el);
  });
  test('MultiLine renders a textarea with scroll bars per ScrollBars; toggling rebuilds inputEl', () => {
    const v = renderControl(txt({ MultiLine: true, Text: 'a\r\nb', ScrollBars: 2 }), 'run', none);
    const ta = v.inputEl as HTMLTextAreaElement;
    expect(ta.tagName).toBe('TEXTAREA');
    expect(ta.value).toBe('a\nb');   // the DOM normalises CRLF to LF; plan 03 converts back to vbCrLf
    expect(ta.style.overflowY).toBe('scroll'); expect(ta.style.overflowX).toBe('hidden');
    v.update({ ScrollBars: 3 });
    expect(v.inputEl!.style.overflowX).toBe('scroll');
    v.update({ ScrollBars: 0 });
    expect(v.inputEl!.style.overflowY).toBe('hidden');
    v.update({ MultiLine: false });
    expect(v.inputEl!.tagName).toBe('INPUT');
  });
  test('PasswordChar, MaxLength, Locked, Alignment, BorderStyle', () => {
    const v = renderControl(txt({ PasswordChar: '*', MaxLength: 5, Locked: true, Alignment: 2 }), 'run', none);
    const i = v.inputEl as HTMLInputElement;
    expect(i.type).toBe('password'); expect(i.maxLength).toBe(5); expect(i.readOnly).toBe(true); expect(i.style.textAlign).toBe('center');
    v.update({ PasswordChar: '', MaxLength: 0, Locked: false });
    expect(v.inputEl!.getAttribute('type')).toBe('text'); expect((v.inputEl as HTMLInputElement).maxLength).toBe(-1);
    expect((v.inputEl as HTMLInputElement).readOnly).toBe(false);
    expect(v.el.classList.contains('vb-bordered')).toBe(true);
    v.update({ BorderStyle: 0 });
    expect(v.el.classList.contains('vb-bordered')).toBe(false);
  });
});

describe('CheckBox and OptionButton', () => {
  test('CheckBox Value 0/1/2', () => {
    const v = renderControl(mk('CheckBox', { Caption: 'Chk' }), 'run', none);
    const i = v.inputEl as HTMLInputElement;
    expect(v.el.textContent).toBe('Chk');
    expect(i.type).toBe('checkbox'); expect(i.checked).toBe(false); expect(i.indeterminate).toBe(false);
    v.update({ Value: 1 }); expect(i.checked).toBe(true); expect(i.indeterminate).toBe(false);
    v.update({ Value: 2 }); expect(i.indeterminate).toBe(true);
    v.update({ Value: 0 }); expect(i.checked).toBe(false); expect(i.indeterminate).toBe(false);
  });
  test('CheckBox Alignment=1 puts the box on the right', () => {
    const v = renderControl(mk('CheckBox', { Alignment: 1 }), 'run', none);
    expect(v.el.classList.contains('vb-right')).toBe(true);
    v.update({ Alignment: 0 });
    expect(v.el.classList.contains('vb-right')).toBe(false);
  });
  test('OptionButton Value true/false; Caption', () => {
    const v = renderControl(mk('OptionButton', { Caption: 'Opt', Value: true }), 'run', none);
    const i = v.inputEl as HTMLInputElement;
    expect(i.type).toBe('radio'); expect(i.checked).toBe(true); expect(v.el.textContent).toBe('Opt');
    v.update({ Value: false, Caption: 'Z' }); expect(i.checked).toBe(false); expect(v.el.textContent).toBe('Z');
  });
  test('design-mode CheckBox still shows its Value', () => {
    const v = renderControl(mk('CheckBox', { Value: 1 }), 'design', none);
    expect((v.inputEl as HTMLInputElement).checked).toBe(true);
  });
});

describe('Frame', () => {
  test('legend shows Caption; BorderStyle None hides the box; BackColor', () => {
    const v = renderControl(mk('Frame', { Caption: 'Group' }), 'run', none);
    expect(v.el.querySelector('legend, .vb-frame-legend')!.textContent).toBe('Group');
    v.update({ Caption: 'New' });
    expect(v.el.querySelector('.vb-frame-legend')!.textContent).toBe('New');
    v.update({ BorderStyle: 0 });
    expect(v.el.classList.contains('vb-noborder')).toBe(true);
    v.update({ BackColor: 0xff });
    expect(v.el.style.backgroundColor).toBe('rgb(255, 0, 0)');
  });
});

describe('ListBox', () => {
  test('List becomes options; ListIndex selects; MultiSelect', () => {
    const v = renderControl(mk('ListBox', { List: ['a', 'b', 'c'] }), 'run', none);
    const s = v.inputEl as HTMLSelectElement;
    expect([...s.options].map(o => o.textContent)).toEqual(['a', 'b', 'c']);
    expect(s.multiple).toBe(false);
    v.update({ ListIndex: 1 }); expect(s.selectedIndex).toBe(1);
    v.update({ ListIndex: -1 }); expect(s.selectedIndex).toBe(-1);
    v.update({ List: ['x'] }); expect(s.options.length).toBe(1);
    v.update({ MultiSelect: 2 }); expect((v.inputEl as HTMLSelectElement).multiple).toBe(true);
  });
  test('Sorted sorts the options', () => {
    const v = renderControl(mk('ListBox', { List: ['b', 'c', 'a'], Sorted: true }), 'run', none);
    expect([...(v.inputEl as HTMLSelectElement).options].map(o => o.textContent)).toEqual(['a', 'b', 'c']);
  });
});

describe('ComboBox', () => {
  test('Dropdown Combo: editable input + arrow button, Text applied', () => {
    const v = renderControl(mk('ComboBox', { Text: 'hi', List: ['a', 'b'] }), 'run', none);
    const i = v.inputEl as HTMLInputElement;
    expect(i.readOnly).toBe(false); expect(i.value).toBe('hi');
    expect(v.el.querySelector('.vb-combo-btn')).toBeTruthy();
    v.update({ Text: 'yo' }); expect(i.value).toBe('yo');
  });
  test('Dropdown List: input is read-only', () => {
    const v = renderControl(mk('ComboBox', { Style: 2 }), 'run', none);
    expect((v.inputEl as HTMLInputElement).readOnly).toBe(true);
  });
  test('Simple Combo shows the list permanently and no arrow', () => {
    const v = renderControl(mk('ComboBox', { Style: 1, List: ['a', 'b'] }), 'run', none);
    expect(v.el.querySelector('.vb-combo-btn')).toBeNull();
    expect([...v.el.querySelectorAll('.vb-item')].map(e => e.textContent)).toEqual(['a', 'b']);
  });
  test('the dropdown opens on arrow mousedown and picking an item sets the text and fires events', () => {
    const v = renderControl(mk('ComboBox', { List: ['a', 'b'] }), 'run', none);
    document.body.appendChild(v.el);
    const onChange = vi.fn(); const onSelect = vi.fn();
    v.inputEl!.addEventListener('change', onChange); v.el.addEventListener('vbselect', onSelect);
    expect(v.el.querySelector('.vb-combo-list.open')).toBeNull();
    v.el.querySelector('.vb-combo-btn')!.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));
    expect(v.el.querySelector('.vb-combo-list.open')).toBeTruthy();
    const items = v.el.querySelectorAll('.vb-item');
    items[1].dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));
    expect((v.inputEl as HTMLInputElement).value).toBe('b');
    expect(v.el.querySelector('.vb-combo-list.open')).toBeNull();
    expect(onChange).toHaveBeenCalledTimes(1);
    expect((onSelect.mock.calls[0][0] as CustomEvent).detail.index).toBe(1);
  });
  test('design mode never opens the list', () => {
    const v = renderControl(mk('ComboBox', { List: ['a'] }), 'design', none);
    v.el.querySelector('.vb-combo-btn')!.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));
    expect(v.el.querySelector('.vb-combo-list.open')).toBeNull();
  });
  test('changing Style rebuilds', () => {
    const v = renderControl(mk('ComboBox', { List: ['a'] }), 'run', none);
    v.update({ Style: 1 });
    expect(v.el.querySelector('.vb-combo-btn')).toBeNull();
  });
});

describe('PictureBox and Image', () => {
  test('PictureBox has an empty draw-layer first in its childHost, Picture is background, BackColor', () => {
    const v = renderControl(mk('PictureBox', { Picture: { asset: 'pic' }, BackColor: 0xff }), 'run', withPic);
    const dl = v.childHost!.firstElementChild as HTMLElement;
    expect(dl.className).toBe('draw-layer'); expect(dl.childElementCount).toBe(0);
    expect(v.childHost!.style.backgroundImage).toContain(PIC);
    expect(v.el.style.backgroundColor).toBe('rgb(255, 0, 0)');
    v.update({ Picture: null });
    expect(v.childHost!.style.backgroundImage).toBe('');
  });
  test('PictureBox BorderStyle', () => {
    const v = renderControl(mk('PictureBox', { BorderStyle: 1 }), 'run', none);
    expect(v.el.classList.contains('vb-bordered')).toBe(true);
    v.update({ BorderStyle: 0 });
    expect(v.el.classList.contains('vb-bordered')).toBe(false);
  });
  test('Image: img src from assets, Stretch, BorderStyle, unresolved picture', () => {
    const v = renderControl(mk('Image', { Picture: { asset: 'pic' } }), 'run', withPic);
    const img = v.el.querySelector('img')!;
    expect(img.getAttribute('src')).toBe(PIC);
    expect(v.el.classList.contains('vb-stretch')).toBe(false);
    v.update({ Stretch: true }); expect(v.el.classList.contains('vb-stretch')).toBe(true);
    v.update({ BorderStyle: 1 }); expect(v.el.classList.contains('vb-bordered')).toBe(true);
    v.update({ Picture: { asset: 'missing' } });
    expect(v.el.querySelector('img')).toBeNull();
    v.update({ Picture: null });
    expect(v.el.classList.contains('vb-empty')).toBe(true);
  });
});

describe('ProgressBar', () => {
  test('Standard draws blocks, Smooth a solid bar, Value/Min/Max drive the width', () => {
    const v = renderControl(pb({ Min: 0, Max: 100, Value: 30 }), 'run', none);
    const fill = v.el.querySelector('.pb-fill') as HTMLElement;
    expect(fill.style.width).toBe('30%');
    expect(v.el.classList.contains('pb-smooth')).toBe(false);
    v.update({ Scrolling: 1 }); expect(v.el.classList.contains('pb-smooth')).toBe(true);
    v.update({ Min: 10, Max: 20, Value: 15 }); expect(fill.style.width).toBe('50%');
    v.update({ Value: 99 }); expect(fill.style.width).toBe('100%');
    v.update({ Value: -5 }); expect(fill.style.width).toBe('0%');
    v.update({ Max: 10 }); expect(fill.style.width).toBe('0%');   // Max == Min
  });
  test('Vertical orientation uses the height', () => {
    const v = renderControl(pb({ Orientation: 1, Value: 25 }), 'run', none);
    const fill = v.el.querySelector('.pb-fill') as HTMLElement;
    expect(v.el.classList.contains('pb-vertical')).toBe(true);
    expect(fill.style.height).toBe('25%'); expect(fill.style.width).toBe('');
    v.update({ Orientation: 0 });
    expect(fill.style.width).toBe('25%'); expect(fill.style.height).toBe('');
  });
  test('Appearance and BorderStyle classes', () => {
    const v = renderControl(pb({ Appearance: 0, BorderStyle: 1 }), 'run', none);
    expect(v.el.classList.contains('pb-flat')).toBe(true);
    expect(v.el.classList.contains('pb-bordered')).toBe(true);
  });
});

describe('scroll bars', () => {
  const scroll = (t: 'HScrollBar' | 'VScrollBar', p: Record<string, PropValue> = {}) =>
    renderControl(mk(t, { Min: 0, Max: 100, Value: 0, SmallChange: 1, LargeChange: 10, ...p }), 'run', none);
  test('structure and orientation', () => {
    const h = scroll('HScrollBar'); const vv = scroll('VScrollBar');
    expect(h.el.classList.contains('vb-horizontal')).toBe(true);
    expect(vv.el.classList.contains('vb-vertical')).toBe(true);
    for (const v of [h, vv]) {
      expect(v.el.querySelectorAll('.vb-sb-btn').length).toBe(2);
      expect(v.el.querySelector('.vb-sb-thumb')).toBeTruthy();
    }
  });
  test('Value exposed and thumb positioned', () => {
    const v = scroll('HScrollBar', { Value: 50 });
    expect(v.inputEl!.getAttribute('aria-valuenow')).toBe('50');
    expect(v.inputEl!.dataset.value).toBe('50');
    const thumb = v.el.querySelector('.vb-sb-thumb') as HTMLElement;
    const w = parseFloat(thumb.style.width);           // LargeChange/(range+LargeChange) = 10/110
    expect(w).toBeCloseTo(9.09, 1);
    expect(parseFloat(thumb.style.left)).toBeCloseTo((100 - w) / 2, 1);
    v.update({ Value: 100 });
    expect(parseFloat(thumb.style.left)).toBeCloseTo(100 - w, 1);
    v.update({ Value: 999 });                          // clamped
    expect(v.inputEl!.dataset.value).toBe('100');
  });
  test('vertical uses top/height', () => {
    const v = scroll('VScrollBar', { Value: 100 });
    const thumb = v.el.querySelector('.vb-sb-thumb') as HTMLElement;
    expect(thumb.style.height).not.toBe(''); expect(thumb.style.width).toBe('');
    expect(parseFloat(thumb.style.top)).toBeGreaterThan(80);
  });
  test('arrow buttons step by SmallChange, track clicks by LargeChange, firing input and change', () => {
    const v = scroll('HScrollBar', { Value: 50, SmallChange: 2, LargeChange: 10 });
    document.body.appendChild(v.el);
    const onInput = vi.fn(); const onChange = vi.fn();
    v.inputEl!.addEventListener('input', onInput); v.inputEl!.addEventListener('change', onChange);
    const [dec, inc] = [...v.el.querySelectorAll('.vb-sb-btn')];
    inc.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, button: 0 }));
    expect(v.inputEl!.dataset.value).toBe('52');
    dec.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, button: 0 }));
    dec.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, button: 0 }));
    expect(v.inputEl!.dataset.value).toBe('48');
    document.dispatchEvent(new MouseEvent('mouseup', { bubbles: true }));
    expect(onChange).toHaveBeenCalled(); expect(onInput).toHaveBeenCalled();
  });
  test('keyboard: arrows, page keys, home/end', () => {
    const v = scroll('HScrollBar', { Value: 50, SmallChange: 1, LargeChange: 10 });
    const key = (k: string) => v.inputEl!.dispatchEvent(new KeyboardEvent('keydown', { key: k, bubbles: true }));
    key('ArrowRight'); expect(v.inputEl!.dataset.value).toBe('51');
    key('PageDown'); expect(v.inputEl!.dataset.value).toBe('61');
    key('Home'); expect(v.inputEl!.dataset.value).toBe('0');
    key('End'); expect(v.inputEl!.dataset.value).toBe('100');
    key('ArrowLeft'); expect(v.inputEl!.dataset.value).toBe('99');
  });
  test('design mode ignores clicks', () => {
    const v = renderControl(mk('HScrollBar', { Min: 0, Max: 100, Value: 50 }), 'design', none);
    v.el.querySelectorAll('.vb-sb-btn')[1].dispatchEvent(new MouseEvent('mousedown', { bubbles: true, button: 0 }));
    expect(v.inputEl!.dataset.value).toBe('50');
  });
});

describe('form surface', () => {
  test('el is the whole window: title bar with Caption, client area inside', () => {
    const s = renderFormSurface(form([], { Caption: 'My form' }), 'run', none);
    expect(s.el.querySelector('.title-bar-text')!.textContent).toBe('My form');
    expect(s.el.contains(s.clientEl)).toBe(true);
    expect(s.el.style.width).toBe('320px'); expect(s.el.style.height).toBe('240px');
    expect(s.clientEl.style.width).toBe('312px'); expect(s.clientEl.style.height).toBe('214px');
  });
  test('title bar buttons follow ControlBox / MinButton / MaxButton / BorderStyle', () => {
    const labels = (p: Record<string, PropValue>) =>
      [...renderFormSurface(form([], p), 'run', none).el.querySelectorAll('.title-bar-controls button')].map(b => b.getAttribute('aria-label'));
    expect(labels({})).toEqual(['Minimize', 'Maximize', 'Close']);
    expect(labels({ ControlBox: false })).toEqual([]);
    expect(labels({ MinButton: false, MaxButton: false })).toEqual(['Close']);
    expect(labels({ BorderStyle: 3 })).toEqual(['Close']);
    const half = renderFormSurface(form([], { MaxButton: false }), 'run', none);
    const btns = half.el.querySelectorAll<HTMLButtonElement>('.title-bar-controls button');
    expect(btns[1].disabled).toBe(true); expect(btns[0].disabled).toBe(false);
  });
  test('ControlBox=False also drops the icon', () => {
    expect(renderFormSurface(form([]), 'run', none).el.querySelector('.title-bar-icon')).toBeTruthy();
    expect(renderFormSurface(form([], { ControlBox: false }), 'run', none).el.querySelector('.title-bar-icon')).toBeNull();
  });
  test('Icon property resolves through assets', () => {
    const s = renderFormSurface(form([], { Icon: { asset: 'pic' } }), 'run', withPic);
    expect(s.el.querySelector('.title-bar-icon')!.getAttribute('src')).toBe(PIC);
  });
  test('BorderStyle None has no title bar and no border', () => {
    const s = renderFormSurface(form([], { BorderStyle: 0 }), 'run', none);
    expect(s.el.querySelector('.title-bar')).toBeNull();
    expect(s.clientEl.style.width).toBe('320px'); expect(s.clientEl.style.height).toBe('240px');
  });
  test('BackColor, ForeColor, Picture on clientEl', () => {
    const s = renderFormSurface(form([], { BackColor: 0xff, ForeColor: 0xff00 }), 'run', withPic);
    expect(s.clientEl.style.backgroundColor).toBe('rgb(255, 0, 0)');
    expect(s.clientEl.style.color).toBe('rgb(0, 255, 0)');
    s.update('form', { Picture: { asset: 'pic' } });
    expect(s.clientEl.style.backgroundImage).toContain(PIC);
  });
  test('draw-layer is the first, empty child of clientEl and stays first', () => {
    const s = renderFormSurface(form([cmd()]), 'run', none);
    const dl = s.clientEl.firstElementChild as HTMLElement;
    expect(dl.className).toBe('draw-layer'); expect(dl.childElementCount).toBe(0);
    s.addControl(lbl());
    expect(s.clientEl.querySelectorAll(':scope > .draw-layer').length).toBe(1);
    expect(s.clientEl.firstElementChild).toBe(s.drawLayer);
  });
  test('with the grid on, the grid sits below the draw layer', () => {
    const s = renderFormSurface(form([cmd()]), 'design', none, { showGrid: true });
    expect([...s.clientEl.children].slice(0, 2).map(e => e.className)).toEqual(['vb-grid', 'draw-layer']);
  });
  test('grid dots only in design mode with showGrid; gridX/gridY in twips', () => {
    const on = renderFormSurface(form([]), 'design', none, { showGrid: true, gridX: 120, gridY: 240 });
    const g = on.clientEl.querySelector('.vb-grid') as HTMLElement;
    expect(g).toBeTruthy();
    expect(g.style.backgroundSize).toBe('8px 16px');
    expect(renderFormSurface(form([]), 'design', none).clientEl.querySelector('.vb-grid')).toBeNull();
    expect(renderFormSurface(form([]), 'run', none, { showGrid: true }).clientEl.querySelector('.vb-grid')).toBeNull();
  });
  test('setGrid toggles the grid', () => {
    const s = renderFormSurface(form([]), 'design', none, { showGrid: true });
    s.setGrid({ showGrid: false });
    expect(s.clientEl.querySelector('.vb-grid')).toBeNull();
    s.setGrid({ showGrid: true, gridX: 150, gridY: 150 });
    expect((s.clientEl.querySelector('.vb-grid') as HTMLElement).style.backgroundSize).toBe('10px 10px');
  });
  test('child listed before its parent still ends up inside the parent', () => {
    const child = mk('CommandButton', {}, { id: 'kid', parentId: 'par' });
    const parent = mk('Frame', {}, { id: 'par' });
    const s = renderFormSurface(form([child, parent]), 'run', none);
    expect(s.views.get('kid')!.el.parentElement).toBe(s.views.get('par')!.childHost);
  });
  test('grandchildren: PictureBox inside Frame inside form', () => {
    const f = mk('Frame', {}, { id: 'f' });
    const p = mk('PictureBox', {}, { id: 'p', parentId: 'f' });
    const l = mk('Label', {}, { id: 'l', parentId: 'p' });
    const s = renderFormSurface(form([l, p, f]), 'run', none);
    expect(s.views.get('l')!.el.parentElement).toBe(s.views.get('p')!.childHost);
    expect(s.views.get('p')!.el.parentElement).toBe(s.views.get('f')!.childHost);
  });
  test('siblings are stacked by their relative array order', () => {
    const a = mk('Label', {}, { id: 'a' }); const b = mk('Label', {}, { id: 'b' });
    const f = mk('Frame', {}, { id: 'f' });
    const c = mk('Label', {}, { id: 'c', parentId: 'f' }); const d = mk('Label', {}, { id: 'd', parentId: 'f' });
    const s = renderFormSurface(form([a, c, f, d, b]), 'run', none);
    const ids = (host: HTMLElement) => [...host.children].filter(e => (e as HTMLElement).dataset.controlId).map(e => (e as HTMLElement).dataset.controlId);
    expect(ids(s.clientEl)).toEqual(['a', 'f', 'b']);
    expect(ids(s.views.get('f')!.childHost!)).toEqual(['c', 'd']);
  });
  test('a control whose parent does not exist falls back to the form', () => {
    const s = renderFormSurface(form([mk('Label', {}, { id: 'o', parentId: 'ghost' })]), 'run', none);
    expect(s.views.get('o')!.el.parentElement).toBe(s.clientEl);
  });
  test('Visible=False hides in run mode only', () => {
    const c = mk('Label', { Visible: false }, { id: 'v' });
    expect(renderFormSurface(form([c]), 'run', none).views.get('v')!.el.style.display).toBe('none');
    expect(renderFormSurface(form([c]), 'design', none).views.get('v')!.el.style.display).not.toBe('none');
  });
  test('update(id, changed) routes to the control view; update("form") to the form', () => {
    const c = mk('CommandButton', { Caption: 'A' }, { id: 'c1' });
    const s = renderFormSurface(form([c]), 'run', none);
    s.update('c1', { Caption: 'B' });
    expect(s.views.get('c1')!.el.textContent).toBe('B');
    s.update('form', { Caption: 'New caption', Width: 6000, Height: 4500 });
    expect(s.el.querySelector('.title-bar-text')!.textContent).toBe('New caption');
    expect(s.el.style.width).toBe('400px'); expect(s.el.style.height).toBe('300px');
    expect(s.clientEl.style.width).toBe('392px'); expect(s.clientEl.style.height).toBe('274px');
    s.update('form', { ControlBox: false });
    expect(s.el.querySelectorAll('.title-bar-controls button').length).toBe(0);
    s.update('form', { BorderStyle: 0 });
    expect(s.el.querySelector('.title-bar')).toBeNull();
    s.update('form', { BorderStyle: 2 });
    expect(s.el.querySelector('.title-bar')).toBeTruthy();
    expect(s.el.querySelector('.title-bar-text')!.textContent).toBe('New caption');
    expect(() => s.update('missing', { Caption: 'x' })).not.toThrow();
  });
  test('addControl places the control in its parent, optionally at a flat z-index; removeControl removes it and its descendants', () => {
    const f = mk('Frame', {}, { id: 'f' });
    const a = mk('Label', {}, { id: 'a' });
    const s = renderFormSurface(form([f, a]), 'design', none);
    const kid = mk('CommandButton', {}, { id: 'kid', parentId: 'f' });
    s.addControl(kid);
    expect(s.views.get('kid')!.el.parentElement).toBe(s.views.get('f')!.childHost);
    const back = mk('Label', {}, { id: 'back' });
    s.addControl(back, 0);                                    // behind everything
    expect((s.clientEl.querySelector('[data-control-id="back"]'))!.nextElementSibling).toBe(s.views.get('f')!.el);
    s.removeControl('f');
    expect(s.views.has('f')).toBe(false); expect(s.views.has('kid')).toBe(false);
    expect(s.clientEl.querySelector('[data-control-id="kid"]')).toBeNull();
    expect(s.views.has('a')).toBe(true);
  });
  test('reorder re-stacks and re-parents from a flat list', () => {
    const a = mk('Label', {}, { id: 'a' }); const b = mk('Label', {}, { id: 'b' }); const f = mk('Frame', {}, { id: 'f' });
    const s = renderFormSurface(form([a, b, f]), 'design', none);
    s.reorder([b, a, f]);
    const ids = [...s.clientEl.children].map(e => (e as HTMLElement).dataset.controlId).filter(Boolean);
    expect(ids).toEqual(['b', 'a', 'f']);
    s.reorder([b, { ...a, parentId: 'f' }, f]);
    expect(s.views.get('a')!.el.parentElement).toBe(s.views.get('f')!.childHost);
    expect([...s.clientEl.children].map(e => (e as HTMLElement).dataset.controlId).filter(Boolean)).toEqual(['b', 'f']);
  });
  test('setActive toggles the inactive title bar', () => {
    const s = renderFormSurface(form([]), 'run', none);
    s.setActive(false);
    expect(s.el.querySelector('.title-bar')!.classList.contains('inactive')).toBe(true);
    s.setActive(true);
    expect(s.el.querySelector('.title-bar')!.classList.contains('inactive')).toBe(false);
  });
  test('design-mode surface: title bar not interactive', () => {
    const s = renderFormSurface(form([]), 'design', none);
    for (const b of s.el.querySelectorAll<HTMLButtonElement>('.title-bar-controls button')) expect(b.tabIndex).toBe(-1);
    expect((s.el.querySelector('.title-bar') as HTMLElement).style.pointerEvents).toBe('none');
  });
});

describe('client-area helper', () => {
  test('Sizable: 4px border, 18px title bar', () => {
    const m = formMetrics({ Width: 4800, Height: 3600, BorderStyle: 2 });
    expect(m).toEqual({ outerWidth: 320, outerHeight: 240, border: 4, titleHeight: 18, menuHeight: 0, clientWidth: 312, clientHeight: 214 });
    expect(formMetrics({ Width: 4800, Height: 3600, BorderStyle: 2 }, true)).toMatchObject({ menuHeight: 19, clientHeight: 195 });   // with a menu bar
  });
  test('other border styles: 3px; None: 0 and no title bar', () => {
    for (const bs of [1, 3, 4]) expect(formMetrics({ Width: 4800, Height: 3600, BorderStyle: bs }).border).toBe(3);
    expect(formMetrics({ Width: 4800, Height: 3600, BorderStyle: 5 }).border).toBe(4);
    const m = formMetrics({ Width: 4800, Height: 3600, BorderStyle: 0 });
    expect([m.border, m.titleHeight, m.clientWidth, m.clientHeight]).toEqual([0, 0, 320, 240]);
  });
  test('falls back to registry defaults and never goes negative', () => {
    expect(formMetrics({}).clientWidth).toBe(312);
    expect(formMetrics({ Width: 15, Height: 15 }).clientHeight).toBe(0);
  });
  test('formScaleSize gives the client size in twips', () => {
    expect(formScaleSize({ Width: 4800, Height: 3600 })).toEqual({ width: 312 * 15, height: 214 * 15 });
  });
});

describe('StatusBar and TabStrip', () => {
  test('a StatusBar docks to the bottom of the form and follows its size; panels render from lines', () => {
    const sb = mk('StatusBar', { Height: 315, Panels: ['Ready|k|0|0', 'Right|r|1500|2'] });
    const surf = renderFormSurface({ props: { Width: 4800, Height: 3600 }, controls: [sb] }, 'design', none);
    const m = formMetrics({ Width: 4800, Height: 3600 });
    const el = surf.views.get(sb.id)!.el;
    expect(el.style.left).toBe('0px'); expect(el.style.width).toBe(`${m.clientWidth}px`);
    expect(el.style.top).toBe(`${m.clientHeight - 21}px`);
    const panels = [...el.querySelectorAll<HTMLElement>('.stb-panel')];
    expect(panels.map(p => p.textContent)).toEqual(['Ready', 'Right']);
    expect(panels[1].style.width).toBe('100px'); expect(panels[1].style.textAlign).toBe('right');
    surf.update('form', { Height: 4800 });
    expect(el.style.top).toBe(`${formMetrics({ Width: 4800, Height: 4800 }).clientHeight - 21}px`);
    surf.update(sb.id, { Height: 600 });
    expect(el.style.top).toBe(`${formMetrics({ Width: 4800, Height: 4800 }).clientHeight - 40}px`);
    surf.update(sb.id, { Style: 1, SimpleText: 'simple' });
    expect([...el.querySelectorAll('.stb-panel')].map(p => p.textContent)).toEqual(['simple']);
  });
  test('TabStrip renders its tabs and marks SelectedTab', () => {
    const ts = mk('TabStrip', { Tabs: ['One|a', '&Two'] });
    const v = renderControl(ts, 'design', none);
    const tabs = [...v.el.querySelectorAll('.ts-tab')];
    expect(tabs.map(t => t.textContent)).toEqual(['One', 'Two']);
    expect(tabs.map(t => t.classList.contains('selected'))).toEqual([true, false]);
    v.update({ SelectedTab: 2 });
    expect([...v.el.querySelectorAll('.ts-tab')].map(t => t.classList.contains('selected'))).toEqual([false, true]);
  });
});
