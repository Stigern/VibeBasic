// The "AI" tab in Tools > Options.
import type { Backend } from '../backend/backend';
import { check, optionsTabs } from '../ide/optionsDialog';
import { field } from '../ide/projectDialogs';
import { createCombo } from '../ui98/combo';
import { messageBox98 } from '../ui98/dialogs';
import { h } from '../ui98/dom';
import { addAiLogEntry, redactUrl } from './aiLog';
import { probeVision } from './detect';
import { nearestEffort, probeEfforts } from './effort';
import { THINKING_LEVELS, MAX_OUTPUT_TOKENS, validMaxTokens, defaultAiSettings, loadAiSettings, updateAiSettings } from './settings';
import type { AiModel, FormPicture, ServerKind, Thinking } from './types';
import type { LanBackend } from './lanTypes';

const THINKING_LABELS: Record<Thinking, string> = { server: 'Server default', low: 'Low (fast)', medium: 'Medium', high: 'High (thorough)', xhigh: 'Extra high (xhigh)' };
const thinkingOf = (label: string): Thinking => THINKING_LEVELS.find(t => THINKING_LABELS[t] === label) ?? 'medium';

type AiBackend = Pick<Backend, 'loadSettings' | 'saveSettings' | 'aiListModels'> & Partial<Pick<Backend, 'aiChat' | 'kind' | 'aiLanNetworks' | 'aiLanScan'>>;

const PICTURE_LABELS: Record<FormPicture, string> = { auto: 'Auto', off: 'Off' };

