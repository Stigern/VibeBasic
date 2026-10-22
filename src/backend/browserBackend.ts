import type { Backend, FileFilter } from './backend';
import type { ChatMessage } from '../ai/types';

const AI_CONNECT_ERROR = (baseUrl: string) =>
  `Could not connect to ${baseUrl}. Check that the AI server is running and can be reached from this Mac. For Ollama on another PC, start Ollama with OLLAMA_HOST=0.0.0.0.`;
const AI_UNREADABLE = 'The AI server sent an answer VibeBasic could not read.';

function aiEndpoint(baseUrl: string, path: string): string {
  return baseUrl.trim().replace(/\/+$/, '') + '/' + path.replace(/^\/+/, '');
}

/** Same error texts as src-tauri/src/ai.rs. Browser fetch needs OLLAMA_ORIGINS=* on the server (development only). */
async function aiRequest(baseUrl: string, apiKey: string, path: string, init: RequestInit, timeoutSecs: number): Promise<unknown> {
  const url = aiEndpoint(baseUrl, path);
  const headers: Record<string, string> = { ...(init.headers as Record<string, string> | undefined) };
  if (apiKey.trim()) headers['Authorization'] = 'Bearer ' + apiKey.trim();
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutSecs * 1000);
  let text: string;
  let res: Response;
  try {
    res = await fetch(url, { ...init, headers, signal: ctrl.signal });
    text = await res.text();
  } catch (e) {
    if (ctrl.signal.aborted) throw new Error(`The AI server did not answer within ${timeoutSecs} seconds.`);
    throw new Error(AI_CONNECT_ERROR(baseUrl));
  } finally {
    clearTimeout(timer);
  }
  if (!res.ok) {
    if (res.status === 404) throw new Error(`The AI server answered 404 Not Found for ${url}. Check the base URL. For Ollama it usually ends with /v1.`);
    if (res.status === 401 || res.status === 403) throw new Error(`The AI server refused the request (${res.status}). Check the API key.`);
    throw new Error(`The AI server answered ${res.status} ${res.statusText}: ${text.slice(0, 200)}`);
  }
  try { return JSON.parse(text); } catch { throw new Error(AI_UNREADABLE); }
}

const FS_PREFIX = 'vibebasic.fs:';

/** Development only: files live in localStorage under `vibebasic.fs:<path>`, dialogs are window.prompt. */
export class BrowserBackend implements Backend {
  readonly kind = 'browser' as const;

  async showMainWindow(): Promise<void> {
    // Ingenting å gjøre i nettleseren.
  }

  private ask(message: string, def: string): string | null {
    const r = window.prompt(message, def);
    const name = r?.trim();
    return name ? name : null;
  }

  async openProjectDialog(): Promise<string | null> {
    return this.ask('Open project (file name, *.vbb):', 'Project1.vbb');
  }

  async saveProjectDialog(defaultFileName: string): Promise<string | null> {
    const name = this.ask('Save project as (file name, *.vbb):', defaultFileName);
    if (name === null) return null;
    return /\.vbb$/i.test(name) ? name : name + '.vbb';
  }

  async saveAppDialog(_defaultName: string): Promise<string | null> {
    return null;
  }

  async makeApp(_o: { targetPath: string; appName: string; projectJson: string; iconPngBase64: string | null; overwrite: boolean }): Promise<void> {
    throw new Error('Make requires the desktop version of VibeBasic.');
  }

  async openFileDialog(filters: FileFilter[]): Promise<string | null> {
    const ext = filters.flatMap((f) => f.extensions).map((x) => '*.' + x).join(', ');
    return this.ask(`Open file (file name${ext ? ', ' + ext : ''}):`, '');
  }

  async readTextFile(path: string): Promise<string> {
    const text = localStorage.getItem(FS_PREFIX + path);
    if (text === null) throw new Error(`${path}: No such file`);
    return text;
  }

  async writeTextFile(path: string, text: string): Promise<void> {
    localStorage.setItem(FS_PREFIX + path, text);
  }

  async readBinaryFile(path: string): Promise<Uint8Array> {
    return new TextEncoder().encode(await this.readTextFile(path));
  }

  async loadSettings<T>(key: string): Promise<T | null> {
    try {
      const raw = localStorage.getItem('vibebasic.settings:' + key);
      return raw === null ? null : (JSON.parse(raw) as T);
    } catch { return null; }
  }

  async saveSettings(key: string, v: unknown): Promise<void> {
    try { localStorage.setItem('vibebasic.settings:' + key, JSON.stringify(v)); } catch { /* storage unavailable */ }
  }

  async setWindowTitle(title: string): Promise<void> {
    document.title = title;
  }

  async closeMainWindow(): Promise<void> {
    window.close(); // best effort: browsers only close windows opened by script
  }

  async getEmbeddedProject(): Promise<string | null> {
    return null;
  }

  async quitApp(): Promise<void> {
    // Nothing to quit in the browser.
  }

  async getAppDir(): Promise<string> {
    return '';
  }

  async getAppName(): Promise<string> {
    return '';
  }

  async canMakeApp(): Promise<void> {
    throw new Error('Make requires the desktop version of VibeBasic.');
  }

  async aiListModels(baseUrl: string, apiKey: string): Promise<string[]> {
    const v = (await aiRequest(baseUrl, apiKey, 'models', { method: 'GET' }, 15)) as { data?: unknown } | null;
    if (!v || !Array.isArray(v.data)) throw new Error(AI_UNREADABLE);
    return v.data.map((m) => (m as { id?: unknown })?.id).filter((id): id is string => typeof id === 'string');
  }

  async aiChat(baseUrl: string, apiKey: string, model: string, messages: ChatMessage[]): Promise<string> {
    const body = JSON.stringify({ model, messages, temperature: 0.2, stream: false });
    const v = (await aiRequest(baseUrl, apiKey, 'chat/completions', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body }, 180)) as
      { choices?: { message?: { content?: unknown } }[] } | null;
    const content = v?.choices?.[0]?.message?.content;
    if (typeof content !== 'string') throw new Error(AI_UNREADABLE);
    return content;
  }

  onQuitRequested(_handler: () => void): void {
    // No runtime menu in the browser.
  }

  onCloseRequested(_handler: () => Promise<boolean>): void {
    // Best effort: beforeunload cannot await an async handler, so the browser's own
    // confirmation prompt stands in for the IDE's "Save changes?" dialog (development only).
    window.addEventListener('beforeunload', (e) => {
      e.preventDefault();
      e.returnValue = '';
    });
  }
}
