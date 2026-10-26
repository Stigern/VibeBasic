import type { Backend } from '../backend/backend';
import { aiSettingsTurn } from '../backend/aiSettingsStore';
import type { AiSettings, FormPicture, ServerKind, Thinking } from './types';

export type { AiSettings, FormPicture, ServerKind, Thinking };

export const THINKING_LEVELS: Thinking[] = ['server', 'low', 'medium', 'high', 'xhigh'];

export const DEFAULT_MAX_TOKENS = 65536;
export const MAX_OUTPUT_TOKENS = 1048576;
export const validMaxTokens = (value: unknown): value is number => typeof value === 'number' && Number.isSafeInteger(value) && value >= 1 && value <= MAX_OUTPUT_TOKENS;

export const defaultAiSettings = (): AiSettings => ({ baseUrl: 'http://localhost:11434/v1', model: '', apiKey: '', thinking: 'medium', maxTokens: DEFAULT_MAX_TOKENS, fastFollowUp: false });

export async function loadAiSettings(b: Pick<Backend, 'loadSettings'>): Promise<AiSettings> {
  const s = await b.loadSettings<Partial<AiSettings>>('ai');
  const r = { ...defaultAiSettings(), ...(s ?? {}) };
  if (!THINKING_LEVELS.includes(r.thinking)) r.thinking = 'medium';
  if (!validMaxTokens(r.maxTokens)) r.maxTokens = DEFAULT_MAX_TOKENS;
  if (!(typeof r.contextTokens === 'number' && r.contextTokens > 0)) delete r.contextTokens;
  if (typeof r.fastFollowUp !== 'boolean') r.fastFollowUp = false;
  if (r.serverKind !== 'vllm' && r.serverKind !== 'openai') delete r.serverKind;
  if (typeof r.vision !== 'boolean') delete r.vision;
  if (r.formPicture !== 'off') delete r.formPicture;
  return r;
}

export async function saveAiSettings(b: Pick<Backend, 'saveSettings'>, s: AiSettings): Promise<void> {
  await b.saveSettings('ai', { baseUrl: s.baseUrl, model: s.model, apiKey: s.apiKey, thinking: s.thinking, maxTokens: validMaxTokens(s.maxTokens) ? s.maxTokens : DEFAULT_MAX_TOKENS, ...(s.contextTokens ? { contextTokens: s.contextTokens } : {}),
    fastFollowUp: s.fastFollowUp === true, ...(s.serverKind ? { serverKind: s.serverKind } : {}),
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
