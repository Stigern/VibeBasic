// The picture probe: bounded in time, cancellable, and only a definitive answer is remembered for the session.
import { expect, test, vi } from 'vitest';
import { detectServer, probeVision } from '../../src/ai/detect';
import { loadAiSettings } from '../../src/ai/settings';
import { AI_CUT_OFF, AI_EMPTY_ANSWER } from '../../src/ai/sse';
import type { Backend } from '../../src/backend/backend';

/** An aiChat that never answers, but rejects with "cancelled" when its signal aborts. */
const hanging = vi.fn((...a: any[]) => new Promise<string>((_, reject) => {
  const signal: AbortSignal | undefined = a[5]?.signal;
  signal?.addEventListener('abort', () => reject(new Error('cancelled')));
}));
const failing = (message: string) => ({ aiChat: async () => { throw new Error(message); } });

test('the probe gives up after its timeout, as unknown', async () => {
  hanging.mockClear();
  expect(await probeVision({ aiChat: hanging }, 'http://x/v1', '', 'm', { timeoutMs: 20 })).toBeUndefined();
  expect(hanging.mock.calls[0][5].signal.aborted).toBe(true);
});

test('the probe stops when the caller aborts', async () => {
  const ac = new AbortController();
  const p = probeVision({ aiChat: hanging }, 'http://x/v1', '', 'm', { signal: ac.signal });
  ac.abort();
  expect(await p).toBeUndefined();
});

test('only an answer the server clearly gave counts as seeing; an unreadable reply is unknown', async () => {
  expect(await probeVision(failing('The AI server sent an answer VibeBasic could not read.'), 'u', '', 'm')).toBeUndefined();
  expect(await probeVision(failing('The AI server sent an answer VibeBasic could not read. (Details: the reply had no text; finish_reason = stop.)'), 'u', '', 'm')).toBe(true);
  expect(await probeVision(failing(AI_CUT_OFF), 'u', '', 'm')).toBe(true);
  expect(await probeVision(failing(AI_EMPTY_ANSWER), 'u', '', 'm')).toBe(true);
  expect(await probeVision(failing('The AI server answered 400: this model does not support image input'), 'u', '', 'm')).toBe(false);
});

test('a probe that failed for another reason is tried again on the next request; a definitive one is not', async () => {
  const store = new Map<string, unknown>([['ai', { baseUrl: 'http://x/v1', apiKey: '', model: 'retry-1', serverKind: 'vllm' }]]);
  let fail = true;
  const b = {
    loadSettings: async (k: string) => store.get(k) ?? null,
    saveSettings: async (k: string, v: unknown) => { store.set(k, v); },
    aiListModels: vi.fn(async () => [{ id: 'retry-1', ownedBy: 'vllm' }]),
    aiChat: vi.fn(async () => { if (fail) throw new Error('connection reset'); return 'OK'; }),
  } as unknown as Backend & { aiChat: ReturnType<typeof vi.fn> };
  const st = await loadAiSettings(b);
  expect((await detectServer(b, st).done).vision).toBeUndefined();
  fail = false;
  expect((await detectServer(b, st).done).vision).toBe(true);
  await detectServer(b, st).done;
  expect(b.aiChat).toHaveBeenCalledTimes(2);
});
