export type Thinking = 'server' | 'low' | 'medium' | 'high';
export interface AiSettings { baseUrl: string; model: string; apiKey: string; thinking: Thinking }
export interface ChatMessage { role: 'system' | 'user' | 'assistant'; content: string }
