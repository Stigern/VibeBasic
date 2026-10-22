/// <reference types="vite/client" />
// Golden programs: each tests/lang/programs/NN-*.bas is run as Module1.Main and
// its output must equal NN-*.out (one final newline in the .out file is ignored).

import { goldenFiles, runGolden } from './testHost';

const EXPECTED = import.meta.glob('./programs/*.out', { query: '?raw', import: 'default', eager: true }) as Record<string, string>;

const files = goldenFiles();

test('golden programs exist', () => {
  expect(files.length).toBeGreaterThanOrEqual(8);
});

test.each(files)('%s', async file => {
  const outKey = `./programs/${file.replace(/\.bas$/, '.out')}`;
  const expected = EXPECTED[outKey];
  expect(expected, `missing ${outKey}`).toBeDefined();
  const actual = await runGolden(file);
  expect(actual).toBe(expected.replace(/\r?\n$/, '').replace(/\r\n/g, '\n'));
});
