import { afterEach, expect, test, vi } from 'vitest';
const { handlers, invoke } = vi.hoisted(() => ({ handlers: new Map<string, (e: any) => void>(), invoke: vi.fn() }));
vi.mock('@tauri-apps/api/core', () => ({ invoke }));
vi.mock('@tauri-apps/api/event', () => ({ listen: async (name: string, callback: (e: any) => void) => { handlers.set(name, callback); return () => handlers.delete(name); } }));
import { TauriBackend } from '../../src/backend/tauriBackend';
afterEach(() => { handlers.clear(); invoke.mockReset(); });

test('metadata alone selects correlated stream and delivers response, tool and reasoning usage events', async () => {
  const metadata: unknown[] = [], usage: unknown[] = [], calls: unknown[] = [];
  invoke.mockImplementation(async (command, args) => {
    if (command !== 'ai_chat') return;
    expect(args.streamId).toBe('client-1');
    expect(args.tools).toEqual([{ type: 'function' }]);
    expect(args.toolChoice).toBe('auto');
    handlers.get('ai:response')?.({ payload: { id: 'other', request_id: 'ignore' } });
    handlers.get('ai:response')?.({ payload: { id: 'client-1', request_id: 'server-1', finish_reason: 'stop', http_status: 200 } });
    handlers.get('ai:tool_call')?.({ payload: { id: 'client-1', tool_call: { index: 0, function: { name: 'run' } } } });
    handlers.get('ai:usage')?.({ payload: { id: 'client-1', prompt_tokens: 4, completion_tokens: 10, reasoning_tokens: 8 } });
    return 'ok';
  });
  expect(await new TauriBackend().aiChat('http://h/v1', '', 'x', [], undefined, { requestId: 'client-1', tools: [{ type: 'function' }], toolChoice: 'auto', onResponse: m => metadata.push(m), onToolCall: c => calls.push(c), onUsage: u => usage.push(u) })).toBe('ok');
  expect(metadata).toEqual([{ requestId: 'server-1', finishReason: 'stop', httpStatus: 200 }]);
  expect(usage).toEqual([{ promptTokens: 4, completionTokens: 10, reasoningTokens: 8 }]);
  expect(calls).toEqual([{ index: 0, function: { name: 'run' } }]);
  expect(handlers.size).toBe(0);
});
