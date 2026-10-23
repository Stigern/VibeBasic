// @vitest-environment jsdom
import { afterEach, expect, test } from 'vitest';
import { containerAt } from '../../src/ide/designerLogic';
import { CONTROL_TYPES } from '../../src/model/controls';
import { bevelShadow, floodBox, ribbonClick } from '../../src/model/sheridan';
import type { ControlDef, ControlType, FormDef, PropValue } from '../../src/model/types';
import { renderControl, renderFormSurface } from '../../src/controls/render';

afterEach(() => { document.body.innerHTML = ''; });
const none = () => null;

let n = 0;
function mk(type: Exclude<ControlType, 'Form'>, props: Record<string, PropValue> = {}, extra: Partial<ControlDef> = {}): ControlDef {
  const base: Record<string, PropValue> = {};
  for (const pd of CONTROL_TYPES[type].props) if (pd.designTime) base[pd.name] = pd.default;
  n++;
  return { id: `ss${n}`, type, name: `${type}${n}`, index: null, parentId: null, props: { ...base, ...props }, ...extra };
}

test('SSPanel with FloodType 1 and FloodPercent 40 renders a 40% flood bar and "40%"', () => {
  const v = renderControl(mk('SSPanel', { Caption: 'Work', FloodType: 1, FloodPercent: 40, FloodShowPct: true }), 'run', none);
  const flood = v.el.querySelector<HTMLElement>('.ssp-flood')!;
  expect(flood.style.width).toBe('40%');
  expect(flood.style.height).toBe('100%');
  expect(v.el.querySelector('.ssp-text')!.textContent).toBe('40%');
  v.update({ FloodShowPct: false });
  expect(v.el.querySelector('.ssp-text')!.textContent).toBe('Work');
  v.update({ FloodType: 4, FloodPercent: 25 });
  expect(flood.style.top).toBe('75%');
  expect(floodBox(5, 100)!.clipPath).toContain('circle(70.71%');
  expect(floodBox(1, 0)).toBeNull();
});

test('bevels: BevelOuter / BevelInner / BevelWidth give Win98 shadows; Font3D a text shadow', () => {
  expect(bevelShadow(0, 2)).toBe('none');
  expect(bevelShadow(2, 1)).toBe('inset 1px 1px 0 #fff, inset -1px -1px 0 #808080');
  expect(bevelShadow(1, 2)).toContain('inset 2px 2px 0 #0a0a0a');
  const v = renderControl(mk('SSPanel', { Caption: 'x', BevelOuter: 1, BevelInner: 2, BevelWidth: 2, Font3D: 3 }), 'run', none);
  expect(v.el.querySelector<HTMLElement>('.ssp-outer')!.style.boxShadow).toContain('inset 1px 1px 0 #808080');
  expect(v.el.querySelector<HTMLElement>('.ssp-caption')!.style.textShadow).toContain('#fff');
});

test('SSPanel and SSFrame hold children in the designer', () => {
  const panel = mk('SSPanel', { Left: 300, Top: 300, Width: 3000, Height: 2000 }, { id: 'P' });
  const frame = mk('SSFrame', { Left: 100, Top: 100, Width: 900, Height: 900 }, { id: 'F', parentId: 'P' });
  const btn = mk('SSCommand', {}, { id: 'B', parentId: 'F' });
  const form: FormDef = { id: 'f', name: 'Form1', props: {}, controls: [panel, frame, btn], code: '' };
  const s = renderFormSurface(form, 'design', none);
  expect(s.views.get('B')!.el.parentElement).toBe(s.views.get('F')!.childHost);
  expect(s.views.get('F')!.el.parentElement).toBe(s.views.get('P')!.childHost);
  expect(s.views.get('P')!.el.parentElement).toBe(s.clientEl);
  expect(containerAt(form, 500, 500, [])).toBe('F');
  expect(containerAt(form, 2500, 2000, [])).toBe('P');
});

test('SSRibbon: Value shows the pressed look and PictureDn; a group releases the others', () => {
  const v = renderControl(mk('SSRibbon', { Caption: 'B', PictureUp: { asset: 'u' }, PictureDn: { asset: 'd' } }), 'run', (r: { asset: string }) => `data:${r.asset}`);
  const btn = v.inputEl as HTMLButtonElement, img = v.el.querySelector('img')!;
  expect(btn.classList.contains('down')).toBe(false);
  expect(img.getAttribute('src')).toBe('data:u');
  v.update({ Value: true });
  expect(btn.classList.contains('down')).toBe(true);
  expect(img.getAttribute('src')).toBe('data:d');
  expect(ribbonClick({ value: false, group: 1, allowAllUp: true }, ['a'])).toEqual({ value: true, release: ['a'] });
  expect(ribbonClick({ value: true, group: 1, allowAllUp: true }, [])).toEqual({ value: false, release: [] });
  expect(ribbonClick({ value: true, group: 1, allowAllUp: false }, [])).toEqual({ value: true, release: [] });
  expect(ribbonClick({ value: true, group: 0, allowAllUp: false }, [])).toEqual({ value: false, release: [] });
});
