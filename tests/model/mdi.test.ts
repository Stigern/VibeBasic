// @vitest-environment jsdom
// The MDI form in the model and the designer: save/load, its properties and controls, the workspace grey, the Window list.
import { expect, test } from 'vitest';
import { renderFormSurface } from '../../src/controls/render';
import { newForm, newProject } from '../../src/model/controls';
import { formHasProp, mdiAllows, newMdiForm, withWindowList } from '../../src/model/mdi';
import { parseProject, serializeProject } from '../../src/model/serialize';
import type { ControlDef } from '../../src/model/types';

test('an MDI form and an MDI child survive save and load', () => {
  const p = newProject();
  const child = newForm('Form2');
  child.props.MDIChild = true;
  p.forms.push(newMdiForm('MDIForm1'), child);
  const back = parseProject(serializeProject(p));
  expect(back.forms.map(f => [f.name, f.mdi ?? false, f.props.MDIChild ?? null])).toEqual([['Form1', false, false], ['MDIForm1', true, null], ['Form2', false, true]]);
  expect(back.forms[1].props).toMatchObject({ BackColor: 0x8000000c | 0, AutoShowChildren: true, ScrollBars: true });
  expect(Object.keys(back.forms[1].props)).not.toContain('KeyPreview');
});

test('an MDI form has its own properties and holds only aligned and invisible controls', () => {
  expect(formHasProp({ mdi: true }, 'AutoShowChildren')).toBe(true);
  expect(formHasProp({ mdi: true }, 'BorderStyle')).toBe(false);
  expect(formHasProp({}, 'ScrollBars')).toBe(false);
  expect(formHasProp({}, 'MDIChild')).toBe(true);
  expect(['PictureBox', 'Toolbar', 'StatusBar', 'CoolBar', 'Timer', 'CommonDialog'].every(t => mdiAllows(t as never))).toBe(true);
  expect(mdiAllows('CommandButton')).toBe(false);
});

test('the designer shows the MDI form with the AppWorkspace grey', () => {
  const s = renderFormSurface(newMdiForm('MDIForm1'), 'design', () => null);
  expect(s.clientEl.style.backgroundColor).toBe('rgb(128, 128, 128)');
});

test('the Window list goes under the WindowList menu, the active child checked', () => {
  const m = (id: string, parentId: string | null, props: Record<string, unknown> = {}): ControlDef =>
    ({ id, type: 'Menu', name: id, index: null, parentId, props: { Caption: id, ...props } as never });
  const menus = [m('win', null, { WindowList: true }), m('tile', 'win')];
  const out = withWindowList(menus, [{ key: 'a', caption: 'Doc A' }, { key: 'b', caption: 'Doc B' }], 'b');
  expect(out.slice(2).map(d => [d.parentId, d.props.Caption, d.props.Checked])).toEqual([['win', '-', false], ['win', '&1 Doc A', false], ['win', '&2 Doc B', true]]);
  expect(withWindowList([m('file', null)], [{ key: 'a', caption: 'A' }], 'a')).toHaveLength(1);
});
