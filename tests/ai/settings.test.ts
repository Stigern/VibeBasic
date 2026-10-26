// @vitest-environment jsdom
import { afterEach, expect, test, vi } from 'vitest';
import { buildAiTab } from '../../src/ai/optionsTab';
import { loadAiSettings, saveAiSettings } from '../../src/ai/settings';
import type { AiModel } from '../../src/ai/types';

afterEach(() => { document.body.innerHTML = ''; });
const fakeBackend = (listModels: (b: string, k: string) => Promise<AiModel[]> = async () => []) => {
  const store = new Map<string, unknown>();
  return {
    store,
    loadSettings: async <T>(k: string) => (store.get(k) as T) ?? null,
    saveSettings: async (k: string, v: unknown) => { store.set(k, v); },
    aiListModels: vi.fn(listModels),
  };
};
const flush = () => new Promise(r => setTimeout(r, 0));
const okButton = () => [...document.querySelectorAll('button')].find(b => b.textContent === 'OK')!;

test('defaults', async () => expect(await loadAiSettings(fakeBackend())).toEqual({ baseUrl: 'http://localhost:11434/v1', model: '', apiKey: '', thinking: 'server' }));

test('Search LAN fills the chosen server and model without keeping the previous server capabilities', async () => {
  const base = fakeBackend();
  base.store.set('ai', { baseUrl: 'http://old/v1', model: 'old-model', apiKey: '', thinking: 'low', vision: false, contextTokens: 8192 });
  const backend = { ...base, kind: 'tauri' as const,
    aiLanNetworks: async () => [],
    aiLanScan: async () => [{ host: '192.168.1.8', port: 8000, baseUrl: 'http://192.168.1.8:8000/v1', kind: 'vLLM', models: ['new-model'], requiresKey: false, latencyMs: 2 }],
  };
  const tab = buildAiTab(backend, document); document.body.append(tab.content);
  await flush();
  const search = [...tab.content.querySelectorAll('button')].find(b => b.textContent === 'Search LAN...');
  expect(search).toBeDefined(); search!.click();
  const press = (label: string) => [...document.querySelectorAll<HTMLButtonElement>('.dlg98 button')].find(b => b.textContent === label)!.click();
  await vi.waitFor(() => expect(document.querySelector<HTMLButtonElement>('.lan98-actions button')?.disabled).toBe(false));
  press('Start');
  await vi.waitFor(() => expect(document.body.textContent).toContain('Done. 1 server found.'));
  press('Use');
  await vi.waitFor(() => expect(tab.controls.baseUrl.value).toBe('http://192.168.1.8:8000/v1'));
  expect(tab.controls.model.getValue()).toBe('new-model');
  await tab.apply();
  expect(base.store.get('ai')).toMatchObject({ baseUrl: 'http://192.168.1.8:8000/v1', model: 'new-model', serverKind: 'vllm' });
  expect(base.store.get('ai')).not.toHaveProperty('vision');
  expect(base.store.get('ai')).not.toHaveProperty('contextTokens');
});

