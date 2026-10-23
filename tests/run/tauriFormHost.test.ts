// @vitest-environment jsdom
import { expect, test } from 'vitest';
import type { FormSnapshot, FromWindow } from '../../src/run/protocol';
import { runDialog } from '../../src/run/dialogSpec';
import { TauriFormHost, type TauriGlue } from '../../src/run/tauriFormHost';
import { getBackend } from '../../src/backend/backend';
import type { PrintJob } from '../../src/run/printing';

function fakeGlue() {
  const handlers = new Map<string, ((p: unknown) => void)[]>();
  const log = { created: [] as { label: string; o: Record<string, unknown> }[], destroyed: [] as string[], emitted: [] as [string, string, unknown][], unlistened: 0 };
  const glue: TauriGlue = {
    async createWindow(label, o) { log.created.push({ label, o: o as unknown as Record<string, unknown> }); return { destroy: async () => { log.destroyed.push(label); } }; },
    async listen(ev, cb) {
      (handlers.get(ev) ?? handlers.set(ev, []).get(ev)!).push(cb as (p: unknown) => void);
      return () => { log.unlistened++; handlers.set(ev, handlers.get(ev)!.filter(h => h !== cb)); };
    },
    async emitTo(label, ev, p) { log.emitted.push([label, ev, p]); },
  };
  const fire = (ev: string, p: unknown) => { for (const h of handlers.get(ev) ?? []) h(p); };
  const tick = () => new Promise(r => setTimeout(r, 0));
  return { glue, log, fire, tick, listeners: () => [...handlers.values()].reduce((n, a) => n + a.length, 0) };
}

const snap = (key: string): FormSnapshot => ({ key, form: { id: 'f', name: key, props: { Width: 4800, Height: 3600, StartUpPosition: 2 }, controls: [], code: '' }, assets: {}, handled: {}, mode: 'ide' });

test('form window: options, hello handshake, ordered queue, routing, cleanup', async () => {
  const f = fakeGlue();
  const host = new TauriFormHost(f.glue);
  const w = await host.openForm(snap('Form1'), { modal: true });
  expect(f.log.created[0]).toMatchObject({ label: 'vbform-Form1', o: { url: 'form.html#Form1', decorations: false, visible: false, alwaysOnTop: false, parent: 'main', width: 320, center: true } });
  w.send({ t: 'patch', id: 'form', props: { Caption: 'x' } });
  await f.tick();
  expect(f.log.emitted).toEqual([]);                       // nothing before the window said hello
  const got: FromWindow[] = [];
  w.onMessage(m => got.push(m));
  f.fire('vb:hello', 'Form1');
  f.fire('vb:from', { key: 'Form1', m: { t: 'ready' } });
  f.fire('vb:from', { key: 'Other', m: { t: 'closeRequest' } });
  await f.tick();
  expect(f.log.emitted.map(e => e[1])).toEqual(['vb:snapshot', 'vb:to']);
  expect(got).toEqual([{ t: 'ready' }]);
  await w.close();
  expect(f.log.destroyed).toEqual(['vbform-Form1']);
  expect(f.listeners()).toBe(0);
});

test('msgbox opens a dialog window owned by the form, blocks forms, returns the result', async () => {
  const f = fakeGlue();
  const host = new TauriFormHost(f.glue);
  const w = await host.openForm(snap('Form1'), { modal: false });
  f.fire('vb:hello', 'Form1');
  const p = host.messageBox({ prompt: 'Hi', title: 'T', buttons: 4 });
  await f.tick();
  const label = f.log.created[1].label, key = label.slice(2);   // vbdialog-<n> / dialog-<n>
  expect(label).toMatch(/^vbdialog-\d+$/);
  expect(f.log.created[1]).toMatchObject({ o: { url: `form.html#${key}`, alwaysOnTop: false, parent: 'vbform-Form1', decorations: false, visible: false } });
  f.fire('vb:hello', key);
  await f.tick();
  expect(f.log.emitted).toContainEqual([label, 'vb:dialog', { kind: 'msgbox', prompt: 'Hi', title: 'T', buttons: 4 }]);
  expect(f.log.emitted).toContainEqual(['vbform-Form1', 'vb:to', { t: 'blocked', blocked: true }]);
  f.fire('vb:from', { key, result: 7 });
  expect(await p).toBe(7);
  await f.tick();
  expect(f.log.destroyed).toEqual([label]);
  expect(f.log.emitted.at(-1)).toEqual(['vbform-Form1', 'vb:to', { t: 'blocked', blocked: false }]);
  await host.dispose();
  expect(f.log.destroyed).toEqual([label, 'vbform-Form1']);
  expect(f.listeners()).toBe(0);
  void w;
});

