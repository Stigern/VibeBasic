// @vitest-environment jsdom
import { afterEach, expect, test, vi } from 'vitest';
import { askAi } from '../../src/ai/askDialog';
import type { AiChatOptions } from '../../src/ai/sse';
import type { Backend } from '../../src/backend/backend';
import { IdeState } from '../../src/ide/ideState';
import { newControl, newProject } from '../../src/model/controls';

type Call = { opts: AiChatOptions; resolve: (t: string) => void; reject: (e: Error) => void };
const fakeBackend = () => {
  const calls: Call[] = [];
  const b = {
    loadSettings: async () => ({ baseUrl: 'http://x/v1', model: 'm', apiKey: '' }),
    saveSettings: async () => {},
    aiListModels: async () => [],
    aiChat: vi.fn((_u: string, _k: string, _m: string, _msgs: unknown, _e: unknown, opts: AiChatOptions) =>
      new Promise<string>((resolve, reject) => { calls.push({ opts, resolve, reject }); })),
  } as unknown as Backend & { aiChat: ReturnType<typeof vi.fn> };
  return { b, calls };
};
const btn = (label: string) => [...document.querySelectorAll<HTMLButtonElement>('.dlg98 button')].find(b => b.textContent === label);
const text = () => [...document.querySelectorAll('.dlg98')].map(d => d.textContent).join('|');
const box = () => document.querySelector<HTMLElement>('.ai-stream')!;
async function enterPrompt(t: string) {
  await vi.waitFor(() => expect(btn('OK')).toBeTruthy());
  (document.querySelector('.ai-prompt') as HTMLTextAreaElement).value = t;
  btn('OK')!.click();
}
const codeWin = (src: string) => {
  const w = { src, getSource: () => w.src, getCursorLine: () => 1, applyChange: vi.fn((a: number, b: number, t: string) => { w.src = w.src.slice(0, a) + t + w.src.slice(b); }) };
  return w;
};
function ide() {
  const s = new IdeState(newProject());
  const f = s.project.forms[0];
  f.code = 'Private Sub Command1_Click()\nEnd Sub';
  f.controls.push(newControl(f, 'CommandButton', { left: 100, top: 100 }, null));
  s.setActiveView({ kind: 'code', itemId: f.id });
  return s;
}
afterEach(() => { document.body.innerHTML = ''; });

const GOOD = '```vb\nPrivate Sub Command1_Click()\n    MsgBox "Hi"\nEnd Sub\n```';
const BAD_SYNTAX = '```vb\nPrivate Sub Command1_Click()\n    If x Then\nEnd Sub\n```';

test('streamed deltas show in the box (thinking grey, answer black) and nothing is applied before OK', async () => {
  const w = codeWin('Private Sub Command1_Click()\nEnd Sub');
  const { b, calls } = fakeBackend();
  const p = askAi(ide(), b, { codeWindowFor: () => w as any });
  await enterPrompt('x');
  await vi.waitFor(() => expect(calls).toHaveLength(1));
  expect(text()).toContain('Waiting for m...');
  calls[0].opts.onDelta!('reasoning', 'Let me ');
  calls[0].opts.onDelta!('reasoning', 'think.');
  calls[0].opts.onDelta!('content', 'Here');
  calls[0].opts.onDelta!('content', ' it is');
  await vi.waitFor(() => expect(box().textContent).toBe('Let me think.\n\nHere it is'));
  const spans = [...box().querySelectorAll<HTMLElement>('span')];
  expect(spans.map(s => s.style.color)).toEqual(['rgb(128, 128, 128)', 'rgb(0, 0, 0)']);
  expect(spans[0].textContent).toBe('Let me think.');
  expect(w.applyChange).not.toHaveBeenCalled();
  calls[0].resolve(GOOD);
  await vi.waitFor(() => expect(text()).toContain('AI Suggestion'));
  expect(w.applyChange).not.toHaveBeenCalled();
  btn('OK')!.click();
  await p;
  expect(w.applyChange).toHaveBeenCalledTimes(1);
});

