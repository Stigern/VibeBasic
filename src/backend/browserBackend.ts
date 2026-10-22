import type { Backend, DirListing, FileFilter, Volume } from './backend';
import type { ChatMessage } from '../ai/types';
import { readSseEvent, parseSseChunk, type AiChatOptions } from '../ai/sse';

const AI_CONNECT_ERROR = (baseUrl: string) =>
  `Could not connect to ${baseUrl}. Check that the AI server is running and can be reached from this Mac. For Ollama on another PC, start Ollama with OLLAMA_HOST=0.0.0.0.`;
const AI_UNREADABLE = 'The AI server sent an answer VibeBasic could not read.';

function aiEndpoint(baseUrl: string, path: string): string {
  return baseUrl.trim().replace(/\/+$/, '') + '/' + path.replace(/^\/+/, '');
}

/** Same error texts as src-tauri/src/ai.rs. Browser fetch needs OLLAMA_ORIGINS=* on the server (development only). */
/** `error.message` (OpenAI / Ollama) or a plain string `error` from a JSON error body. */
function errorMessage(body: string): string | null {
  try {
    const e = (JSON.parse(body) as { error?: unknown } | null)?.error;
    const m = typeof e === 'string' ? e : typeof (e as { message?: unknown } | null)?.message === 'string' ? (e as { message: string }).message : '';
    return m.trim() || null;
  } catch { return null; }
}

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
  if (!res.ok) throw httpError(res, text, url);
  try { return JSON.parse(text); } catch { throw new Error(AI_UNREADABLE); }
}

function httpError(res: Response, text: string, url: string): Error {
  if (res.status === 401 || res.status === 403) return new Error(`The AI server refused the request (${res.status}). Check the API key.`);
  const status = `${res.status}${res.statusText ? ` ${res.statusText}` : ''}`;
  const message = errorMessage(text);
  if (message) return new Error(`The AI server answered ${status}: ${message}`);
  if (res.status === 404) return new Error(`The AI server answered 404 Not Found for ${url}. Check the base URL. For Ollama it usually ends with /v1.`);
  return new Error(`The AI server answered ${status}: ${text.slice(0, 200)}`);
}

const STREAM_IDLE_SECS = 90;
const STREAM_TOTAL_SECS = 20 * 60;

/** The answer text from the parts of a reply: content, else the thinking, else the "unreadable" error. */
function answerText(content: string, reasoning: string, finish: string | undefined): string {
  if (content.trim()) return content.trim();
  if (reasoning.trim()) return reasoning.trim();
  throw new Error(`${AI_UNREADABLE} (Details: the reply had no text; finish_reason = ${finish ?? 'none'}.)`);
}

