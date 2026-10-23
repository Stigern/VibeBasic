// Break mode ('debug' on an unhandled error, Stop, requestPause), Continue
// (the faulting statement runs again), the Immediate window, and End/end()
// stopping everything that runs or waits.

import { Program, type ProgramOptions, type SourceModule } from '../../src/lang/interp/program';
import type { VBValue } from '../../src/lang/values';
import { FakeObject } from './fakeObject';
import { TestHost, TEST_OPTIONS } from './testHost';

const lines = (...l: string[]) => l.join('\n');

function program(src: string | SourceModule[], host = new TestHost(), opts: ProgramOptions = {}) {
  const mods = typeof src === 'string' ? [{ name: 'Module1', kind: 'module' as const, source: src }] : src;
  return { host, prog: new Program(mods, host, { ...TEST_OPTIONS, ...opts }) };
}

/** Debug.Print output only (no `[Error ...]` / `[MsgBox]` lines). */
const printed = (host: TestHost) => host.lines().filter(l => !l.startsWith('[Error ') && !l.startsWith('[MsgBox]'));

const never = () => new Promise<VBValue>(() => {});
const tick = (ms = 0) => new Promise(r => setTimeout(r, ms));

describe('brief', () => {
  test('debug then continue re-executes statement', async () => {
    const host = new TestHost();
    host.errorChoice = 'debug';
    const { prog } = program(lines('Sub Main()', '  Dim d As Integer', '  Debug.Print 10 / d', 'End Sub'), host);
    host.breakHook = async () => {
      expect(await prog.immediate('d = 2')).toBe('');
      return 'continue';
    };
    await prog.runEvent('Module1', 'Main');
    const out = printed(host);
    expect(out).toEqual([' 5 ']);
  });

  test('immediate sees locals in break frame', async () => {
    const host = new TestHost();
    host.errorChoice = 'debug';
    const { prog } = program(lines('Sub Main()', '  Dim d As Integer', '  Debug.Print 10 / d', 'End Sub'), host);
    let seen = '';
    host.breakHook = async () => {
      seen = await prog.immediate('? d * 3');
      return 'end';
    };
    await prog.runEvent('Module1', 'Main');
    expect(seen).toBe(' 0 ');
  });

  test('immediate error text', async () => {
    const { prog } = program(lines('Sub Main()', 'End Sub'));
    expect(await prog.immediate('? 1/0')).toBe("Run-time error '11': Division by zero");
  });

  test('pause infinite loop within 500 ms', async () => {   // Review Focus 1
    const host = new TestHost();
    host.breakChoice = 'wait';
    const { prog } = program(lines('Sub Spin()', '  Do', '  Loop', 'End Sub'), host);
    const p = prog.runEvent('Module1', 'Spin');            // Sub Spin(): Do: Loop: End Sub
    setTimeout(() => prog.requestPause(), 50);
    const info = await host.nextBreak();                    // TestHost lagrer onBreak-kall som promise
    expect(info.reason).toBe('pause'); expect(info.at.procName).toBe('Spin');
    prog.end(); await p; expect(prog.state).toBe('ended');
  }, 500);

  test('end stops nested and pending', async () => {
    // A waits in DoEvents; B (nested) waits on a dialog that never closes; C runs End.
    const host = new TestHost();
    const dlg = new FakeObject('Form', { methods: { Show: never } });
    host.objects.set('dlg', dlg);
    const { prog } = program([{
      name: 'Form1', kind: 'form', source: lines(
        'Sub A_Click()', '  Debug.Print "a1"', '  DoEvents', '  Debug.Print "a2"', 'End Sub',
        'Sub B_Click()', '  Debug.Print "b1"', '  Dlg.Show', '  Debug.Print "b2"', 'End Sub',
        'Sub C_Click()', '  Debug.Print "c"', '  End', '  Debug.Print "c2"', 'End Sub',
      ),
    }], host);
    let b: Promise<void> | undefined;
    host.doEvents = () => new Promise<void>(resolve => setTimeout(() => { b = prog.runEvent('Form1', 'B_Click'); resolve(); }, 0));
    const a = prog.runEvent('Form1', 'A_Click');
    await tick(10);
    await prog.runEvent('Form1', 'C_Click');
    await a;
    await b;
    expect(host.lines()).toEqual(['a1', 'b1', 'c']);
    expect(prog.state).toBe('ended');
    expect(host.endCalls).toBe(1);
  });
});

