// Line-based procedure scanner (tolerates syntax errors, used by the code window dropdowns and event stubs).
import type { EventDef } from './controls';

/** 1-based lines. A Property procedure is a `function` (Get) or `sub` (Let / Set) with `property` set. */
export interface ProcInfo { name: string; kind: 'sub' | 'function'; property?: 'get' | 'let' | 'set'; line: number; endLine: number }

const HEAD = /^\s*(?:(?:Public|Private|Friend|Static)\s+)*(Sub|Function|Property\s+(Get|Let|Set))\s+([A-Za-z_][A-Za-z0-9_]*)/i;
const TAIL = /^\s*End\s+(Sub|Function|Property)\b/i;

/** How the code window's Procedure box shows a procedure: `Name`, or `Name [PropertyGet]` as in VB6. */
export function procLabel(p: ProcInfo): string {
  return p.property ? `${p.name} [Property${p.property.charAt(0).toUpperCase()}${p.property.slice(1)}]` : p.name;
}

export function listProcedures(source: string): ProcInfo[] {
  const lines = source.split(/\r\n|\n|\r/);
  const out: ProcInfo[] = [];
  let cur: ProcInfo | null = null;
  lines.forEach((text, i) => {
    const line = i + 1;
    if (cur) {
      if (TAIL.test(text)) { cur.endLine = line; out.push(cur); cur = null; return; }
      const m = HEAD.exec(text);
      if (m) { cur.endLine = line - 1; out.push(cur); cur = null; } else return;   // missing End Sub: close before the next head
    }
    const m = HEAD.exec(text);
    if (m) {
      const prop = m[2]?.toLowerCase() as ProcInfo['property'];
      cur = { name: m[3], kind: m[1].toLowerCase() === 'sub' || (prop && prop !== 'get') ? 'sub' : 'function', line, endLine: line };
      if (prop) cur.property = prop;
    }
  });
  if (cur) { (cur as ProcInfo).endLine = lines.length; out.push(cur); }
  return out;
}

/** The procedure named `name`; with `property` given, only that kind (null: a Sub or Function, 'get': its Property Get ...). */
export function findProcedureRange(source: string, name: string, property?: ProcInfo['property'] | null): ProcInfo | null {
  const n = name.toLowerCase();
  return listProcedures(source).find(p => p.name.toLowerCase() === n && (property === undefined || (p.property ?? null) === property)) ?? null;
}

export function buildEventStub(objectName: string, isArray: boolean, ev: EventDef): string {
  const params = [isArray ? 'Index As Integer' : '', ev.params].filter(Boolean).join(', ');
  return `Private Sub ${objectName}_${ev.name}(${params})\n\nEnd Sub`;
}

/** Appends `stub` after a blank line; `cursorLine` is the empty body line of the stub. */
export function insertProcedure(source: string, stub: string): { source: string; cursorLine: number } {
  const base = source.replace(/\s+$/, '');
  if (!base) return { source: stub, cursorLine: 2 };
  const before = base.split('\n').length + 1;   // lines of base + one blank line
  return { source: `${base}\n\n${stub}`, cursorLine: before + 2 };
}
