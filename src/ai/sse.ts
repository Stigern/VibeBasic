// Server-sent events from an OpenAI-style streaming chat reply (same logic as SseParser in src-tauri/src/ai.rs).

export type AiDeltaKind = 'reasoning' | 'content';

/** Token counts the server reports for a request. `cachedTokens` is how much of the prompt it reused. */
export interface AiUsage { promptTokens: number; completionTokens: number; cachedTokens?: number; reasoningTokens?: number }

export interface AiResponseMetadata { requestId?: string; finishReason?: string; httpStatus?: number }
export interface AiToolCallDelta { index: number; id?: string; type?: string; function?: { name?: string; arguments?: string } }

export interface AiChatOptions {
  requestId?: string;
  onResponse?: (metadata: AiResponseMetadata) => void;
  onToolCall?: (call: AiToolCallDelta) => void;
  tools?: unknown[];
  toolChoice?: unknown;
  /** Called for every piece of the reply as it arrives: the model's thinking, then its answer. */
  onDelta?: (kind: AiDeltaKind, text: string) => void;
  /** Aborting stops the request; aiChat then rejects with "cancelled". */
  signal?: AbortSignal;
  /** Called once when the server reports token counts (streaming requests only). Never called if it sends none. */
  onUsage?: (u: AiUsage) => void;
  /** Sent as `response_format` (structured output, e.g. a json_schema). */
  responseFormat?: unknown;
  /** Sent as `structured_outputs` (vLLM's own structured output field; never together with responseFormat). */
  structuredOutputs?: unknown;
  /** Sent as `max_tokens` (on vLLM the thinking counts too). */
  maxTokens?: number;
  /** Sent as `presence_penalty` (only on the retry after a loop). */
  presencePenalty?: number;
}

/** The error text when the server stopped at max_tokens (finish_reason "length"); same text as src-tauri/src/ai.rs. */
export const AI_CUT_OFF = 'Output token limit reached (finish_reason = length). The output budget includes reasoning and the final answer; this does not mean the full context window is exhausted. Increase Output budget (tokens), choose a lower Thinking level, or ask for less at a time. VibeBasic will not retry automatically.';
export const AI_EMPTY_ANSWER = 'The AI server returned reasoning without a final answer.';
export const AI_TOOL_CALLS = 'The AI server requested tool calls; no final answer was produced.';
export const AI_INTERRUPTED = 'The AI response was interrupted before completion.';

/** The `usage` object of a response or chunk, if it has a prompt token count. */
export function readUsage(v: any): AiUsage | undefined {
  const u = v?.usage;
  if (!u || typeof u.prompt_tokens !== 'number') return undefined;
  const cached = u.prompt_tokens_details?.cached_tokens;
  return {
    promptTokens: u.prompt_tokens,
    completionTokens: typeof u.completion_tokens === 'number' ? u.completion_tokens : 0,
    ...(typeof cached === 'number' ? { cachedTokens: cached } : {}),
    ...(typeof u.completion_tokens_details?.reasoning_tokens === 'number' ? { reasoningTokens: u.completion_tokens_details.reasoning_tokens } : {}),
  };
}

/**
 * Splits `buffer` into the `data` payloads of its complete events (blank-line terminated) and the unfinished rest,
 * which the caller prepends to the next chunk. Comment lines (":") and other fields are ignored.
 */
export function parseSseChunk(buffer: string): { events: string[]; rest: string } {
  const text = buffer.replace(/\r\n/g, '\n');
  const blocks = text.split('\n\n');
  const rest = blocks.pop() ?? '';
  const events: string[] = [];
  for (const block of blocks) {
    const data: string[] = [];
    for (const line of block.split('\n')) {
      if (line.startsWith('data:')) data.push(line.slice(5).replace(/^ /, ''));
    }
    if (data.length) events.push(data.join('\n'));
  }
  return { events, rest };
}

export const SSE_DONE = '[DONE]';

/** The pieces carried by one event payload, the finish reason, or an error message from the server. */
export function readSseEvent(payload: string): { deltas: { kind: AiDeltaKind; text: string }[]; finish?: string; error?: string; done?: boolean; usage?: AiUsage; requestId?: string; toolCalls?: AiToolCallDelta[] } {
  const p = payload.trim();
  if (p === SSE_DONE) return { deltas: [], done: true };
  let v: any;
  try { v = JSON.parse(p); } catch { return { deltas: [] }; }
  let error: string | undefined;
  if (v && v.error !== undefined && v.error !== null) {
    const m = typeof v.error === 'string' ? v.error : v.error?.message;
    error = typeof m === 'string' && m.trim() ? m.trim() : 'The AI server sent an answer VibeBasic could not read.';
  }
  const choice = v?.choices?.[0];
  const d = choice?.delta;
  const deltas: { kind: AiDeltaKind; text: string }[] = [];
  const thinking = [d?.reasoning, d?.reasoning_content].find(t => typeof t === 'string' && t);
  if (thinking) deltas.push({ kind: 'reasoning', text: thinking });
  if (typeof d?.content === 'string' && d.content) deltas.push({ kind: 'content', text: d.content });
  return { deltas, ...(error ? { error } : {}), ...(typeof v?.id === 'string' ? { requestId: v.id } : {}), toolCalls: readToolCalls(d?.tool_calls), finish: typeof choice?.finish_reason === 'string' ? choice.finish_reason : undefined, usage: readUsage(v) };
}

/** Tool fragments remain separate from answer text. JSON message calls lack an index. */
export function readToolCalls(value: unknown): AiToolCallDelta[] {
  if (!Array.isArray(value)) return [];
  return value.filter(c => c && typeof c === 'object').map((c, index) => ({
    index: typeof c.index === 'number' ? c.index : index,
    ...(typeof c.id === 'string' ? { id: c.id } : {}),
    ...(typeof c.type === 'string' ? { type: c.type } : {}),
    ...(c.function && typeof c.function === 'object' ? { function: {
      ...(typeof c.function.name === 'string' ? { name: c.function.name } : {}),
      ...(typeof c.function.arguments === 'string' ? { arguments: c.function.arguments } : {}),
    } } : {}),
  }));
}
