import { getCurrentWindow } from '@tauri-apps/api/window';
import type { Backend } from './backend';

export class TauriBackend implements Backend {
  readonly kind = 'tauri' as const;

  async showMainWindow(): Promise<void> {
    await getCurrentWindow().show();
  }
}
