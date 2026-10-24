// Summarises live-run results (JSON lines from aiEval.live.ts) as Markdown tables.
//   node tests-live/summarize.mjs tests-live/results/low.jsonl tests-live/results/medium.jsonl > summary.md
import { readFileSync } from 'node:fs';

const recs = process.argv.slice(2).flatMap(f => readFileSync(f, 'utf8').split('\n').filter(Boolean).map(l => JSON.parse(l)));
const pct = (a, b) => (b ? `${Math.round((100 * a) / b)}%` : '-');
const q = (xs, p) => { if (!xs.length) return 0; const s = [...xs].sort((a, b) => a - b); return s[Math.min(s.length - 1, Math.floor(p * s.length))]; };
const f1 = n => (Math.round(n * 10) / 10).toString();
const table = (head, rows) => [`| ${head.join(' | ')} |`, `|${head.map(() => '---').join('|')}|`, ...rows.map(r => `| ${r.join(' | ')} |`)].join('\n');
const out = [];
const levels = [...new Set(recs.map(r => r.thinking))];
const NOTE = /^(Ignored|Renamed|Sizes for|Kept|Later changes|Made the form|Put the tab captions)/;

// success per category and thinking level (capability probes left out)
out.push('## Success per category', '');
const cats = ['code', 'form', 'error', 'question'];
out.push(table(['category', ...levels.map(l => `${l}: ok / runs`), ...levels.map(l => `${l}: proposal or answer`)],
  cats.map(c => [c,
    ...levels.map(l => { const rs = recs.filter(r => r.category === c && r.thinking === l && !r.gap); return `${rs.filter(r => r.success).length} / ${rs.length} (${pct(rs.filter(r => r.success).length, rs.length)})`; }),
    ...levels.map(l => { const rs = recs.filter(r => r.category === c && r.thinking === l && !r.gap); return pct(rs.filter(r => r.steps.every(s => s.proposal || s.dialogs.answers.length)).length, rs.length); }),
  ]).concat([['**all**', ...levels.map(l => { const rs = recs.filter(r => r.thinking === l && !r.gap); return `${rs.filter(r => r.success).length} / ${rs.length} (${pct(rs.filter(r => r.success).length, rs.length)})`; }), ...levels.map(() => '')]])));
out.push('');

// per task
out.push('## Per task', '');
const tasks = [...new Set(recs.map(r => r.task))];
out.push(table(['task', ...levels, 'failures (first of each kind)'], tasks.map(t => {
  const rs = recs.filter(r => r.task === t);
  const fails = [...new Set(rs.filter(r => !r.success).map(r => `${r.thinking}: ${r.failure}`.slice(0, 160).replace(/\|/g, '/')))].slice(0, 3);
  return [`${t}${rs[0].hard ? ' (hard)' : ''}${rs[0].gap ? ' (probe)' : ''}`, ...levels.map(l => { const x = rs.filter(r => r.thinking === l); return `${x.filter(r => r.success).length}/${x.length}`; }), fails.join('<br>')];
})));
out.push('');

// latency
out.push('## Latency', '');
const rows = [];
for (const l of levels) for (const c of cats) {
  const rs = recs.filter(r => r.thinking === l && r.category === c);
  const conv = rs.map(r => r.steps.reduce((n, s) => n + s.seconds, 0));
  const first = rs.flatMap(r => r.requests.filter(x => x.kind === 'first').map(x => x.ms / 1000));
  rows.push([l, c, rs.length, f1(q(conv, 0.5)), f1(q(conv, 0.9)), f1(Math.max(0, ...conv)), f1(q(first, 0.5)), f1(q(first, 0.9))]);
}
out.push(table(['thinking', 'category', 'runs', 'conversation p50 s', 'p90 s', 'max s', 'first request p50 s', 'p90 s'], rows));
out.push('');
const kinds = [...new Set(recs.flatMap(r => r.requests.map(x => x.kind)))];
out.push(table(['request kind', ...levels.map(l => `${l}: n / p50 s / p90 s / avg completion tok / avg thinking chars`)], kinds.map(k => [k, ...levels.map(l => {
  const xs = recs.filter(r => r.thinking === l).flatMap(r => r.requests.filter(x => x.kind === k));
  if (!xs.length) return '-';
  const ct = xs.map(x => x.completionTokens ?? 0), rc = xs.map(x => x.reasoningChars);
  return `${xs.length} / ${f1(q(xs.map(x => x.ms / 1000), 0.5))} / ${f1(q(xs.map(x => x.ms / 1000), 0.9))} / ${Math.round(ct.reduce((a, b) => a + b, 0) / xs.length)} / ${Math.round(rc.reduce((a, b) => a + b, 0) / xs.length)}`;
})])));
out.push('');
const pt = recs.flatMap(r => r.requests.filter(x => x.kind === 'first').map(x => x.promptTokens ?? 0)).filter(Boolean);
out.push(`First-request prompt tokens: p50 ${q(pt, 0.5)}, max ${Math.max(0, ...pt)}. Cached tokens reported: ${recs.some(r => r.requests.some(x => x.cachedTokens !== undefined)) ? 'yes' : 'never (the server sends no prompt_tokens_details)'}.`, '');