describe('break on errors', () => {
  test('onBreak gets reason error, the error and the innermost location; state is break meanwhile', async () => {
    const host = new TestHost();
    host.errorChoice = 'debug';
    const { prog } = program(lines('Sub Main()', '  A', 'End Sub', 'Sub A()', '  Dim n As Integer', '  n = 40000', 'End Sub'), host);
    let state = '';
    host.breakHook = () => { state = prog.state; return 'end'; };
    await prog.runEvent('Module1', 'Main');
    expect(host.breaks).toHaveLength(1);
    const info = host.breaks[0];
    expect(info.reason).toBe('error');
    expect(info.at).toEqual({ moduleName: 'Module1', procName: 'A', line: 6 });
    expect(info.error?.number).toBe(6);
    expect(state).toBe('break');
    expect(prog.state).toBe('ended');
    expect(host.endCalls).toBe(1);
  });

  test('continue after debug in a callee re-runs the callee statement; the program goes on', async () => {
    const host = new TestHost();
    host.errorChoice = 'debug';
    const { prog } = program(lines(
      'Sub Main()', '  Debug.Print Half(0)', '  Debug.Print "main done"', 'End Sub',
      'Function Half(x As Integer) As Double', '  Half = 1 / x', 'End Function',
    ), host);
    host.breakHook = async () => {
      expect(await prog.immediate('? x')).toBe(' 0 ');
      await prog.immediate('x = 4');
      return 'continue';
    };
    await prog.runEvent('Module1', 'Main');
    expect(printed(host)).toEqual([' .25 ', 'main done']);
    expect(prog.state).toBe('idle');
    expect(host.endCalls).toBe(0);
  });

  test('Err holds the unhandled error while in break mode', async () => {
    const host = new TestHost();
    host.errorChoice = 'debug';
    const { prog } = program(lines('Sub Main()', '  Err.Raise 1234, , "boom"', 'End Sub'), host);
    let seen = '';
    host.breakHook = async () => { seen = await prog.immediate('? Err.Number; Err.Description'); return 'end'; };
    await prog.runEvent('Module1', 'Main');
    expect(seen).toBe(' 1234 boom');
  });

  test('events are dropped while in break mode after an error, and run again after continue', async () => {
    const host = new TestHost();
    host.errorChoice = 'debug';
    const { prog } = program(lines(
      'Dim d As Integer',
      'Sub Main()', '  Debug.Print 10 / d', 'End Sub',
      'Sub Tick()', '  Debug.Print "tick"', 'End Sub',
    ), host);
    host.breakHook = async () => {
      await prog.runEvent('Module1', 'Tick'); // a timer tick during break: dropped
      await prog.immediate('d = 1');
      return 'continue';
    };
    await prog.runEvent('Module1', 'Main');
    await prog.runEvent('Module1', 'Tick');
    expect(printed(host)).toEqual([' 10 ', 'tick']);
  });

  test('continue after a failing For increment retries only the increment, not the loop', async () => {
    const host = new TestHost();
    host.errorChoice = 'debug';
    const { prog } = program(lines(
      'Sub Main()', '  Dim i As Integer, n As Long', '  For i = 32766 To 32767', '    n = n + 1', '  Next', 'End Sub',
    ), host);
    const seen: string[] = [];
    host.breakHook = async info => {
      seen.push(`${info.error?.number}@${info.at.line}`);
      if (seen.length === 1) { await prog.immediate('i = 32766'); return 'continue'; }
      seen.push(await prog.immediate('? n; i'));
      return 'end';
    };
    await prog.runEvent('Module1', 'Main');
    // 32766, 32767, overflow; i = 32766 → increment again → 32767 runs once more → overflow
    // (the increment belongs to Next, so the error is on the Next line, as in VB6)
    expect(seen).toEqual(['6@5', '6@5', ' 3  32767 ']);
  });
});

