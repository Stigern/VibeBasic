import { expect, test } from 'vitest';
import { lineChanges, type TextChange } from '../../src/ide/lineDiff';

const apply = (doc: string, cs: TextChange[]) => {
  let out = '', at = 0;
  for (const c of cs) { out += doc.slice(at, c.from) + c.insert; at = c.to; }
  return out + doc.slice(at);
};

test('lineChanges: only the differing lines change, and applying them gives the new text (review 08 final #2)', () => {
  const doc = 'a\nb\nc\nd\ne\n';
  expect(lineChanges(doc, 0, doc.length, doc)).toEqual([]);
  // two separate edits with an untouched line between: two changes, the middle line is not covered
  const cs = lineChanges(doc, 0, doc.length, 'a\nB\nc\nD\ne\n');
  expect(cs).toEqual([{ from: 2, to: 3, insert: 'B' }, { from: 6, to: 7, insert: 'D' }]);
  // a removed line is removed whole, with its line break
  expect(lineChanges(doc, 0, doc.length, 'a\nc\nd\ne\n')).toEqual([{ from: 2, to: 4, insert: '' }]);
  const cases = ['', 'x', 'a\nb\nc\nd\ne', 'e\nd\nc\nb\na\n', 'a\nx\ny\nb\nc\nd\ne\n', 'zz\n'];
  for (const t of cases) expect(apply(doc, lineChanges(doc, 0, doc.length, t)), t).toBe(t);
  // a range inside the text
  expect(apply(doc, lineChanges(doc, 2, 6, 'B\nC\n'))).toBe('a\nB\nC\nd\ne\n');
});
