// Member completion ("IntelliSense") after `Control.`, `Control(n).`, `Me.`, `Me.Control.` and the global objects (App,
// Screen, Clipboard, Forms; Controls in a form) - a pure function plus the CodeMirror completion source that feeds it.
// Only run-time members are listed (props with runtime !== 'none', methods).
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

/** The members of the run session's global objects (src/run/objects/appObjects.ts, globalObjects.ts). */
const GLOBAL_OBJECTS: Record<string, string[]> = {
  app: ['EXEName', 'Path', 'PrevInstance', 'Title'],
  screen: ['ActiveControl', 'ActiveForm', 'Height', 'MouseIcon', 'MousePointer', 'Width'],
  clipboard: ['Clear', 'GetFormat', 'GetText', 'SetText'],
  forms: ['Count', 'Item'],
  printer: ['ColorMode', 'Copies', 'CurrentX', 'CurrentY', 'DeviceName', 'DrawMode', 'DrawStyle', 'DrawWidth', 'DriverName', 'EndDoc',
    'FillColor', 'FillStyle', 'Font', 'FontBold', 'FontItalic', 'FontName', 'FontSize', 'FontTransparent', 'FontUnderline', 'ForeColor',
    'Height', 'KillDoc', 'NewPage', 'Orientation', 'Page', 'PaintPicture', 'PaperSize', 'Port', 'ScaleHeight', 'ScaleLeft', 'ScaleMode',
    'ScaleTop', 'ScaleWidth', 'ScaleX', 'ScaleY', 'TextHeight', 'TextWidth', 'Width'],
  printers: ['Count', 'Item'],
};
/** What every run-time form has besides its registry members (formInstance.ts FORM_OBJECTS). */
const FORM_OBJECTS = ['ActiveControl', 'Controls', 'Count'];

/** `form` null: a module window (only the global objects). */
export function completionsFor(lineBeforeCursor: string, form: FormDef | null): { from: number; options: string[] } | null {
  if (inStringOrComment(lineBeforeCursor)) return null;
  const m = /((?:[A-Za-z_]\w*(?:\([^()]*\))?\s*\.\s*)+)(\w*)$/.exec(lineBeforeCursor);
  if (!m) return null;
  const prefix = m[2];
  const segs = m[1].split('.').map(s => s.trim()).filter(Boolean).map(s => s.replace(/\(.*\)$/, '').toLowerCase());
  const ctl = (name: string) => form?.controls.find(c => c.name.toLowerCase() === name);
  let names: string[] | null = null;
  const first = segs[0];
  if (form && (first === 'me' || first === form.name.toLowerCase())) {
    if (segs.length === 1) names = [...membersOf('Form'), ...FORM_OBJECTS, ...form.controls.map(c => c.name)];
    else if (segs.length === 2) { const c = ctl(segs[1]); if (c) names = membersOf(c.type); else if (segs[1] === 'controls') names = GLOBAL_OBJECTS.forms; }
  } else if (segs.length === 1) {
    const c = ctl(first);
    if (c) names = membersOf(c.type);
    else if (GLOBAL_OBJECTS[first]) names = GLOBAL_OBJECTS[first];
    else if (form && first === 'controls') names = GLOBAL_OBJECTS.forms;
  }
  if (!names) return null;
  const low = prefix.toLowerCase();
  const options = [...new Set(names)].filter(n => n.toLowerCase().startsWith(low))
    .sort((a, b) => { const x = a.toLowerCase(), y = b.toLowerCase(); return x < y ? -1 : x > y ? 1 : 0; });
  if (options.length === 1 && options[0].toLowerCase() === low) return null;   // already typed in full: Enter inserts a newline
  return { from: lineBeforeCursor.length - prefix.length, options };
}

/** CodeMirror source; `getForm` returns the form being edited (null in module windows: the global objects only). */
export function memberCompletion(getForm: () => FormDef | null): CompletionSource {
  return (ctx: CompletionContext): CompletionResult | null => {
    const line = ctx.state.doc.lineAt(ctx.pos);
    const r = completionsFor(line.text.slice(0, ctx.pos - line.from), getForm());
    if (!r || r.options.length === 0) return null;
    return { from: line.from + r.from, options: r.options.map(label => ({ label })), filter: false };
  };
}
