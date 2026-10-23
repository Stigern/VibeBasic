import { expect, test } from 'vitest';
import type { Paras, Run, RtfFormat } from '../../src/controls/richText';
import { adjustParas } from '../../src/controls/richText';
import { fromRtf, toRtf } from '../../src/run/objects/rtf';

const base: RtfFormat = { bold: false, italic: false, underline: false, strike: false, color: 0x80000008 | 0, fontName: 'Arial', fontSize: 10 };

test('runs and paragraph formats round trip through RTF: every character format, alignment, indents, bullets, unicode, braces', () => {
  const runs: Run[] = [
    { text: 'plain ', fmt: {} },
    { text: 'bold', fmt: { bold: true, italic: true, underline: true, strike: true } },
    { text: ' red{14}\\', fmt: { color: 0x0000ff, fontSize: 14, fontName: 'Courier New' } },
    { text: '\n', fmt: {} },
    { text: 'café €\t', fmt: { fontSize: 12 } },
    { text: '\n\nlast', fmt: {} },
  ];
  const paras: Paras = [{ align: 2 }, { indent: 360, hanging: 240, bullet: true }, {}, { align: 1, rightIndent: 720 }];
  const back = fromRtf(toRtf(runs, paras, base), base)!;
  expect(back.runs).toEqual(runs);
  expect(back.paras).toEqual(paras);
});

test('fromRtf: text that is not RTF is null; \\par at the very end adds no line break; ignorable groups are skipped', () => {
  expect(fromRtf('plain text', base)).toBeNull();
  const d = fromRtf('{\\rtf1{\\*\\generator Word;}{\\stylesheet{\\s0 Normal;}}a\\par b\\par}', base)!;
  expect(d.runs.map(r => r.text).join('')).toBe('a\nb');
});

test('adjustParas: a line break typed in a paragraph copies its format, a deleted one drops the next paragraph\'s', () => {
  const p: Paras = [{ align: 2 }, { align: 1 }];
  expect(adjustParas(p, 'ab\ncd', 'a\nb\ncd')).toEqual([{ align: 2 }, { align: 2 }, { align: 1 }]);
  expect(adjustParas(p, 'ab\ncd', 'abcd')).toEqual([{ align: 2 }]);
});
