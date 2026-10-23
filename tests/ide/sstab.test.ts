// @vitest-environment jsdom
import { afterEach, beforeEach, expect, test } from 'vitest';
import { openDesigner, pasteControls, registerDesignerActions } from '../../src/ide/designer';
import { hitTest } from '../../src/ide/designerLogic';
import { IdeState } from '../../src/ide/ideState';
import type { IdeActions } from '../../src/ide/menus';
import { addControlsCmd, setPropertyCmd } from '../../src/model/commands';
import { newControl } from '../../src/model/controls';
import type { ControlDef } from '../../src/model/types';

let ide: IdeState, host: HTMLElement, client: HTMLElement;
const form = () => ide.project.forms[0];
const OX = 100, OY = 50;
const ev = (type: string, x: number, y: number) => new MouseEvent(type, { bubbles: true, cancelable: true, button: 0, clientX: x, clientY: y });
const px = (tw: number, o: number) => o + tw / 15;
function click(x: number, y: number) {   // twips in the client area
  client.dispatchEvent(ev('pointerdown', px(x, OX), px(y, OY)));
  document.dispatchEvent(ev('pointerup', px(x, OX), px(y, OY)));
}
const shown = (d: ControlDef) => (client.querySelector<HTMLElement>(`[data-control-id="${d.id}"]`)!.parentElement as HTMLElement).style.display !== 'none';

beforeEach(() => {
  ide = new IdeState();
  host = document.createElement('div');
  document.body.appendChild(host);
  const actions: IdeActions = {};
  registerDesignerActions(ide, actions);
  openDesigner(ide, form().id, { mdiHost: host, actions });
  client = host.querySelector('.vb-form-client') as HTMLElement;
  client.getBoundingClientRect = () => ({ left: OX, top: OY, right: OX + 400, bottom: OY + 300, width: 400, height: 300, x: OX, y: OY, toJSON() {} });
});
afterEach(() => { document.body.innerHTML = ''; });

test('SSTab in the designer: a tab click switches tabs, a drop goes onto the current tab, other tabs are hidden', async () => {
  const tab = newControl(form(), 'SSTab', { left: 0, top: 0 }, null);   // 4335 wide: three 1445-twip tabs, 520 high
  ide.stack.execute(addControlsCmd(form().id, [tab]));
  expect(client.querySelectorAll('.sst-tab').length).toBe(3);

  click(2000, 200);                                   // the header of tab 1
  const sst = () => form().controls[0];
  expect(sst().props).toMatchObject({ Tab: 1, Caption: 'Tab 1' });
  expect(client.querySelector('.sst-tab.selected')!.textContent).toBe('Tab 1');

  ide.setTool('Label');
  click(600, 1200);
  const label = form().controls[1];
  expect(label).toMatchObject({ type: 'Label', parentId: tab.id, tab: 1, props: { Left: 600, Top: 1200 } });
  expect(shown(label)).toBe(true);
  expect(hitTest(form(), 700, 1300)).toBe(label.id);

  click(200, 200);                                    // back to tab 0: the label is hidden and cannot be hit
  expect(sst().props.Tab).toBe(0);
  expect(shown(label)).toBe(false);
  expect(hitTest(form(), 700, 1300)).toBe(tab.id);

  ide.setSelection({ formId: form().id, ids: [tab.id] });   // a paste with the SSTab selected lands on its current tab, under the tabs
  await pasteControls(ide, form().id, [{ ...label, id: 'x', name: 'Pasted', parentId: null }], tab.id);
  expect(form().controls[2]).toMatchObject({ parentId: tab.id, tab: 0, props: { Left: 0, Top: 520 } });

  ide.stack.undo(); ide.stack.undo();                 // undo the paste and the tab switch
  expect(sst().props).toMatchObject({ Tab: 1, Caption: 'Tab 1' });
  expect(shown(label)).toBe(true);
});

test('lowering Tabs moves the controls on the removed tabs to the last tab (review08 #11)', () => {
  const sst = newControl(form(), 'SSTab', { left: 0, top: 0 }, null);
  const a = { ...newControl(form(), 'Label', { left: 100, top: 700 }, sst.id), tab: 2 };
  const b = { ...newControl(form(), 'Label', { left: 100, top: 700 }, sst.id), name: 'Label2', tab: 0 };
  ide.stack.execute(addControlsCmd(form().id, [sst, a, b]));
  ide.stack.execute(setPropertyCmd(form().id, sst.id, 'Tabs', 2));
  const tabOf = (id: string) => form().controls.find(c => c.id === id)!.tab;
  expect([tabOf(a.id), tabOf(b.id)]).toEqual([1, 0]);
  ide.stack.execute(setPropertyCmd(form().id, sst.id, 'Tab', 1));
  expect(shown(form().controls[1])).toBe(true);
  ide.stack.undo(); ide.stack.undo();
  expect([tabOf(a.id), tabOf(b.id)]).toEqual([2, 0]);
  ide.stack.redo();
  expect(tabOf(a.id)).toBe(1);
});
