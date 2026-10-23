// @vitest-environment jsdom
// Answers without code (AI Answer dialog, Ask more...), the AI log, and the automatic retry of transient errors.
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { aiRetry, askAi } from '../../src/ai/askDialog';
import { aiLogEntries, aiLogRow, clearAiLog, showAiLog } from '../../src/ai/aiLog';
import { buildAiTab } from '../../src/ai/optionsTab';
import { AI_CUT_OFF } from '../../src/ai/sse';
import type { Backend } from '../../src/backend/backend';
import { IdeState } from '../../src/ide/ideState';
import { newControl, newProject } from '../../src/model/controls';

const KEY = 'sk-very-secret-4711';
const fakeBackend = (chat: (...a: any[]) => Promise<string>, settings: Record<string, unknown> = {}) => ({
  loadSettings: async () => ({ baseUrl: 'http://x/v1', apiKey: KEY, model: 'm', ...settings }),
  saveSettings: async () => {},
  aiListModels: async () => [],
  clipboardSetText: vi.fn(async () => {}),
  aiChat: vi.fn(chat),
}) as unknown as Backend & { aiChat: ReturnType<typeof vi.fn>; clipboardSetText: ReturnType<typeof vi.fn> };
const btn = (label: string) => [...document.querySelectorAll<HTMLButtonElement>('.dlg98 button')].find(b => b.textContent === label);
const click = (label: string) => btn(label)!.click();
const text = () => [...document.querySelectorAll('.dlg98')].map(d => d.textContent).join('|');
async function enterPrompt(t: string) {
  await vi.waitFor(() => expect(document.querySelector('.ai-prompt')).toBeTruthy());
  (document.querySelector('.ai-prompt') as HTMLTextAreaElement).value = t;
  click('OK');
}
function ide() {
  const s = new IdeState(newProject());
  const f = s.project.forms[0];
  f.code = 'Private Sub Command1_Click()\nEnd Sub';
  f.controls.push(newControl(f, 'CommandButton', { left: 100, top: 100 }, null));
  s.setActiveView({ kind: 'code', itemId: f.id });
  return s;
}
const codeWin = () => {
  const w = { src: 'Private Sub Command1_Click()\nEnd Sub', getSource: () => w.src, getCursorLine: () => 1, applyChange: vi.fn() };
  return w;
};
const ask = (b: Backend, w = codeWin()) => askAi(ide(), b, { codeWindowFor: () => w as any });
const PROSE = 'Command1_Click runs when the user clicks the button. It is empty now, so nothing happens.';
const GOOD = '```vb\nPrivate Sub Command1_Click()\n    MsgBox "Hi"\nEnd Sub\n```';

beforeEach(() => { clearAiLog(); aiRetry.delayMs = 1; });
afterEach(() => { document.body.innerHTML = ''; });

test('a prose reply opens the AI Answer dialog; a question shows code blocks in Courier; garbage stays "not understood"', async () => {
  const b = fakeBackend(async () => PROSE);
  const w = codeWin();
  const p = ask(b, w);
  await enterPrompt('add a button');
  await vi.waitFor(() => expect(document.querySelector('.ai-answer-box')).toBeTruthy());
  expect(text()).toContain('AI Answer');
  expect(text()).toContain('clicks the button');
  expect(text()).not.toContain('could not be understood');
  click('Copy');
  await vi.waitFor(() => expect(b.clipboardSetText).toHaveBeenCalledWith(PROSE));
  await vi.waitFor(() => expect(btn('OK')).toBeTruthy());
  click('OK');
  await p;
  expect(w.applyChange).not.toHaveBeenCalled();

  // A question gets the answer dialog even when the reply has a code block (no preview, no checks).
  const q = fakeBackend(async () => `It shows a message.\n${GOOD}`);
  const p2 = ask(q);
  await enterPrompt('What does Command1_Click do?');
  await vi.waitFor(() => expect(document.querySelector('pre.ai-answer-code')).toBeTruthy());
  expect(document.querySelector('pre.ai-answer-code')!.textContent).toContain('MsgBox "Hi"');
  expect(text()).not.toContain('AI Suggestion');
  click('OK');
  await p2;
  expect(q.aiChat).toHaveBeenCalledTimes(1);

  const g = fakeBackend(async () => '{"x": [1, 2, ### ;;; }');
  const p3 = ask(g);
  await enterPrompt('add a button');
  await vi.waitFor(() => expect(text()).toContain('could not be understood'));
  click('OK');
  await p3;
});