/** Streaming chat request (SSE). Idle timeout instead of a total one, plus a 20 minute safety cap. */
async function aiStream(baseUrl: string, apiKey: string, body: string, opts: AiChatOptions): Promise<string> {
  const url = aiEndpoint(baseUrl, 'chat/completions');
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  if (apiKey.trim()) headers['Authorization'] = 'Bearer ' + apiKey.trim();
  const ctrl = new AbortController();
  let reason: 'cancel' | 'idle' | 'total' | null = null;
  const stop = (r: 'cancel' | 'idle' | 'total') => { reason = reason ?? r; ctrl.abort(); };
  if (opts.signal?.aborted) throw new Error('cancelled');
  opts.signal?.addEventListener('abort', () => stop('cancel'));
  let idleTimer: ReturnType<typeof setTimeout> | undefined;
  const touch = () => { clearTimeout(idleTimer); idleTimer = setTimeout(() => stop('idle'), STREAM_IDLE_SECS * 1000); };
  const totalTimer = setTimeout(() => stop('total'), STREAM_TOTAL_SECS * 1000);
  try {
    touch();
    const res = await fetch(url, { method: 'POST', headers, body, signal: ctrl.signal });
    touch();
    if (!res.ok) throw httpError(res, await res.text(), url);
    if (/json/i.test(res.headers.get('content-type') ?? '')) {
      let v: any;
      try { v = JSON.parse(await res.text()); } catch { throw new Error(AI_UNREADABLE); }
      const m = v?.choices?.[0]?.message;
      return answerText(typeof m?.content === 'string' ? m.content : '', [m?.reasoning, m?.reasoning_content].find(t => typeof t === 'string') ?? '', v?.choices?.[0]?.finish_reason);
    }
    if (!res.body) throw new Error(AI_UNREADABLE);
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buf = '', content = '', reasoning = '', finish: string | undefined;
    let done = false;
    const handle = (payload: string) => {
      const ev = readSseEvent(payload);
      if (ev.error) throw new Error(ev.error);
      if (ev.done) { done = true; return; }
      if (ev.finish) finish = ev.finish;
      for (const d of ev.deltas) {
        if (d.kind === 'reasoning') reasoning += d.text; else content += d.text;
        opts.onDelta?.(d.kind, d.text);
      }
    };
    while (!done) {
      const { value, done: eof } = await reader.read();
      touch();
      if (eof) break;
      const parsed = parseSseChunk(buf + decoder.decode(value, { stream: true }));
      buf = parsed.rest;
      for (const p of parsed.events) { handle(p); if (done) break; }
    }
    if (!done) for (const p of parseSseChunk(buf + '\n\n').events) handle(p);
    else void reader.cancel().catch(() => {});
    return answerText(content, reasoning, finish);
  } catch (e) {
    if (reason === 'cancel') throw new Error('cancelled');
    if (reason === 'idle') throw new Error(`The AI server stopped sending for ${STREAM_IDLE_SECS} seconds.`);
    if (reason === 'total') throw new Error(`The AI server did not finish within ${STREAM_TOTAL_SECS / 60} minutes.`);
    if (e instanceof Error && e.message.startsWith('The AI server')) throw e;
    throw new Error(AI_CONNECT_ERROR(baseUrl));
  } finally {
    clearTimeout(idleTimer);
    clearTimeout(totalTimer);
  }
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

  async showOpenDialog(filters: FileFilter[], title: string, initDir: string): Promise<string | null> {
    const ext = filters.flatMap(f => f.extensions).map(x => '*.' + x).join(', ');
    return this.ask(`${title || 'Open'} (file name${ext ? ', ' + ext : ''}):`, initDir ? `${initDir.replace(/\/+$/, '')}/` : '');
  }

  async showSaveDialog(_filters: FileFilter[], title: string, initDir: string, defaultName = ''): Promise<string | null> {
    return this.ask(`${title || 'Save as'} (file name):`, initDir ? `${initDir.replace(/\/+$/, '')}/${defaultName}` : defaultName);
  }

  async listVolumes(): Promise<Volume[]> {
    return [{ name: '/', path: '/' }];
  }

  /** The files "written" in this browser (localStorage) make up the folders. */
  async listDir(path: string): Promise<DirListing> {
    const base = path.replace(/\/+$/, '') + '/';
    const dirs = new Set<string>();
    const files: { name: string; hidden: boolean }[] = [];
    for (let i = 0; i < localStorage.length; i++) {
      const k = localStorage.key(i);
      if (!k?.startsWith(FS_PREFIX + base)) continue;
      const rest = k.slice(FS_PREFIX.length + base.length), slash = rest.indexOf('/');
      if (slash >= 0) dirs.add(rest.slice(0, slash)); else files.push({ name: rest, hidden: rest.startsWith('.') });
    }
    const by = (a: string, b: string) => a.toLowerCase().localeCompare(b.toLowerCase());
    return { dirs: [...dirs].sort(by), files: files.sort((a, b) => by(a.name, b.name)) };
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

  async aiChat(baseUrl: string, apiKey: string, model: string, messages: ChatMessage[], reasoningEffort?: string, opts?: AiChatOptions): Promise<string> {
    const effort = reasoningEffort?.trim();
    const streaming = !!opts?.onDelta;
    const body = JSON.stringify({ model, messages, temperature: 0.2, stream: streaming, ...(effort ? { chat_template_kwargs: { reasoning_effort: effort } } : {}) });
    if (streaming) return aiStream(baseUrl, apiKey, body, opts!);
    const v = (await aiRequest(baseUrl, apiKey, 'chat/completions', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body }, 600)) as
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
