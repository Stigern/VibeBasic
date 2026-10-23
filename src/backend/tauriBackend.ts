import { invoke } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';
import { getCurrentWindow } from '@tauri-apps/api/window';
import { open, save } from '@tauri-apps/plugin-dialog';
import type { Backend, CommEvent, CommLines, SysInfoData, DbExecResult, DbQueryResult, DbValue, DirListing, FileFilter, InetRequest, InetResponse, SocketEvent, SocketInfo, Volume } from './backend';
import type { AiModel, ChatMessage } from '../ai/types';
import { dialogFilters } from './dialogFilters';
import type { AiChatOptions, AiDeltaKind } from '../ai/sse';
import type { FileAccess, FileMode, FileStat } from '../lang/fileio/fsApi';
import { AI_SETTINGS_KEY, loadAiSettingsFrom, saveAiSettingsTo, type AiSettingsIo } from './aiSettingsStore';


const PROJECT_FILTER: FileFilter = { name: 'VibeBasic Project', extensions: ['vbb'] };

async function call<T>(cmd: string, args: Record<string, unknown>): Promise<T> {
  try {
    return await invoke<T>(cmd, args);
  } catch (e) {
    throw new Error(typeof e === 'string' ? e : e instanceof Error ? e.message : String(e));
  }
}

/** A raw IPC response (tauri::ipc::Response) is an ArrayBuffer; older shapes are a number array. */
function bytesOf(r: number[] | ArrayBuffer | Uint8Array): Uint8Array {
  return r instanceof Uint8Array ? r : new Uint8Array(r);
}

/** The AI settings live on the Rust side (ai_settings.rs), not in localStorage, which the form windows share. */
const aiSettingsIo: AiSettingsIo = {
  get: () => call<unknown>('ai_settings_get', {}),
  set: v => call<void>('ai_settings_set', { settings: v }),
};

function legacyStorage(): Pick<Storage, 'getItem' | 'removeItem'> | null {
  try { return localStorage; } catch { return null; }
}

/** "7|path: the file is too big" -> an Error with the text and `vbNumber` 7 (the IDE shows the text, a running program
 *  raises the number). */
function numbered(e: unknown): never {
  const m = /^(\d+)\|([\s\S]*)$/.exec(e instanceof Error ? e.message : String(e));
  throw m ? Object.assign(new Error(m[2]), { vbNumber: Number(m[1]) }) : e;
}

function toBase64(bytes: Uint8Array): string {
  let s = '';
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(s);
}
function fromBase64(b64: string): Uint8Array {
  const s = atob(b64), out = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i++) out[i] = s.charCodeAt(i);
  return out;
}

