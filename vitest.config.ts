import pkg from './package.json' with { type: 'json' };
import { defineConfig } from 'vitest/config';


export default defineConfig({
  define: { __APP_VERSION__: JSON.stringify(pkg.version) },
  test: {
    environment: 'jsdom',
    globals: true,
    include: ['tests/**/*.test.ts'],
  },
});
