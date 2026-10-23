import { AI_SETTINGS_KEY, aiSettingsTurn } from './backend/aiSettingsStore';
import type { Backend } from './backend/backend';
import { parseProject } from './model/serialize';
import type { Project } from './model/types';

export interface BootDeps {
  startIde: (b: Backend) => void;
  startRuntime: (p: Project, b: Backend) => Promise<void>;
  /** Shows an error where the user can see it (the main window is hidden in runtime mode). */
  /** Cmd+Q from the runtime menu. */
  onQuit?: () => void;
  showError: (text: string) => Promise<void>;
}

/**
 * Moves AI settings (with the API key) that versions before 0.8 kept in localStorage to the Rust store, and deletes them
 * from localStorage once stored (aiSettingsStore.ts). Done at every start of the main window, IDE or made app (they share
 * the localStorage and the config folder), so the key does not wait in the localStorage the form windows share until
 * Options or Ask AI is next opened.
 */
export function moveLegacyAiSettings(backend: Backend): Promise<void> {
  if (backend.kind !== 'tauri') return Promise.resolve();
  return aiSettingsTurn(() => backend.loadSettings(AI_SETTINGS_KEY)).then(() => {}, () => {});
}

/** Picks the mode: a made app has an embedded project and runs it; otherwise this is the IDE. */
export async function boot(backend: Backend, deps: BootDeps): Promise<void> {
  backend.onQuitRequested(() => deps.onQuit?.());   // before any await: an early Cmd+Q must not be lost
  const moved = moveLegacyAiSettings(backend);
  let text: string | null;
  try {
    text = await backend.getEmbeddedProject();
  } catch (e) {
    // The embedded project exists but could not be read: never fall back to the IDE.
    await deps.showError(e instanceof Error ? e.message : String(e));
    await backend.quitApp();
    return;
  }
  if (text === null) {
    deps.startIde(backend);
    await backend.showMainWindow();
    return;
  }
  let project: Project;
  try {
    project = parseProject(text);
  } catch (e) {
    await deps.showError(e instanceof Error ? e.message : String(e));
    await backend.quitApp();
    return;
  }
  await moved;   // before the program opens form windows
  await deps.startRuntime(project, backend);
}
