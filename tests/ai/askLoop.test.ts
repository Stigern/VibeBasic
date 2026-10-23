// @vitest-environment jsdom
// An answer that repeats itself: stopped at once, logged as "loop", tried once more with a nudge and a mild presence penalty.
import { afterEach, expect, test, vi } from 'vitest';
import { AI_STUCK, LOOP_NUDGE, LOOP_PENALTY, LOOP_RETRY_LABEL, askAi, formPictures } from '../../src/ai/askDialog';
import { aiLogEntries, clearAiLog } from '../../src/ai/aiLog';
import type { AiChatOptions } from '../../src/ai/sse';
import type { ChatMessage } from '../../src/ai/types';
import type { Backend } from '../../src/backend/backend';
import { IdeState } from '../../src/ide/ideState';
import { newControl, newProject } from '../../src/model/controls';

type Call = { msgs: ChatMessage[]; opts: AiChatOptions; resolve: (t: string) => void; reject: (e: Error) => void };
const fakeBackend = (settings: Record<string, unknown>, failPenalties = false) => {
  const calls: Call[] = [];
  const b = {
    loadSettings: async () => ({ baseUrl: 'http://x/v1', apiKey: '', formPicture: 'off', ...settings }),
    saveSettings: async () => {},
    aiListModels: async () => [],
    aiChat: vi.fn((_u: string, _k: string, _m: string, msgs: ChatMessage[], _e: unknown, opts: AiChatOptions) => {
      if (failPenalties && opts.presencePenalty !== undefined) return Promise.reject(new Error('The AI server answered 400 Bad Request: presence_penalty is not supported'));
      return new Promise<string>((resolve, reject) => {
        opts.signal?.addEventListener('abort', () => reject(new Error('cancelled')));
        calls.push({ msgs, opts, resolve, reject });
      });
    }),
  } as unknown as Backend & { aiChat: ReturnType<typeof vi.fn> };
  return { b, calls };
};
const btn = (label: string) => [...document.querySelectorAll<HTMLButtonElement>('.dlg98 button')].find(b => b.textContent === label);
const text = () => [...document.querySelectorAll('.dlg98')].map(d => d.textContent).join('|');
function ide() {
  const s = new IdeState(newProject());
  const f = s.project.forms[0];
  f.controls.push(newControl(f, 'CommandButton', { left: 100, top: 100 }, null));
  s.setActiveView({ kind: 'designer', formId: f.id });
  return s;
}
async function start(b: Backend) {
  const s = ide();
  const p = askAi(s, b, { codeWindowFor: () => null });
  await vi.waitFor(() => expect(document.querySelector('.ai-prompt')).toBeTruthy());
  (document.querySelector('.ai-prompt') as HTMLTextAreaElement).value = 'Lag et finansprogram';
  btn('OK')!.click();
  return { s, p };
}
const OBSERVED = '{"op":"form","props":{"Caption":"Financial Manager","Width":4800,"Height":4800}},';
/** Streams the observed loop into a call until it is stopped (at most 100 copies). */
function loop(c: Call) {
  c.opts.onDelta!('content', '{"ops":[');
  for (let i = 0; i < 100 && !c.opts.signal!.aborted; i++) c.opts.onDelta!('content', OBSERVED);
}
const OPS = '{"ops":[{"op":"set","name":"Command1","props":{"Caption":"Go"}}]}';
afterEach(() => { document.body.innerHTML = ''; clearAiLog(); vi.restoreAllMocks(); });

const hasPicture = (msgs: ChatMessage[]) => msgs.some(m => Array.isArray(m.content) && m.content.some(p => p.type !== 'text'));

