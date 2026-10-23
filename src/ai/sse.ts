// Server-sent events from an OpenAI-style streaming chat reply (same logic as SseParser in src-tauri/src/ai.rs).

export type AiDeltaKind = 'reasoning' | 'content';

/** Token counts the server reports for a request. `cachedTokens` is how much of the prompt it reused. */
export interface AiUsage { promptTokens: number; completionTokens: number; cachedTokens?: number }

export interface AiChatOptions {
  /** Called for every piece of the reply as it arrives: the model's thinking, then its answer. */
  onDelta?: (kind: AiDeltaKind, text: string) => void;
  /** Aborting stops the request; aiChat then rejects with "cancelled". */
  signal?: AbortSignal;
  /** Called once when the server reports token counts (streaming requests only). Never called if it sends none. */
  onUsage?: (u: AiUsage) => void;
}

/** The `usage` object of a response or chunk, if it has a prompt token count. */
export function readUsage(v: any): AiUsage | undefined {
  const u = v?.usage;
  if (!u || typeof u.prompt_tokens !== 'number') return undefined;
  const cached = u.prompt_tokens_details?.cached_tokens;
  return {
    promptTokens: u.prompt_tokens,
    completionTokens: typeof u.completion_tokens === 'number' ? u.completion_tokens : 0,
    ...(typeof cached === 'number' ? { cachedTokens: cached } : {}),
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
export function readSseEvent(payload: string): { deltas: { kind: AiDeltaKind; text: string }[]; finish?: string; error?: string; done?: boolean; usage?: AiUsage } {
  const p = payload.trim();
  if (p === SSE_DONE) return { deltas: [], done: true };
  let v: any;
  try { v = JSON.parse(p); } catch { return { deltas: [] }; }
  if (v && v.error !== undefined && v.error !== null) {
    const m = typeof v.error === 'string' ? v.error : v.error?.message;
    return { deltas: [], error: typeof m === 'string' && m.trim() ? m.trim() : 'The AI server sent an answer VibeBasic could not read.' };
  }
  const choice = v?.choices?.[0];
  const d = choice?.delta;
  const deltas: { kind: AiDeltaKind; text: string }[] = [];
  const thinking = [d?.reasoning, d?.reasoning_content].find(t => typeof t === 'string' && t);
  if (thinking) deltas.push({ kind: 'reasoning', text: thinking });
  if (typeof d?.content === 'string' && d.content) deltas.push({ kind: 'content', text: d.content });
  return { deltas, finish: typeof choice?.finish_reason === 'string' ? choice.finish_reason : undefined, usage: readUsage(v) };
}
