// @vitest-environment jsdom
import { afterEach, expect, test } from 'vitest';
import { runtimeErrorContent, type RuntimeErrorInfo } from '../../src/run/errorDialog';
import { InlineFormHost } from '../../src/run/inlineFormHost';

afterEach(() => { document.body.innerHTML = ''; });
const info = (o: Partial<RuntimeErrorInfo>): RuntimeErrorInfo => ({ number: 11, description: 'Division by zero', compile: false, mode: 'ide', title: 'P', ...o });
const labels = (o: Partial<RuntimeErrorInfo>) => runtimeErrorContent(info(o)).buttons.map(b => b.label);

test('Ask AI sits between Debug and Help in the IDE, after OK for a compile error, and never in a made app', () => {
  expect(labels({})).toEqual(['Continue', 'End', 'Debug', 'Ask AI', 'Help']);
  expect(labels({ compile: true })).toEqual(['OK', 'Ask AI', 'Help']);
  expect(runtimeErrorContent(info({})).buttons.find(b => b.label === 'Ask AI')).toEqual({ label: 'Ask AI', value: 'ai' });
  expect(labels({ mode: 'app' })).toEqual(['OK']);
  expect(labels({ mode: 'app', compile: true })).toEqual(['OK']);
});

test('the inline host answers ai when Ask AI is pressed', async () => {
  const host = new InlineFormHost(document.body.appendChild(document.createElement('div')));
  const p = host.runtimeErrorBox(info({}));
  [...document.querySelectorAll<HTMLButtonElement>('.dlg98 button')].find(b => b.textContent === 'Ask AI')!.click();
  expect(await p).toBe('ai');
});

test('the Tauri host passes ai back from the dialog window', async () => {
  const { TauriFormHost } = await import('../../src/run/tauriFormHost');
  const handlers = new Map<string, ((p: unknown) => void)[]>();
  const created: string[] = [];
  const host = new TauriFormHost({
    async createWindow(label) { created.push(label); return { destroy: async () => {} }; },
    async listen(ev, cb) { (handlers.get(ev) ?? handlers.set(ev, []).get(ev)!).push(cb as (p: unknown) => void); return () => {}; },
    async emitTo() {},
  });
  const p = host.runtimeErrorBox(info({}));
  await new Promise(r => setTimeout(r, 0));
  for (const h of handlers.get('vb:from') ?? []) h({ key: created[0].slice(2), result: 'ai' });
  expect(await p).toBe('ai');
});