test('connection testing and LAN search cannot overwrite each other while either is pending', async () => {
  let listed!: (models: AiModel[]) => void;
  const base = fakeBackend(() => new Promise(r => { listed = r; }));
  const backend = { ...base, kind: 'tauri' as const, aiLanNetworks: async () => [], aiLanScan: async () => [] };
  const tab = buildAiTab(backend, document); document.body.append(tab.content);
  await flush();
  const search = [...tab.content.querySelectorAll('button')].find(b => b.textContent === 'Search LAN...')!;
  const tested = tab.controls.testConnection();
  expect(search.disabled).toBe(true);
  listed([]); await flush(); okButton().click(); await tested;
  expect(search.disabled).toBe(false);
  search.click();
  await vi.waitFor(() => expect(document.querySelector('.lan98')).not.toBeNull());
  expect(tab.controls.test.disabled).toBe(true);
  [...document.querySelectorAll<HTMLButtonElement>('.dlg98 button')].find(b => b.textContent === 'Close')!.click();
  await vi.waitFor(() => expect(tab.controls.test.disabled).toBe(false));
});
test('roundtrip', async () => {
  const b = fakeBackend();
  const s = { baseUrl: 'http://10.0.0.5:11434/v1', model: 'qwen2.5-coder:14b', apiKey: 'k', thinking: 'low' as const };
  await saveAiSettings(b, s);
  expect(b.store.get('ai')).toEqual(s);
  expect(await loadAiSettings(b)).toEqual(s);
});
test('tab loads saved values; key is a password field; apply saves', async () => {
  const b = fakeBackend();
  await saveAiSettings(b, { baseUrl: 'http://x/v1', model: 'm1', apiKey: 'secret', thinking: 'medium' });
  const tab = buildAiTab(b, document);
  await flush();
  expect(tab.controls.baseUrl.value).toBe('http://x/v1');
  expect(tab.controls.model.getValue()).toBe('m1');
  expect(tab.controls.apiKey.type).toBe('password');
  expect(tab.controls.thinking.getValue()).toBe('Medium');
  tab.controls.model.setValue('m2');
  tab.controls.thinking.setValue('High (thorough)');
  tab.apply();
  await flush();
  expect(b.store.get('ai')).toEqual({ baseUrl: 'http://x/v1', model: 'm2', apiKey: 'secret', thinking: 'high' });
  expect(tab.content.textContent).toContain('For Ollama on another PC use http://<its IP>:11434/v1');
  expect(tab.content.textContent).toContain('Thinking:');
  expect(tab.content.textContent).toContain('Use Server default for other servers.');
  expect((tab.controls.thinking.el.querySelector('input') as HTMLInputElement).readOnly).toBe(true);
});
test('test connection fills models and reports', async () => {
  const b = fakeBackend(async () => [{ id: 'qwen2.5-coder:14b' }]);
  const tab = buildAiTab(b, document);
  document.body.append(tab.content);
  await flush();
  const p = tab.controls.testConnection();
  expect(tab.controls.test.disabled).toBe(true);
  await flush();
  expect(document.body.textContent).toContain('Connected. 1 models found.');
  okButton().click();
  await p;
  expect(tab.controls.test.disabled).toBe(false);
  tab.content.querySelector<HTMLElement>('.cb98-arrow')!.click();
  expect(document.querySelector('.popup98-layer .cb98-item')!.textContent).toBe('qwen2.5-coder:14b');
});
test('test connection selects first model when Model is empty, keeps a chosen one', async () => {
  const b = fakeBackend(async () => [{ id: 'a' }, { id: 'b' }]);
  const tab = buildAiTab(b, document);
  await flush();
  const p = tab.controls.testConnection();
  await flush(); okButton().click(); await p;
  expect(tab.controls.model.getValue()).toBe('a');
  tab.controls.model.setValue('b');
  const p2 = tab.controls.testConnection();
  await flush(); okButton().click(); await p2;
  expect(tab.controls.model.getValue()).toBe('b');
});
test('test connection fixes the case of a typed model name', async () => {
  const b = fakeBackend(async () => [{ id: 'qwen38-27b' }]);
  const tab = buildAiTab(b, document);
  await flush();
  tab.controls.model.setValue('Qwen38-27b');
  const p = tab.controls.testConnection();
  await flush(); okButton().click(); await p;
  expect(tab.controls.model.getValue()).toBe('qwen38-27b');
});
test('settings text fields have OS auto-capitalisation and correction off', () => {
  const tab = buildAiTab(fakeBackend(), document);
  for (const el of [tab.controls.baseUrl, tab.content.querySelector('.cb98-input')!]) {
    expect(el.getAttribute('autocapitalize')).toBe('off');
    expect(el.getAttribute('autocorrect')).toBe('off');
    expect(el.getAttribute('spellcheck')).toBe('false');
  }
});
test('apply before the load finished still saves the stored values', async () => {
  const b = fakeBackend();
  await saveAiSettings(b, { baseUrl: 'http://x/v1', model: 'm1', apiKey: 'k', thinking: 'server' });
  const tab = buildAiTab(b, document);
  tab.apply();
  await flush();
  expect(b.store.get('ai')).toEqual({ baseUrl: 'http://x/v1', model: 'm1', apiKey: 'k', thinking: 'server' });
});
test('test connection error shown', async () => {
  const b = fakeBackend(async () => { throw 'Could not connect to http://x/v1'; });
  const tab = buildAiTab(b, document);
  await flush();
  const p = tab.controls.testConnection();
  await flush();
  expect(document.body.textContent).toContain('Could not connect to http://x/v1');
  okButton().click();
  await p;
});
test('a failed save is reported', async () => {
  const b = { ...fakeBackend(), saveSettings: async () => { throw new Error('disk full'); } };
  const tab = buildAiTab(b, document);
  tab.apply();
  await vi.waitFor(() => expect(document.querySelector('.dlg98')?.textContent).toContain('Could not save the AI settings: disk full'));
  okButton().click();
});
test('old settings without thinking load as server default', async () => {
  const b = fakeBackend();
  b.store.set('ai', { baseUrl: 'http://x/v1', model: 'm', apiKey: '' });
  expect((await loadAiSettings(b)).thinking).toBe('server');
  b.store.set('ai', { baseUrl: 'http://x/v1', model: 'm', apiKey: '', thinking: 'bogus' });
  expect((await loadAiSettings(b)).thinking).toBe('server');
});
test('test connection stores the context size; old settings without it load as undefined', async () => {
  const b = fakeBackend(async () => [{ id: 'q', contextTokens: 262144 }, { id: 'r' }]);
  b.store.set('ai', { baseUrl: 'http://x/v1', model: 'q', apiKey: '', thinking: 'server' });
  expect((await loadAiSettings(b)).contextTokens).toBeUndefined();
  const tab = buildAiTab(b, document);
  await flush();
  const p = tab.controls.testConnection();
  await flush(); okButton().click(); await p;
  tab.apply();
  await flush();
  expect((await loadAiSettings(b)).contextTokens).toBe(262144);
});

