// The "AI" tab in Tools > Options.
import type { Backend } from '../backend/backend';
import { optionsTabs } from '../ide/optionsDialog';
import { field } from '../ide/projectDialogs';
import { createCombo } from '../ui98/combo';
import { messageBox98 } from '../ui98/dialogs';
import { h } from '../ui98/dom';
import { defaultAiSettings, loadAiSettings, saveAiSettings } from './settings';

type AiBackend = Pick<Backend, 'loadSettings' | 'saveSettings' | 'aiListModels'>;

export function buildAiTab(backend: AiBackend, doc: Document = document) {
  const d = defaultAiSettings();
  const baseUrl = h('input', { type: 'text', value: d.baseUrl });
  const model = createCombo({ items: [], value: d.model, editable: true, onChange: () => { dirty.model = true; } });
  const apiKey = h('input', { type: 'password', value: '', autocomplete: 'off' });
  const test = h('button', { type: 'button' }, 'Test Connection');
  const dirty = { baseUrl: false, apiKey: false, model: false };
  baseUrl.addEventListener('input', () => { dirty.baseUrl = true; });
  apiKey.addEventListener('input', () => { dirty.apiKey = true; });
  const loading = loadAiSettings(backend).then(s => {
    if (!dirty.baseUrl) baseUrl.value = s.baseUrl;
    if (!dirty.apiKey) apiKey.value = s.apiKey;
    if (!dirty.model) { model.setValue(s.model); if (s.model) model.setItems([s.model]); }
  }).catch(() => {});

  const testConnection = async (): Promise<void> => {
    test.disabled = true;
    try {
      const models = await backend.aiListModels(baseUrl.value.trim(), apiKey.value);
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

  return {
    label: 'AI',
    content: h('div', { class: 'dlgform98' },
      field('Base URL:', baseUrl), field('Model:', model.el), field('API Key (optional):', apiKey), test,
      h('div', {}, 'For Ollama on another PC use http://<its IP>:11434/v1')),
    apply() {
      void loading
        .then(() => saveAiSettings(backend, { baseUrl: baseUrl.value.trim(), model: model.getValue().trim(), apiKey: apiKey.value }))
        .catch(e => messageBox98(doc, { prompt: `Could not save the AI settings: ${e instanceof Error ? e.message : String(e)}`, title: 'VibeBasic', buttons: 48 }));
    },
    // exposed for tests
    controls: { baseUrl, model, apiKey, test, testConnection },
  };
}

export function registerAiOptionsTab(backend: AiBackend): void {
  optionsTabs.push((_ide, doc) => buildAiTab(backend, doc));
}
