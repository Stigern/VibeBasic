// @vitest-environment jsdom
import { afterEach, expect, test, vi } from 'vitest';
import { AI_CUT_OFF } from '../../src/ai/sse';
import { BrowserBackend } from '../../src/backend/browserBackend';

afterEach(() => { vi.unstubAllGlobals(); });
const reply = (status: number, statusText: string, body: string) =>
  vi.stubGlobal('fetch', vi.fn(async () => new Response(body, { status, statusText })));

test('AI error body message is shown instead of the base URL hint', async () => {
  const b = new BrowserBackend();
  reply(404, 'Not Found', JSON.stringify({ error: { message: 'model "x" not found, try pulling it first' } }));
  await expect(b.aiChat('http://h/v1', '', 'x', [])).rejects.toThrow('The AI server answered 404 Not Found: model "x" not found, try pulling it first');
  reply(500, 'Internal Server Error', JSON.stringify({ error: 'out of memory' }));
  await expect(b.aiListModels('http://h/v1', '')).rejects.toThrow('The AI server answered 500 Internal Server Error: out of memory');
  reply(404, 'Not Found', 'nope');
  await expect(b.aiChat('http://h/v1', '', 'x', [])).rejects.toThrow('Check the base URL. For Ollama it usually ends with /v1.');
});

test('reasoning effort goes into chat_template_kwargs only when given', async () => {
  const b = new BrowserBackend();
  const f = vi.fn(async () => new Response(JSON.stringify({ choices: [{ message: { content: 'ok' }, finish_reason: 'stop' }] }), { status: 200 }));
  vi.stubGlobal('fetch', f);
  await b.aiChat('http://h/v1', '', 'x', [], 'low');
  expect(JSON.parse((f.mock.calls[0] as any)[1].body).chat_template_kwargs).toEqual({ reasoning_effort: 'low' });
  await b.aiChat('http://h/v1', '', 'x', []);
  expect(JSON.parse((f.mock.calls[1] as any)[1].body)).not.toHaveProperty('chat_template_kwargs');
});

test('response_format and max_tokens are sent when given; a reply cut off at max_tokens gives the cut-off message', async () => {
  const b = new BrowserBackend();
  const f = vi.fn(async () => new Response(JSON.stringify({ choices: [{ message: { content: '{"ops":[' }, finish_reason: 'length' }] }), { status: 200 }));
  vi.stubGlobal('fetch', f);
  const rf = { type: 'json_schema', json_schema: { name: 'form_ops', schema: { type: 'object' } } };
  await expect(b.aiChat('http://h/v1', '', 'x', [], undefined, { responseFormat: rf, maxTokens: 8192 })).rejects.toThrow(AI_CUT_OFF);
  const body = JSON.parse((f.mock.calls[0] as any)[1].body);
  expect(body.response_format).toEqual(rf);
  expect(body.max_tokens).toBe(8192);
  expect(AI_CUT_OFF).toContain('lower Thinking level');
  // streamed
  const sse = `data: ${JSON.stringify({ choices: [{ delta: { content: 'Private Sub' }, finish_reason: 'length' }] })}\n\ndata: [DONE]\n\n`;
  vi.stubGlobal('fetch', vi.fn(async () => new Response(sse, { status: 200, headers: { 'content-type': 'text/event-stream' } })));
  await expect(b.aiChat('http://h/v1', '', 'x', [], undefined, { onDelta: () => {} })).rejects.toThrow(AI_CUT_OFF);
});

test('#20 an error the server sends inside the stream is passed on, not taken for a lost connection; error: null is no error', async () => {
  const b = new BrowserBackend();
  const stream = (body: string) => vi.stubGlobal('fetch', vi.fn(async () => new Response(body, { status: 200, headers: { 'content-type': 'text/event-stream' } })));
  stream(`data: ${JSON.stringify({ error: { message: 'image input is not supported for this model' } })}\n\n`);
  await expect(b.aiChat('http://h/v1', '', 'x', [], undefined, { onDelta: () => {} })).rejects.toThrow(/^image input is not supported for this model$/);
  stream(`data: ${JSON.stringify({ choices: [{ delta: { content: 'Hi' }, finish_reason: 'stop' }], error: null })}\n\ndata: [DONE]\n\n`);
  await expect(b.aiChat('http://h/v1', '', 'x', [], undefined, { onDelta: () => {} })).resolves.toBe('Hi');
});

