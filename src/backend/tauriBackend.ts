import { invoke } from '@tauri-apps/api/core';
import { getCurrentWindow } from '@tauri-apps/api/window';
import { open, save } from '@tauri-apps/plugin-dialog';
import type { Backend, FileFilter } from './backend';

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

  async openFileDialog(filters: FileFilter[]): Promise<string | null> {
    const r = await open({ multiple: false, directory: false, filters });
    return typeof r === 'string' ? r : null;
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

  async setWindowTitle(title: string): Promise<void> {
    await getCurrentWindow().setTitle(title);
  }

  onCloseRequested(handler: () => Promise<boolean>): void {
    void getCurrentWindow().onCloseRequested(async (e) => {
      if (!(await handler())) e.preventDefault();
    });
  }
}