test('Ask more... continues the same conversation (prefix-identical), and a code reply then gets the preview', async () => {
  const replies = [PROSE, GOOD];
  const b = fakeBackend(async () => replies.shift()!);
  const w = codeWin();
  const p = ask(b, w);
  await enterPrompt('Why does nothing happen?');
  await vi.waitFor(() => expect(btn('Ask more...')).toBeTruthy());
  click('Ask more...');
  await vi.waitFor(() => expect(document.querySelector('.ai-ask-more')).toBeTruthy());
  (document.querySelector('.ai-ask-more') as HTMLInputElement).value = 'Then make it show Hi';
  click('OK');
  await vi.waitFor(() => expect(text()).toContain('AI Suggestion'));
  const [first, second] = b.aiChat.mock.calls.map(c => c[3]);
  expect(second.slice(0, first.length)).toEqual(first);
  expect(second.slice(first.length)).toEqual([{ role: 'assistant', content: PROSE }, { role: 'user', content: 'Then make it show Hi' }]);
  click('OK');
  await p;
  expect(w.applyChange).toHaveBeenCalledTimes(1);
});

test('the AI log records an ok and an error exchange with tokens, and shows them', async () => {
  const b = fakeBackend(async (...a: any[]) => {
    a[5].onDelta('reasoning', 'thinking hard');
    a[5].onUsage({ promptTokens: 1234, completionTokens: 56 });
    if (b.aiChat.mock.calls.length > 1) throw new Error(AI_CUT_OFF);
    a[5].onDelta('content', GOOD);
    return GOOD;
  });
  const p = ask(b);
  await enterPrompt('show hi');
  await vi.waitFor(() => expect(text()).toContain('AI Suggestion'));
  click('Cancel');
  await p;
  const p2 = ask(b);
  await enterPrompt('show hi again');
  await vi.waitFor(() => expect(text()).toContain('cut off'));
  click('OK');
  await p2;

  const [err, ok] = aiLogEntries();
  expect(aiLogRow(ok).slice(1)).toEqual(['code', 'm', '1,234', '56', expect.any(String), 'ok']);
  expect(aiLogRow(err).slice(1)).toEqual(['code', 'm', '1,234', '56', expect.any(String), 'error']);
  expect(err.error).toBe(AI_CUT_OFF);
  expect(ok.sent).toContain('--- user ---');
  expect(ok.sent).toContain('show hi');
  expect(ok.reply).toBe(GOOD);

  const shown = showAiLog(document, () => {});
  await vi.waitFor(() => expect(document.querySelectorAll('.ai-log-row').length).toBe(2));
  document.querySelectorAll<HTMLElement>('.ai-log-row')[1].dispatchEvent(new MouseEvent('mousedown'));
  expect(document.querySelector('.ai-log-reply .ai-thinking')!.textContent).toContain('thinking hard');
  expect(document.querySelector('.ai-log-reply .ai-answer')!.textContent).toBe(GOOD);
  expect(document.querySelector('.ai-log-sent')!.textContent).toContain('show hi');
  click('Close');
  await shown;
});

test('the API key never appears in the log, also not from a Test Connection error', async () => {
  const b = fakeBackend(async () => { throw new Error(`The AI server answered 400 Bad Request: bad token ${KEY}`); });
  const p = ask(b);
  await enterPrompt('x');
  await vi.waitFor(() => expect(text()).toContain('bad token'));
  click('OK');
  await p;
  const tab = buildAiTab({ loadSettings: async () => null, saveSettings: async () => {}, aiListModels: async () => { throw new Error(`refused ${KEY}`); } }, document);
  tab.controls.apiKey.value = KEY;
  const t = tab.controls.testConnection();
  await vi.waitFor(() => expect(btn('OK')).toBeTruthy());
  click('OK');
  await t;
  expect(aiLogEntries().map(e => e.mode)).toEqual(['test', 'code']);
  expect(aiLogEntries()[0].status).toBe('error');
  expect(JSON.stringify(aiLogEntries())).not.toContain(KEY);
  const shown = showAiLog(document, () => {});
  for (const row of document.querySelectorAll<HTMLElement>('.ai-log-row')) {
    row.dispatchEvent(new MouseEvent('mousedown'));
    expect(document.querySelector('.dlg98')!.textContent).not.toContain(KEY);
  }
  click('Close');
  await shown;
});

test('a 503 is retried once after a pause, showing Retrying...', async () => {
  aiRetry.delayMs = 50;
  const b = fakeBackend(async () => { throw new Error('The AI server answered 503 Service Unavailable: overloaded'); });
  const p = ask(b);
  await enterPrompt('x');
  await vi.waitFor(() => expect(text()).toContain('Retrying...'));
  await vi.waitFor(() => expect(text()).toContain('overloaded'));
  click('OK');
  await p;
  expect(b.aiChat).toHaveBeenCalledTimes(2);
  expect(aiLogEntries().map(e => [e.mode, e.status])).toEqual([['retry', 'error'], ['code', 'error']]);
  // a retry that works gives the normal preview
  const replies: (() => string)[] = [() => { throw new Error('Could not connect to http://x/v1. (Details: Connection refused)'); }, () => GOOD];
  const c = fakeBackend(async () => replies.shift()!());
  const p2 = ask(c);
  await enterPrompt('x');
  await vi.waitFor(() => expect(text()).toContain('AI Suggestion'));
  click('Cancel');
  await p2;
  expect(c.aiChat).toHaveBeenCalledTimes(2);
});
