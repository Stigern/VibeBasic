// @vitest-environment jsdom
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { clipboardHasControls } from '../../src/ide/clipboard';
import { openDesigner, pasteControls, registerDesignerActions } from '../../src/ide/designer';
import { IdeState } from '../../src/ide/ideState';
import type { IdeActions } from '../../src/ide/menus';
import { newControl } from '../../src/model/controls';
import { addControlsCmd, addFormCmd } from '../../src/model/commands';
import type { ControlDef } from '../../src/model/types';
import { messageBox98 } from '../../src/ui98/dialogs';

vi.mock('../../src/ui98/dialogs', async orig => ({ ...(await orig<typeof import('../../src/ui98/dialogs')>()), messageBox98: vi.fn() }));
const box = vi.mocked(messageBox98);

let ide: IdeState, host: HTMLElement, actions: IdeActions, client: HTMLElement;
const form = () => ide.project.forms[0];
const OX = 100, OY = 50;   // client area origin in jsdom pixels
const ev = (type: string, x: number, y: number, init: MouseEventInit = {}) =>
  new MouseEvent(type, { bubbles: true, cancelable: true, button: 0, clientX: x, clientY: y, ...init });
/** Client-area pixel for a twips position. */
const px = (tw: number, o: number) => o + tw / 15;
function drag(from: [number, number], to: [number, number], target: Element = client, init: MouseEventInit = {}) {
  target.dispatchEvent(ev('pointerdown', ...from, init));
  document.dispatchEvent(ev('pointermove', ...to));
  document.dispatchEvent(ev('pointerup', ...to));
}
function add(type: ControlDef['type'], l: number, t: number, w?: number, h?: number, parentId: string | null = null): ControlDef {
  const d = newControl(form(), type, { left: l, top: t, width: w, height: h }, parentId);
  ide.stack.execute(addControlsCmd(form().id, [d]));
  return d;
}

beforeEach(() => {
  ide = new IdeState();
  host = document.createElement('div');
  document.body.appendChild(host);
  actions = {};
  registerDesignerActions(ide, actions);
  openDesigner(ide, form().id, { mdiHost: host, actions });
  client = host.querySelector('.vb-form-client') as HTMLElement;
  client.getBoundingClientRect = () => ({ left: OX, top: OY, right: OX + 400, bottom: OY + 300, width: 400, height: 300, x: OX, y: OY, toJSON() {} });
  box.mockReset();
});
afterEach(() => { document.body.innerHTML = ''; });

test('opening an open designer activates the same window', () => {
  const a = openDesigner(ide, form().id, { mdiHost: host });
  expect(host.querySelectorAll('.mdi98').length).toBe(1);
  expect(a.el.classList.contains('active')).toBe(true);
});

test('drawing a control with tool creates it with that size and resets tool', () => {
  ide.setTool('CommandButton');
  drag([px(120, OX), px(120, OY)], [px(1320, OX), px(600, OY)]);
  expect(form().controls).toHaveLength(1);
  expect(form().controls[0]).toMatchObject({ type: 'CommandButton', parentId: null, props: { Left: 120, Top: 120, Width: 1200, Height: 480 } });
  expect(ide.currentTool).toBe('Pointer');
  expect(ide.selection!.ids).toEqual([form().controls[0].id]);
  expect(client.querySelectorAll('.vb-ctl').length).toBe(1);
  ide.stack.undo();
  expect(client.querySelectorAll('.vb-ctl').length).toBe(0);
});

test('a click with a tool gives the default size; drawing inside a Frame makes a child', () => {
  ide.setTool('Frame');
  drag([px(240, OX), px(240, OY)], [px(240, OX), px(240, OY)]);
  expect(form().controls[0].props).toMatchObject({ Left: 240, Top: 240, Width: 1815, Height: 1335 });
  ide.setTool('Label');
  drag([px(480, OX), px(480, OY)], [px(480, OX), px(480, OY)]);
  expect(form().controls[1]).toMatchObject({ type: 'Label', parentId: form().controls[0].id, props: { Left: 240, Top: 240 } });
});

test('dragging moves with one undo step and snaps to the grid', () => {
  const c = add('CommandButton', 240, 240, 1200, 480);
  drag([px(300, OX), px(300, OY)], [px(300, OX) + 18, px(300, OY) + 8]);   // +270 / +120 twips -> snapped
  expect(form().controls[0].props).toMatchObject({ Left: 480, Top: 360 });
  ide.stack.undo();
  expect(form().controls[0].props).toMatchObject({ Left: 240, Top: 240 });
  expect(form().controls[0].id).toBe(c.id);
});

