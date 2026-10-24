// @vitest-environment jsdom
// Re-judges stored runs with the current checks (no server): LIVE_RECHECK=a.jsonl,b.jsonl npx vitest run --config tests-live/vitest.config.ts tests-live/recheck.live.ts
import { readFileSync, writeFileSync } from 'node:fs';
import { test } from 'vitest';
import { judge, type RunRecord } from './flows';
import { TASKS } from './tasks';

const files = (process.env.LIVE_RECHECK ?? '').split(',').filter(Boolean);
test.skipIf(!files.length)('re-check stored runs', async () => {
  for (const f of files) {
    const recs = (readFileSync(f, 'utf8') as string).split('\n').filter(Boolean).map((l: string) => JSON.parse(l) as RunRecord);
    let changed = 0;
    for (const r of recs) {
      const task = TASKS.find(t => t.id === r.task);
      if (!task || !r.finalProject) continue;
      const was = r.success;
      await judge(task, r);
      if (was !== r.success) { changed++; process.stderr.write(`${r.task} ${r.thinking} ${r.run}: ${was} -> ${r.success} ${r.failure.slice(0, 160)}\n`); }
    }
    writeFileSync(f, recs.map(r => JSON.stringify(r)).join('\n') + '\n');
    process.stderr.write(`${f}: ${recs.length} runs, ${changed} verdicts changed\n`);
  }
});
