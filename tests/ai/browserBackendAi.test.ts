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
  const f = vi.fn(async () => new Response(JSON.stringify({ choices: [{ message: { content: 'ok' } }] }), { status: 200 }));
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
  stream(`data: ${JSON.stringify({ choices: [{ delta: { content: 'Hi' } }], error: null })}\n\ndata: [DONE]\n\n`);
  await expect(b.aiChat('http://h/v1', '', 'x', [], undefined, { onDelta: () => {} })).resolves.toBe('Hi');
});

test('#15 credentials in the base URL never reach the log or an error', async () => {
  const { describeRequest, redactUrl } = await import('../../src/ai/aiLog');
  expect(describeRequest('https://bob:sk-SECRET@host/v1/?key=sk-SECRET#x', 'm', [], {}).split('\n')[0]).toBe('POST https://host/v1/chat/completions');
  expect(redactUrl('http://h:11434/v1')).toBe('http://h:11434/v1');
  expect(redactUrl('ht tp://bob:sk-SECRET@host/v1?key=sk-SECRET')).not.toContain('SECRET');
  vi.stubGlobal('fetch', vi.fn(async () => { throw new TypeError('Failed to fetch'); }));
  await expect(new BrowserBackend().aiChat('https://bob:sk-SECRET@host/v1', '', 'x', [])).rejects.toThrow(/^Could not connect to https:\/\/host\/v1\. /);
});
