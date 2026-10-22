// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import { formMetrics, renderFormSurface } from '../../src/controls/render';
import { newControl, newForm, newProject } from '../../src/model/controls';
import { setPressed, userClickButton } from '../../src/model/toolbar';
import type { ControlDef, ControlType, Project, PropValue } from '../../src/model/types';
import { InlineFormHost } from '../../src/run/inlineFormHost';
import { RunSession } from '../../src/run/session';

const PIC_A = 'data:image/png;base64,QUFB', PIC_B = 'data:image/png;base64,QkJC';
const assets = (ref: { asset: string }): string | null => ({ a1: PIC_A, b1: PIC_B } as Record<string, string>)[ref.asset] ?? null;

let n = 0;
function mk(type: Exclude<ControlType, 'Form'>, name: string, props: Record<string, PropValue> = {}): ControlDef {
  n++;
  const base: Record<string, PropValue> = {};
  const f = newForm('F');
  Object.assign(base, newControl(f, type, { left: 0, top: 0 }, null).props);
  return { id: `i${n}`, type, name, index: null, parentId: null, props: { ...base, ...props } };
}
const surface = (controls: ControlDef[], mode: 'design' | 'run' = 'design') =>
  renderFormSurface({ props: { Width: 4800, Height: 3600 }, controls }, mode, assets);

describe('ImageList pictures shown by other controls', () => {
  const list = () => mk('ImageList', 'ImageList1', { ListImages: ['first|a1', 'second|b1|t'], ImageWidth: 16, ImageHeight: 16 });

  test('a Toolbar button with Image by key (or index) renders an img, even when the ImageList comes later on the form', () => {
    const tb = mk('Toolbar', 'Toolbar1', { ImageList: 'ImageList1', Buttons: ['Open|o|0|second', '||3', 'Save|s|0|1', 'Plain|p'] });
    const s = surface([tb, list()]);
    const el = s.views.get(tb.id)!.el;
    const imgs = [...el.querySelectorAll<HTMLImageElement>('img.tbr-img')];
    expect(imgs.map(i => i.getAttribute('src'))).toEqual([PIC_B, PIC_A]);
    expect(imgs[0].style.width).toBe('16px');
    expect(el.querySelectorAll('.tbr-btn').length).toBe(3);
    expect(el.querySelectorAll('.tbr-sep').length).toBe(1);
    // the ImageList changes: the Toolbar repaints
    s.update([...s.views.keys()][1], { ListImages: ['second|a1'] });
    expect([...el.querySelectorAll('img.tbr-img')].map(i => i.getAttribute('src'))).toEqual([PIC_A, PIC_A]);
  });

  test('a Toolbar docks to the top, full width, by Align; Align = 0 frees it', () => {
    const tb = mk('Toolbar', 'Toolbar1', { Left: 500, Top: 700, Height: 390 });
    const s = surface([tb]);
    const el = s.views.get(tb.id)!.el;
    expect(el.style.top).toBe('0px');
    expect(el.style.width).toBe(`${formMetrics({ Width: 4800, Height: 3600 }).clientWidth}px`);
    s.update(tb.id, { Align: 2 });
    expect(el.style.top).toBe(`${formMetrics({ Width: 4800, Height: 3600 }).clientHeight - 26}px`);
    s.update(tb.id, { Align: 0 });
    expect(el.style.top).toBe('47px');
    expect(el.style.left).toBe('33px');
  });

  test('a TreeView node shows its image, and SelectedImage when selected; a ListView item its icon; a tab its image', () => {
    const tv = mk('TreeView', 'TreeView1', { ImageList: 'ImageList1', Nodes: ['0|1|0|k|Root|first|second', '0|2|0||Plain'], SelectedNode: 1 });
    const lv = mk('ListView', 'ListView1', { Icons: 'ImageList1', SmallIcons: 'ImageList1', View: 1, ListItems: ['1|One', '2|Two'], ListIcons: ['first|second', '|'] });
    const ts = mk('TabStrip', 'TabStrip1', { ImageList: 'ImageList1', Tabs: ['A|a|second', 'B'] });
    const s = surface([tv, lv, ts, list()]);
    const tvImgs = s.views.get(tv.id)!.el.querySelectorAll<HTMLImageElement>('.tv-row img.tv-img');
    expect(tvImgs.length).toBe(1);
    expect(tvImgs[0].getAttribute('src')).toBe(PIC_B);   // the selected node shows its SelectedImage
    s.update(tv.id, { SelectedNode: 2 });
    expect(s.views.get(tv.id)!.el.querySelector('.tv-row img.tv-img')!.getAttribute('src')).toBe(PIC_A);
    const lvImgs = s.views.get(lv.id)!.el.querySelectorAll<HTMLImageElement>('.lv-item img');
    expect(lvImgs.length).toBe(1);
    expect(lvImgs[0].getAttribute('src')).toBe(PIC_B);   // SmallIcons in lvwSmallIcon
    s.update(lv.id, { View: 0 });
    expect(s.views.get(lv.id)!.el.querySelector('.lv-item img')!.getAttribute('src')).toBe(PIC_A);   // Icons in lvwIcon
    const tabImgs = s.views.get(ts.id)!.el.querySelectorAll<HTMLImageElement>('.ts-tab img');
    expect([...tabImgs].map(i => i.getAttribute('src'))).toEqual([PIC_B]);
  });
});

