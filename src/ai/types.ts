export type Thinking = 'server' | 'low' | 'medium' | 'high';
/** What Test Connection found: "vllm" (GET /models says owned_by "vllm") or "openai" (any other server). */
export type ServerKind = 'vllm' | 'openai';
export interface AiSettings {
  baseUrl: string; model: string; apiKey: string; thinking: Thinking;
  /** The model's context size in tokens as the server reported it at Test Connection (undefined when unknown). */
  contextTokens?: number;
  /** "Fast follow-up rounds": the check-and-fix retry and Change... rounds think 'low'. Undefined (old settings) means on. */
  fastFollowUp?: boolean;
  /** The server kind from the last Test Connection (undefined when unknown): vLLM gets `structured_outputs`, others `response_format`. */
  serverKind?: ServerKind;
  /** Whether the model accepts pictures (Test Connection or the first request probes it; undefined: unknown, try once). */
  vision?: boolean;
  /** "Send form picture": Auto (when the model can see) or Off. Undefined (old settings) means Auto. */
  formPicture?: FormPicture;
}
export type FormPicture = 'auto' | 'off';
/** A model from GET /models: its id and, when the server says, its context size (vLLM max_model_len, or context_length). */
export interface AiModel { id: string; contextTokens?: number; /** `owned_by` from the server ("vllm" on vLLM). */ ownedBy?: string }
/** One part of a message with a picture (OpenAI style): text, or a PNG as a data URL. */
export type ContentPart = { type: 'text'; text: string } | { type: 'image_url'; image_url: { url: string } };
export interface ChatMessage { role: 'system' | 'user' | 'assistant'; content: string | ContentPart[] }
/** A message of text only (what the request builders make). */
export interface TextMessage extends ChatMessage { content: string }

/** About how many characters a picture counts for in the prompt budget (an 800 px picture is about 500 tokens on Qwen). */
export const PICTURE_CHARS = 3000;
/** The text of a message; a picture shows as "[picture]". */
export const contentText = (c: ChatMessage['content']): string =>
  typeof c === 'string' ? c : c.map(p => (p.type === 'text' ? p.text : '[picture]')).join('\n');
/** The size of a message for the budgets: its text, plus PICTURE_CHARS per picture. */
export const contentChars = (c: ChatMessage['content']): number =>
  typeof c === 'string' ? c.length : c.reduce((n, p) => n + (p.type === 'text' ? p.text.length : PICTURE_CHARS), 0);
