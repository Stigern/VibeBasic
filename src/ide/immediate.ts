// The Immediate window: a plain text area. Enter on a line runs it (`? expr`, statements, calls) in the running
// session, or in a throw-away Program of the project's modules in design mode; the result goes on the next line
// as in VB6. Debug.Print output lands here too.
import { VBSyntaxError } from '../lang/errors';
import type { Host } from '../lang/host';
import { Program } from '../lang/interp/program';
import { moduleKind, type Project } from '../model/types';
import type { RunSession } from '../run/session';
import { h } from '../ui98/dom';

/** Host of the design-mode Immediate Program: no forms, dialogs answer OK, Debug.Print goes to the window. */
function designHost(print: (t: string, nl: boolean) => void): Host {
  return {
    resolveName: () => undefined,
    msgBox: async () => 1,
    inputBox: async (_p, _t, d) => d,
    debugPrint: print,
    doEvents: async () => {},
    loadPicture: async () => { throw new Error('LoadPicture is not available in design mode'); },
    onRuntimeError: async () => 'end',
    onBreak: async () => 'end',
    onEnd: () => {},
  };
}

export function createImmediateWindow(host: HTMLElement, run: () => RunSession | null, project: () => Project):
  { print(text: string, newline: boolean): void; show(): void; focus(): void } {
  const ta = h('textarea', { class: 'imm98', spellcheck: 'false', 'aria-label': 'Immediate' }) as HTMLTextAreaElement;
  host.appendChild(ta);
  /** While a line runs: where its Debug.Print output goes (start of the line below it). */
  let outPos: number | null = null;

  const insertAt = (pos: number, text: string): void => {
    ta.value = ta.value.slice(0, pos) + text + ta.value.slice(pos);
  };

  function print(text: string, newline: boolean): void {
    const t = newline ? `${text}\n` : text;
    if (outPos !== null) { insertAt(outPos, t); outPos += t.length; } else { ta.value += t; }
    ta.scrollTop = ta.scrollHeight;
  }

  async function evaluate(line: string): Promise<string> {
    const s = run();
    if (s && !s.ended) return s.immediate(line);
    const p = project();
    let prog: Program;
    try {
      prog = new Program([
        ...p.forms.map(f => ({ name: f.name, kind: 'form' as const, source: f.code })),
        ...p.modules.map(m => ({ name: m.name, kind: moduleKind(m), source: m.code })),
      ], designHost((t, nl) => print(t, nl)), { appTitle: p.title || p.name });
    } catch (e) {
      if (e instanceof VBSyntaxError) return `Compile error: ${e.message}`;
      return `Error: ${e instanceof Error ? e.message : String(e)}`;
    }
    try {
      return await prog.immediate(line);
    } finally {
      prog.end();
    }
  }

  let busy = false;
  ta.addEventListener('keydown', ev => {
    const e = ev as KeyboardEvent;
    if (e.key !== 'Enter' || e.shiftKey || e.isComposing || busy) return;
    const v = ta.value, caret = ta.selectionStart ?? v.length;
    const start = v.lastIndexOf('\n', caret - 1) + 1;
    let end = v.indexOf('\n', caret);
    if (end < 0) end = v.length;
    const line = v.slice(start, end).trim();
    e.preventDefault();
    if (end === v.length) ta.value += '\n';
    if (line === '') {   // an empty line only moves on
      ta.selectionStart = ta.selectionEnd = end + 1;
      return;
    }
    outPos = end + 1;
    busy = true;
    void evaluate(line).catch(err => `Error: ${err instanceof Error ? err.message : String(err)}`).then(result => {
      if (result !== '') print(result, true);
      ta.selectionStart = ta.selectionEnd = outPos ?? ta.value.length;
      ta.scrollTop = ta.scrollHeight;
    }).finally(() => { outPos = null; busy = false; });
  });

  const pane = () => host.closest('.ide98-pane');
  return {
    print,
    show: () => { pane()?.classList.remove('hidden'); },
    focus: () => { ta.focus(); ta.selectionStart = ta.selectionEnd = ta.value.length; },
  };
}