test('the retry keeps streaming into the same text after a separator line', async () => {
  const w = codeWin('Private Sub Command1_Click()\nEnd Sub');
  const { b, calls } = fakeBackend();
  const p = askAi(ide(), b, { codeWindowFor: () => w as any });
  await enterPrompt('x');
  await vi.waitFor(() => expect(calls).toHaveLength(1));
  calls[0].opts.onDelta!('content', 'first');
  calls[0].resolve(BAD_SYNTAX);
  await vi.waitFor(() => expect(calls).toHaveLength(2));
  expect(text()).toContain('Checking and fixing...');
  await vi.waitFor(() => expect(box().textContent).toContain('first'));
  calls[1].opts.onDelta!('reasoning', 'again');
  await vi.waitFor(() => expect(box().textContent).toBe('first\n\n--- Checking and fixing ---\n\nagain'));
  calls[1].resolve(GOOD);
  await vi.waitFor(() => expect(text()).toContain('AI Suggestion'));
  btn('Cancel')!.click();
  await p;
  expect(w.applyChange).not.toHaveBeenCalled();
});

test('Cancel aborts the stream and discards a late reply', async () => {
  const w = codeWin('Private Sub Command1_Click()\nEnd Sub');
  const { b, calls } = fakeBackend();
  const p = askAi(ide(), b, { codeWindowFor: () => w as any });
  await enterPrompt('x');
  await vi.waitFor(() => expect(calls).toHaveLength(1));
  expect(calls[0].opts.signal!.aborted).toBe(false);
  btn('Cancel')!.click();
  await p;
  expect(calls[0].opts.signal!.aborted).toBe(true);
  calls[0].resolve(GOOD);
  await new Promise(r => setTimeout(r, 20));
  expect(document.querySelector('.dlg98')).toBeNull();
  expect(w.applyChange).not.toHaveBeenCalled();
});

test('the preview shows the measurement line; without usage from the server only the time', async () => {
  const w = codeWin('Private Sub Command1_Click()\nEnd Sub');
  const { b, calls } = fakeBackend();
  const p = askAi(ide(), b, { codeWindowFor: () => w as any });
  await enterPrompt('x');
  await vi.waitFor(() => expect(calls).toHaveLength(1));
  calls[0].opts.onUsage!({ promptTokens: 3210, completionTokens: 41, cachedTokens: 2900 });
  calls[0].resolve(GOOD);
  await vi.waitFor(() => expect(document.querySelector('.ai-metrics')?.textContent).toMatch(/^3,210 prompt tokens \(2,900 cached\) · \d+ s$/));
  btn('Cancel')!.click();
  await p;

  const w2 = codeWin('Private Sub Command1_Click()\nEnd Sub');
  const f2 = fakeBackend();
  const p2 = askAi(ide(), f2.b, { codeWindowFor: () => w2 as any });
  await enterPrompt('x');
  await vi.waitFor(() => expect(f2.calls).toHaveLength(1));
  f2.calls[0].resolve(GOOD);
  await vi.waitFor(() => expect(document.querySelector('.ai-metrics')?.textContent).toMatch(/^\d+ s$/));
  btn('Cancel')!.click();
  await p2;
});

test('the waiting dialog shows the animation, follows the delta kind, and removes it when closed', async () => {
  const w = codeWin('Private Sub Command1_Click()\nEnd Sub');
  const { b, calls } = fakeBackend();
  vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] });
  try {
    const p = askAi(ide(), b, { codeWindowFor: () => w as any });
    await enterPrompt('x');
    await vi.waitFor(() => expect(calls).toHaveLength(1));
    const anim = () => document.querySelector<HTMLElement>('.dlg98 .ai-anim');
    expect(anim()?.querySelector('svg')).toBeTruthy();
    expect(anim()!.dataset.phase).toBe('thinking');
    calls[0].opts.onDelta!('content', 'x');
    expect(anim()!.dataset.phase).toBe('writing');
    const timers = vi.getTimerCount();
    btn('Cancel')!.click();
    await p;
    expect(anim()).toBeNull();
    expect(vi.getTimerCount()).toBeLessThan(timers);
    expect(vi.getTimerCount()).toBe(0);
  } finally { vi.useRealTimers(); }
});