type RawCommEvent = Exclude<CommEvent, { kind: 'data' }> | { kind: 'data'; id: number; data: string };
type RawSocketEvent = Exclude<SocketEvent, { kind: 'data' }> | { kind: 'data'; id: number; data: string; remoteIp: string; remotePort: number };

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

  listVolumes(): Promise<Volume[]> {
    return call<Volume[]>('list_volumes', {});
  }

  /** pbpaste / pbcopy on the Rust side: navigator.clipboard wants a user gesture, which a Timer or Form_Load does not have. */
  clipboardGetText(): Promise<string> {
    return call<string>('clipboard_get_text', {});
  }

  clipboardSetText(text: string): Promise<void> {
    return call<void>('clipboard_set_text', { text });
  }

  listDir(path: string): Promise<DirListing> {
    return call<DirListing>('list_dir', { path });
  }

  // -- Inet and Winsock (inet.rs, winsock.rs) --

  async inetRequest(r: InetRequest): Promise<InetResponse> {
    const res = await call<Omit<InetResponse, 'body'> & { body: string }>('inet_request', {
      id: r.id, url: r.url, method: r.method, headers: r.headers, body: toBase64(r.body),
      timeoutSecs: Math.max(0, Math.round(r.timeoutSecs)), userName: r.userName, password: r.password,
    });
    return { ...res, body: fromBase64(res.body) };
  }
  async inetCancel(id: string): Promise<void> { await call<void>('inet_cancel', { id }); }
  sockConnect(id: number, host: string, port: number): Promise<SocketInfo> { return call<SocketInfo>('sock_connect', { id, host, port }); }
  sockListen(id: number, port: number, ip: string): Promise<SocketInfo> { return call<SocketInfo>('sock_listen', { id, port, ip }); }
  sockAccept(id: number, requestId: number): Promise<SocketInfo> { return call<SocketInfo>('sock_accept', { id, requestId }); }
  sockBind(id: number, port: number, ip: string): Promise<SocketInfo> { return call<SocketInfo>('sock_bind', { id, port, ip }); }
  async sockSend(id: number, data: Uint8Array, host: string, port: number): Promise<void> { await call<void>('sock_send', { id, data: toBase64(data), host, port }); }
  async sockClose(id: number): Promise<void> { await call<void>('sock_close', { id }); }
  async netReset(): Promise<void> { await call<void>('net_reset', {}); }
  netLocalIp(): Promise<string> { return call<string>('net_local_ip', {}); }
  onSocketEvent(handler: (e: SocketEvent) => void): Promise<() => void> {
    return listen<RawSocketEvent>('vb:socket', e => {
      const p = e.payload;
      handler(p.kind === 'data' ? { ...p, data: fromBase64(p.data) } : p);
    });
  }

  readTextFile(path: string): Promise<string> {
    return call<string>('read_text_file', { path }).catch(numbered);
  }

  async writeTextFile(path: string, text: string): Promise<void> {
    await call<void>('write_text_file', { path, text });
  }

  /** Raw bytes. A file over the size cap rejects with an Error whose `vbNumber` is 7 (Out of memory). */
  async readBinaryFile(path: string): Promise<Uint8Array> {
    return bytesOf(await call<number[] | ArrayBuffer | Uint8Array>('read_binary_file', { path }).catch(numbered));
  }

  // the files of a running program (src-tauri/src/fileio.rs); rejections are "number|description"
  fioOpen(path: string, mode: FileMode, access: FileAccess): Promise<{ id: number; len: number }> { return call('fio_open', { path, mode, access }); }
  async fioRead(id: number, pos: number, len: number): Promise<Uint8Array> { return bytesOf(await call<ArrayBuffer>('fio_read', { id, pos, len })); }
  async fioWrite(id: number, pos: number, data: Uint8Array): Promise<void> { await call<void>('fio_write', { id, pos, data: toBase64(data) }); }
  async fioClose(id: number): Promise<void> { await call<void>('fio_close', { id }); }
  async fioReset(): Promise<void> { await call<void>('fio_reset', {}); }
  async fsKill(path: string): Promise<void> { await call<void>('fs_kill', { path }); }
  async fsRename(from: string, to: string): Promise<void> { await call<void>('fs_rename', { from, to }); }
  async fsMkDir(path: string): Promise<void> { await call<void>('fs_mkdir', { path }); }
  async fsRmDir(path: string): Promise<void> { await call<void>('fs_rmdir', { path }); }
  async fsCopy(from: string, to: string): Promise<void> { await call<void>('fs_copy', { from, to }); }
  async fsSetAttr(path: string, attr: number): Promise<void> { await call<void>('fs_set_attr', { path, attr }); }
  fsStat(path: string): Promise<FileStat | null> { return call('fs_stat', { path }); }
  settingGet(appName: string, section: string, key: string): Promise<string | null> { return call('setting_get', { appName, section, key }); }
  async settingSave(appName: string, section: string, key: string, value: string): Promise<void> { await call<void>('setting_save', { appName, section, key, value }); }
  async settingDelete(appName: string, section: string, key: string | null): Promise<void> { await call<void>('setting_delete', { appName, section, key }); }
  settingAll(appName: string, section: string): Promise<[string, string][]> { return call('setting_all', { appName, section }); }

  dbOpen(path: string): Promise<number> { return call('db_open', { path }); }
  dbQuery(id: number, sql: string, params: DbValue[]): Promise<DbQueryResult> { return call('db_query', { id, sql, params }); }
  dbExecute(id: number, sql: string, params: DbValue[]): Promise<DbExecResult> { return call('db_execute', { id, sql, params }); }
  async dbClose(id: number): Promise<void> { await call<void>('db_close', { id }); }
  async dbReset(): Promise<void> { await call<void>('db_reset', {}); }

  // -- MSComm and SysInfo (comm.rs, sysinfo.rs) --
  commList(): Promise<string[]> { return call('comm_list', {}); }
  commOpen(id: number, path: string, settings: string, handshaking: number, dtr: boolean, rts: boolean): Promise<CommLines> {
    return call('comm_open', { id, path, settings, handshaking, dtr, rts });
  }
  async commConfigure(id: number, settings: string, handshaking: number): Promise<void> { await call<void>('comm_configure', { id, settings, handshaking }); }
  async commWrite(id: number, data: Uint8Array): Promise<void> { await call<void>('comm_write', { id, data: toBase64(data) }); }
  async commSetLines(id: number, dtr: boolean | null, rts: boolean | null, brk: boolean | null): Promise<void> { await call<void>('comm_set_lines', { id, dtr, rts, brk }); }
  async commClose(id: number): Promise<void> { await call<void>('comm_close', { id }); }
  async commReset(): Promise<void> { await call<void>('comm_reset', {}); }
  onCommEvent(handler: (e: CommEvent) => void): Promise<() => void> {
    return listen<RawCommEvent>('vb:comm', e => {
      const p = e.payload;
      handler(p.kind === 'data' ? { ...p, data: fromBase64(p.data) } : p);
    });
  }
  sysInfo(): Promise<SysInfoData> { return call('sys_info', {}); }

  mediaOpen(path: string): Promise<string> { return call<string>('media_open', { path }); }
  async mediaRead(token: string): Promise<Uint8Array> {
    return bytesOf(await call<number[] | ArrayBuffer | Uint8Array>('media_read', { token }));
  }
  async mediaClose(token: string): Promise<void> { await call<void>('media_close', { token }); }

  async loadSettings<T>(key: string): Promise<T | null> {
    if (key === AI_SETTINGS_KEY) return loadAiSettingsFrom<T>(aiSettingsIo, legacyStorage());
    try {
      const raw = localStorage.getItem('vibebasic.settings:' + key);
      return raw === null ? null : (JSON.parse(raw) as T);
    } catch { return null; }
  }

  async saveSettings(key: string, v: unknown): Promise<void> {
    if (key === AI_SETTINGS_KEY) return saveAiSettingsTo(aiSettingsIo, legacyStorage(), v);
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

  aiListModels(baseUrl: string, apiKey: string): Promise<AiModel[]> {
    return call<AiModel[]>('ai_list_models', { baseUrl, apiKey });
  }

  async aiChat(baseUrl: string, apiKey: string, model: string, messages: ChatMessage[], reasoningEffort?: string, opts?: AiChatOptions): Promise<string> {
    const args = { baseUrl, apiKey, model, messages, reasoningEffort: reasoningEffort || null };
    if (!opts?.onDelta && !opts?.signal) return call<string>('ai_chat', args);
    if (opts.signal?.aborted) throw new Error('cancelled');
    const streamId = `ai-${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
    const unlisten = await listen<{ id: string; kind: AiDeltaKind; text: string }>('ai:delta', e => {
      if (e.payload.id === streamId) opts.onDelta?.(e.payload.kind, e.payload.text);
    });
    const unlistenUsage = await listen<{ id: string; prompt_tokens: number; completion_tokens: number; cached_tokens?: number | null }>('ai:usage', e => {
      const p = e.payload;
      if (p.id !== streamId) return;
      opts.onUsage?.({ promptTokens: p.prompt_tokens, completionTokens: p.completion_tokens, ...(typeof p.cached_tokens === 'number' ? { cachedTokens: p.cached_tokens } : {}) });
    });
    const onAbort = () => { void invoke('ai_cancel', { streamId }).catch(() => {}); };
    opts.signal?.addEventListener('abort', onAbort);
    try {
      return await call<string>('ai_chat', { ...args, streamId });
    } finally {
      opts.signal?.removeEventListener('abort', onAbort);
      unlisten();
      unlistenUsage();
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
