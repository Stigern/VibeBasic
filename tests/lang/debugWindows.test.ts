// The break-mode debugger API (debugger.ts): Locals, watches, call stack, data tips, Set Next Statement.

import type { BreakInfo } from '../../src/lang/host';
import { Program } from '../../src/lang/interp/program';
import type { DebugNode, WatchSpec } from '../../src/lang/interp/debugger';
import { TestHost, TEST_OPTIONS } from './testHost';

const SRC = [
  'Sub Main()',                            // 1
  '  Dim a(2) As Integer, s As String',    // 2
  '  a(1) = 7: s = "hi"',                  // 3
  '  Calc 5',                              // 4
  'End Sub',                               // 5
  'Sub Calc(n As Integer)',                // 6
  '  Dim x As Integer',                    // 7
  '  x = n',                               // 8
  '  Inner',                               // 9
  '  x = x + 1',                           // 10
  '  Debug.Print x',                       // 11
  'End Sub',                               // 12
  'Sub Inner()',                           // 13
  '  Debug.Print "in"',                    // 14
  'End Sub',                               // 15
].join('\n');

/** Runs Main with breakpoints; `onBreak` runs at each break (the program is in break mode meanwhile). */
async function run(bps: number[], onBreak: (p: Program, info: BreakInfo) => unknown = () => {}, watches: WatchSpec[] = []) {
  const host = new TestHost();
  const prog = new Program([{ name: 'Module1', kind: 'module', source: SRC }], host, TEST_OPTIONS);
  const stops: number[] = [];
  host.breakHook = async info => {
    stops.push(info.at.line);
    await onBreak(prog, info);
    return 'continue';
  };
  prog.setBreakpoints('Module1', bps);
  await prog.debug.setWatches(watches);
  await prog.runEvent('Module1', 'Main');
  return { stops, out: host.lines() };
}

const row = (n: DebugNode) => `${n.name}|${n.value}|${n.type}`;

test('Locals lists the locals of the paused procedure, with an expanded array; then the parameters of a Sub', async () => {
  const seen: string[][] = [];
  await run([4, 10], p => {
    const l = p.debug.locals();
    seen.push(l.map(row));
    const a = l.find(n => n.name === 'a');
    if (a) seen.push(a.children!().map(row));
  });
  expect(seen).toEqual([
    ['a||Integer(0 to 2)', 's|"hi"|String'],
    ['a(0)|0|Integer', 'a(1)|7|Integer', 'a(2)|0|Integer'],
    ['n|5|Integer', 'x|5|Integer'],
  ]);
});

test('a watch shows its value in context, <Out of context> elsewhere', async () => {
  const vals: string[] = [];
  const spec: WatchSpec = { expression: 'x * 2', module: 'Module1', procedure: 'Calc', kind: 'watch' };
  await run([4, 10], async p => { vals.push((await p.debug.watchNode(spec)).value); });
  expect(vals).toEqual(['<Out of context>', '10']);
});

test('Break When Value Changes stops at the line after the change', async () => {
  const { stops, out } = await run([], () => {}, [{ expression: 'x', module: 'Module1', procedure: 'Calc', kind: 'breakChange' }]);
  expect(stops).toEqual([9, 11]);
  expect(out).toEqual(['in', ' 6 ']);
});

test('Break When Value Is True stops when the expression becomes True', async () => {
  const { stops } = await run([], () => {}, [{ expression: 'x > 5', module: 'Module1', procedure: null, kind: 'breakTrue' }]);
  expect(stops).toEqual([11]);
});

test('the Call Stack has a frame per nested call, newest first', async () => {
  let stack: string[] = [];
  await run([14], p => { stack = p.debug.callStack().map(e => `${e.moduleName}.${e.procName}:${e.line}`); });
  expect(stack).toEqual(['Module1.Inner:14', 'Module1.Calc:9', 'Module1.Main:4']);
});

test('a data tip shows a variable, never runs a procedure', async () => {
  const tips: (string | null)[] = [];
  await run([10], p => { tips.push(p.debug.dataTip('x'), p.debug.dataTip('n'), p.debug.dataTip('Inner')); });
  expect(tips).toEqual(['x = 5', 'n = 5', null]);
});

test('Set Next Statement skips a line: the program breaks on the new line, then goes on from there', async () => {
  const errs: (string | null)[] = [];
  const { stops, out } = await run([10], (p, info) => { if (info.at.line === 10) errs.push(p.debug.setNextStatement(11)); });
  expect(errs).toEqual([null]);
  expect(stops).toEqual([10, 11]);
  expect(out).toEqual(['in', ' 5 ']);
});
