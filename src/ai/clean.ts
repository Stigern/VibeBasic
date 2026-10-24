/** Removes `<think>…</think>` blocks (Qwen models think aloud). An unclosed `<think>` drops the rest of the reply. */
export function stripThinking(reply: string): string {
  return reply.replace(/<think>[\s\S]*?<\/think>/gi, '').replace(/<think>[\s\S]*$/i, '').trim();
}

/** The thinking of a reply that has nothing else (`<think>...</think>` only; see answerText in the backends), else null. */
export function thinkingOnly(reply: string): string | null {
  if (stripThinking(reply)) return null;
  const m = /<think>([\s\S]*?)(?:<\/think>|$)/i.exec(reply);
  return m && m[1].trim() ? m[1].trim() : null;
}