describe('module initialisation errors', () => {
  test('debug + continue retries a failing module-level Dim (reported once per attempt)', async () => {
    const host = new TestHost();
    host.errorChoice = 'debug';
    const { prog } = program(lines('Dim big(100000000) As Integer', 'Sub Main()', '  Debug.Print "main"', 'End Sub'), host);
    host.breakHook = () => (host.breaks.length === 1 ? 'continue' : 'end');
    await prog.runEvent('Module1', 'Main');
    expect(host.lines()).toEqual(['[Error 7 at Module1:1] Out of memory', '[Error 7 at Module1:1] Out of memory']);
    expect(host.breaks.map(b => b.reason)).toEqual(['error', 'error']);
    expect(prog.state).toBe('ended');
    expect(host.endCalls).toBe(1);
  });
});

describe('Immediate window', () => {
  test('? prints like Debug.Print (separators, zones)', async () => {
    const { prog } = program(lines('Sub Main()', 'End Sub'));
    expect(await prog.immediate('? 1; 2')).toBe(' 1  2 ');
    expect(await prog.immediate('?"a", "b"')).toBe('a             b');
    expect(await prog.immediate('Print "x" & 1')).toBe('x1');
    expect(await prog.immediate('print 2 + 2')).toBe(' 4 ');
    expect(await prog.immediate('?')).toBe('');
  });

  test('statements run (several, separated by colons) and see globals, not private module variables', async () => {
    const { prog, host } = program(lines('Public total As Long', 'Dim secret As Integer', 'Sub Main()', '  secret = 5', 'End Sub', 'Function Twice(n)', '  Twice = n * 2', 'End Function'));
    await prog.runEvent('Module1', 'Main');
    expect(await prog.immediate('total = 7: total = total * 2')).toBe('');
    expect(await prog.immediate('? total')).toBe(' 14 ');
    expect(await prog.immediate('? Twice(21)')).toBe(' 42 ');
    expect(await prog.immediate('? secret')).toBe(''); // a new (empty) Immediate variable, not Module1's private one
    expect(await prog.immediate('Debug.Print "via host"')).toBe('');
    expect(host.lines()).toEqual(['via host']);
  });

  test('in break mode it sees and modifies the paused frame, module variables and the function result', async () => {
    const host = new TestHost();
    host.breakChoice = 'continue';
    const { prog } = program(lines(
      'Dim m As Integer',
      'Sub Main()', '  Debug.Print F(3)', 'End Sub',
      'Function F(a As Integer) As Integer', '  Dim loc As Integer', '  loc = a * 10', '  m = 1', '  Stop', '  F = loc + m', 'End Function',
    ), host);
    const seen: string[] = [];
    host.breakHook = async () => {
      seen.push(await prog.immediate('? a; loc; m'));
      await prog.immediate('loc = 100: m = 5');
      return 'continue';
    };
    await prog.runEvent('Module1', 'Main');
    expect(seen).toEqual([' 3  30  1 ']);
    expect(printed(host)).toEqual([' 105 ']);
  });

  test('errors give the run-time error text without break or onRuntimeError', async () => {
    const host = new TestHost();
    host.errorChoice = 'debug';
    const { prog } = program(lines('Sub Boom()', '  Err.Raise 1000, , "Egen"', 'End Sub', 'Sub Main()', 'End Sub'), host);
    expect(await prog.immediate('Boom')).toBe("Run-time error '1000': Egen");
    expect(await prog.immediate('x = 1 / 0')).toBe("Run-time error '11': Division by zero");
    expect(await prog.immediate('? CInt("abc")')).toBe("Run-time error '13': Type mismatch");
    expect(host.breaks).toEqual([]);
    expect(host.lines()).toEqual([]);
    expect(prog.state).toBe('idle');
  });

  test('an error in Immediate during break keeps the program in break mode', async () => {
    const host = new TestHost();
    host.breakChoice = 'continue';
    const { prog } = program(lines('Sub Main()', '  Stop', '  Debug.Print "after"', 'End Sub'), host);
    const seen: string[] = [];
    host.breakHook = async () => {
      seen.push(await prog.immediate('? 1 / 0'), prog.state);
      return 'continue';
    };
    await prog.runEvent('Module1', 'Main');
    expect(seen).toEqual(["Run-time error '11': Division by zero", 'break']);
    expect(printed(host)).toEqual(['after']);
  });

  test('procedures called from Immediate use their own handlers', async () => {
    const { prog } = program(lines('Function Safe()', '  On Error Resume Next', '  Safe = 1 / 0', '  Safe = Err.Number', 'End Function'));
    expect(await prog.immediate('? Safe()')).toBe(' 11 ');
  });

  test('Dim, syntax errors and compile errors give compile error text', async () => {
    const { prog } = program(lines('Option Explicit', 'Sub Main()', 'End Sub'));
    expect(await prog.immediate('Dim z As Integer')).toBe('Compile error: Invalid in Immediate window');
    expect(await prog.immediate('? 1 +')).toMatch(/^Compile error: /);
    expect(await prog.immediate('Nope 1')).toBe('Compile error: Sub or Function not defined');
  });

  test('Immediate uses the program locale for dates', async () => {
    const us = program(lines('Sub Main()', 'End Sub'));
    const no = program(lines('Sub Main()', 'End Sub'), new TestHost(), { locale: 'nb-NO' });
    expect(await us.prog.immediate('? DateSerial(2020, 1, 2)')).toBe('1/2/2020');
    expect(await no.prog.immediate('? DateSerial(2020, 1, 2)')).toBe('2.1.2020');
  });

  test('End in Immediate ends the program', async () => {
    const { prog, host } = program(lines('Sub Main()', 'End Sub'));
    expect(await prog.immediate('End')).toBe('');
    expect(prog.state).toBe('ended');
    expect(host.endCalls).toBe(1);
  });
});