test('dragging into a Frame reparents with relative coordinates; moving the frame keeps children', () => {
  const fr = add('Frame', 2400, 2400, 3000, 2000);
  const c = add('CommandButton', 120, 120, 1200, 480);
  drag([px(200, OX), px(200, OY)], [px(2640 + 200, OX), px(2640 + 200, OY)]);
  const moved = form().controls.find(x => x.id === c.id)!;
  expect(moved.parentId).toBe(fr.id);
  expect(moved.props).toMatchObject({ Left: 360, Top: 360 });   // abs 2760 -> 360 relative to the frame
  ide.stack.undo();
  expect(form().controls.find(x => x.id === c.id)!.parentId).toBeNull();
});

test('handles resize the selection in one command; form resize changes Width/Height', () => {
  add('TextBox', 240, 240, 1200, 480);
  ide.setSelection({ formId: form().id, ids: [form().controls[0].id] });
  const se = host.querySelector('[data-handle="se"]') as HTMLElement;
  expect(host.querySelectorAll('.dsg-h.filled').length).toBe(8);
  drag([0, 0], [130 / 15, 10 / 15], se);
  expect(form().controls[0].props).toMatchObject({ Left: 240, Top: 240, Width: 1320, Height: 480 });
  ide.setSelection({ formId: form().id, ids: [] });
  const w0 = Number(form().props.Width), h0 = Number(form().props.Height);
  expect(host.querySelectorAll('.dsg-h').length).toBe(3);
  drag([0, 0], [240 / 15, 120 / 15], host.querySelector('[data-handle="se"]') as HTMLElement);
  expect(form().props).toMatchObject({ Width: w0 + 240, Height: h0 + 120 });
  ide.stack.undo();
  expect(form().props).toMatchObject({ Width: w0, Height: h0 });
});

test('multi selection has hollow handles with a filled primary', () => {
  const a = add('Label', 0, 0, 600, 240), b = add('Label', 1200, 0, 600, 240);
  ide.setSelection({ formId: form().id, ids: [a.id, b.id] });
  expect(host.querySelectorAll('.dsg-h.filled').length).toBe(8);
  expect(host.querySelectorAll('.dsg-h.hollow').length).toBe(8);
});

test('click selects, ctrl-click toggles, empty click selects the form, rubber band selects touched controls', () => {
  const a = add('Label', 0, 0, 600, 240), b = add('Label', 1200, 0, 600, 240);
  const click = (x: number, y: number, init: MouseEventInit = {}) => drag([px(x, OX), px(y, OY)], [px(x, OX), px(y, OY)], client, init);
  click(100, 100);
  expect(ide.selection!.ids).toEqual([a.id]);
  click(1300, 100, { ctrlKey: true });
  expect(ide.selection!.ids).toEqual([a.id, b.id]);
  click(1300, 100, { ctrlKey: true });
  expect(ide.selection!.ids).toEqual([a.id]);
  click(5000, 3000);
  expect(ide.selection!.ids).toEqual([]);
  drag([px(2000, OX), px(100, OY)], [px(300, OX), px(200, OY)]);
  expect(ide.selection!.ids).toEqual([a.id, b.id]);
});

test('double-click on control and form calls viewCode with the default event', () => {
  const viewCode = vi.fn();
  actions.viewCode = viewCode;
  const c = add('CommandButton', 0, 0, 1200, 480);
  client.dispatchEvent(ev('dblclick', px(100, OX), px(100, OY)));
  expect(viewCode).toHaveBeenLastCalledWith(form().id, c.name, 'Click');
  client.dispatchEvent(ev('dblclick', px(3000, OX), px(2000, OY)));
  expect(viewCode).toHaveBeenLastCalledWith(form().id, 'Form', 'Load');
  delete actions.viewCode;
  client.dispatchEvent(ev('dblclick', px(3000, OX), px(2000, OY)));   // no handler: nothing happens
});

test('Ctrl+Arrow moves one grid cell, Shift+Arrow resizes, locked controls do not move', () => {
  const c = add('CommandButton', 240, 240, 1200, 480);
  ide.setSelection({ formId: form().id, ids: [c.id] });
  const stage = host.querySelector('.dsg-stage') as HTMLElement;
  const key = (k: string, init: KeyboardEventInit) => stage.dispatchEvent(new KeyboardEvent('keydown', { key: k, bubbles: true, cancelable: true, ...init }));
  key('ArrowRight', { ctrlKey: true });
  key('ArrowDown', { shiftKey: true });
  expect(form().controls[0].props).toMatchObject({ Left: 360, Top: 240, Width: 1200, Height: 600 });
  actions.lockControls();
  key('ArrowRight', { ctrlKey: true });
  expect(form().controls[0].props.Left).toBe(360);
});