describe('toolbar button state rules', () => {
  test('check buttons toggle, group buttons release their group, separators and disabled buttons do nothing', () => {
    const lines = ['a||1', 'b||2', 'c||2', '||3', 'd||2'];
    expect(userClickButton(lines, 1)).toEqual(['a||1|||1', 'b||2', 'c||2', '||3', 'd||2']);
    const g = userClickButton(lines, 2)!;
    expect(g[1]).toBe('b||2|||1');
    const g2 = userClickButton(g, 3)!;
    expect([g2[1], g2[2], g2[4]]).toEqual(['b||2', 'c||2|||1', 'd||2']);
    expect(userClickButton(lines, 4)).toBeNull();
    expect(userClickButton(['x|||||||0'], 1)).toBeNull();
    expect(setPressed(g2, 1, false)).toEqual(g2);
  });
});

// --- a whole program ---

let container: HTMLElement;
let session: RunSession | undefined;
beforeEach(() => { container = document.createElement('div'); document.body.appendChild(container); });
afterEach(() => { if (session && session.state !== 'ended') session.end(); session = undefined; document.body.innerHTML = ''; });
const tick = () => new Promise(r => setTimeout(r, 0));
const settle = async () => { for (let i = 0; i < 20; i++) await tick(); };

async function run(code: string, controls: [Exclude<ControlType, 'Form'>, string, Record<string, PropValue>?][]) {
  const p: Project = newProject();
  p.forms = [newForm('Form1', code)];
  p.startupForm = 'Form1';
  p.assets = { a1: { mime: 'image/png', dataBase64: 'QUFB' } };
  for (const [type, name, props] of controls) {
    const c = newControl(p.forms[0], type, { left: 120, top: 120 }, null);
    c.name = name; Object.assign(c.props, props ?? {});
    p.forms[0].controls.push(c);
  }
  const out: string[] = [];
  session = new RunSession(p, new InlineFormHost(container), {
    debugPrint: t => { out.push(t); }, onBreak: async () => 'end', onEnded: () => {},
    readFile: async () => new Uint8Array([66, 66, 66]), appPath: '/app',
  }, 'ide');
  await session.start();
  await settle();
  const el = (name: string) => container.querySelector<HTMLElement>(`[data-control-id="${p.forms[0].controls.find(c => c.name === name)!.id}"]`)!;
  return { out, el };
}

