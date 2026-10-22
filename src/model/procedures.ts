// Line-based procedure scanner (tolerates syntax errors, used by the code window dropdowns and event stubs).
import type { EventDef } from './controls';

export interface ProcInfo { name: string; kind: 'sub' | 'function'; line: number; endLine: number }   // 1-based lines

const HEAD = /^\s*(?:(?:Public|Private|Friend|Static)\s+)*(Sub|Function)\s+([A-Za-z_][A-Za-z0-9_]*)/i;
const TAIL = /^\s*End\s+(Sub|Function)\b/i;

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
    if (m) cur = { name: m[2], kind: m[1].toLowerCase() === 'sub' ? 'sub' : 'function', line, endLine: line };
  });
  if (cur) { (cur as ProcInfo).endLine = lines.length; out.push(cur); }
  return out;
}

export function findProcedureRange(source: string, name: string): ProcInfo | null {
  const n = name.toLowerCase();
  return listProcedures(source).find(p => p.name.toLowerCase() === n) ?? null;
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
