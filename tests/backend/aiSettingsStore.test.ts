// Review 08 (L4): the AI settings (with the API key) are kept by the Rust side, not in the localStorage the form windows
// share; settings left in localStorage by older versions are moved over once and deleted there.
import { describe, expect, test } from 'vitest';
import { LEGACY_AI_KEY, loadAiSettingsFrom, saveAiSettingsTo, type AiSettingsIo } from '../../src/backend/aiSettingsStore';

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
