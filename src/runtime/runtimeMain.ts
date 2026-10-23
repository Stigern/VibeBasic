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

/** Cmd+Q state: a quit asked for before the session exists is applied as soon as it does. `dialogs`: dialogs open (MsgBox ...). */
const quit: {
  session: RunSession | null; backend: Backend | null; pending: boolean; asking: boolean; dialogs: number;
  fallback: ReturnType<typeof setTimeout> | null;
} = { session: null, backend: null, pending: false, asking: false, dialogs: 0, fallback: null };

/** How long a program may take to answer Cmd+Q (not counting the time a dialog of it is open) before the app quits anyway. */
const QUIT_FALLBACK_MS = 1500;

function armFallback(backend: Backend): void {
  if (quit.fallback) clearTimeout(quit.fallback);
  quit.fallback = setTimeout(() => {
    quit.fallback = null;
    if (!quit.asking) return;
    if (quit.dialogs > 0) armFallback(backend);   // "Save changes?": the user answers, however long that takes
    else void backend.quitApp();                  // the program hangs
  }, QUIT_FALLBACK_MS);
}

/**
 * Cmd+Q: every form gets QueryUnload (UnloadMode vbAppWindows) and Unload, then the program ends (onEnded quits the app). A form
 * that sets Cancel keeps the app running. A program that does not answer (a loop) is quit after QUIT_FALLBACK_MS; a second
 * Cmd+Q while no dialog of it is open quits at once.
 */
export function requestQuit(): void {
  const { session, backend } = quit;
  if (!session || !backend) { quit.pending = true; return; }
  if (session.ended) { void backend.quitApp(); return; }
  if (quit.asking) { if (quit.dialogs === 0) void backend.quitApp(); return; }
  quit.asking = true;
  armFallback(backend);
  void session.quit().catch(() => false).then(done => {
    quit.asking = false;
    if (!done && quit.fallback) { clearTimeout(quit.fallback); quit.fallback = null; }
  });
}

function sessionEnded(): void {
  if (quit.fallback) clearTimeout(quit.fallback);
  quit.fallback = null;
  quit.asking = false;
}

const DIALOGS = new Set<PropertyKey>(['messageBox', 'inputBox', 'fileDialog', 'colorDialog', 'fontDialog', 'runtimeErrorBox']);
/** The host as the session sees it: it counts the program's dialogs that are open (Cmd+Q waits while one is). */
function countingDialogs(host: TauriFormHost): TauriFormHost {
  return new Proxy(host, {
    get(t, k) {
      const v: unknown = Reflect.get(t, k, t);
      if (typeof v !== 'function') return v;
      const f = v as (...a: unknown[]) => unknown;
      if (!DIALOGS.has(k)) return f.bind(t);
      return (...a: unknown[]) => {
        quit.dialogs++;
        return Promise.resolve(f.apply(t, a)).finally(() => { quit.dialogs--; });
      };
    },
  });
}

export async function startRuntime(project: Project, backend: Backend, host: TauriFormHost = new TauriFormHost()): Promise<void> {
  const appPath = await backend.getAppDir().catch(() => '');
  const appName = await backend.getAppName().catch(() => '');
  let session: RunSession;
  try {
    session = new RunSession(project, countingDialogs(host), {
      debugPrint: () => {},
      onBreak: async () => 'end',
      // the text Print # left in buffers is on disk before the app quits
      onEnded: () => { sessionEnded(); void session.filesClosed.then(() => host.dispose()).finally(() => backend.quitApp()); },
      readFile: p => backend.readBinaryFile(p),
      appPath,
      appName,
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
