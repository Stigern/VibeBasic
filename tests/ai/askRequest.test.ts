// @vitest-environment jsdom
// Request options: structured output in form mode (response_format, or structured_outputs on vLLM, with the fallbacks),
// fast follow-up rounds, max_tokens.
import { afterEach, expect, test, vi } from 'vitest';
import { askAi, formatMetrics, maxTokensFor } from '../../src/ai/askDialog';
import { FORM_RESPONSE_FORMAT, FORM_STRUCTURED_OUTPUTS } from '../../src/ai/formMode';
import { AI_CUT_OFF } from '../../src/ai/sse';
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

test('form request includes response_format (json_schema form_ops) and max_tokens on an unknown or openai server', async () => {
  for (const serverKind of [undefined, 'openai']) {
    const b = fakeBackend({ model: `schema-ok-${serverKind}`, serverKind }, async () => OPS);
    await askForm(b);
    expect(opts(b, 0).responseFormat).toEqual(FORM_RESPONSE_FORMAT);
    expect(opts(b, 0).responseFormat.json_schema.name).toBe('form_ops');
    expect(opts(b, 0).structuredOutputs).toBeUndefined();
    expect(opts(b, 0).maxTokens).toBe(16384 + 16384);
  }
});

test('on vLLM the form request sends structured_outputs (no whitespace) instead of response_format', async () => {
  const b = fakeBackend({ model: 'vllm-ok', serverKind: 'vllm' }, async () => OPS);
  await askForm(b);
  expect(opts(b, 0).structuredOutputs).toEqual(FORM_STRUCTURED_OUTPUTS);
  expect(opts(b, 0).structuredOutputs.disable_any_whitespace).toBe(true);
  expect(opts(b, 0).responseFormat).toBeUndefined();
});

test('a 400 about structured_outputs on vLLM falls back the same way', async () => {
  const b = fakeBackend({ model: 'vllm-400', serverKind: 'vllm' }, async (...a: any[]) => {
    if (a[5]?.structuredOutputs) throw new Error('The AI server answered 400 Bad Request: Grammar error: Invalid type');
    return OPS;
  });
  await askForm(b);
  expect(b.aiChat).toHaveBeenCalledTimes(2);
  expect(opts(b, 1).structuredOutputs).toBeUndefined();
  await askForm(b);
  expect(opts(b, 2).structuredOutputs).toBeUndefined();
});

test('a structured reply cut off with only whitespace after { is retried without structured output, for the session', async () => {
  const b = fakeBackend({ model: 'runaway', serverKind: 'vllm' }, async (...a: any[]) => {
    if (!a[5]?.structuredOutputs) return OPS;
    a[5].onDelta('content', `{"ops"${' '.repeat(500)}`);
    throw new Error(AI_CUT_OFF);
  });
  await askForm(b);
  expect(b.aiChat).toHaveBeenCalledTimes(2);
  expect(opts(b, 1).structuredOutputs).toBeUndefined();
  await askForm(b);
  expect(b.aiChat).toHaveBeenCalledTimes(3);
  expect(opts(b, 2).structuredOutputs).toBeUndefined();
  // a real cut-off (text, not whitespace) is not retried
  const c = fakeBackend({ model: 'cut', serverKind: 'vllm' }, async (...a: any[]) => { a[5].onDelta('content', '{"ops":[{"op":"set","name":"Command1"'); throw new Error(AI_CUT_OFF); });
  const p = askAi(ide('designer'), c, { codeWindowFor: () => null });
  await enterPrompt('x');
  await vi.waitFor(() => expect(text()).toContain('cut off'));
  click('OK');
  await p;
  expect(c.aiChat).toHaveBeenCalledTimes(1);
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
  const c = fakeBackend({ model: 'other-error' }, async () => { throw new Error('The AI server answered 400 Bad Request: boom'); });
  const p = askAi(ide('designer'), c, { codeWindowFor: () => null });
  await enterPrompt('x');
  await vi.waitFor(() => expect(text()).toContain('boom'));
  click('OK');
  await p;
  expect(c.aiChat).toHaveBeenCalledTimes(1);
});

test('a whitespace runaway is stopped as soon as it streams in (not at max_tokens) and retried without structured output', async () => {
  const b = fakeBackend({ model: 'runaway-early' }, (...a: any[]) => {
    if (!a[5]?.responseFormat) return Promise.resolve(OPS);
    a[5].onDelta('content', '{"ops"');
    a[5].onDelta('content', ' '.repeat(100));
    const signal = a[5].signal as AbortSignal;
    return new Promise<string>((_, reject) => {
      if (signal.aborted) reject(new Error('cancelled'));
      signal.addEventListener('abort', () => reject(new Error('cancelled')));
    });
  });
  await askForm(b);
  expect(b.aiChat).toHaveBeenCalledTimes(2);
  expect(opts(b, 1).responseFormat).toBeUndefined();
});

test('a server that rejects max_tokens gets the request again at once without it, and later requests skip it', async () => {
  const b = fakeBackend({ model: 'no-max-tokens' }, async (...a: any[]) => {
    if (a[5]?.maxTokens !== undefined) throw new Error('The AI server answered 400: max_tokens is too large: 24576. This model supports at most 16384 completion tokens.');
    return OPS;
  });
  await askForm(b);
  expect(b.aiChat).toHaveBeenCalledTimes(2);
  expect(opts(b, 0).maxTokens).toBe(32768);
  expect(opts(b, 1).maxTokens).toBeUndefined();
  await askForm(b);
  expect(b.aiChat).toHaveBeenCalledTimes(3);
  expect(opts(b, 2).maxTokens).toBeUndefined();
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
  expect(await levels({ thinking: 'high' })).toEqual({ levels: ['high', 'low', 'low'], maxTokens: [32768, 20480, 20480] });
  expect((await levels({ thinking: 'medium', fastFollowUp: false })).levels).toEqual(['medium', 'medium', 'medium']);
  expect((await levels({ thinking: 'server' })).levels).toEqual([undefined, undefined, undefined]);
});

test('max_tokens is lowered to fit a known context, or left out when it cannot', () => {
  expect(maxTokensFor('low', undefined, 1000)).toBe(20480);
  expect(maxTokensFor('low', 262144, 30000)).toBe(36864);
  expect(maxTokensFor('low', 32768, 90000)).toBe(32768 - 30000 - 256);
  expect(maxTokensFor('high', 8192, 30000)).toBeUndefined();
});

test('without prompt_tokens_details the metrics line still shows the tokens, and nothing else', () => {
  expect(formatMetrics({ promptTokens: 3210, completionTokens: 41 }, 41000)).toBe('3,210 prompt tokens · 41 s');
});