describe('pause', () => {
  test('pause during a time slice breaks in the innermost running procedure; continue goes on', async () => {
    const host = new TestHost();
    host.breakChoice = 'wait';
    const { prog } = program(lines(
      'Dim stopNow As Boolean',
      'Sub Main()', '  Do', '    Inner', '  Loop Until stopNow', '  Debug.Print "out"', 'End Sub',
      'Sub Inner()', '  Dim k As Integer', '  k = k + 1', 'End Sub',
    ), host, { sliceSize: 50 });
    const p = prog.runEvent('Module1', 'Main');
    await tick(5);
    prog.requestPause();
    const info = await host.nextBreak();
    expect(info.reason).toBe('pause');
    expect(['Main', 'Inner']).toContain(info.at.procName);
    expect(prog.state).toBe('break');
    expect(await prog.immediate('stopNow = True')).toBe('');
    host.answerBreak('continue');
    await p;
    expect(host.lines()).toEqual(['out']);
    expect(prog.state).toBe('idle');
  });

  test('requestPause while idle calls onBreak at once with an empty location', async () => {
    const host = new TestHost();
    host.breakChoice = 'wait';
    const { prog } = program(lines('Sub Main()', '  Debug.Print "m"', 'End Sub', 'Function G()', '  G = 7', 'End Function'), host);
    prog.requestPause();
    const info = await host.nextBreak();
    expect(info).toEqual({ reason: 'pause', at: { moduleName: '', procName: '', line: 0 } });
    expect(prog.state).toBe('break');
    await prog.runEvent('Module1', 'Main'); // dropped in break mode
    expect(await prog.immediate('? G()')).toBe(' 7 '); // global context
    host.answerBreak('continue');
    await tick();
    expect(prog.state).toBe('idle');
    await prog.runEvent('Module1', 'Main');
    expect(host.lines()).toEqual(['m']);
  });

  test('a pause requested while the last handler waits (no boundary reached) breaks when it finishes', async () => {
    const host = new TestHost();
    host.breakChoice = 'continue';
    let close!: (v: VBValue) => void;
    host.objects.set('dlg', new FakeObject('Form', { methods: { Show: () => new Promise<VBValue>(r => { close = r; }) } }));
    const { prog } = program(lines('Sub Main()', '  Dlg.Show', 'End Sub'), host);
    const p = prog.runEvent('Module1', 'Main');
    await tick();
    prog.requestPause();
    expect(host.breaks).toEqual([]);
    close(0);
    await p;
    expect(host.breaks).toEqual([{ reason: 'pause', at: { moduleName: '', procName: '', line: 0 } }]);
    await tick();
    expect(prog.state).toBe('idle');
  });

  test('requestPause while idle: end answer ends; a rejected onBreak is handled', async () => {
    const host = new TestHost();
    host.breakChoice = 'end';
    const { prog } = program(lines('Sub Main()', 'End Sub'), host);
    prog.requestPause();
    await tick();
    expect(prog.state).toBe('ended');
    expect(host.endCalls).toBe(1);

    const host2 = new TestHost();
    host2.breakHook = () => Promise.reject(new Error('dialog failed'));
    const p2 = program(lines('Sub Main()', 'End Sub'), host2);
    p2.prog.requestPause();
    await tick();
    expect(p2.prog.state).toBe('idle');
  });
});

