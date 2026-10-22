// @vitest-environment jsdom
import { afterEach, expect, test, vi } from 'vitest';
import { buildAiTab } from '../../src/ai/optionsTab';
import { loadAiSettings, saveAiSettings } from '../../src/ai/settings';

afterEach(() => { document.body.innerHTML = ''; });
const fakeBackend = (listModels: (b: string, k: string) => Promise<string[]> = async () => []) => {
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

test('defaults', async () => expect(await loadAiSettings(fakeBackend())).toEqual({ baseUrl: 'http://localhost:11434/v1', model: '', apiKey: '' }));
test('roundtrip', async () => {
  const b = fakeBackend();
  const s = { baseUrl: 'http://10.0.0.5:11434/v1', model: 'qwen2.5-coder:14b', apiKey: 'k' };
  await saveAiSettings(b, s);
  expect(b.store.get('ai')).toEqual(s);
  expect(await loadAiSettings(b)).toEqual(s);
});
test('tab loads saved values; key is a password field; apply saves', async () => {
  const b = fakeBackend();
  await saveAiSettings(b, { baseUrl: 'http://x/v1', model: 'm1', apiKey: 'secret' });
  const tab = buildAiTab(b, document);
  await flush();
  expect(tab.controls.baseUrl.value).toBe('http://x/v1');
  expect(tab.controls.model.getValue()).toBe('m1');
  expect(tab.controls.apiKey.type).toBe('password');
  tab.controls.model.setValue('m2');
  tab.apply();
  await flush();
  expect(b.store.get('ai')).toEqual({ baseUrl: 'http://x/v1', model: 'm2', apiKey: 'secret' });
  expect(tab.content.textContent).toContain('For Ollama on another PC use http://<its IP>:11434/v1');
});
test('test connection fills models and reports', async () => {
  const b = fakeBackend(async () => ['qwen2.5-coder:14b']);
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
  expect(tab.content.querySelector('.cb98-item')!.textContent).toBe('qwen2.5-coder:14b');
});
test('test connection selects first model when Model is empty, keeps a chosen one', async () => {
  const b = fakeBackend(async () => ['a', 'b']);
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
test('apply before the load finished still saves the stored values', async () => {
  const b = fakeBackend();
  await saveAiSettings(b, { baseUrl: 'http://x/v1', model: 'm1', apiKey: 'k' });
  const tab = buildAiTab(b, document);
  tab.apply();
  await flush();
  expect(b.store.get('ai')).toEqual({ baseUrl: 'http://x/v1', model: 'm1', apiKey: 'k' });
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
