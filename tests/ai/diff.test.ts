import { expect, test } from 'vitest';
import { MAX_DIFF_CELLS, diffLines } from '../../src/ai/diff';

const sides = (d: ReturnType<typeof diffLines>) => ({ a: d.filter(x => x.kind !== 'add').map(x => x.text), b: d.filter(x => x.kind !== 'del').map(x => x.text) });

test('the diff rebuilds both sides and keeps the longest common part', () => {
  let seed = 7;
  const rnd = (k: number) => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed % k; };
  for (let t = 0; t < 200; t++) {
    const a = Array.from({ length: rnd(12) }, () => 'abcd'[rnd(4)]), b = Array.from({ length: rnd(12) }, () => 'abcd'[rnd(4)]);
    const d = diffLines(a, b);
    expect(sides(d)).toEqual({ a, b });
    // the same lines are a longest common subsequence
    const lcs = (i: number, j: number, memo = new Map<string, number>()): number => {
      if (i === a.length || j === b.length) return 0;
      const k = `${i},${j}`;
      if (!memo.has(k)) memo.set(k, a[i] === b[j] ? 1 + lcs(i + 1, j + 1, memo) : Math.max(lcs(i + 1, j, memo), lcs(i, j + 1, memo)));
      return memo.get(k)!;
    };
    expect(d.filter(x => x.kind === 'same').length).toBe(lcs(0, 0));
  }
});

test('#16 a large module with one changed line is fast and small; a huge changed middle becomes one block', () => {
  const a = Array.from({ length: 20000 }, (_, i) => `    x = x + ${i}`);
  const b = [...a];
  b[10000] = '    x = 0';
  const t0 = performance.now();
  const d = diffLines(a, b);
  expect(performance.now() - t0).toBeLessThan(500);
  expect(d.filter(x => x.kind !== 'same')).toEqual([{ kind: 'del', text: a[10000] }, { kind: 'add', text: '    x = 0' }]);
  const n = Math.ceil(Math.sqrt(MAX_DIFF_CELLS)) + 10;
  const c = Array.from({ length: n }, (_, i) => `a${i}`), e = Array.from({ length: n }, (_, i) => `b${i}`);
  const big = diffLines(['top', ...c, 'end'], ['top', ...e, 'end']);
  expect(sides(big)).toEqual({ a: ['top', ...c, 'end'], b: ['top', ...e, 'end'] });
  expect(big.map(x => x.kind).join('')).toMatch(/^same(del)+(add)+same$/);
});