describe('ImageList in a running program', () => {
  test('ListImages by key and index, Add with LoadPicture, duplicate key 35602, Picture assignment, constants', async () => {
    const r = await run([
      'Private Sub Form_Load()',
      '  Debug.Print ImageList1.ListImages.Count; ImageList1.ListImages("open").Index; ImageList1.ListImages(1).Key',
      '  ImageList1.ListImages.Add , "k", LoadPicture("x.png")',
      '  Debug.Print ImageList1.ListImages.Count; ImageList1.ListImages("K").Index',
      '  On Error Resume Next',
      '  ImageList1.ListImages.Add , "OPEN", LoadPicture("x.png")',
      '  Debug.Print Err.Number',
      '  Err.Clear',
      '  Debug.Print ImageList1.ListImages(9).Key',
      '  Debug.Print Err.Number',
      '  Err.Clear',
      '  Toolbar1.ImageList = ImageList1',
      '  Debug.Print Toolbar1.ImageList.Name; tbrCheck; tbrPressed; tbrFlat',
      '  Debug.Print ImageList1.ListImages(1).Picture Is Nothing',
      'End Sub', '',
    ].join('\n'), [['ImageList', 'ImageList1', { ListImages: ['open|a1'] }], ['Toolbar', 'Toolbar1', {}]]);
    expect(r.out[0]).toBe(' 1  1 open');
    expect(r.out[1]).toBe(' 2  2 ');
    expect(r.out[2]).toBe(' 35602 ');
    expect(r.out[3]).toBe(' 35600 ');
    expect(r.out[4]).toBe('ImageList1 1  1  1 ');
    expect(r.out[5]).toBe('False');
  });

  test('ButtonClick passes the Button with the right Key; tbrCheck toggles Value; the image shows', async () => {
    const r = await run([
      'Private Sub Toolbar1_ButtonClick(ByVal Button As Button)',
      '  Label1.Caption = Button.Key & Button.Index & Button.Value',
      '  Debug.Print Button.Key; Toolbar1.Buttons(Button.Key).Value',
      'End Sub',
      'Private Sub Form_Load()',
      '  Toolbar1.Buttons.Add , "added", "Late", tbrCheck',
      'End Sub', '',
    ].join('\n'), [
      ['ImageList', 'ImageList1', { ListImages: ['open|a1'] }],
      ['Toolbar', 'Toolbar1', { ImageList: 'ImageList1', Buttons: ['New|new|0|open', 'Bold|bold|1', '||3', 'Left|l|2', 'Right|r|2'] }],
      ['Label', 'Label1'],
    ]);
    const btns = () => [...r.el('Toolbar1').querySelectorAll<HTMLElement>('.tbr-btn')];
    expect(btns().map(b => b.textContent)).toEqual(['New', 'Bold', 'Left', 'Right', 'Late']);
    expect(btns()[0].querySelector('img')!.getAttribute('src')).toBe(PIC_A);
    btns()[0].dispatchEvent(new MouseEvent('click', { bubbles: true }));
    await settle();
    expect(r.el('Label1').textContent).toBe('new10');
    btns()[1].dispatchEvent(new MouseEvent('click', { bubbles: true }));
    await settle();
    expect(r.out.slice(-1)).toEqual(['bold 1 ']);   // Value is already tbrPressed inside the event
    expect(btns()[1].classList.contains('pressed')).toBe(true);
    btns()[1].dispatchEvent(new MouseEvent('click', { bubbles: true }));
    await settle();
    expect(r.out.slice(-1)).toEqual(['bold 0 ']);
    expect(btns()[1].classList.contains('pressed')).toBe(false);
    btns()[2].dispatchEvent(new MouseEvent('click', { bubbles: true }));
    btns()[3].dispatchEvent(new MouseEvent('click', { bubbles: true }));
    await settle();
    expect(btns().map(b => b.classList.contains('pressed'))).toEqual([false, false, false, true, false]);
  });

  test('Nodes.Add with Image / SelectedImage, ListItems.Add with Icon / SmallIcon and Tabs.Add with Image show their pictures', async () => {
    const r = await run([
      'Private Sub Form_Load()',
      '  Set TreeView1.ImageList = ImageList1',
      '  TreeView1.Nodes.Add , , "r", "Root", "open", 1',
      '  Debug.Print TreeView1.Nodes(1).Image; TreeView1.Nodes(1).SelectedImage',
      '  ListView1.Icons = ImageList1',
      '  ListView1.SmallIcons = ImageList1',
      '  ListView1.ListItems.Add , "i", "Item", 1, "open"',
      '  TabStrip1.ImageList = ImageList1',
      '  TabStrip1.Tabs(1).Image = "open"',
      'End Sub', '',
    ].join('\n'), [
      ['ImageList', 'ImageList1', { ListImages: ['open|a1'] }], ['TreeView', 'TreeView1'],
      ['ListView', 'ListView1', { View: 1 }], ['TabStrip', 'TabStrip1', { Tabs: ['One'] }],
    ]);
    expect(r.out[0]).toBe('open1');
    expect(r.el('TreeView1').querySelector('.tv-row img')!.getAttribute('src')).toBe(PIC_A);
    expect(r.el('ListView1').querySelector('.lv-item img')!.getAttribute('src')).toBe(PIC_A);
    expect(r.el('TabStrip1').querySelector('.ts-tab img')!.getAttribute('src')).toBe(PIC_A);
  });
});
