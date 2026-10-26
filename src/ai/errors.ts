export type AiErrorKind = 'output_limit' | 'empty_answer' | 'tool_calls' | 'interrupted' | 'cancelled' | 'http' | 'timeout' | 'connection_refused' | 'connection' | 'unknown';

/** Classify stable transport prefixes before inspecting any provider supplied error text. */
export function classifyAiError(message: string): AiErrorKind {
  if (/^The AI server (?:answered \d{3}\b|refused the request \(\d{3}\))/.test(message)) return 'http';
  if (/^Output token limit reached|^The AI answer was cut off/.test(message)) return 'output_limit';
  if (/^The AI server (?:returned reasoning without a final answer|returned no final answer|sent an answer .*reply had no text)/.test(message)) return 'empty_answer';
  if (/^The AI server requested tool calls/.test(message)) return 'tool_calls';
  if (/^The AI response (?:was interrupted|ended before completion|was incomplete)/.test(message)) return 'interrupted';
  if (/^cancelled$/i.test(message)) return 'cancelled';
  if (/^The AI server (?:did not answer within|stopped sending for|did not finish within)|^.*(?:timed out|timeout)$/i.test(message)) return 'timeout';
  if (/^(?:The AI connection was refused|Connection refused|Could not connect.*connection refused)/i.test(message)) return 'connection_refused';
  if (/^Could not connect|^The AI connection|^Network error/i.test(message)) return 'connection';
  return 'unknown';
}
