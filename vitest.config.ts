import pkg from './package.json' with { type: 'json' };
import { defineConfig } from 'vitest/config';


export default defineConfig({
  define: { __APP_VERSION__: JSON.stringify(pkg.version) },
  test: {
    environment: 'jsdom',
    globals: true,
    include: ['tests/**/*.test.ts'],
    setupFiles: ['tests/setup.ts'],
    // CI runners (Windows above all: coarse timers, slower disks) need more room than a local machine
    testTimeout: (globalThis as { process?: { env: Record<string, string | undefined> } }).process?.env.CI ? 30_000 : 5_000,
  },
});