export function buildAiTab(backend: AiBackend, doc: Document = document) {
  const d = defaultAiSettings();
  const baseUrl = h('input', { type: 'text', value: d.baseUrl });
  const model = createCombo({ items: [], value: d.model, editable: true, onChange: () => { dirty.model = true; } });
  const thinking = createCombo({ items: THINKING_LEVELS.map(t => THINKING_LABELS[t]), value: THINKING_LABELS[d.thinking], editable: false, onChange: () => { dirty.thinking = true; } });
  const apiKey = h('input', { type: 'password', value: '', autocomplete: 'off' });
  const fast = check('Fast follow-up rounds', false);
  const maxTokens = h('input', { type: 'number', min: '1', max: String(MAX_OUTPUT_TOKENS), step: '1', value: String(d.maxTokens) });
  const validate = (): string | null => /^\d+$/.test(maxTokens.value.trim()) && validMaxTokens(Number(maxTokens.value)) ? null : `Output budget must be a whole number from 1 to ${MAX_OUTPUT_TOKENS} tokens.`;
  const picture = createCombo({ items: [PICTURE_LABELS.auto, PICTURE_LABELS.off], value: PICTURE_LABELS.auto, editable: false, onChange: () => { dirty.picture = true; } });
  const test = h('button', { type: 'button' }, 'Test Connection');
  const canSearch = backend.kind === 'tauri' && !!backend.aiLanNetworks && !!backend.aiLanScan;
  const search = h('button', { type: 'button', disabled: !canSearch, title: canSearch ? 'Find AI servers on this computer, your LAN or Tailscale' : 'LAN search is available in the VibeBasic desktop app.' }, 'Search LAN...');
  let probing = false;
  const setProbing = (value: boolean) => {
    probing = value; test.disabled = value; search.disabled = value || !canSearch;
    baseUrl.disabled = apiKey.disabled = value;
    for (const input of model.el.querySelectorAll('input')) input.disabled = value;
  };
  const dirty = { baseUrl: false, apiKey: false, model: false, thinking: false, fast: false, picture: false, maxTokens: false };
  maxTokens.addEventListener('input', () => { dirty.maxTokens = true; });
  baseUrl.addEventListener('input', () => { dirty.baseUrl = true; });
  fast.input.addEventListener('change', () => { dirty.fast = true; });
  apiKey.addEventListener('input', () => { dirty.apiKey = true; });
  // The models by lower-case id from the last Test Connection, and the stored settings (to keep their contextTokens and serverKind).
  let tested: Map<string, AiModel> | null = null;
  let testedUrl: string | undefined;
  /** Vision per lower-case model id, from the picture probe of the last Test Connection. */
  const visionTested = new Map<string, boolean>();
  let saved = d;
  const loading = loadAiSettings(backend).then(s => {
    saved = s;
    if (!dirty.baseUrl) baseUrl.value = s.baseUrl;
    if (!dirty.apiKey) apiKey.value = s.apiKey;
    if (!dirty.thinking) thinking.setValue(THINKING_LABELS[s.thinking]);
    if (!dirty.fast) fast.input.checked = s.fastFollowUp === true;
    if (!dirty.maxTokens) maxTokens.value = String(s.maxTokens);
    if (!dirty.picture) picture.setValue(PICTURE_LABELS[s.formPicture ?? 'auto']);
    if (!dirty.model) { model.setValue(s.model); if (s.model) model.setItems([s.model]); }
  }).catch(() => {});

  search.addEventListener('click', () => { void (async () => {
    if (!canSearch || probing) return;
    setProbing(true);
    try {
      await loading;
      const { searchLanDialog } = await import('./lanDialog');
      const found = await searchLanDialog(doc, backend as LanBackend, apiKey.value);
      if (!found) return;
      baseUrl.value = found.baseUrl; dirty.baseUrl = dirty.model = true;
      const previous = model.getValue();
      model.setItems(found.models); model.setValue(found.models.includes(previous) ? previous : found.models[0] ?? '');
      testedUrl = found.baseUrl;
      tested = new Map(found.models.map(id => [id.toLowerCase(), { id, ...(found.kind === 'vLLM' ? { ownedBy: 'vllm' } : {}) }]));
      visionTested.clear();
    } finally { setProbing(false); }
  })(); });

  const testConnection = async (): Promise<void> => {
    if (probing) return;
    setProbing(true);
    const t0 = Date.now();
    try {
      const url = baseUrl.value.trim();
      const list = await backend.aiListModels(url, apiKey.value);
      testedUrl = url;
      visionTested.clear();
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
        seeing += await thinkingLevels(chosen);
      }
      await messageBox98(doc, { prompt: `Connected. ${models.length} models found.${seeing}`, title: 'VibeBasic', buttons: 64 });
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      addAiLogEntry({ mode: 'test', model: model.getValue().trim(), seconds: Math.round((Date.now() - t0) / 100) / 10, status: 'error',
        sent: `GET ${redactUrl(baseUrl.value)}/models`, reply: '', reasoning: '', error: message }, apiKey.value);
      await messageBox98(doc, { prompt: message, title: 'VibeBasic', buttons: 48 });
    } finally { setProbing(false); }
  };
  test.addEventListener('click', () => { void testConnection(); });

  /**
   * The thinking levels the server takes, as a sentence for the Test Connection box (empty when it does not say). A model that
   * takes reasoning_effort while Thinking is still Server default gets Medium selected when supported; OK keeps it.
   */
  const thinkingLevels = async (chosen: string): Promise<string> => {
    const found = await probeEfforts(backend as Pick<Backend, 'aiChat'>, baseUrl.value.trim(), apiKey.value, chosen);
    if (!found) return '';
    const shown = found.levels.map(l => (l === found.default ? `${l} (default)` : l)).join(', ');
    let text = ` Thinking levels it accepts: ${shown}.`;
    const high = nearestEffort('high', found.levels);
    if (high && high !== 'high') text += ` High is sent as ${high}.`;
    if (thinkingOf(thinking.getValue()) === 'server' && found.levels.includes('medium')) {
      thinking.setValue(THINKING_LABELS.medium);
      dirty.thinking = true;
      text += ' Thinking is now set to Medium. Press OK to keep it.';
    }
    return text;
  };

  /** The context size and server kind to store for `m` at `url`: what the last Test Connection reported (owned_by "vllm" is vLLM,
   *  any other model a server found is "openai"), else the stored ones if nothing changed. */
  const testedFor = (url: string, m: string): { contextTokens?: number; serverKind?: ServerKind; vision?: boolean } => {
    const same = url === saved.baseUrl && m.toLowerCase() === saved.model.toLowerCase();
    const previous = same ? { contextTokens: saved.contextTokens, serverKind: saved.serverKind, vision: saved.vision } : {};
    if (tested && url === testedUrl) {
      const t = tested.get(m.toLowerCase());
      return t ? {
        contextTokens: t.contextTokens ?? previous.contextTokens,
        serverKind: t.ownedBy ? (t.ownedBy === 'vllm' ? 'vllm' : 'openai') : previous.serverKind ?? 'openai',
        vision: visionTested.get(m.toLowerCase()) ?? previous.vision,
      } : {};
    }
    return previous;
  };

  return {
    label: 'AI',
    content: h('div', { class: 'dlgform98' },
      field('Base URL:', baseUrl), field('Model:', model.el), field('API Key (optional):', apiKey), field('Thinking:', thinking.el),
      field('Output budget (tokens):', maxTokens), field('Send form picture:', picture.el), fast.el, h('div', { style: 'display:flex;gap:8px' }, test, search),
      h('div', {}, 'For Ollama on another PC use http://<its IP>:11434/v1'),
      h('div', {}, 'Thinking level is sent to vLLM/Qwen servers. Use Server default for other servers.'),
      h('div', {}, 'Reasoning and the final answer share this budget. The context limit also includes input and images.'),
      h('div', {}, 'Fast follow-up rounds: the check-and-fix retry and Change... think Low.'),
      h('div', {}, 'Send form picture: Auto shows form mode a picture of the form when the model can see pictures.')),
    validate,
    apply() {
      return loading
        .then(() => {
          const invalid = validate();
          if (invalid) return messageBox98(doc, { prompt: invalid, title: 'VibeBasic', buttons: 48 }).then(() => {});
          const url = baseUrl.value.trim(), m = model.getValue().trim();
          return updateAiSettings(backend, () => ({ baseUrl: url, model: m, apiKey: apiKey.value, thinking: thinkingOf(thinking.getValue()), maxTokens: Number(maxTokens.value), ...testedFor(url, m), fastFollowUp: fast.input.checked,
            ...(picture.getValue() === PICTURE_LABELS.off ? { formPicture: 'off' as const } : {}) }));
        })
        .catch(async e => { await messageBox98(doc, { prompt: `Could not save the AI settings: ${e instanceof Error ? e.message : String(e)}`, title: 'VibeBasic', buttons: 48 }); });
    },
    // exposed for tests
    controls: { maxTokens, baseUrl, model, apiKey, thinking, fast: fast.input, picture, test, testConnection },
  };
}

export function registerAiOptionsTab(backend: AiBackend): void {
  optionsTabs.push((_ide, doc) => buildAiTab(backend, doc));
}