test('Fast follow-up rounds: on for old settings, saved only when turned off', async () => {
  const b = fakeBackend();
  b.store.set('ai', { baseUrl: 'http://x/v1', model: 'm', apiKey: '', thinking: 'low' });
  expect((await loadAiSettings(b)).fastFollowUp).toBeUndefined();
  const tab = buildAiTab(b, document);
  await flush();
  expect(tab.controls.fast.checked).toBe(true);
  expect(tab.content.textContent).toContain('Fast follow-up rounds');
  tab.controls.fast.checked = false;
  tab.controls.fast.dispatchEvent(new Event('change'));
  tab.apply();
  await flush();
  expect((await loadAiSettings(b)).fastFollowUp).toBe(false);
});

test('test connection records the server kind: owned_by "vllm" is vllm, anything else openai; old settings have none', async () => {
  for (const [ownedBy, kind] of [['vllm', 'vllm'], ['ollama', 'openai'], [undefined, 'openai']] as const) {
    const b = fakeBackend(async () => [{ id: 'q', ...(ownedBy ? { ownedBy } : {}) }]);
    b.store.set('ai', { baseUrl: 'http://x/v1', model: 'q', apiKey: '', thinking: 'server' });
    expect((await loadAiSettings(b)).serverKind).toBeUndefined();
    const tab = buildAiTab(b, document);
    await flush();
    const p = tab.controls.testConnection();
    await flush(); okButton().click(); await p;
    tab.apply();
    await flush();
    expect((await loadAiSettings(b)).serverKind).toBe(kind);
  }
});
test('test connection probes vision with one tiny picture and stores it; Send form picture Off is saved', async () => {
  const b = { ...fakeBackend(async () => [{ id: 'vl', ownedBy: 'vllm' }]), aiChat: vi.fn(async () => 'OK') };
  const tab = buildAiTab(b, document);
  await flush();
  tab.controls.model.setValue('vl');
  const p = tab.controls.testConnection();
  await vi.waitFor(() => expect(document.body.textContent).toContain('vl can see pictures.'));
  okButton().click(); await p;
  expect((b.aiChat.mock.calls as unknown as any[][])[0][3][0].content[1].type).toBe('image_url');
  tab.controls.picture.setValue('Off');
  tab.apply(); await flush();
  expect(b.store.get('ai')).toMatchObject({ model: 'vl', serverKind: 'vllm', vision: true, formPicture: 'off' });
  // old settings: unknown vision, picture Auto
  const old = fakeBackend(); old.store.set('ai', { baseUrl: 'http://x/v1', model: 'm', apiKey: '', thinking: 'low' });
  const s = await loadAiSettings(old);
  expect(s.vision).toBeUndefined(); expect(s.formPicture).toBeUndefined();
});