test('runDialog renders the run-time error dialog and returns the button value', async () => {
  const p = runDialog(document, { kind: 'error', info: { number: 13, description: 'Type mismatch', compile: false, mode: 'ide', title: 'P' } });
  const debug = [...document.querySelectorAll('button')].find(b => b.textContent === 'Debug')!;
  expect(document.body.textContent).toContain("Run-time error '13':");
  debug.click();
  expect(await p).toBe('debug');
});

test('dispose destroys a pending dialog window before resolving; OS-closed dialog answers Cancel', async () => {
  const f = fakeGlue();
  const host = new TauriFormHost(f.glue);
  const a = host.inputBox({ prompt: 'p', title: 't', defaultText: 'x' });
  await f.tick();
  expect(f.log.created[0].o.parent).toBe('main');   // no form window: owned by the IDE window
  f.fire('vb:from', { key: f.log.created[0].label.slice(2), cancelled: true });
  expect(await a).toBe('');
  const b = host.messageBox({ prompt: 'p', title: 't', buttons: 1 });
  await f.tick();
  await host.dispose();
  expect(f.log.destroyed).toEqual([f.log.created[0].label, f.log.created[1].label]);
  expect(await b).toBe(2);
});

test('cascade restarts when no forms are open', async () => {
  const f = fakeGlue();
  const host = new TauriFormHost(f.glue);
  const s = snap('Form1');
  s.form.props.StartUpPosition = 3;
  await (await host.openForm(s, { modal: false })).close();
  await host.openForm(s, { modal: false });
  expect(f.log.created.map(c => c.o.x)).toEqual([60, 60]);
});

test('dialog labels are unique across hosts (a late dispose of an old run cannot destroy a new dialog)', async () => {
  const f1 = fakeGlue(), f2 = fakeGlue();
  const old = new TauriFormHost(f1.glue), cur = new TauriFormHost(f2.glue);
  void old.messageBox({ prompt: 'a', title: 't', buttons: 0 });
  void cur.messageBox({ prompt: 'b', title: 't', buttons: 0 });
  await f1.tick();
  expect(f1.log.created[0].label).not.toBe(f2.log.created[0].label);
  await old.dispose();
  expect(f1.log.destroyed).toEqual([f1.log.created[0].label]);
  await cur.dispose();
});

test('a modal form and a dialog belong to the last visible form window', async () => {
  const f = fakeGlue();
  const host = new TauriFormHost(f.glue);
  await host.openForm(snap('Form1'), { modal: false });
  const w2 = await host.openForm(snap('Form2'), { modal: false });
  w2.send({ t: 'hide' });
  await host.openForm(snap('Form3'), { modal: true });
  expect(f.log.created[2].o).toMatchObject({ parent: 'vbform-Form1', alwaysOnTop: false });
  expect(f.log.created[1].o.parent).toBeUndefined();
  void host.messageBox({ prompt: 'p', title: 't', buttons: 0 });
  await f.tick();
  expect(f.log.created[3].o.parent).toBe('vbform-Form3');
  await host.dispose();
});

test('print job: the print window gets the pages on hello; once drawn, the main window asks for the print dialog on it; Close destroys it', async () => {
  const f = fakeGlue();
  const host = new TauriFormHost(f.glue);
  const b = getBackend(), asked: string[] = [];
  b.printWindow = async l => { asked.push(l); };
  try {
    const job: PrintJob = { title: 'T', device: '', copies: 1, paperSize: 9, pages: [{ paperW: 794, paperH: 1123, left: 24, top: 24, w: 746, h: 1075, ops: [] }] };
    const done = host.printPages(job);
    await f.tick();
    const label = f.log.created[0].label, key = label.slice('vbdialog-'.length);
    expect(label).toMatch(/^vbdialog-print-\d+$/);   // a run window (run-windows.json): no app commands
    expect(f.log.created[0].o).toMatchObject({ url: `form.html#${key}`, visible: false, decorations: false });
    f.fire('vb:hello', key);
    await f.tick();
    expect(f.log.emitted).toContainEqual([label, 'vb:print', job]);
    f.fire('vb:from', { key, result: 'ready' });
    await done;
    expect(asked).toEqual([label]);
    f.fire('vb:from', { key, result: 'close' });
    await f.tick(); await f.tick();
    expect(f.log.destroyed).toEqual([label]);
  } finally {
    delete b.printWindow;
  }
});
