import type { Backend } from '../backend/backend';
import type { AiSettings, Thinking } from './types';

export type { AiSettings, Thinking };

export const THINKING_LEVELS: Thinking[] = ['server', 'low', 'medium', 'high'];

export const defaultAiSettings = (): AiSettings => ({ baseUrl: 'http://localhost:11434/v1', model: '', apiKey: '', thinking: 'server' });

export async function loadAiSettings(b: Pick<Backend, 'loadSettings'>): Promise<AiSettings> {
  const s = await b.loadSettings<Partial<AiSettings>>('ai');
  const r = { ...defaultAiSettings(), ...(s ?? {}) };
  if (!THINKING_LEVELS.includes(r.thinking)) r.thinking = 'server';
  return r;
}

export async function saveAiSettings(b: Pick<Backend, 'saveSettings'>, s: AiSettings): Promise<void> {
  await b.saveSettings('ai', { baseUrl: s.baseUrl, model: s.model, apiKey: s.apiKey, thinking: s.thinking });
}
