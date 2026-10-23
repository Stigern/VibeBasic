// The "AI" tab in Tools > Options.
import type { Backend } from '../backend/backend';
import { check, optionsTabs } from '../ide/optionsDialog';
import { field } from '../ide/projectDialogs';
import { createCombo } from '../ui98/combo';
import { messageBox98 } from '../ui98/dialogs';
import { h } from '../ui98/dom';
import { addAiLogEntry } from './aiLog';
import { probeVision } from './detect';
import { THINKING_LEVELS, defaultAiSettings, loadAiSettings, saveAiSettings } from './settings';
import type { AiModel, FormPicture, ServerKind, Thinking } from './types';

const THINKING_LABELS: Record<Thinking, string> = { server: 'Server default', low: 'Low (fast)', medium: 'Medium', high: 'High (thorough)' };
const thinkingOf = (label: string): Thinking => THINKING_LEVELS.find(t => THINKING_LABELS[t] === label) ?? 'server';

type AiBackend = Pick<Backend, 'loadSettings' | 'saveSettings' | 'aiListModels'> & Partial<Pick<Backend, 'aiChat'>>;

const PICTURE_LABELS: Record<FormPicture, string> = { auto: 'Auto', off: 'Off' };

export function buildAiTab(backend: AiBackend, doc: Document = document) {
  const d = defaultAiSettings();
  const baseUrl = h('input', { type: 'text', value: d.baseUrl });
  const model = createCombo({ items: [], value: d.model, editable: true, onChange: () => { dirty.model = true; } });
  const thinking = createCombo({ items: THINKING_LEVELS.map(t => THINKING_LABELS[t]), value: THINKING_LABELS[d.thinking], editable: false, onChange: () => { dirty.thinking = true; } });
  const apiKey = h('input', { type: 'password', value: '', autocomplete: 'off' });
  const fast = check('Fast follow-up rounds', true);
  const picture = createCombo({ items: [PICTURE_LABELS.auto, PICTURE_LABELS.off], value: PICTURE_LABELS.auto, editable: false, onChange: () => { dirty.picture = true; } });
  const test = h('button', { type: 'button' }, 'Test Connection');
  const dirty = { baseUrl: false, apiKey: false, model: false, thinking: false, fast: false, picture: false };
  baseUrl.addEventListener('input', () => { dirty.baseUrl = true; });
  fast.input.addEventListener('change', () => { dirty.fast = true; });
  apiKey.addEventListener('input', () => { dirty.apiKey = true; });
  // The models by lower-case id from the last Test Connection, and the stored settings (to keep their contextTokens and serverKind).
  let tested: Map<string, AiModel> | null = null;
  /** Vision per lower-case model id, from the picture probe of the last Test Connection. */
  const visionTested = new Map<string, boolean>();
  let saved = d;
  const loading = loadAiSettings(backend).then(s => {
    saved = s;
    if (!dirty.baseUrl) baseUrl.value = s.baseUrl;
    if (!dirty.apiKey) apiKey.value = s.apiKey;
    if (!dirty.thinking) thinking.setValue(THINKING_LABELS[s.thinking]);
    if (!dirty.fast) fast.input.checked = s.fastFollowUp !== false;
    if (!dirty.picture) picture.setValue(PICTURE_LABELS[s.formPicture ?? 'auto']);
    if (!dirty.model) { model.setValue(s.model); if (s.model) model.setItems([s.model]); }
  }).catch(() => {});

  const testConnection = async (): Promise<void> => {
    test.disabled = true;
    const t0 = Date.now();
    try {
      const list = await backend.aiListModels(baseUrl.value.trim(), apiKey.value);
      const models = list.map(m => m.id);
      tested = new Map(list.map(m => [m.id.toLowerCase(), m]));
      model.setItems(models);
      const typed = model.getValue().trim();
      const match = models.find(m => m.toLowerCase() === typed.toLowerCase());
      if (match) { if (match !== typed) model.setValue(match); }
      else if (!typed && models.length > 0) model.setValue(models[0]);
      // one tiny picture: can the chosen model see?
      const chosen = model.getValue().trim();
      let seeing = '';
      if (backend.aiChat && tested.has(chosen.toLowerCase())) {
        const v = await probeVision(backend as Pick<Backend, 'aiChat'>, baseUrl.value.trim(), apiKey.value, chosen);
        if (v !== undefined) { visionTested.set(chosen.toLowerCase(), v); seeing = v ? ` ${chosen} can see pictures.` : ` ${chosen} cannot see pictures.`; }
      }
      await messageBox98(doc, { prompt: `Connected. ${models.length} models found.${seeing}`, title: 'VibeBasic', buttons: 64 });
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      addAiLogEntry({ mode: 'test', model: model.getValue().trim(), seconds: Math.round((Date.now() - t0) / 100) / 10, status: 'error',
        sent: `GET ${baseUrl.value.trim().replace(/\/+$/, '')}/models`, reply: '', reasoning: '', error: message }, apiKey.value);
      await messageBox98(doc, { prompt: message, title: 'VibeBasic', buttons: 48 });
    } finally { test.disabled = false; }
  };
  test.addEventListener('click', () => { void testConnection(); });

  /** The context size and server kind to store for `m` at `url`: what the last Test Connection reported (owned_by "vllm" is vLLM,
   *  any other model a server found is "openai"), else the stored ones if nothing changed. */
  const testedFor = (url: string, m: string): { contextTokens?: number; serverKind?: ServerKind; vision?: boolean } => {
    if (tested) {
      const t = tested.get(m.toLowerCase());
      return t ? { contextTokens: t.contextTokens, serverKind: t.ownedBy === 'vllm' ? 'vllm' : 'openai', vision: visionTested.get(m.toLowerCase()) } : {};
    }
    return url === saved.baseUrl && m === saved.model ? { contextTokens: saved.contextTokens, serverKind: saved.serverKind, vision: saved.vision } : {};
  };

  return {
    label: 'AI',
    content: h('div', { class: 'dlgform98' },
      field('Base URL:', baseUrl), field('Model:', model.el), field('API Key (optional):', apiKey), field('Thinking:', thinking.el),
      field('Send form picture:', picture.el), fast.el, test,
      h('div', {}, 'For Ollama on another PC use http://<its IP>:11434/v1'),
      h('div', {}, 'Thinking level is sent to vLLM/Qwen servers. Use Server default for other servers.'),
      h('div', {}, 'Fast follow-up rounds: the check-and-fix retry and Change... think Low.'),
      h('div', {}, 'Send form picture: Auto shows form mode a picture of the form when the model can see pictures.')),
    apply() {
      void loading
        .then(() => {
          const url = baseUrl.value.trim(), m = model.getValue().trim();
          return saveAiSettings(backend, { baseUrl: url, model: m, apiKey: apiKey.value, thinking: thinkingOf(thinking.getValue()), ...testedFor(url, m), fastFollowUp: fast.input.checked,
            ...(picture.getValue() === PICTURE_LABELS.off ? { formPicture: 'off' as const } : {}) });
        })
        .catch(e => messageBox98(doc, { prompt: `Could not save the AI settings: ${e instanceof Error ? e.message : String(e)}`, title: 'VibeBasic', buttons: 48 }));
    },
    // exposed for tests
    controls: { baseUrl, model, apiKey, thinking, fast: fast.input, picture, test, testConnection },
  };
}

export function registerAiOptionsTab(backend: AiBackend): void {
  optionsTabs.push((_ide, doc) => buildAiTab(backend, doc));
}
