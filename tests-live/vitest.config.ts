// Live AI evaluation against a real model server. Not part of `npm test`: run it with this config, e.g.
//   LIVE_BASE_URL=http://host:8000/v1 LIVE_MODEL=my-model npx vitest run --config tests-live/vitest.config.ts
// Options (environment): LIVE_TASKS=id,id (default all), LIVE_RUNS=2, LIVE_THINKING=low, LIVE_OUT=tests-live/results/x.jsonl,
// LIVE_HARD=1 (only the tasks marked hard). The base URL is never written into results or the report.
import pkg from '../package.json' with { type: 'json' };
import { defineConfig } from 'vitest/config';

export default defineConfig({
  define: { __APP_VERSION__: JSON.stringify(pkg.version) },
  test: {
    root: new URL('..', import.meta.url).pathname,
    environment: 'jsdom',
    globals: true,
    include: ['tests-live/**/*.live.ts'],
    setupFiles: ['tests/setup.ts'],
    testTimeout: 60 * 60 * 1000,
    hookTimeout: 60_000,
    fileParallelism: false,
  },
});
