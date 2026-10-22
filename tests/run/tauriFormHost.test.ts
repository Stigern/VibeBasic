// @vitest-environment jsdom
import { expect, test } from 'vitest';
import type { FormSnapshot, FromWindow } from '../../src/run/protocol';
import { runDialog } from '../../src/run/dialogSpec';
import { TauriFormHost, type TauriGlue } from '../../src/run/tauriFormHost';

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
  expect(f.log.created[0]).toMatchObject({ label: 'vbform-Form1', o: { url: 'form.html#Form1', decorations: false, visible: false, alwaysOnTop: true, width: 320, center: true } });
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

test('msgbox opens an always-on-top dialog window, blocks forms, returns the result', async () => {
  const f = fakeGlue();
  const host = new TauriFormHost(f.glue);
  const w = await host.openForm(snap('Form1'), { modal: false });
  f.fire('vb:hello', 'Form1');
  const p = host.messageBox({ prompt: 'Hi', title: 'T', buttons: 4 });
  await f.tick();
  expect(f.log.created[1]).toMatchObject({ label: 'vbdialog-1', o: { url: 'form.html#dialog-1', alwaysOnTop: true, decorations: false, visible: false } });
  f.fire('vb:hello', 'dialog-1');
  await f.tick();
  expect(f.log.emitted).toContainEqual(['vbdialog-1', 'vb:dialog', { kind: 'msgbox', prompt: 'Hi', title: 'T', buttons: 4 }]);
  expect(f.log.emitted).toContainEqual(['vbform-Form1', 'vb:to', { t: 'blocked', blocked: true }]);
  f.fire('vb:from', { key: 'dialog-1', result: 7 });
  expect(await p).toBe(7);
  await f.tick();
  expect(f.log.destroyed).toEqual(['vbdialog-1']);
  expect(f.log.emitted.at(-1)).toEqual(['vbform-Form1', 'vb:to', { t: 'blocked', blocked: false }]);
  await host.dispose();
  expect(f.log.destroyed).toEqual(['vbdialog-1', 'vbform-Form1']);
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
  f.fire('vb:from', { key: 'dialog-1', cancelled: true });
  expect(await a).toBe('');
  const b = host.messageBox({ prompt: 'p', title: 't', buttons: 1 });
  await f.tick();
  await host.dispose();
  expect(f.log.destroyed).toEqual(['vbdialog-1', 'vbdialog-2']);
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