test('#15 credentials in the base URL never reach the log or an error', async () => {
  const { describeRequest, redactUrl } = await import('../../src/ai/aiLog');
  expect(describeRequest('https://bob:sk-SECRET@host/v1/?key=sk-SECRET#x', 'm', [], {})).not.toContain('SECRET');
  expect(redactUrl('http://h:11434/v1')).toBe('http://h:11434/v1');
  expect(redactUrl('ht tp://bob:sk-SECRET@host/v1?key=sk-SECRET')).not.toContain('SECRET');
  vi.stubGlobal('fetch', vi.fn(async () => { throw new TypeError('Failed to fetch'); }));
  await expect(new BrowserBackend().aiChat('https://bob:sk-SECRET@host/v1', '', 'x', [])).rejects.toThrow(/^Could not connect to https:\/\/host\/v1\. /);
});

test.each([
  [{ reasoning: 'private' }, 'stop', 'reasoning without a final answer'],
  [{ content: 'partial' }, null, 'interrupted'],
  [{ content: 'partial' }, 'length', 'Output token limit reached'],
  [{ tool_calls: [{ index: 0, id: 'call1', type: 'function', function: { name: 'run', arguments: '{}' } }] }, 'tool_calls', 'requested tool calls'],
])('rejects incomplete or non-answer stream %#', async (delta, finish, error) => {
  const body = `data: ${JSON.stringify({ choices: [{ delta, finish_reason: finish }] })}\n\ndata: [DONE]\n\n`;
  vi.stubGlobal('fetch', vi.fn(async () => new Response(body, { headers: { 'content-type': 'text/event-stream' } })));
  await expect(new BrowserBackend().aiChat('http://h/v1', '', 'x', [], undefined, { onDelta() {} })).rejects.toThrow(error);
});

test('reports server metadata and reasoning usage before length failure', async () => {
  const metadata: unknown[] = [], usage: unknown[] = [];
  const body = `data: ${JSON.stringify({ id: 'server-body', choices: [{ delta: { reasoning: 'thinking' }, finish_reason: 'length' }], usage: { prompt_tokens: 10, completion_tokens: 30, completion_tokens_details: { reasoning_tokens: 30 } } })}\n\ndata: [DONE]\n\n`;
  const f = vi.fn(async () => new Response(body, { headers: { 'content-type': 'text/event-stream', 'x-request-id': 'server-header' } }));
  vi.stubGlobal('fetch', f);
  await expect(new BrowserBackend().aiChat('http://h/v1', '', 'x', [], undefined, { requestId: 'client-id', onResponse: m => metadata.push(m), onUsage: u => usage.push(u) })).rejects.toThrow('Output token limit reached');
  expect(new Headers((f.mock.calls[0] as any)[1].headers).get('X-Client-Request-Id')).toBe('client-id');
  expect(metadata).toContainEqual({ httpStatus: 200, requestId: 'server-header' });
  expect(metadata).toContainEqual({ requestId: 'server-body', finishReason: 'length' });
  expect(usage).toEqual([{ promptTokens: 10, completionTokens: 30, reasoningTokens: 30 }]);
});