test('paste: duplicate name + Yes makes a control array 0 and 1', async () => {
  const c = add('CommandButton', 600, 600, 1200, 480);
  box.mockResolvedValue(6);
  await pasteControls(ide, form().id, [structuredClone(c)]);
  expect(box.mock.calls[0][1]).toMatchObject({ prompt: "You already have a control named 'Command1'. Do you want to create a control array?", buttons: 4 + 32 });
  expect(form().controls.map(x => [x.name, x.index])).toEqual([['Command1', 0], ['Command1', 1]]);
  expect(form().controls[1].props).toMatchObject({ Left: 0, Top: 0 });
  ide.stack.undo();   // one undo step for rename + add
  expect(form().controls.map(x => [x.name, x.index])).toEqual([['Command1', null]]);
});

test('paste: duplicate name + No gives Command2', async () => {
  const c = add('CommandButton', 0, 0, 1200, 480);
  box.mockResolvedValue(7);
  await pasteControls(ide, form().id, [structuredClone(c)]);
  expect(form().controls.map(x => [x.name, x.index])).toEqual([['Command1', null], ['Command2', null]]);
});

test('paste: a renamed ImageList takes the controls pasted with it along; the form\'s own keep theirs', async () => {
  const il = add('ImageList', 0, 0, 480, 480);
  const own = add('Toolbar', 0, 0, 3000, 400);
  own.props.ImageList = il.name;
  form().controls.find(x => x.id === own.id)!.props.ImageList = il.name;
  const copied = [structuredClone(il), { ...structuredClone(own), id: 'tb-copy', name: 'Toolbar9' }];
  box.mockResolvedValue(7);   // No: not a control array
  await pasteControls(ide, form().id, copied);
  const byName = (n: string) => form().controls.find(x => x.name === n)!;
  expect(byName('ImageList2')).toBeTruthy();
  expect(byName('Toolbar9').props.ImageList).toBe('ImageList2');
  expect(byName(own.name).props.ImageList).toBe('ImageList1');
});

test('copy/cut/paste actions keep container children; delete and select all', async () => {
  const fr = add('Frame', 600, 600, 3000, 2000);
  add('CommandButton', 100, 100, 1200, 480, fr.id);
  ide.setSelection({ formId: form().id, ids: [fr.id] });
  actions.copy();
  expect(clipboardHasControls()).toBe(true);
  box.mockResolvedValue(7);
  ide.setSelection({ formId: form().id, ids: [] });   // with the frame selected, paste would go into it
  actions.paste();
  await vi.waitFor(() => expect(form().controls).toHaveLength(4));
  const [, , fr2, cmd2] = form().controls;
  expect(fr2).toMatchObject({ name: 'Frame2', parentId: null, props: { Left: 0, Top: 0 } });
  expect(cmd2.parentId).toBe(fr2.id);
  actions.selectAll();
  expect(ide.selection!.ids).toHaveLength(2);
  ide.setSelection({ formId: form().id, ids: [fr2.id] });
  actions.delete();
  expect(form().controls).toHaveLength(2);
  expect(client.querySelectorAll('.vb-ctl').length).toBe(2);
});

test('align, same size and z-order actions work on the selection (primary last)', () => {
  const a = add('Label', 100, 100, 600, 240), b = add('Label', 1200, 600, 900, 360);
  ide.setSelection({ formId: form().id, ids: [a.id, b.id] });
  actions.alignLefts();
  expect(form().controls[0].props.Left).toBe(1200);
  actions.sameBoth();
  expect(form().controls[0].props).toMatchObject({ Width: 900, Height: 360 });
  ide.setSelection({ formId: form().id, ids: [a.id] });
  actions.bringToFront();
  expect(form().controls.map(c => c.id)).toEqual([b.id, a.id]);
  actions.sendToBack();
  expect(form().controls.map(c => c.id)).toEqual([a.id, b.id]);
  expect(client.querySelectorAll('.vb-ctl').length).toBe(2);
});