// robustness
out.push('## Retries, loops, fallbacks', '');
out.push(table(['thinking', 'conversations', 'with check round', 'check round fixed all', 'check round left problems', 'json retry', 'loops', 'SO fallback', 'transient retry', 'request errors', 'not understood', 'undo failed', 'lost code'], levels.map(l => {
  const rs = recs.filter(r => r.thinking === l);
  const checked = rs.filter(r => r.requests.some(x => x.kind === 'check'));
  let fixed = 0, left = 0;
  for (const r of checked) {
    const last = r.steps.flatMap(s => s.dialogs.previews).at(-1);
    const remaining = (last?.warnings ?? []).filter(w => !NOTE.test(w)).length;
    if (remaining) left++; else fixed++;
  }
  const count = k => rs.reduce((n, r) => n + r.requests.filter(x => x.kind === k).length, 0);
  return [l, rs.length, `${checked.length} (${pct(checked.length, rs.length)})`, fixed, left, count('json-retry'),
    rs.reduce((n, r) => n + r.steps.reduce((m, s) => m + s.logStatuses.filter(x => x === 'loop').length, 0), 0), count('so-fallback'), count('repeat'),
    rs.reduce((n, r) => n + r.requests.filter(x => x.error).length, 0), rs.reduce((n, r) => n + r.steps.reduce((m, s) => m + s.dialogs.notUnderstood.length, 0), 0),
    rs.reduce((n, r) => n + r.steps.filter(s => s.undo === 'failed').length, 0), rs.reduce((n, r) => n + r.steps.filter(s => s.lost.length).length, 0)];
})));
out.push('');

// what the check-and-fix round complained about
out.push('## Check-and-fix complaints (first round), by kind', '');
const kindOf = p => /overlap/.test(p) ? 'layout: overlap' : /past the (right|bottom) edge/.test(p) ? 'layout: outside the form' : /starts (left|above)/.test(p) ? 'layout: negative position'
  : /caption|too (narrow|small|low)|min/i.test(p) && /twips/.test(p) ? 'layout: size/caption' : /Line \d+:/.test(p) ? 'syntax' : /has no .* (property|method|event)/.test(p) ? 'unknown member'
  : /not defined/.test(p) ? 'not defined' : /needs \(/.test(p) ? 'event signature' : /without their code/.test(p) ? 'echoed stubs' : /renamed/.test(p) ? 'name clash' : /twips/.test(p) ? 'layout: other' : 'other';
const tally = new Map();
for (const r of recs) for (const x of r.requests.filter(y => y.kind === 'check')) for (const line of x.lastUser.split('\n').filter(s => s.startsWith('- '))) {
  const k = kindOf(line); const e = tally.get(k) ?? { n: 0, ex: line.slice(2, 180) }; e.n++; tally.set(k, e);
}
out.push(table(['kind', 'count', 'example'], [...tally.entries()].sort((a, b) => b[1].n - a[1].n).map(([k, e]) => [k, e.n, e.ex.replace(/\|/g, '/')])));
out.push('');

// preview warnings (what the user sees in grey) other than notes
const warn = new Map();
for (const r of recs) for (const s of r.steps) for (const p of s.dialogs.previews) for (const w of p.warnings) {
  const k = w.replace(/\d+/g, 'N').replace(/(for|of|on|to|type|control|property) [A-Za-z0-9_()]+/g, '$1 X').slice(0, 90);
  warn.set(k, (warn.get(k) ?? 0) + 1);
}
out.push('## Grey warnings in the final previews', '');
out.push(table(['warning (normalised)', 'count'], [...warn.entries()].sort((a, b) => b[1] - a[1]).slice(0, 25).map(([k, n]) => [k.replace(/\|/g, '/'), n])));
console.log(out.join('\n'));