describe('End and end()', () => {
  test('end() during break (onBreak pending) ends the run', async () => {
    const host = new TestHost();
    host.breakChoice = 'wait';
    const { prog } = program(lines('Sub Main()', '  Stop', '  Debug.Print "no"', 'End Sub'), host);
    const p = prog.runEvent('Module1', 'Main');
    await host.nextBreak();
    prog.end();
    await p;
    expect(prog.state).toBe('ended');
    expect(host.endCalls).toBe(1);
    expect(host.lines()).toEqual([]);
    host.answerBreak('continue'); // too late: ignored
    await tick();
    expect(host.lines()).toEqual([]);
    expect(host.endCalls).toBe(1);
  });

  test('end() while a host promise never settles', async () => {
    const host = new TestHost();
    host.objects.set('dlg', new FakeObject('Form', { methods: { Show: never } }));
    const { prog } = program(lines('Sub Main()', '  Dlg.Show', '  Debug.Print "no"', 'End Sub'), host);
    const p = prog.runEvent('Module1', 'Main');
    await tick();
    prog.end();
    await p;
    expect(prog.state).toBe('ended');
    expect(host.endCalls).toBe(1);
    expect(host.lines()).toEqual([]);
  });

  test('end() while onRuntimeError is pending', async () => {
    const host = new TestHost();
    host.onRuntimeError = () => new Promise(() => {});
    const { prog } = program(lines('Sub Main()', '  Debug.Print 1 / 0', 'End Sub'), host);
    const p = prog.runEvent('Module1', 'Main');
    await tick();
    prog.end();
    await p;
    expect(prog.state).toBe('ended');
    expect(host.endCalls).toBe(1);
  });

  test('End in a nested event while the outer one waits on a never-settling promise', async () => {
    const host = new TestHost();
    host.objects.set('dlg', new FakeObject('Form', { methods: { Show: never } }));
    const { prog } = program([{
      name: 'Form1', kind: 'form', source: lines(
        'Sub A_Click()', '  Dlg.Show', '  Debug.Print "a2"', 'End Sub',
        'Sub B_Click()', '  End', 'End Sub',
      ),
    }], host);
    const a = prog.runEvent('Form1', 'A_Click');
    await tick();
    await prog.runEvent('Form1', 'B_Click');
    await a;
    expect(host.lines()).toEqual([]);
    expect(host.endCalls).toBe(1);
  });

  test('end() releases events queued during a time slice; they never run', async () => {
    const host = new TestHost();
    const { prog } = program(lines(
      'Sub Spin()', '  Do', '  Loop', 'End Sub', 'Sub Tick()', '  Debug.Print "tick"', 'End Sub',
    ), host, { sliceSize: 20 });
    const p = prog.runEvent('Module1', 'Spin');
    await tick();
    const t = prog.runEvent('Module1', 'Tick'); // queued: Spin is in a time slice
    prog.end();
    await Promise.all([p, t]);
    expect(host.lines()).toEqual([]);
    expect(host.endCalls).toBe(1);
  });

  test('end() twice and End after end() call onEnd once', async () => {
    const { prog, host } = program(lines('Sub Main()', '  End', 'End Sub'));
    prog.end();
    prog.end();
    await prog.runEvent('Module1', 'Main');
    expect(host.endCalls).toBe(1);
  });
});

