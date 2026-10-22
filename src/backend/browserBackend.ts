import type { Backend } from './backend';

export class BrowserBackend implements Backend {
  readonly kind = 'browser' as const;

  async showMainWindow(): Promise<void> {
    // Ingenting å gjøre i nettleseren.
  }
}
