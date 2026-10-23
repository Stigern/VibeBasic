// The "AI" tab in Tools > Options.
import type { Backend } from '../backend/backend';
import { check, optionsTabs } from '../ide/optionsDialog';
import { field } from '../ide/projectDialogs';
import { createCombo } from '../ui98/combo';
import { messageBox98 } from '../ui98/dialogs';
import { h } from '../ui98/dom';
import { THINKING_LEVELS, defaultAiSettings, loadAiSettings, saveAiSettings } from './settings';
import type { Thinking } from './types';

const THINKING_LABELS: Record<Thinking, string> = { server: 'Server default', low: 'Low (fast)', medium: 'Medium', high: 'High (thorough)' };
const thinkingOf = (label: string): Thinking => THINKING_LEVELS.find(t => THINKING_LABELS[t] === label) ?? 'server';

type AiBackend = Pick<Backend, 'loadSettings' | 'saveSettings' | 'aiListModels'>;

export function buildAiTab(backend: AiBackend, doc: Document = document) {
  const d = defaultAiSettings();
  const baseUrl = h('input', { type: 'text', value: d.baseUrl });
  const model = createCombo({ items: [], value: d.model, editable: true, onChange: () => { dirty.model = true; } });
  const thinking = createCombo({ items: THINKING_LEVELS.map(t => THINKING_LABELS[t]), value: THINKING_LABELS[d.thinking], editable: false, onChange: () => { dirty.thinking = true; } });
  const apiKey = h('input', { type: 'password', value: '', autocomplete: 'off' });
  const fast = check('Fast follow-up rounds', true);
  const test = h('button', { type: 'button' }, 'Test Connection');
  const dirty = { baseUrl: false, apiKey: false, model: false, thinking: false, fast: false };
  baseUrl.addEventListener('input', () => { dirty.baseUrl = true; });
  fast.input.addEventListener('change', () => { dirty.fast = true; });
  apiKey.addEventListener('input', () => { dirty.apiKey = true; });
  // Context sizes by lower-case model id from the last Test Connection, and the stored settings (to keep their contextTokens).
  let tested: Map<string, number | undefined> | null = null;
  let saved = d;
  const loading = loadAiSettings(backend).then(s => {
    saved = s;
    if (!dirty.baseUrl) baseUrl.value = s.baseUrl;
    if (!dirty.apiKey) apiKey.value = s.apiKey;
    if (!dirty.thinking) thinking.setValue(THINKING_LABELS[s.thinking]);
    if (!dirty.fast) fast.input.checked = s.fastFollowUp !== false;
    if (!dirty.model) { model.setValue(s.model); if (s.model) model.setItems([s.model]); }
  }).catch(() => {});

  const testConnection = async (): Promise<void> => {
    test.disabled = true;
    try {
      const list = await backend.aiListModels(baseUrl.value.trim(), apiKey.value);
      const models = list.map(m => m.id);
      tested = new Map(list.map(m => [m.id.toLowerCase(), m.contextTokens]));
      model.setItems(models);
      const typed = model.getValue().trim();
      const match = models.find(m => m.toLowerCase() === typed.toLowerCase());
      if (match) { if (match !== typed) model.setValue(match); }
      else if (!typed && models.length > 0) model.setValue(models[0]);
      await messageBox98(doc, { prompt: `Connected. ${models.length} models found.`, title: 'VibeBasic', buttons: 64 });
    } catch (e) {
      await messageBox98(doc, { prompt: e instanceof Error ? e.message : String(e), title: 'VibeBasic', buttons: 48 });
    } finally { test.disabled = false; }
  };
  test.addEventListener('click', () => { void testConnection(); });

  /** The context size to store for `m` at `url`: what the last Test Connection reported, else the stored one if nothing changed. */
  const contextFor = (url: string, m: string): number | undefined =>
    tested ? tested.get(m.toLowerCase()) : url === saved.baseUrl && m === saved.model ? saved.contextTokens : undefined;

  return {
    label: 'AI',
    content: h('div', { class: 'dlgform98' },
      field('Base URL:', baseUrl), field('Model:', model.el), field('API Key (optional):', apiKey), field('Thinking:', thinking.el), fast.el, test,
      h('div', {}, 'For Ollama on another PC use http://<its IP>:11434/v1'),
      h('div', {}, 'Thinking level is sent to vLLM/Qwen servers. Use Server default for other servers.'),
      h('div', {}, 'Fast follow-up rounds: the check-and-fix retry and Change... think Low.')),
    apply() {
      void loading
        .then(() => {
          const url = baseUrl.value.trim(), m = model.getValue().trim();
          return saveAiSettings(backend, { baseUrl: url, model: m, apiKey: apiKey.value, thinking: thinkingOf(thinking.getValue()), contextTokens: contextFor(url, m), fastFollowUp: fast.input.checked });
        })
        .catch(e => messageBox98(doc, { prompt: `Could not save the AI settings: ${e instanceof Error ? e.message : String(e)}`, title: 'VibeBasic', buttons: 48 }));
    },
    // exposed for tests
    controls: { baseUrl, model, apiKey, thinking, fast: fast.input, test, testConnection },
  };
}

export function registerAiOptionsTab(backend: AiBackend): void {
  optionsTabs.push((_ide, doc) => buildAiTab(backend, doc));
}
