// Breakpoints, Step Into / Over / Out and Run To Cursor in the interpreter.

import { Program } from '../../src/lang/interp/program';
import { TestHost, TEST_OPTIONS } from './testHost';

const SRC = [
  'Sub Main()',          // 1
  '  Debug.Print "a"',   // 2
  '  Foo',               // 3
  '  Debug.Print "b"',   // 4
  'End Sub',             // 5
  'Sub Foo()',           // 6
  '  Debug.Print "f"',   // 7
  'End Sub',             // 8
].join('\n');

/** Runs Main; at each break records `proc:line` and the output so far, then `answer` decides how to go on. */
async function run(setup: (p: Program) => void, answer: (p: Program, n: number) => 'continue' | 'end' = () => 'continue') {
  const host = new TestHost();
  const prog = new Program([{ name: 'Module1', kind: 'module', source: SRC }], host, TEST_OPTIONS);
  const stops: string[] = [];
  host.breakHook = info => {
    stops.push(`${info.at.procName}:${info.at.line} [${host.lines().join(',')}]`);
    return answer(prog, stops.length);
  };
  setup(prog);
  await prog.runEvent('Module1', 'Main');
  return { stops, out: host.lines(), prog, host };
}

test('breaks on a breakpoint line before the line runs', async () => {
  const { stops, out } = await run(p => p.setBreakpoints('Module1', [4]));
  expect(stops).toEqual(['Main:4 [a,f]']);
  expect(out).toEqual(['a', 'f', 'b']);
});

test('Step Into goes into a called Sub', async () => {
  const { stops } = await run(p => p.setBreakpoints('Module1', [3]), (p, n) => { if (n === 1) p.step('into'); return 'continue'; });
  expect(stops).toEqual(['Main:3 [a]', 'Foo:7 [a]']);
});

test('Step Over runs the Sub to completion', async () => {
  const { stops } = await run(p => p.setBreakpoints('Module1', [3]), (p, n) => { if (n === 1) p.step('over'); return 'continue'; });
  expect(stops).toEqual(['Main:3 [a]', 'Main:4 [a,f]']);
});

test('Step Out returns to the caller', async () => {
  const { stops } = await run(p => p.setBreakpoints('Module1', [7]), (p, n) => { if (n === 1) p.step('out'); return 'continue'; });
  expect(stops).toEqual(['Foo:7 [a]', 'Main:4 [a,f]']);
});

test('Step Into before the start breaks at the first statement, and stepping walks every statement', async () => {
  const { stops } = await run(p => p.step('into'), p => { p.step('into'); return 'continue'; });
  expect(stops.map(s => s.split(' ')[0])).toEqual(['Main:2', 'Main:3', 'Foo:7', 'Main:4']);
});

test('Run To Cursor stops at the line once', async () => {
  const { stops, prog, host } = await run(p => p.runToLine('Module1', 7));
  expect(stops).toEqual(['Foo:7 [a]']);
  await prog.runEvent('Module1', 'Main');
  expect(host.breaks.length).toBe(1);
});

test('no breaks inside an Immediate command', async () => {
  const host = new TestHost();
  const prog = new Program([{ name: 'Module1', kind: 'module', source: SRC }], host, TEST_OPTIONS);
  prog.setBreakpoints('Module1', [7]);
  prog.step('into');
  expect(await prog.immediate('Foo')).toBe('');
  expect(host.breaks).toEqual([]);
  expect(host.lines()).toEqual(['f']);
});
