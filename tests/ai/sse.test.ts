// @vitest-environment jsdom
import { afterEach, expect, test, vi } from 'vitest';
import { parseSseChunk, readSseEvent } from '../../src/ai/sse';
import { BrowserBackend } from '../../src/backend/browserBackend';

afterEach(() => { vi.unstubAllGlobals(); });

test('parseSseChunk: several events in one chunk, the unfinished rest is returned', () => {
  const r = parseSseChunk(': ping\n\ndata: {"a":1}\n\ndata: {"b":2}\r\n\r\ndata: [DO');
  expect(r.events).toEqual(['{"a":1}', '{"b":2}']);
  expect(r.rest).toBe('data: [DO');
  const r2 = parseSseChunk(r.rest + 'NE]\n\n');
  expect(r2).toEqual({ events: ['[DONE]'], rest: '' });
});

test('parseSseChunk: lines split mid-way and multi-line data', () => {
  let r = parseSseChunk('data: {"x"');
  expect(r.events).toEqual([]);
  r = parseSseChunk(r.rest + ':1}\n');
  expect(r.events).toEqual([]);
  r = parseSseChunk(r.rest + '\ndata: a\ndata: b\n\n');
  expect(r.events).toEqual(['{"x":1}', 'a\nb']);
});

test('readSseEvent: reasoning, reasoning_content, content, finish, done, error', () => {
  expect(readSseEvent('{"choices":[{"delta":{"reasoning":"r"}}]}').deltas).toEqual([{ kind: 'reasoning', text: 'r' }]);
  expect(readSseEvent('{"choices":[{"delta":{"reasoning_content":"r2","content":"c"}}]}').deltas).toEqual([{ kind: 'reasoning', text: 'r2' }, { kind: 'content', text: 'c' }]);
  expect(readSseEvent('{"choices":[{"delta":{},"finish_reason":"length"}]}').finish).toBe('length');
  expect(readSseEvent('[DONE]').done).toBe(true);
  expect(readSseEvent('{"error":{"message":"boom"}}').error).toBe('boom');
  expect(readSseEvent('not json').deltas).toEqual([]);
});

const sseResponse = (chunks: string[]) => new Response(new ReadableStream({
  start(c) { const e = new TextEncoder(); for (const x of chunks) c.enqueue(e.encode(x)); c.close(); },
}), { status: 200, headers: { 'content-type': 'text/event-stream' } });
const d = (o: object) => `data: ${JSON.stringify(o)}\n\n`;

test('BrowserBackend streams deltas and returns the accumulated answer', async () => {
  const body = d({ choices: [{ delta: { reasoning: 'think' } }] }) + d({ choices: [{ delta: { content: 'Hello' } }] }) + 'data: [DONE]\n\n';
  const f = vi.fn(async () => sseResponse([body.slice(0, 20), body.slice(20, 75), body.slice(75)]));
  vi.stubGlobal('fetch', f);
  const got: [string, string][] = [];
  const r = await new BrowserBackend().aiChat('http://h/v1', '', 'x', [], undefined, { onDelta: (k, t) => got.push([k, t]) });
  expect(r).toBe('Hello');
  expect(got).toEqual([['reasoning', 'think'], ['content', 'Hello']]);
  expect(JSON.parse((f.mock.calls[0] as any)[1].body).stream).toBe(true);
});

test('BrowserBackend: abort rejects with "cancelled"; JSON reply still works', async () => {
  vi.stubGlobal('fetch', vi.fn((_u: string, init: RequestInit) => new Promise((_res, rej) => {
    init.signal!.addEventListener('abort', () => rej(new DOMException('aborted', 'AbortError')));
  })));
  const ctrl = new AbortController();
  const p = new BrowserBackend().aiChat('http://h/v1', '', 'x', [], undefined, { onDelta: () => {}, signal: ctrl.signal });
  ctrl.abort();
  await expect(p).rejects.toThrow('cancelled');
  vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ choices: [{ message: { content: 'plain' } }] }), { status: 200, headers: { 'content-type': 'application/json' } })));
  expect(await new BrowserBackend().aiChat('http://h/v1', '', 'x', [], undefined, { onDelta: () => {} })).toBe('plain');
});
