// The module-level lines of VB code grouped into whole statements, so code mode never splits one when it merges an answer:
// a statement continued with ` _`, a Type or Enum block, and a #If ... #End If block (with what is inside) each make one unit.

/** A line that continues on the next one. */
export const CONTINUED = /\s_\s*$/;
const COMMENT = /^\s*('|Rem(\s|$))/i;
const BLOCK_START = /^\s*((Public|Private)\s+)?(Type|Enum)\s/i;
const BLOCK_END = /^\s*End\s+(Type|Enum)\b/i;
const COND_START = /^\s*#If\b/i;
const COND_END = /^\s*#End\s*If\b/i;
const COND_CONST = /^\s*#Const\b/i;
const ATTRIBUTE = /^\s*Attribute\s/i;
const DECL = /^\s*(Option\s|Dim\s|Const\s|Public\s|Private\s|Global\s|Static\s|Type\s|Enum\s|Event\s|Implements\s|Declare\s|Friend\s)/i;

/**
 * `decl`: a declaration statement (Dim, Const, Declare, Option, Event, Implements ...); `block`: Type or Enum ... End;
 * `cond`: #If ... #End If or #Const; `attr`: an Attribute line; `other`: anything else (prose, a stray statement).
 */
export type UnitKind = 'blank' | 'comment' | 'decl' | 'block' | 'cond' | 'attr' | 'other';
/** Lines [start, end) (0-based) of one unit. */
export interface Unit { start: number; end: number; kind: UnitKind }

/** The header-kind units: where new declarations may go after. */
export const isDeclaration = (u: Unit): boolean => u.kind === 'decl' || u.kind === 'block' || u.kind === 'cond' || u.kind === 'attr';

/** Groups lines [from, to) into units. A block that is not closed runs to `to`. */
export function units(lines: readonly string[], from = 0, to = lines.length): Unit[] {
  const out: Unit[] = [];
  /** The end of the statement starting at line k (past its continuation lines). */
  const stmtEnd = (k: number): number => { while (k < to - 1 && CONTINUED.test(lines[k])) k++; return k + 1; };
  let i = from;
  while (i < to) {
    const l = lines[i];
    let end: number, kind: UnitKind;
    if (l.trim() === '') { end = i + 1; kind = 'blank'; }
    else if (COMMENT.test(l)) { end = stmtEnd(i); kind = 'comment'; }
    else if (COND_START.test(l)) {
      kind = 'cond';
      end = to;
      for (let k = i, depth = 0; k < to; k++) {
        if (COND_START.test(lines[k])) depth++;
        else if (COND_END.test(lines[k]) && --depth === 0) { end = k + 1; break; }
      }
    } else if (COND_CONST.test(l)) { end = stmtEnd(i); kind = 'cond'; }
    else if (BLOCK_START.test(l)) {
      kind = 'block';
      end = to;
      for (let k = i + 1; k < to; k++) if (BLOCK_END.test(lines[k])) { end = k + 1; break; }
    } else if (ATTRIBUTE.test(l)) { end = stmtEnd(i); kind = 'attr'; }
    else { end = stmtEnd(i); kind = DECL.test(l) ? 'decl' : 'other'; }
    out.push({ start: i, end, kind });
    i = end;
  }
  return out;
}

/** The text of a line without its comment (an apostrophe outside a string). */
function codePart(line: string): string {
  let inStr = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (c === '"') inStr = !inStr;
    else if (c === "'" && !inStr) return line.slice(0, i);
  }
  return line;
}

/** Splits at the commas outside parentheses and strings. */
function topLevelItems(text: string): string[] {
  const out: string[] = [];
  let depth = 0, inStr = false, start = 0;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (c === '"') inStr = !inStr;
    else if (inStr) continue;
    else if (c === '(') depth++;
    else if (c === ')') depth--;
    else if (c === ',' && depth === 0) { out.push(text.slice(start, i)); start = i + 1; }
  }
  out.push(text.slice(start));
  return out;
}

/**
 * The lower-case names a module-level declaration unit declares (`Dim a As Long, b(3) As String`: a and b; `Private Type Pt`: pt;
 * `Option Explicit`: "option explicit"), or none (a comment, a #If block, an Attribute line, prose).
 */
export function declaredNames(lines: readonly string[]): string[] {
  const t = lines.map(codePart).join(' ').replace(/\s_\s+/g, ' ').trim();
  let m: RegExpExecArray | null;
  if ((m = /^Option\s+(\w+)/i.exec(t))) return [`option ${m[1].toLowerCase()}`];
  if ((m = /^Implements\s+([\w.]+)/i.exec(t))) return [`implements ${m[1].toLowerCase()}`];
  let rest = t.replace(/^(?:Public|Private|Global|Friend)\s+/i, '');
  if ((m = /^Declare\s+(?:PtrSafe\s+)?(?:Sub|Function)\s+(\w+)/i.exec(rest))) return [m[1].toLowerCase()];
  if ((m = /^(?:Type|Enum)\s+(\w+)/i.exec(rest))) return [m[1].toLowerCase()];
  if ((m = /^Event\s+(\w+)/i.exec(rest))) return [m[1].toLowerCase()];
  rest = rest.replace(/^(?:Dim|Static|Const)\s+/i, '');
  if (rest === t) return [];   // no declaration keyword
  const names: string[] = [];
  for (const item of topLevelItems(rest)) {
    const n = /^\s*(?:WithEvents\s+)?([A-Za-z_][A-Za-z0-9_]*)/i.exec(item);
    if (n) names.push(n[1].toLowerCase());
  }
  return names;
}
