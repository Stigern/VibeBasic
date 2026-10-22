/** Removes `<think>…</think>` blocks (Qwen models think aloud). An unclosed `<think>` drops the rest of the reply. */
export function stripThinking(reply: string): string {
  return reply.replace(/<think>[\s\S]*?<\/think>/gi, '').replace(/<think>[\s\S]*$/i, '').trim();
}
