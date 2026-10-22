export interface AiSettings { baseUrl: string; model: string; apiKey: string }
export interface ChatMessage { role: 'system' | 'user' | 'assistant'; content: string }