test('JSON fallback emits reasoning, answer, tools and metadata separately', async () => {
  const tools = [{ type: 'function', function: { name: 'run' } }];
  const call = { id: 'tool-1', type: 'function', function: { name: 'run', arguments: '{}' } };
  const response = { id: 'json-id', choices: [{ message: { reasoning: 'private', content: 'answer', tool_calls: [call] }, finish_reason: 'stop' }] };
  const f = vi.fn(async () => new Response(JSON.stringify(response), { headers: { 'content-type': 'application/json' } }));
  vi.stubGlobal('fetch', f);
  const deltas: unknown[] = [], calls: unknown[] = [], metadata: unknown[] = [];
  await expect(new BrowserBackend().aiChat('http://h/v1', '', 'x', [], undefined, { tools, toolChoice: 'auto', onDelta: (k,t) => deltas.push([k,t]), onToolCall: c => calls.push(c), onResponse: m => metadata.push(m) })).rejects.toThrow('requested tool calls');
  expect(deltas).toEqual([['reasoning', 'private'], ['content', 'answer']]);
  expect(calls).toEqual([{ index: 0, ...call }]);
  expect(metadata).toContainEqual({ requestId: 'json-id', finishReason: 'stop' });
  expect(JSON.parse((f.mock.calls[0] as any)[1].body)).toMatchObject({ tools, tool_choice: 'auto' });
});

test('HTTP failures report status and generic browser failure explains network/CORS', async () => {
  const seen: unknown[] = [];
  reply(429, 'Too Many Requests', '{"error":"slow down"}');
  await expect(new BrowserBackend().aiChat('http://h/v1', '', 'x', [], undefined, { onResponse: m => seen.push(m) })).rejects.toThrow('429');
  expect(seen).toContainEqual({ httpStatus: 429 });
  vi.stubGlobal('fetch', vi.fn(async () => { throw new TypeError('Failed to fetch'); }));
  await expect(new BrowserBackend().aiChat('http://h/v1', '', 'x', [])).rejects.toThrow(/network.*CORS/i);
});

test('classifies failures using transport evidence, not words in a server error body', async () => {
  const { classifyAiError } = await import('../../src/ai/errors');
  expect(classifyAiError('The AI server answered 500: connection refused, timeout')).toBe('http');
  expect(classifyAiError('The AI server returned reasoning without a final answer.')).toBe('empty_answer');
  expect(classifyAiError('The AI response was interrupted before completion.')).toBe('interrupted');
  expect(classifyAiError('connection refused')).toBe('connection_refused');
  expect(classifyAiError('cancelled')).toBe('cancelled');
});

test('a dropped response body is interruption even after partial text', async () => {
  let reads = 0;
  const body = new ReadableStream({ pull(c) {
    if (reads++ === 0) c.enqueue(new TextEncoder().encode('data: {"choices":[{"delta":{"content":"partial"}}]}\n\n'));
    else c.error(new TypeError('terminated'));
  } });
  vi.stubGlobal('fetch', vi.fn(async () => new Response(body, { headers: { 'content-type': 'text/event-stream' } })));
  await expect(new BrowserBackend().aiChat('http://h/v1', '', 'x', [], undefined, { onDelta() {} })).rejects.toThrow('interrupted');
});

test('JSON reasoning-only and missing termination fail through the ordinary request path', async () => {
  for (const [message, finish, expected] of [[{ reasoning_content: 'private' }, 'stop', 'reasoning without a final answer'], [{ content: 'partial' }, undefined, 'interrupted']] as const) {
    reply(200, 'OK', JSON.stringify({ choices: [{ message, finish_reason: finish }] }));
    await expect(new BrowserBackend().aiChat('http://h/v1', '', 'x', [])).rejects.toThrow(expected);
  }
});

test.each([
  ['Output token limit reached (finish_reason = length).', 'output_limit'],
  ['The AI response was incomplete: no finish_reason was received.', 'interrupted'],
  ['The AI response was interrupted before it was complete.', 'interrupted'],
  ['The AI server requested tool calls; no final answer was produced.', 'tool_calls'],
  ['The AI server returned no final answer.', 'empty_answer'],
  ['The AI server did not answer within 90 seconds.', 'timeout'],
  ['Could not connect to http://h. Check network and CORS.', 'connection'],
  ['The AI server refused the request (401). Check the API key.', 'http'],
  ['provider body mentions 500 without a transport status', 'unknown'],
])('classifies %s as %s', async (message, expected) => {
  const { classifyAiError } = await import('../../src/ai/errors');
  expect(classifyAiError(message)).toBe(expected);
});

