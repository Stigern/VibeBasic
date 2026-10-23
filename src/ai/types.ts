export type Thinking = 'server' | 'low' | 'medium' | 'high';
export interface AiSettings {
  baseUrl: string; model: string; apiKey: string; thinking: Thinking;
  /** The model's context size in tokens as the server reported it at Test Connection (undefined when unknown). */
  contextTokens?: number;
}
/** A model from GET /models: its id and, when the server says, its context size (vLLM max_model_len, or context_length). */
export interface AiModel { id: string; contextTokens?: number }
export interface ChatMessage { role: 'system' | 'user' | 'assistant'; content: string }
