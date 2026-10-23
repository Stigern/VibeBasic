// The AI settings (base URL, model, API key) in the desktop app: kept on the Rust side (src-tauri/src/ai_settings.rs, a file
// only the user can read, behind commands only the main window may call), not in localStorage. Every window of the app shares
// one localStorage, the form windows of a running program included, so an API key kept there could be read from them.
// Settings saved there by older versions are moved over once and then deleted from localStorage.

/** The settings key (Backend.loadSettings / saveSettings) that goes to the Rust store. */
export const AI_SETTINGS_KEY = 'ai';
/** Where older versions kept it. */
export const LEGACY_AI_KEY = 'vibebasic.settings:ai';

/** The read-merge-write runs of the AI settings in this window, one after the other (see aiSettingsTurn). */
let turn: Promise<unknown> = Promise.resolve();

/**
 * Runs `fn` after every earlier turn has finished. The server detection saves what it found (a read-merge-write) in the
 * background, possibly while Tools > Options saves: run in turn, neither overwrites what the other just wrote.
 */
export function aiSettingsTurn<T>(fn: () => Promise<T>): Promise<T> {
  const r = turn.then(fn, fn);
  turn = r.catch(() => {});
  return r;
}

export interface AiSettingsIo {
  /** Null when nothing is saved. */
  get(): Promise<unknown>;
  set(v: unknown): Promise<void>;
}

type Legacy = Pick<Storage, 'getItem' | 'removeItem'>;

function legacyValue(storage: Legacy | null): { found: boolean; value: unknown } {
  try {
    const raw = storage?.getItem(LEGACY_AI_KEY) ?? null;
    if (raw === null) return { found: false, value: null };
    try { return { found: true, value: JSON.parse(raw) as unknown }; } catch { return { found: true, value: null }; }
  } catch { return { found: false, value: null }; }
}

function removeLegacy(storage: Legacy | null): void {
  try { storage?.removeItem(LEGACY_AI_KEY); } catch { /* storage unavailable */ }
}

/** The saved settings; old ones still in localStorage are moved to the store first (and only deleted once stored). */
export async function loadAiSettingsFrom<T>(io: AiSettingsIo, storage: Legacy | null): Promise<T | null> {
  const stored = await io.get().catch(() => null);
  const legacy = legacyValue(storage);
  if (stored !== null && stored !== undefined) {
    if (legacy.found) removeLegacy(storage);
    return stored as T;
  }
  if (!legacy.found) return null;
  if (legacy.value === null) { removeLegacy(storage); return null; }
  try {
    await io.set(legacy.value);
    removeLegacy(storage);
  } catch { /* kept in localStorage until it can be moved */ }
  return legacy.value as T;
}

export async function saveAiSettingsTo(io: AiSettingsIo, storage: Legacy | null, v: unknown): Promise<void> {
  await io.set(v);
  removeLegacy(storage);
}
