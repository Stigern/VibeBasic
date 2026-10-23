import type { Backend } from '../backend/backend';
import { aiSettingsTurn } from '../backend/aiSettingsStore';
import type { AiSettings, FormPicture, ServerKind, Thinking } from './types';

export type { AiSettings, FormPicture, ServerKind, Thinking };

export const THINKING_LEVELS: Thinking[] = ['server', 'low', 'medium', 'high'];

export const defaultAiSettings = (): AiSettings => ({ baseUrl: 'http://localhost:11434/v1', model: '', apiKey: '', thinking: 'server' });

export async function loadAiSettings(b: Pick<Backend, 'loadSettings'>): Promise<AiSettings> {
  const s = await b.loadSettings<Partial<AiSettings>>('ai');
  const r = { ...defaultAiSettings(), ...(s ?? {}) };
  if (!THINKING_LEVELS.includes(r.thinking)) r.thinking = 'server';
  if (!(typeof r.contextTokens === 'number' && r.contextTokens > 0)) delete r.contextTokens;
  if (typeof r.fastFollowUp !== 'boolean') delete r.fastFollowUp;
  if (r.serverKind !== 'vllm' && r.serverKind !== 'openai') delete r.serverKind;
  if (typeof r.vision !== 'boolean') delete r.vision;
  if (r.formPicture !== 'off') delete r.formPicture;
  return r;
}

export async function saveAiSettings(b: Pick<Backend, 'saveSettings'>, s: AiSettings): Promise<void> {
  await b.saveSettings('ai', { baseUrl: s.baseUrl, model: s.model, apiKey: s.apiKey, thinking: s.thinking, ...(s.contextTokens ? { contextTokens: s.contextTokens } : {}),
    ...(s.fastFollowUp === false ? { fastFollowUp: false } : {}), ...(s.serverKind ? { serverKind: s.serverKind } : {}),
    ...(typeof s.vision === 'boolean' ? { vision: s.vision } : {}), ...(s.formPicture === 'off' ? { formPicture: 'off' } : {}) });
}

/**
 * Read-merge-write of the settings, in turn with every other update (aiSettingsTurn): `change` gets the stored settings and
 * returns what to store, or null to store nothing.
 */
export function updateAiSettings(b: Pick<Backend, 'loadSettings' | 'saveSettings'>, change: (cur: AiSettings) => AiSettings | null): Promise<void> {
  return aiSettingsTurn(async () => {
    const next = change(await loadAiSettings(b));
    if (next) await saveAiSettings(b, next);
  });
}
