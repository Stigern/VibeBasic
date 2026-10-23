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
}
/** A model from GET /models: its id and, when the server says, its context size (vLLM max_model_len, or context_length). */
export interface AiModel { id: string; contextTokens?: number; /** `owned_by` from the server ("vllm" on vLLM). */ ownedBy?: string }
export interface ChatMessage { role: 'system' | 'user' | 'assistant'; content: string }
