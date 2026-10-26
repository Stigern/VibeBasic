// @vitest-environment jsdom
// Regression tests for the live evaluation (tests-live/report.md): thinking levels a server does not take, replies that are only
// thinking, and questions.
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { askAi, runCodeConversation } from '../../src/ai/askDialog';
import { questionMode } from '../../src/ai/answerDialog';
import { thinkingOnly } from '../../src/ai/clean';
import { effortFor, nearestEffort, probeEfforts, resetEfforts, retryEffort, supportedEfforts } from '../../src/ai/effort';
import { buildAiTab } from '../../src/ai/optionsTab';
import type { Backend } from '../../src/backend/backend';
import { BrowserBackend } from '../../src/backend/browserBackend';
import { IdeState } from '../../src/ide/ideState';
import { newControl, newProject } from '../../src/model/controls';
import type { ControlType } from '../../src/model/types';

const EFFORT_400 = 'The AI server answered 400 Bad Request: Unexpected reasoning effort high. Supported types are xhigh (default), medium, and low.';

const fakeBackend = (replies: (string | (() => string))[], settings: Record<string, unknown> = {}) => {
  let i = 0;
  return {
    loadSettings: async () => ({ baseUrl: 'http://x/v1', model: 'm', apiKey: '', ...settings }),
    saveSettings: async () => {},
    aiListModels: async () => [],
    aiChat: vi.fn(async () => { const r = replies[Math.min(i++, replies.length - 1)]; return typeof r === 'function' ? r() : r; }),
  } as unknown as Backend & { aiChat: ReturnType<typeof vi.fn> };
};
const btn = (label: string) => [...document.querySelectorAll<HTMLButtonElement>('.dlg98 button')].find(b => b.textContent === label);
const click = (label: string) => btn(label)!.click();
const text = () => [...document.querySelectorAll('.dlg98')].map(d => d.textContent).join('|');
async function enterPrompt(t: string) {
  await vi.waitFor(() => expect(btn('OK')).toBeTruthy());
  (document.querySelector('.ai-prompt') as HTMLTextAreaElement).value = t;
  click('OK');
}
const codeWin = (src: string) => {
  const w = { src, getSource: () => w.src, getCursorLine: () => 1, applyChange: vi.fn((a: number, b: number, t: string) => { w.src = w.src.slice(0, a) + t + w.src.slice(b); }) };
  return w;
};
function ide(view: 'code' | 'designer', controls: [Exclude<ControlType, 'Form'>, string][] = [['CommandButton', 'Command1']]) {
  const s = new IdeState(newProject());
  const f = s.project.forms[0];
  f.code = 'Private Sub Command1_Click()\nEnd Sub';
  for (const [type, name] of controls) { const c = newControl(f, type, { left: 120, top: 120 }, null); c.name = name; f.controls.push(c); }
  s.setActiveView(view === 'code' ? { kind: 'code', itemId: f.id } : { kind: 'designer', formId: f.id });
  return s;
}
beforeEach(() => resetEfforts());
afterEach(() => { document.body.innerHTML = ''; });

// ---------------------------------------------------------------------------------------------------------------
// 1. Thinking levels the server does not take

test('effort: the levels of a 400 are read; the nearest one (the lower on a tie) is chosen', () => {
  expect(supportedEfforts(EFFORT_400)).toEqual(['xhigh', 'medium', 'low']);
  expect(supportedEfforts('The AI server answered 400 Bad Request: max_tokens too large')).toBeNull();
  expect(nearestEffort('high', ['xhigh', 'medium', 'low'])).toBe('medium');
  expect(nearestEffort('low', ['medium', 'high'])).toBe('medium');
  expect(nearestEffort('medium', ['low', 'medium'])).toBe('medium');
  // remembered per base URL for the session
  expect(retryEffort('http://a/v1', 'high', EFFORT_400)).toBe('medium');
  expect(effortFor('http://a/v1/', 'high')).toBe('medium');
  expect(effortFor('http://a/v1', 'low')).toBe('low');
  expect(effortFor('http://b/v1', 'high')).toBe('high');
  // the same level again is no retry
  expect(retryEffort('http://a/v1', 'medium', EFFORT_400)).toBeUndefined();
});

test('Thinking High on a server without it: one retry at Medium, and Medium from then on', async () => {
  const w = codeWin('Private Sub Command1_Click()\nEnd Sub');
  const good = '```vb\nPrivate Sub Command1_Click()\n    MsgBox "Hi"\nEnd Sub\n```';
  let calls = 0;
  const b = fakeBackend([], { thinking: 'high' });
  b.aiChat.mockImplementation(async (_u: string, _k: string, _m: string, _msgs: unknown, effort?: string) => {
    calls++;
    if (effort === 'high') throw new Error(EFFORT_400);
    return good;
  });
  const p = askAi(ide('code'), b, { codeWindowFor: () => w as any });
  await enterPrompt('x');
  await vi.waitFor(() => expect(text()).toContain('AI Suggestion'));
  expect(b.aiChat.mock.calls.map(c => c[4])).toEqual(['high', 'medium']);
  click('Cancel');
  await p;
  const p2 = askAi(ide('code'), b, { codeWindowFor: () => w as any });
  await enterPrompt('y');
  await vi.waitFor(() => expect(text()).toContain('AI Suggestion'));
  expect(b.aiChat.mock.calls.slice(2).map(c => c[4])).toEqual(['medium']);
  expect(calls).toBe(3);
  click('Cancel');
  await p2;
});

