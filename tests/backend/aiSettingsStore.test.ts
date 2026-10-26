// Review 08 (L4): the AI settings (with the API key) are kept by the Rust side, not in the localStorage the form windows
// share; settings left in localStorage by older versions are moved over once and deleted there.
import { describe, expect, test } from 'vitest';
import { AI_SETTINGS_KEY, LEGACY_AI_KEY, loadAiSettingsFrom, saveAiSettingsTo, type AiSettingsIo } from '../../src/backend/aiSettingsStore';
import { loadAiSettings, saveAiSettings, updateAiSettings, type AiSettings } from '../../src/ai/settings';

class FakeStore implements AiSettingsIo {
  value: unknown = null;
  sets = 0;
  fail = false;
  async get(): Promise<unknown> { return this.value; }
  async set(v: unknown): Promise<void> { if (this.fail) throw new Error('no'); this.sets++; this.value = v; }
}

function storage(init: Record<string, string> = {}) {
  const m = new Map(Object.entries(init));
  return { m, getItem: (k: string) => m.get(k) ?? null, removeItem: (k: string) => { m.delete(k); } };
}

const old = { baseUrl: 'http://localhost:11434/v1', model: 'm', apiKey: 'secret', thinking: 'low' };

describe('AI settings store', () => {
  test('old settings in localStorage are moved to the store once and deleted there', async () => {
    const io = new FakeStore();
    const ls = storage({ [LEGACY_AI_KEY]: JSON.stringify(old), 'vibebasic.settings:ide': '{}' });
    expect(await loadAiSettingsFrom(io, ls)).toEqual(old);
    expect(io.value).toEqual(old);
    expect(ls.m.has(LEGACY_AI_KEY)).toBe(false);
    expect(ls.m.has('vibebasic.settings:ide')).toBe(true);
    expect(await loadAiSettingsFrom(io, ls)).toEqual(old);
    expect(io.sets).toBe(1);
  });

  test('the store wins over a stale localStorage copy, which is deleted', async () => {
    const io = new FakeStore();
    io.value = { ...old, apiKey: 'new' };
    const ls = storage({ [LEGACY_AI_KEY]: JSON.stringify(old) });
    expect(await loadAiSettingsFrom(io, ls)).toEqual({ ...old, apiKey: 'new' });
    expect(ls.m.size).toBe(0);
    expect(io.sets).toBe(0);
  });

  test('when the store cannot be written the old copy is kept for the next try', async () => {
    const io = new FakeStore();
    io.fail = true;
    const ls = storage({ [LEGACY_AI_KEY]: JSON.stringify(old) });
    expect(await loadAiSettingsFrom(io, ls)).toEqual(old);
    expect(ls.m.has(LEGACY_AI_KEY)).toBe(true);
  });

  test('nothing saved is null; saving writes the store and never localStorage', async () => {
    const io = new FakeStore();
    const ls = storage();
    expect(await loadAiSettingsFrom(io, ls)).toBeNull();
    expect(await loadAiSettingsFrom(io, null)).toBeNull();
    await saveAiSettingsTo(io, ls, old);
    expect(io.value).toEqual(old);
    expect(ls.m.size).toBe(0);
  });
});

// Integration of 0.8: the ai-boost settings fields (contextTokens, serverKind, vision, fastFollowUp, formPicture) go through the
// same Rust-side store, and settings saved before them (in localStorage or in the store) still load.
describe('AI settings store with the 0.8 fields', () => {
  const backendOn = (io: AiSettingsIo, ls: ReturnType<typeof storage>) => ({
    loadSettings: <T,>(key: string) => (key === AI_SETTINGS_KEY ? loadAiSettingsFrom<T>(io, ls) : Promise.resolve(null)),
    saveSettings: (key: string, v: unknown) => (key === AI_SETTINGS_KEY ? saveAiSettingsTo(io, ls, v) : Promise.resolve()),
  });

  test('the new fields are stored on the Rust side and come back; nothing goes to localStorage', async () => {
    const io = new FakeStore();
    const ls = storage();
    const b = backendOn(io, ls);
    const s: AiSettings = { ...old, thinking: 'low', maxTokens: 65536, contextTokens: 262144, serverKind: 'vllm', vision: true, fastFollowUp: false, formPicture: 'off' };
    await saveAiSettings(b, s);
    expect(io.value).toEqual(s);
    expect(ls.m.size).toBe(0);
    expect(await loadAiSettings(b)).toEqual(s);
  });

  test('old settings without the new fields load (from localStorage, moved once) with unknown capabilities and explicit budget defaults', async () => {
    const io = new FakeStore();
    const ls = storage({ [LEGACY_AI_KEY]: JSON.stringify(old) });
    const r = await loadAiSettings(backendOn(io, ls));
    expect(r).toEqual({ ...old, thinking: 'low', maxTokens: 65536, fastFollowUp: false });
    for (const k of ['contextTokens', 'serverKind', 'vision', 'formPicture']) expect(k in r).toBe(false);
    expect(io.value).toEqual(old);
    expect(ls.m.has(LEGACY_AI_KEY)).toBe(false);
  });
});

// Review 08 final #3: the server detection's read-merge-write and a save from Options run in turn, so neither loses the other's.
test('read-merge-write updates of the AI settings run one after the other', async () => {
  const io = new FakeStore();
  io.value = { ...old };
  const slow = { get: async () => { await new Promise(r => setTimeout(r, 5)); return io.get(); }, set: (v: unknown) => io.set(v) };
  const b = {
    loadSettings: <T,>(key: string) => (key === AI_SETTINGS_KEY ? loadAiSettingsFrom<T>(slow, null) : Promise.resolve(null)),
    saveSettings: (key: string, v: unknown) => (key === AI_SETTINGS_KEY ? saveAiSettingsTo(slow, null, v) : Promise.resolve()),
  };
  const found = updateAiSettings(b, cur => ({ ...cur, serverKind: 'vllm' }));   // detectServer's saveFound
  const options = updateAiSettings(b, cur => ({ ...cur, apiKey: 'typed in Options' }));
  const vision = updateAiSettings(b, cur => ({ ...cur, vision: true }));
  const none = updateAiSettings(b, () => null);
  await Promise.all([found, options, vision, none]);
  expect(io.value).toEqual({ ...old, serverKind: 'vllm', apiKey: 'typed in Options', vision: true, maxTokens: 65536, fastFollowUp: false });
  expect(io.sets).toBe(3);
  // a failed update does not stop the next one
  await expect(updateAiSettings(b, () => { throw new Error('x'); })).rejects.toThrow('x');
  await updateAiSettings(b, cur => ({ ...cur, model: 'n' }));
  expect((io.value as AiSettings).model).toBe('n');
});
