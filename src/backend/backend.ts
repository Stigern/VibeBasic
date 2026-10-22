import { BrowserBackend } from './browserBackend';
import { TauriBackend } from './tauriBackend';

export interface Backend {
  readonly kind: 'tauri' | 'browser';
  showMainWindow(): Promise<void>;
}

let cached: Backend | undefined;

/** Velger TauriBackend når appen kjører i Tauri, ellers BrowserBackend. */
export function getBackend(): Backend {
  if (!cached) {
    const inTauri = typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window;
    cached = inTauri ? new TauriBackend() : new BrowserBackend();
  }
  return cached;
}
