import { invoke } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';
import { getCurrentWindow } from '@tauri-apps/api/window';
import { open, save } from '@tauri-apps/plugin-dialog';
import type { Backend, FileFilter } from './backend';
import type { ChatMessage } from '../ai/types';
import type { AiChatOptions, AiDeltaKind } from '../ai/sse';

/** The plugin takes plain extensions: `*` (all files) is dropped, and so is a filter left with none; without a filter every file is allowed. */
function dialogFilters(filters: FileFilter[]): FileFilter[] {
  return filters.map(f => ({ name: f.name, extensions: f.extensions.filter(x => x !== '*' && x !== '') })).filter(f => f.extensions.length > 0);
}

const PROJECT_FILTER: FileFilter = { name: 'VibeBasic Project', extensions: ['vbb'] };

async function call<T>(cmd: string, args: Record<string, unknown>): Promise<T> {
  try {
    return await invoke<T>(cmd, args);
  } catch (e) {
    throw new Error(typeof e === 'string' ? e : e instanceof Error ? e.message : String(e));
  }
}

export class TauriBackend implements Backend {
  readonly kind = 'tauri' as const;

  async showMainWindow(): Promise<void> {
    await getCurrentWindow().show();
  }

  openProjectDialog(): Promise<string | null> {
    return this.openFileDialog([PROJECT_FILTER]);
  }

  async saveProjectDialog(defaultFileName: string): Promise<string | null> {
    return (await save({ defaultPath: defaultFileName, filters: [PROJECT_FILTER] })) ?? null;
  }

  async saveAppDialog(defaultName: string): Promise<string | null> {
    return (await save({ defaultPath: defaultName, filters: [{ name: 'Application', extensions: ['app'] }] })) ?? null;
  }

  async makeApp(o: { targetPath: string; appName: string; projectJson: string; iconPngBase64: string | null; overwrite: boolean }): Promise<void> {
    await call<void>('make_app', {
      targetPath: o.targetPath, appName: o.appName, projectJson: o.projectJson,
      iconPngBase64: o.iconPngBase64, overwrite: o.overwrite,
    });
  }

  async openFileDialog(filters: FileFilter[]): Promise<string | null> {
    const r = await open({ multiple: false, directory: false, filters });
    return typeof r === 'string' ? r : null;
  }

  async showOpenDialog(filters: FileFilter[], title: string, initDir: string): Promise<string | null> {
    const r = await open({ multiple: false, directory: false, title: title || undefined, defaultPath: initDir || undefined, filters: dialogFilters(filters) });
    return typeof r === 'string' ? r : null;
  }

  async showSaveDialog(filters: FileFilter[], title: string, initDir: string, defaultName = ''): Promise<string | null> {
    const defaultPath = initDir ? (defaultName ? `${initDir.replace(/\/+$/, '')}/${defaultName}` : initDir) : defaultName || undefined;
    return (await save({ title: title || undefined, defaultPath, filters: dialogFilters(filters) })) ?? null;
  }

  readTextFile(path: string): Promise<string> {
    return call<string>('read_text_file', { path });
  }

  async writeTextFile(path: string, text: string): Promise<void> {
    await call<void>('write_text_file', { path, text });
  }

  async readBinaryFile(path: string): Promise<Uint8Array> {
    const r = await call<number[] | ArrayBuffer | Uint8Array>('read_binary_file', { path });
    return r instanceof Uint8Array ? r : new Uint8Array(r);
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
    await getCurrentWindow().setTitle(title);
  }

  async closeMainWindow(): Promise<void> {
    await getCurrentWindow().destroy();
  }

  getEmbeddedProject(): Promise<string | null> {
    return call<string | null>('get_embedded_project', {});
  }

  async quitApp(): Promise<void> {
    await call<void>('quit_app', {});
  }

  async getAppDir(): Promise<string> {
    return (await call<string | null>('get_app_dir', {})) ?? '';
  }

  async getAppName(): Promise<string> {
    return (await call<string | null>('get_app_name', {})) ?? '';
  }

  canMakeApp(): Promise<void> {
    return call<void>('can_make_app', {});
  }

  aiListModels(baseUrl: string, apiKey: string): Promise<string[]> {
    return call<string[]>('ai_list_models', { baseUrl, apiKey });
  }

  async aiChat(baseUrl: string, apiKey: string, model: string, messages: ChatMessage[], reasoningEffort?: string, opts?: AiChatOptions): Promise<string> {
    const args = { baseUrl, apiKey, model, messages, reasoningEffort: reasoningEffort || null };
    if (!opts?.onDelta && !opts?.signal) return call<string>('ai_chat', args);
    if (opts.signal?.aborted) throw new Error('cancelled');
    const streamId = `ai-${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
    const unlisten = await listen<{ id: string; kind: AiDeltaKind; text: string }>('ai:delta', e => {
      if (e.payload.id === streamId) opts.onDelta?.(e.payload.kind, e.payload.text);
    });
    const onAbort = () => { void invoke('ai_cancel', { streamId }).catch(() => {}); };
    opts.signal?.addEventListener('abort', onAbort);
    try {
      return await call<string>('ai_chat', { ...args, streamId });
    } finally {
      opts.signal?.removeEventListener('abort', onAbort);
      unlisten();
    }
  }

  onQuitRequested(handler: () => void): void {
    void listen('vb:quit-requested', () => handler());
  }

  onCloseRequested(handler: () => Promise<boolean>): void {
    void getCurrentWindow().onCloseRequested(async (e) => {
      if (!(await handler())) e.preventDefault();
    });
  }
}
