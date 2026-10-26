// @vitest-environment jsdom
import { expect, test } from 'vitest';
import { addAiLogEntry, finishAiLogEntry, aiLogEntries, clearAiLog, describeRequest } from '../../src/ai/aiLog';

test('diagnostics retain correlation and budgets without request, reasoning, answer or raw error contents', () => {
  clearAiLog();
  const sent = describeRequest('http://user:credential@host/v1?key=credential', 'paiton-flashnext-vision', [{ role: 'user', content: 'PRIVATE PROMPT' }], { reasoning_effort: 'medium', max_tokens: 65536 });
  const entry = addAiLogEntry({ requestId: 'client-123', model: 'paiton-flashnext-vision', reasoningEffort: 'medium', maxTokens: 65536,
    mode: 'form', seconds: 0, status: 'ok', sent, reply: 'PRIVATE ANSWER', reasoning: 'PRIVATE THOUGHTS' });
  finishAiLogEntry(entry, { status: 'error', reply: 'PRIVATE ANSWER', reasoning: 'PRIVATE THOUGHTS', ms: 100,
    usage: { promptTokens: 10573, completionTokens: 49152, reasoningTokens: 49152 },
    error: 'The AI server answered 400: PRIVATE SERVER ECHO', finishReason: 'length', serverRequestId: 'chatcmpl-abc', httpStatus: 200 });
  expect(entry).toMatchObject({ requestId: 'client-123', serverRequestId: 'chatcmpl-abc', reasoningEffort: 'medium', maxTokens: 65536,
    promptTokens: 10573, completionTokens: 49152, reasoningTokens: 49152, finishReason: 'length', httpStatus: 200, errorKind: 'output_limit' });
  const serialized = JSON.stringify(aiLogEntries());
  for (const secret of ['PRIVATE PROMPT', 'PRIVATE ANSWER', 'PRIVATE THOUGHTS', 'PRIVATE SERVER ECHO', 'credential']) expect(serialized).not.toContain(secret);
});