describe('review fixes (round 1)', () => {
  const rtOf = (prog: Program) => (prog as unknown as { rt: { abortListeners: Set<unknown>; state: string } }).rt;

  test('awaits do not accumulate End cancel listeners (DoEvents loop)', async () => {
    const host = new TestHost();
    const { prog } = program(lines('Sub Main()', '  Dim i As Long', '  For i = 1 To 3000', '    DoEvents', '  Next', '  Debug.Print "done"', 'End Sub'), host);
    let max = 0;
    host.doEvents = async () => { max = Math.max(max, rtOf(prog).abortListeners.size); };
    await prog.runEvent('Module1', 'Main');
    expect(host.lines()).toEqual(['done']);
    expect(max).toBeLessThanOrEqual(1);
    expect(rtOf(prog).abortListeners.size).toBe(0);
  });

  test('time slices do not accumulate End cancel listeners either', async () => {
    const { prog, host } = program(lines('Sub Main()', '  Dim i As Long', '  For i = 1 To 20000', '  Next', '  Debug.Print "done"', 'End Sub'), new TestHost(), { sliceSize: 10 });
    await prog.runEvent('Module1', 'Main');
    expect(host.lines()).toEqual(['done']);
    expect(rtOf(prog).abortListeners.size).toBe(0);
  });

  test('a rejected onBreak during a run counts as continue; the program stays usable', async () => {
    const host = new TestHost();
    const { prog } = program(lines('Sub Main()', '  Stop', '  Debug.Print "x"', 'End Sub', 'Sub T()', '  Debug.Print "t"', 'End Sub'), host);
    host.breakHook = () => Promise.reject(new Error('dialog failed'));
    await prog.runEvent('Module1', 'Main');
    expect(prog.state).toBe('idle');
    await prog.runEvent('Module1', 'T');
    expect(host.lines()).toEqual(['x', 't']);
    host.breakHook = undefined;
    host.breakChoice = 'continue';
    prog.requestPause();
    expect(host.breaks).toHaveLength(2);
    await tick();
    expect(prog.state).toBe('idle');
  });

  test('a synchronously throwing onBreak also counts as continue', async () => {
    const host = new TestHost();
    const { prog } = program(lines('Sub Main()', '  Stop', '  Debug.Print "x"', 'End Sub'), host);
    host.onBreak = () => { throw new Error('sync'); };
    await prog.runEvent('Module1', 'Main');
    expect(host.lines()).toEqual(['x']);
    expect(prog.state).toBe('idle');
  });

  test('Immediate rejects On Error, Resume, GoTo and labels; the paused handler does not run', async () => {
    const host = new TestHost();
    host.breakChoice = 'continue';
    const { prog } = program(lines('Sub Main()', '  On Error GoTo H', '  Stop', '  Exit Sub', 'H:', '  Debug.Print "HANDLER RAN"', 'End Sub'), host);
    const seen: string[] = [];
    host.breakHook = async () => {
      for (const cmd of ['On Error GoTo H: x = 1 / 0', 'On Error Resume Next', 'Resume Next', 'GoTo H', 'H:', 'If True Then GoTo H']) {
        seen.push(await prog.immediate(cmd));
      }
      seen.push(await prog.immediate('x = 1 / 0'));
      return 'continue';
    };
    await prog.runEvent('Module1', 'Main');
    const invalid = 'Compile error: Invalid in Immediate window';
    expect(seen).toEqual([invalid, invalid, invalid, invalid, invalid, invalid, "Run-time error '11': Division by zero"]);
    expect(host.lines()).toEqual([]);
  });

  test('an error break consumes a pending pause request (Continue does not break again)', async () => {
    const host = new TestHost();
    host.errorChoice = 'debug';
    host.objects.set('dlg', new FakeObject('Form', { methods: { Show: () => new Promise<VBValue>(r => setTimeout(() => r(10), 5)) } }));
    const { prog } = program(lines('Dim d As Integer', 'Sub Main()', '  Dim x', '  x = Dlg.Show() / d', '  Debug.Print x', 'End Sub'), host);
    host.breakHook = async () => { await prog.immediate('d = 2'); return 'continue'; };
    const p = prog.runEvent('Module1', 'Main');
    await tick();
    prog.requestPause(); // arrives while Dlg.Show is pending
    await p;
    expect(host.breaks.map(b => b.reason)).toEqual(['error']);
    expect(printed(host)).toEqual([' 5 ']);
    expect(prog.state).toBe('idle');
  });

  test('requestPause while only an Immediate command runs is ignored', async () => {
    const host = new TestHost();
    const { prog } = program(lines('Sub Main()', 'End Sub'), host, { sliceSize: 50 });
    const imm = prog.immediate('Do While k < 20000: k = k + 1: Loop');
    await tick();
    prog.requestPause();
    expect(prog.state).toBe('idle');
    expect(await imm).toBe('');
    expect(host.breaks).toEqual([]);
    expect(prog.state).toBe('idle');
  });
});