test('the browser backend reports the 400 alike, so the same retry works there (the Rust side: reasoning_effort_400_keeps_the_supported_levels)', async () => {
  const real = globalThis.fetch;
  globalThis.fetch = (async () => new Response(JSON.stringify({ error: { message: 'Unexpected reasoning effort high. Supported types are xhigh (default), medium, and low.', code: 400 } }),
    { status: 400, statusText: 'Bad Request', headers: { 'content-type': 'application/json' } })) as typeof fetch;
  try {
    const e = await new BrowserBackend().aiChat('http://x/v1', '', 'm', [{ role: 'user', content: 'hi' }], 'high', { onDelta: () => {} }).catch(x => x as Error);
    expect((e as Error).message).toBe(EFFORT_400);
    expect(supportedEfforts((e as Error).message)).toEqual(['xhigh', 'medium', 'low']);
  } finally { globalThis.fetch = real; }
});

test('Test Connection shows the levels, says how High is sent, and picks Medium for a user on Server default', async () => {
  const store = new Map<string, unknown>();
  const b = {
    loadSettings: async <T,>(k: string) => (store.get(k) as T) ?? null,
    saveSettings: async (k: string, v: unknown) => { store.set(k, v); },
    aiListModels: vi.fn(async () => [{ id: 'q', ownedBy: 'vllm' }]),
    aiChat: vi.fn(async (_u: string, _k: string, _m: string, _msgs: unknown, effort?: string, _o?: unknown) => {
      if (effort) throw new Error(EFFORT_400.replace('effort high', `effort ${effort}`));
      return 'OK';
    }),
  };
  const tab = buildAiTab(b, document);
  await new Promise(r => setTimeout(r, 0));
  tab.controls.model.setValue('q');
  tab.controls.thinking.setValue('Server default');
  const p = tab.controls.testConnection();
  await vi.waitFor(() => expect(document.body.textContent).toContain('Thinking levels it accepts: xhigh (default), medium, low. High is sent as medium.'));
  expect(document.body.textContent).toContain('Thinking is now set to Medium');
  [...document.querySelectorAll('button')].find(x => x.textContent === 'OK')!.click();
  await p;
  expect(tab.controls.thinking.getValue()).toBe('Medium');
  // the probe is one tiny request at a level no server has
  const probe = b.aiChat.mock.calls.find(c => c[4]);
  expect(probe?.[5]).toMatchObject({ maxTokens: 1 });
  expect(await probeEfforts({ aiChat: async () => 'OK' }, 'http://y/v1', '', 'm')).toBeNull();
});

// ---------------------------------------------------------------------------------------------------------------
// 6. A reply that is only thinking

test('reasoning-only output fails in code mode and for questions', async () => {
  const thinking = '<think>Maybe:\n```vb\nPrivate Sub Command1_Click()\n    End\nEnd Sub\n```</think>';
  expect(thinkingOnly(thinking)).toMatch(/^Maybe:/);
  expect(thinkingOnly('<think>a</think>answer')).toBeNull();
  const w = codeWin('Private Sub Command1_Click()\nEnd Sub');
  const s = ide('code');
  const b = fakeBackend([thinking]);
  const done = runCodeConversation({ ide: s, backend: b, settings: { baseUrl: 'http://x/v1', model: 'm', apiKey: '', thinking: 'server' }, doc: document },
    { first: [{ role: 'user', content: 'x' }], itemId: s.project.forms[0].id, codeWin: w as any });
  await vi.waitFor(() => expect(text()).toContain('reasoning without a final answer'));
  click('OK');
  expect(await done).toBe(false);
  expect(w.applyChange).not.toHaveBeenCalled();
  const q = runCodeConversation({ ide: s, backend: fakeBackend(['<think>It shows a message.</think>']), settings: { baseUrl: 'http://x/v1', model: 'm', apiKey: '', thinking: 'server' }, doc: document },
    { first: [{ role: 'user', content: 'x' }], itemId: s.project.forms[0].id, codeWin: w as any, question: true });
  await vi.waitFor(() => expect(text()).toContain('reasoning without a final answer'));
  expect(document.querySelector('.ai-answer-box')).toBeNull();
  click('OK');
  expect(await q).toBe(false);
});

// ---------------------------------------------------------------------------------------------------------------
// 10. Questions

test('questionMode: questions, polite requests that may carry code, and change requests', () => {
  for (const q of ['How do I make an MDI app?', 'how can I sort a list', 'Can I use ADO here?', 'Is this correct?', 'Is there a way to...', 'Can you explain this?', 'What does it do?'])
    expect(questionMode(q)).toBe(true);
  expect(questionMode('Can you add a Clear button?')).toBe('unless-code');
  expect(questionMode('Add a Clear button')).toBe(false);
});

test('"Can you ..." with a code answer is a proposal; with a prose answer an answer', async () => {
  const w = codeWin('Private Sub Command1_Click()\nEnd Sub');
  const p = askAi(ide('code'), fakeBackend(['```vb\nPrivate Sub Command1_Click()\n    MsgBox "Hi"\nEnd Sub\n```']), { codeWindowFor: () => w as any });
  await enterPrompt('Can you make the button say hi?');
  await vi.waitFor(() => expect(text()).toContain('AI Suggestion'));
  click('OK');
  await p;
  expect(w.src).toContain('MsgBox "Hi"');
  const p2 = askAi(ide('code'), fakeBackend(['Yes: set the Caption of the button in Form_Load to the text you want.']), { codeWindowFor: () => w as any });
  await enterPrompt('Can you change the caption at run time?');
  await vi.waitFor(() => expect(text()).toContain('AI Answer'));
  click('OK');
  await p2;
});
