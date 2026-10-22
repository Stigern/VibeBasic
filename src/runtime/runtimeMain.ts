// Runtime mode of a made app: the main window stays hidden, the embedded project runs in a RunSession
// with TauriFormHost in mode 'app', and the app quits when the program ends.

import type { Backend } from '../backend/backend';
import type { Project } from '../model/types';
import { RunSession } from '../run/session';
import { TauriFormHost } from '../run/tauriFormHost';

const vbOK = 0;
const vbCritical = 16;

/** Shows an error in a dialog window (the main window is hidden in runtime mode). */
export async function showErrorBox(text: string, host: Pick<TauriFormHost, 'messageBox'> = new TauriFormHost()): Promise<void> {
  await host.messageBox({ prompt: text, title: 'VibeBasic', buttons: vbOK | vbCritical });
}

async function fatalError(backend: Backend, text: string, host: Pick<TauriFormHost, 'messageBox'>): Promise<void> {
  try {
    await showErrorBox(text, host);
  } catch { /* quit anyway */ }
  await backend.quitApp();
}

/** Cmd+Q state: a quit asked for before the session exists is applied as soon as it does. */
const quit: { session: RunSession | null; backend: Backend | null; pending: boolean; fallback: ReturnType<typeof setTimeout> | null } =
  { session: null, backend: null, pending: false, fallback: null };

/** Cmd+Q: ends the program cleanly (onEnded then quits); a timer quits anyway if the program never reports back. */
export function requestQuit(): void {
  const { session, backend } = quit;
  if (!session || !backend) { quit.pending = true; return; }
  if (session.ended) { void backend.quitApp(); return; }
  session.end();
  if (!session.ended) quit.fallback ??= setTimeout(() => { void backend.quitApp(); }, 1500);
}

function sessionEnded(): void {
  if (quit.fallback) clearTimeout(quit.fallback);
  quit.fallback = null;
}

export async function startRuntime(project: Project, backend: Backend, host: TauriFormHost = new TauriFormHost()): Promise<void> {
  const appPath = await backend.getAppDir().catch(() => '');
  let session: RunSession;
  try {
    session = new RunSession(project, host, {
      debugPrint: () => {},
      onBreak: async () => 'end',
      onEnded: () => { sessionEnded(); void host.dispose().finally(() => backend.quitApp()); },
      readFile: p => backend.readBinaryFile(p),
      appPath,
    }, 'app');
  } catch (e) {
    await fatalError(backend, `Compile error:\n\n${e instanceof Error ? e.message : String(e)}`, host);
    return;
  }
  quit.session = session;
  quit.backend = backend;
  if (quit.pending) { quit.pending = false; requestQuit(); }
  try {
    await session.start();
  } catch (e) {
    await fatalError(backend, e instanceof Error ? e.message : String(e), host);
  }
}