describe('review fixes (round 2)', () => {
  test('a rejected onBreak after an error ends the program (no retry loop)', async () => {
    const host = new TestHost();
    host.errorChoice = 'debug';
    const { prog } = program(lines('Sub Main()', '  x = 1 / 0', '  Debug.Print "no"', 'End Sub', 'Sub T()', '  Debug.Print "t"', 'End Sub'), host);
    let calls = 0;
    host.breakHook = () => { calls++; return Promise.reject(new Error('dialog failed')); };
    await prog.runEvent('Module1', 'Main');
    expect(calls).toBe(1);
    expect(host.lines()).toEqual(['[Error 11 at Module1:2] Division by zero']);
    expect(prog.state).toBe('ended');
    expect(host.endCalls).toBe(1);
    await prog.runEvent('Module1', 'T'); // dropped after the end
    expect(host.lines()).toHaveLength(1);
  });

  test('a synchronously throwing onBreak after an error ends the program too', async () => {
    const host = new TestHost();
    host.errorChoice = 'debug';
    const { prog } = program(lines('Sub Main()', '  x = 1 / 0', 'End Sub'), host);
    let calls = 0;
    host.onBreak = () => { calls++; throw new Error('sync'); };
    await prog.runEvent('Module1', 'Main');
    expect(calls).toBe(1);
    expect(prog.state).toBe('ended');
    expect(host.endCalls).toBe(1);
  });
});