test('finish metadata survives a server error in the same SSE chunk', async () => {
  const seen: unknown[] = [];
  const body = 'data: {"id":"server-error","choices":[{"delta":{},"finish_reason":"length"}],"error":{"message":"limit"}}\n\n';
  vi.stubGlobal('fetch', vi.fn(async () => new Response(body, { headers: { 'content-type': 'text/event-stream' } })));
  await expect(new BrowserBackend().aiChat('http://h/v1', '', 'x', [], undefined, { onResponse: m => seen.push(m) })).rejects.toThrow('Output token limit reached');
  expect(seen).toContainEqual({ requestId: 'server-error', finishReason: 'length' });
});

test('length remains an output-limit failure if the stream then drops', async () => {
  let reads = 0;
  const body = new ReadableStream({ pull(c) {
    if (reads++ === 0) c.enqueue(new TextEncoder().encode('data: {"choices":[{"delta":{"content":"partial"},"finish_reason":"length"}]}\n\n'));
    else c.error(new TypeError('terminated'));
  } });
  vi.stubGlobal('fetch', vi.fn(async () => new Response(body, { headers: { 'content-type': 'text/event-stream' } })));
  await expect(new BrowserBackend().aiChat('http://h/v1', '', 'x', [], undefined, { onDelta() {} })).rejects.toThrow('Output token limit reached');
});

test('tool calls prevent applying even accompanying answer text', async () => {
  const response = { choices: [{ message: { content: 'untrusted answer', tool_calls: [{ id: 'call1', function: { name: 'run', arguments: '{}' } }] }, finish_reason: 'stop' }] };
  reply(200, 'OK', JSON.stringify(response));
  await expect(new BrowserBackend().aiChat('http://h/v1', '', 'x', [])).rejects.toThrow('requested tool calls');
});

test('length remains output limit when a later provider error arrives', async () => {
  const body = 'data: {"choices":[{"delta":{},"finish_reason":"length"}]}\n\ndata: {"error":{"message":"later error"}}\n\n';
  vi.stubGlobal('fetch', vi.fn(async () => new Response(body, { headers: { 'content-type': 'text/event-stream' } })));
  await expect(new BrowserBackend().aiChat('http://h/v1', '', 'x', [], undefined, { onDelta() {} })).rejects.toThrow('Output token limit reached');
});

test.each(['idle', 'total', 'cancel'] as const)('length survives %s unless explicitly cancelled', async (termination) => {
  vi.useFakeTimers();
  let heartbeat: ReturnType<typeof setInterval> | undefined;
  vi.stubGlobal('fetch', vi.fn(async (_url, init: RequestInit) => new Response(new ReadableStream({ start(c) {
    c.enqueue(new TextEncoder().encode('data: {"choices":[{"delta":{},"finish_reason":"length"}]}\n\n'));
    if (termination === 'total') heartbeat = setInterval(() => c.enqueue(new TextEncoder().encode(': heartbeat\n\n')), 60_000);
    init.signal!.addEventListener('abort', () => { clearInterval(heartbeat); c.error(new DOMException('aborted', 'AbortError')); });
  } }), { headers: { 'content-type': 'text/event-stream' } })));
  try {
    const ctrl = new AbortController();
    const pending = new BrowserBackend().aiChat('http://h/v1', '', 'x', [], undefined, { signal: ctrl.signal, onDelta() {} });
    const outcome = pending.then(value => value, error => (error as Error).message);
    await vi.advanceTimersByTimeAsync(1);
    if (termination === 'cancel') ctrl.abort();
    else await vi.advanceTimersByTimeAsync(termination === 'idle' ? 90_000 : 1_200_000);
    expect(await outcome).toContain(termination === 'cancel' ? 'cancelled' : 'Output token limit reached');
  } finally { clearInterval(heartbeat); vi.useRealTimers(); }
});
