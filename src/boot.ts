import type { Backend } from './backend/backend';
import { parseProject } from './model/serialize';
import type { Project } from './model/types';

export interface BootDeps {
  startIde: (b: Backend) => void;
  startRuntime: (p: Project, b: Backend) => Promise<void>;
  /** Shows an error where the user can see it (the main window is hidden in runtime mode). */
  showError: (text: string) => Promise<void>;
}

/** Picks the mode: a made app has an embedded project and runs it; otherwise this is the IDE. */
export async function boot(backend: Backend, deps: BootDeps): Promise<void> {
  const text = await backend.getEmbeddedProject().catch(() => null);
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
  await deps.startRuntime(project, backend);
}
