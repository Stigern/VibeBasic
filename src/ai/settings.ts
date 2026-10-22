import type { Backend } from '../backend/backend';
import type { AiSettings } from './types';

export type { AiSettings };

export const defaultAiSettings = (): AiSettings => ({ baseUrl: 'http://localhost:11434/v1', model: '', apiKey: '' });

export async function loadAiSettings(b: Pick<Backend, 'loadSettings'>): Promise<AiSettings> {
  const s = await b.loadSettings<Partial<AiSettings>>('ai');
  return { ...defaultAiSettings(), ...(s ?? {}) };
}

export async function saveAiSettings(b: Pick<Backend, 'saveSettings'>, s: AiSettings): Promise<void> {
  await b.saveSettings('ai', { baseUrl: s.baseUrl, model: s.model, apiKey: s.apiKey });
}