test('a loop is stopped at once, logged and tried once more with the nudge and a mild presence penalty', async () => {
  vi.spyOn(formPictures, 'render').mockResolvedValue('data:image/png;base64,AAAA');
  const { b, calls } = fakeBackend({ model: 'loop-vllm', serverKind: 'vllm', formPicture: 'auto', vision: true });
  const { s, p } = await start(b);
  await vi.waitFor(() => expect(calls).toHaveLength(1));
  expect(calls[0].opts.presencePenalty).toBeUndefined();
  loop(calls[0]);
  expect(calls[0].opts.signal!.aborted).toBe(true);
  await vi.waitFor(() => expect(calls).toHaveLength(2));
  expect(text()).toContain(LOOP_RETRY_LABEL);
  // the same request plus one short user message, but without the picture and the structured output (they set the loop off)
  expect(hasPicture(calls[0].msgs)).toBe(true);
  expect(calls[0].opts.structuredOutputs).toBeDefined();
  expect(hasPicture(calls[1].msgs)).toBe(false);
  expect(calls[1].msgs.at(-1)).toEqual({ role: 'user', content: LOOP_NUDGE });
  expect(calls[1].opts.presencePenalty).toBe(LOOP_PENALTY);
  expect(calls[1].opts).not.toHaveProperty('frequencyPenalty');
  expect(calls[1].opts.structuredOutputs).toBeUndefined();
  expect(aiLogEntries()[1].status).toBe('loop');
  expect(aiLogEntries()[1].reply).toContain(OBSERVED);
  calls[1].resolve(OPS);
  await vi.waitFor(() => expect(text()).toContain('AI Suggestion'));
  expect(aiLogEntries()[0]).toMatchObject({ status: 'ok', mode: 'retry' });
  btn('OK')!.click();
  await p;
  expect(s.project.forms[0].controls[0].props.Caption).toBe('Go');
});

test('a second loop gives the message and nothing is applied', async () => {
  const { b, calls } = fakeBackend({ model: 'loop-twice', serverKind: 'openai' });
  const { s, p } = await start(b);
  await vi.waitFor(() => expect(calls).toHaveLength(1));
  loop(calls[0]);
  await vi.waitFor(() => expect(calls).toHaveLength(2));
  loop(calls[1]);
  await vi.waitFor(() => expect(text()).toContain(AI_STUCK));
  expect(calls).toHaveLength(2);
  expect(aiLogEntries().slice(0, 2).map(e => e.status)).toEqual(['loop', 'loop']);
  btn('OK')!.click();
  await p;
  expect(s.project.forms[0].controls[0].props.Caption).toBe('Command1');
});

test('the penalty only on a known server kind, and dropped when the server rejects it', async () => {
  const unknown = fakeBackend({ model: 'loop-unknown' });
  const a = await start(unknown.b);
  await vi.waitFor(() => expect(unknown.calls).toHaveLength(1));
  loop(unknown.calls[0]);
  await vi.waitFor(() => expect(unknown.calls).toHaveLength(2));
  expect(unknown.calls[1].opts.presencePenalty).toBeUndefined();
  expect(unknown.calls[1].msgs.at(-1)!.content).toBe(LOOP_NUDGE);
  unknown.calls[1].resolve(OPS);
  await vi.waitFor(() => expect(text()).toContain('AI Suggestion'));
  btn('Cancel')!.click();
  await a.p;

  const rejecting = fakeBackend({ model: 'loop-no-penalties', serverKind: 'vllm' }, true);
  const r = await start(rejecting.b);
  await vi.waitFor(() => expect(rejecting.calls).toHaveLength(1));
  loop(rejecting.calls[0]);
  // the call with penalties was refused at once; the one after it goes without them
  await vi.waitFor(() => expect(rejecting.calls).toHaveLength(2));
  expect(rejecting.b.aiChat).toHaveBeenCalledTimes(3);
  expect(rejecting.calls[1].opts.presencePenalty).toBeUndefined();
  expect(rejecting.calls[1].msgs.at(-1)!.content).toBe(LOOP_NUDGE);
  rejecting.calls[1].resolve(OPS);
  await vi.waitFor(() => expect(text()).toContain('AI Suggestion'));
  btn('Cancel')!.click();
  await r.p;
});
