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
  const model = createCombo({ items: [], value: d.model, editable: true });
  const apiKey = h('input', { type: 'password', value: '', autocomplete: 'off' });
  const test = h('button', { type: 'button' }, 'Test Connection');
  let loaded = false;
  void loadAiSettings(backend).then(s => {
    baseUrl.value = s.baseUrl; apiKey.value = s.apiKey; model.setValue(s.model);
    if (s.model) model.setItems([s.model]);
    loaded = true;
  }).catch(() => { loaded = true; });

  const testConnection = async (): Promise<void> => {
    test.disabled = true;
    try {
      const models = await backend.aiListModels(baseUrl.value.trim(), apiKey.value);
      model.setItems(models);
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
      if (loaded) void saveAiSettings(backend, { baseUrl: baseUrl.value.trim(), model: model.getValue().trim(), apiKey: apiKey.value });
    },
    // exposed for tests
    controls: { baseUrl, model, apiKey, test, testConnection },
  };
}

export function registerAiOptionsTab(backend: AiBackend): void {
  optionsTabs.push((_ide, doc) => buildAiTab(backend, doc));
}
