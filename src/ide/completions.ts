// Member completion ("IntelliSense") after `Control.`, `Control(n).`, `Me.` and `Me.Control.` - a pure function plus the
// CodeMirror completion source that feeds it. Only run-time members are listed (props with runtime !== 'none', methods).
import type { CompletionContext, CompletionResult, CompletionSource } from '@codemirror/autocomplete';
import { CONTROL_TYPES } from '../model/controls';
import type { ControlType, FormDef } from '../model/types';

/** True when the end of `line` lies inside a string literal or a comment (`'` or `Rem`). */
function inStringOrComment(line: string): boolean {
  let inStr = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (inStr) { if (c === '"') inStr = false; continue; }
    if (c === '"') inStr = true;
    else if (c === "'") return true;
    else if (/^rem(\s|$)/i.test(line.slice(i)) && /(^|[:\s])$/.test(line.slice(0, i)) && /^\s*(\w+\s*:\s*)*$/.test(line.slice(0, i))) return true;
  }
  return inStr;
}

const membersOf = (type: ControlType): string[] =>
  [...CONTROL_TYPES[type].props.filter(p => p.runtime !== 'none').map(p => p.name), ...CONTROL_TYPES[type].methods.map(m => m.name)];

export function completionsFor(lineBeforeCursor: string, form: FormDef | null): { from: number; options: string[] } | null {
  if (!form || inStringOrComment(lineBeforeCursor)) return null;
  const m = /((?:[A-Za-z_]\w*(?:\([^()]*\))?\s*\.\s*)+)(\w*)$/.exec(lineBeforeCursor);
  if (!m) return null;
  const prefix = m[2];
  const segs = m[1].split('.').map(s => s.trim()).filter(Boolean).map(s => s.replace(/\(.*\)$/, '').toLowerCase());
  const ctl = (name: string) => form.controls.find(c => c.name.toLowerCase() === name);
  let names: string[] | null = null;
  const first = segs[0];
  if (first === 'me' || first === form.name.toLowerCase()) {
    if (segs.length === 1) names = [...membersOf('Form'), ...form.controls.map(c => c.name)];
    else if (segs.length === 2) { const c = ctl(segs[1]); if (c) names = membersOf(c.type); }
  } else if (segs.length === 1) { const c = ctl(first); if (c) names = membersOf(c.type); }
  if (!names) return null;
  const low = prefix.toLowerCase();
  const options = [...new Set(names)].filter(n => n.toLowerCase().startsWith(low))
    .sort((a, b) => { const x = a.toLowerCase(), y = b.toLowerCase(); return x < y ? -1 : x > y ? 1 : 0; });
  return { from: lineBeforeCursor.length - prefix.length, options };
}

/** CodeMirror source; `getForm` returns the form being edited (null in module windows: no completion). */
export function memberCompletion(getForm: () => FormDef | null): CompletionSource {
  return (ctx: CompletionContext): CompletionResult | null => {
    const line = ctx.state.doc.lineAt(ctx.pos);
    const r = completionsFor(line.text.slice(0, ctx.pos - line.from), getForm());
    if (!r || r.options.length === 0) return null;
    return { from: line.from + r.from, options: r.options.map(label => ({ label })), filter: false };
  };
}
