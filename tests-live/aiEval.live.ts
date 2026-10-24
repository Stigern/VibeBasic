// @vitest-environment jsdom
// Live evaluation of the AI assistant: every task of tasks.ts, LIVE_RUNS times, against the server in LIVE_BASE_URL.
// One JSON line per run goes to LIVE_OUT. See vitest.config.ts in this folder for the options.
import { appendFileSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { test, vi } from 'vitest';
import './driver';
import { runTask, type LiveConfig } from './flows';
import { TASKS } from './tasks';

vi.mock('../src/ui98/dialogs', async orig => {
  const real = await orig<typeof import('../src/ui98/dialogs')>();
  type D = import('./driver').Driver;
  const d = () => (globalThis as unknown as { __liveDriver: D }).__liveDriver;
  return {
    ...real,
    showDialog98: (doc: Document, o: Parameters<D['dialog']>[1]) => d().dialog(doc, o),
    messageBox98: async (_doc: Document, o: { prompt: string }) => d().messageBox(o),
    compileErrorBox: async () => d().compileChoice,
  };
});

const rect = { x: 0, y: 0, top: 0, left: 0, right: 0, bottom: 0, width: 0, height: 0, toJSON() {} };
Range.prototype.getClientRects = () => [] as unknown as DOMRectList;
Range.prototype.getBoundingClientRect = () => rect as DOMRect;

const env = process.env;
const baseUrl = env.LIVE_BASE_URL ?? '';
const cfg: LiveConfig = { baseUrl, model: env.LIVE_MODEL ?? '', thinking: (env.LIVE_THINKING as LiveConfig['thinking']) ?? 'low' };
const runs = Number(env.LIVE_RUNS ?? 2);
const only = env.LIVE_TASKS ? new Set(env.LIVE_TASKS.split(',').map((s: string) => s.trim())) : null;
const out = env.LIVE_OUT ?? 'tests-live/results/results.jsonl';
const tasks = TASKS.filter(t => (!only || only.has(t.id)) && (env.LIVE_HARD !== '1' || t.hard));

test.skipIf(!baseUrl || !cfg.model)('live AI evaluation', async () => {
  mkdirSync(dirname(out), { recursive: true });
  for (let run = 1; run <= runs; run++) {
    for (const task of tasks) {
      const rec = await runTask(task, run, cfg);
      // the server address never goes into the results
      appendFileSync(out, `${JSON.stringify(rec).split(baseUrl).join('<server>')}\n`);
      const req = rec.requests;
      process.stderr.write(`[${cfg.thinking} run ${run}] ${task.id}: ${rec.success ? 'OK' : `FAIL ${rec.failure.slice(0, 220)}`} (${rec.seconds.toFixed(0)} s, ${req.length} req: ${req.map(r => r.kind).join(',')})\n`);
    }
  }
});