test('property changes through the stack re-sync the surface; closing the form window unregisters', () => {
  ide.stack.execute({ label: 'x', do: p => { p.forms[0].props.Width = 6000; }, undo: p => { p.forms[0].props.Width = 4800; } });
  expect((host.querySelector('.vb-form') as HTMLElement).style.width).toBe('400px');
  host.querySelector<HTMLElement>('.mdi98')!.remove();
});

test('pointerdown inside a background designer raises it', () => {
  const f2 = { ...structuredClone(form()), id: 'f2', name: 'Form2', controls: [] };
  ide.project.forms.push(f2);
  openDesigner(ide, 'f2', { mdiHost: host, actions });
  const wins = [...host.querySelectorAll('.mdi98')];
  expect(wins[1].classList.contains('active')).toBe(true);
  client.dispatchEvent(ev('pointerdown', px(10, OX), px(10, OY)));
  document.dispatchEvent(ev('pointerup', px(10, OX), px(10, OY)));
  expect(wins[0].classList.contains('active')).toBe(true);
  expect(wins[1].classList.contains('active')).toBe(false);
  expect(ide.activeView).toEqual({ kind: 'designer', formId: form().id });
});

test('Edit actions ignore focus outside the designer', () => {
  const c = add('CommandButton', 240, 240, 1200, 480);
  ide.setSelection({ formId: form().id, ids: [c.id] });
  const row = document.body.appendChild(document.createElement('div'));
  row.tabIndex = 0; row.focus();
  actions.delete!(); actions.cut!(); actions.selectAll!();
  expect(form().controls).toHaveLength(1);
  row.remove();
  (host.querySelector('.dsg-stage') as HTMLElement).focus();
  actions.delete!();
  expect(form().controls).toHaveLength(0);
});

test('Lock Controls still lets the form be resized', () => {
  ide.setSelection({ formId: form().id, ids: [] });
  actions.lockControls!();
  const w = Number(form().props.Width);
  const hd = host.querySelector('[data-handle="se"][data-id="form"]') as HTMLElement;
  expect(hd).toBeTruthy();
  drag([0, 0], [150, 0], hd);
  expect(Number(form().props.Width)).toBeGreaterThan(w);
});

test('pointercancel ends a draw gesture without committing', () => {
  ide.setTool('CommandButton');
  client.dispatchEvent(ev('pointerdown', px(120, OX), px(120, OY)));
  document.dispatchEvent(ev('pointermove', px(1320, OX), px(600, OY)));
  document.dispatchEvent(ev('pointercancel', px(1320, OX), px(600, OY)));
  document.dispatchEvent(ev('pointerup', px(1320, OX), px(600, OY)));
  expect(form().controls).toHaveLength(0);
  expect(host.querySelectorAll('.dsg-ghost')).toHaveLength(0);
});

test('undoing the add of a form clears a selection that pointed at it', () => {
  const f2 = { ...structuredClone(form()), id: 'f2', name: 'Form2', controls: [] };
  ide.stack.execute(addFormCmd(f2));
  openDesigner(ide, 'f2', { mdiHost: host, actions });
  ide.setSelection({ formId: 'f2', ids: [] });
  ide.stack.undo();
  expect(ide.selection).toBeNull();
});

test('Line: drawn from end to end, end point handles move X1/Y1 or X2/Y2, no resize handles', () => {
  ide.setTool('Line');
  drag([px(120, OX), px(120, OY)], [px(1320, OX), px(240, OY)]);
  expect(form().controls[0]).toMatchObject({ type: 'Line', props: { X1: 120, Y1: 120, X2: 1320, Y2: 240 } });
  expect(host.querySelectorAll('[data-handle="p1"], [data-handle="p2"]')).toHaveLength(2);
  expect(host.querySelector('[data-handle="se"]')).toBeNull();
  drag([0, 0], [240 / 15, 120 / 15], host.querySelector('[data-handle="p2"]') as HTMLElement);
  expect(form().controls[0].props).toMatchObject({ X1: 120, Y1: 120, X2: 1560, Y2: 360 });
  ide.stack.undo();
  expect(form().controls[0].props).toMatchObject({ X2: 1320, Y2: 240 });
  drag([px(720, OX), px(180, OY)], [px(720, OX), px(180, OY) + 8]);   // grab the line (near the segment) and move it down
  expect(form().controls[0].props).toMatchObject({ X1: 120, X2: 1320 });
  expect(Number(form().controls[0].props.Y1)).toBeGreaterThan(120);
});

