// @vitest-environment jsdom
// Request options: structured output in form mode (with its fallback), fast follow-up rounds, max_tokens.
import { afterEach, expect, test, vi } from 'vitest';
import { askAi, formatMetrics, maxTokensFor } from '../../src/ai/askDialog';
import { FORM_RESPONSE_FORMAT } from '../../src/ai/formMode';
import type { Backend } from '../../src/backend/backend';
import { IdeState } from '../../src/ide/ideState';
import { newControl, newProject } from '../../src/model/controls';

const fakeBackend = (settings: Record<string, unknown>, chat: (...a: any[]) => Promise<string>) => ({
  loadSettings: async () => ({ baseUrl: 'http://x/v1', apiKey: '', ...settings }),
  saveSettings: async () => {},
  aiListModels: async () => [],
  aiChat: vi.fn(chat),
}) as unknown as Backend & { aiChat: ReturnType<typeof vi.fn> };
const btn = (label: string) => [...document.querySelectorAll<HTMLButtonElement>('.dlg98 button')].find(b => b.textContent === label);
const click = (label: string) => btn(label)!.click();
const text = () => [...document.querySelectorAll('.dlg98')].map(d => d.textContent).join('|');
async function enterPrompt(t: string) {
  await vi.waitFor(() => expect(document.querySelector('.ai-prompt')).toBeTruthy());
  (document.querySelector('.ai-prompt') as HTMLTextAreaElement).value = t;
  click('OK');
}
async function change(wish: string) {
  await vi.waitFor(() => expect(btn('Change...')).toBeTruthy());
  click('Change...');
  await vi.waitFor(() => expect(document.querySelector('.ai-change')).toBeTruthy());
  (document.querySelector('.ai-change') as HTMLInputElement).value = wish;
  click('OK');
}
function ide(view: 'code' | 'designer') {
  const s = new IdeState(newProject());
  const f = s.project.forms[0];
  f.code = 'Private Sub Command1_Click()\nEnd Sub';
  f.controls.push(newControl(f, 'CommandButton', { left: 100, top: 100 }, null));
  s.setActiveView(view === 'code' ? { kind: 'code', itemId: f.id } : { kind: 'designer', formId: f.id });
  return s;
}
const codeWin = () => {
  const w = { src: 'Private Sub Command1_Click()\nEnd Sub', getSource: () => w.src, getCursorLine: () => 1, applyChange: vi.fn() };
  return w;
};
afterEach(() => { document.body.innerHTML = ''; });

const OPS = '{"ops":[{"op":"set","name":"Command1","props":{"Caption":"Go"}}]}';
const GOOD = '```vb\nPrivate Sub Command1_Click()\n    MsgBox "Hi"\nEnd Sub\n```';
const BAD_SYNTAX = '```vb\nPrivate Sub Command1_Click()\n    If x Then\nEnd Sub\n```';
const opts = (b: { aiChat: ReturnType<typeof vi.fn> }, i: number) => b.aiChat.mock.calls[i][5];

async function askForm(b: Backend) {
  const p = askAi(ide('designer'), b, { codeWindowFor: () => null });
  await enterPrompt('x');
  await vi.waitFor(() => expect(text()).toContain('AI Suggestion'));
  click('Cancel');
  await p;
}

test('form request includes response_format (json_schema form_ops) and max_tokens', async () => {
  const b = fakeBackend({ model: 'schema-ok' }, async () => OPS);
  await askForm(b);
  expect(opts(b, 0).responseFormat).toEqual(FORM_RESPONSE_FORMAT);
  expect(opts(b, 0).responseFormat.json_schema.name).toBe('form_ops');
  expect(opts(b, 0).maxTokens).toBe(8192 + 16384);
});

test('a 400 about response_format is retried at once without it, and later requests skip it', async () => {
  const b = fakeBackend({ model: 'no-schema' }, async (...a: any[]) => {
    if (a[5]?.responseFormat) throw new Error("The AI server answered 400 Bad Request: unknown field 'response_format'");
    return OPS;
  });
  await askForm(b);
  expect(b.aiChat).toHaveBeenCalledTimes(2);
  expect(opts(b, 0).responseFormat).toBeDefined();
  expect(opts(b, 1).responseFormat).toBeUndefined();
  await askForm(b);
  expect(b.aiChat).toHaveBeenCalledTimes(3);
  expect(opts(b, 2).responseFormat).toBeUndefined();
  // other errors are not retried
  const c = fakeBackend({ model: 'other-error' }, async () => { throw new Error('The AI server answered 500 Internal Server Error: boom'); });
  const p = askAi(ide('designer'), c, { codeWindowFor: () => null });
  await enterPrompt('x');
  await vi.waitFor(() => expect(text()).toContain('boom'));
  click('OK');
  await p;
  expect(c.aiChat).toHaveBeenCalledTimes(1);
});

/** The thinking levels sent: first answer, its check-and-fix retry, then a Change... round. */
async function levels(settings: Record<string, unknown>) {
  const replies = [BAD_SYNTAX, GOOD, GOOD];
  const b = fakeBackend({ model: 'm', ...settings }, async () => replies.shift()!);
  const w = codeWin();
  const p = askAi(ide('code'), b, { codeWindowFor: () => w as any });
  await enterPrompt('x');
  await change('more');
  await vi.waitFor(() => expect(b.aiChat).toHaveBeenCalledTimes(3));
  await vi.waitFor(() => expect(btn('Cancel')).toBeTruthy());
  click('Cancel');
  await p;
  expect(opts(b, 0).responseFormat).toBeUndefined();   // code mode: no schema
  return { levels: b.aiChat.mock.calls.map(c => c[4]), maxTokens: b.aiChat.mock.calls.map(c => c[5].maxTokens) };
}

test('follow-up rounds think low only with Fast follow-up rounds on and a thinking level set', async () => {
  expect(await levels({ thinking: 'high' })).toEqual({ levels: ['high', 'low', 'low'], maxTokens: [24576, 12288, 12288] });
  expect((await levels({ thinking: 'medium', fastFollowUp: false })).levels).toEqual(['medium', 'medium', 'medium']);
  expect((await levels({ thinking: 'server' })).levels).toEqual([undefined, undefined, undefined]);
});

test('max_tokens is lowered to fit a known context, or left out when it cannot', () => {
  expect(maxTokensFor('low', undefined, 1000)).toBe(12288);
  expect(maxTokensFor('low', 262144, 30000)).toBe(12288);
  expect(maxTokensFor('low', 32768, 90000)).toBe(32768 - 30000 - 256);
  expect(maxTokensFor('high', 8192, 30000)).toBeUndefined();
});

test('without prompt_tokens_details the metrics line still shows the tokens, and nothing else', () => {
  expect(formatMetrics({ promptTokens: 3210, completionTokens: 41 }, 41000)).toBe('3,210 prompt tokens · 41 s');
});
