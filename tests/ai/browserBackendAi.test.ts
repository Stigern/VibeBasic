// @vitest-environment jsdom
import { afterEach, expect, test, vi } from 'vitest';
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