test('Toolbox double-click: a control larger than the form shrinks to fit and never starts off the form', async () => {
  const { placeControlCentered } = await import('../../src/ide/designer');
  ide.setActiveView({ kind: 'designer', formId: form().id });
  placeControlCentered(ide, 'WebBrowser');   // 4815 x 3615 by default; the default form's client area is smaller
  const c = form().controls.find(x => x.type === 'WebBrowser')!;
  expect(c.props.Left as number).toBeGreaterThanOrEqual(0);
  expect(c.props.Top as number).toBeGreaterThanOrEqual(0);
  expect(c.props.Width as number).toBeLessThan(4815);
  placeControlCentered(ide, 'CommandButton');   // small controls keep their default size
  expect(form().controls.find(x => x.type === 'CommandButton')!.props.Width).toBe(1215);
});

test('paste with a Frame or PictureBox selected pastes into it (review08 #4)', async () => {
  const btn = add('CommandButton', 0, 0, 1200, 480);
  const fr = add('Frame', 2000, 600, 3000, 2000);
  const pic = add('PictureBox', 600, 3000, 2000, 1500);
  ide.setSelection({ formId: form().id, ids: [btn.id] });
  actions.cut();
  ide.setSelection({ formId: form().id, ids: [fr.id] });
  actions.paste();
  await vi.waitFor(() => expect(form().controls).toHaveLength(3));
  expect(form().controls[2]).toMatchObject({ name: 'Command1', parentId: fr.id });
  ide.setSelection({ formId: form().id, ids: [pic.id] });
  box.mockResolvedValue(7);
  actions.paste();
  await vi.waitFor(() => expect(form().controls).toHaveLength(4));
  expect(form().controls[3].parentId).toBe(pic.id);
});

test('copied pictures and ImageList images go along to another project, and a cut keeps them for the paste (review08 #7)', async () => {
  const pic = add('PictureBox', 0, 0, 1200, 1200);
  const il = add('ImageList', 2000, 0);
  ide.stack.execute({ label: 'x', do: p => {
    p.assets.a1 = { mime: 'image/png', dataBase64: 'AAA' };
    p.assets.a2 = { mime: 'image/png', dataBase64: 'BBB' };
    p.forms[0].controls[0].props.Picture = { asset: 'a1' };
    p.forms[0].controls[1].props.ListImages = ['k|a2|'];
  }, undo: () => {} });
  ide.setSelection({ formId: form().id, ids: [pic.id, il.id] });
  actions.cut();
  expect(ide.project.assets).toEqual({});   // the cut controls took their pictures along
  actions.paste();
  await vi.waitFor(() => expect(form().controls).toHaveLength(2));
  expect(Object.keys(ide.project.assets).sort()).toEqual(['a1', 'a2']);
  // another project
  const other = new IdeState();
  const host2 = document.createElement('div');
  document.body.appendChild(host2);
  const actions2: IdeActions = {};
  registerDesignerActions(other, actions2);
  openDesigner(other, other.project.forms[0].id, { mdiHost: host2, actions: actions2 });
  actions2.paste();
  await vi.waitFor(() => expect(other.project.forms[0].controls).toHaveLength(2));
  expect(other.project.assets.a1).toEqual({ mime: 'image/png', dataBase64: 'AAA' });
  expect(other.project.assets.a2).toEqual({ mime: 'image/png', dataBase64: 'BBB' });
  other.stack.undo();   // one undo step takes them out again
  expect(other.project.assets).toEqual({});
});

test('TabIndex stays unique: delete renumbers, new and pasted controls come last (review08 #9)', async () => {
  const [c1, c2, c3] = [0, 1, 2].map(i => add('CommandButton', i * 1300, 0, 1200, 480));
  expect([c1, c2, c3].map(c => c.props.TabIndex)).toEqual([0, 1, 2]);
  ide.setSelection({ formId: form().id, ids: [c1.id] });
  actions.delete();
  const tabs = () => form().controls.map(c => `${c.name}:${c.props.TabIndex}`);
  expect(tabs()).toEqual(['Command2:0', 'Command3:1']);
  add('CommandButton', 0, 1000, 1200, 480);
  expect(tabs()).toEqual(['Command2:0', 'Command3:1', 'Command1:2']);
  box.mockResolvedValue(7);
  await pasteControls(ide, form().id, [structuredClone(form().controls[0])]);
  expect(tabs()).toEqual(['Command2:0', 'Command3:1', 'Command1:2', 'Command4:3']);
  ide.stack.undo(); ide.stack.undo(); ide.stack.undo();   // undo of the delete restores the old numbers
  expect(tabs()).toEqual(['Command1:0', 'Command2:1', 'Command3:2']);
});
