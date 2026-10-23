// Code mode: pull code out of the model's reply and merge it into a module's source.
import { findProcedureRange, listProcedures } from '../model/procedures';
import { stripThinking } from './clean';
import { hasNoCode, isOmittedStub } from './omitted';

export { diffLines } from './diff';
export { showCodePreview } from './previewDialogs';

const VB_LANGS = new Set(['vb', 'vba', 'vb6', 'vbnet', 'basic']);
const CODE_START = /^(Private|Public|Sub|Function|Dim|Const)\b|^'/i;

const trimBlankEdges = (s: string): string => s.replace(/^(?:[ \t]*\r?\n)+/, '').replace(/\s+$/, '');

export function extractCode(reply: string): string | null {
  const text = stripThinking(reply);
  const re = /```([A-Za-z0-9_+-]*)[^\n]*\n([\s\S]*?)(?:```|$)/g;
  let first: string | null = null, unlabeled: string | null = null;
  for (let m = re.exec(text); m; m = re.exec(text)) {
    const lang = m[1].toLowerCase();
    if (VB_LANGS.has(lang)) { first = m[2]; break; }
    if (lang === '' && unlabeled === null) unlabeled = m[2];
  }
  const block = first ?? unlabeled;
  if (block !== null) { const code = trimBlankEdges(block); return code ? code : null; }
  if (text.includes('```')) return null;
  const firstLine = text.split(/\r?\n/).find(l => l.trim() !== '');
  return firstLine !== undefined && CODE_START.test(firstLine.trim()) ? trimBlankEdges(text) : null;
}

/** `skipped`: procedures of the reply that were left out because they are stubs without a body (the `(body omitted)` lines the model
 *  was shown, echoed back); the module keeps its own procedure. */
export interface CodeApplyResult { source: string; changes: { name: string; kind: 'replaced' | 'added' | 'body' | 'selection' | 'declarations' }[]; skipped?: string[] }

const DECL = /^\s*(Option\s|Dim\s|Const\s|Public\s|Private\s|Global\s|Static\s|Type\s|Enum\s|Event\s|Implements\s)/i;
const DECL_ONLY = /^\s*(Dim|Const|Public|Private|Global|Static)\s/i;
const TAIL = /^\s*End\s+(Sub|Function|Property)\b/i;
const DECLARE = /^\s*((Public|Private)\s+)?Declare\s/i;
const BLOCK_START = /^\s*((Public|Private)\s+)?(Type|Enum)\s/i;
const BLOCK_END = /^\s*End\s+(Type|Enum)\b/i;
const COMMENT = /^\s*('|Rem(\s|$))/i;

/**
 * Splits the lines before the first procedure into declarations (with the comments directly attached to them) and
 * the comment block right above the first procedure (which belongs to that procedure). Other lines (prose) are dropped.
 */
function splitHeader(header: string[]): { decls: string[]; procComments: string[] } {
  let end = header.length;
  while (end > 0 && header[end - 1].trim() === '') end--;
  let start = end;
  while (start > 0 && COMMENT.test(header[start - 1])) start--;
  const procComments = header.slice(start, end);
  const rest = header.slice(0, start);
  const keep = rest.map(() => false);
  for (let i = 0, inBlock = false; i < rest.length; i++) {
    const l = rest[i];
    if (inBlock) { keep[i] = true; if (BLOCK_END.test(l)) inBlock = false; continue; }
    if (BLOCK_START.test(l)) { keep[i] = true; inBlock = true; continue; }
    if (!COMMENT.test(l) && (DECL.test(l) || DECLARE.test(l))) keep[i] = true;
  }
  // comment groups touching a kept declaration line (no blank line between) stay with it
  for (let i = 0; i < rest.length; i++) {
    if (!COMMENT.test(rest[i]) || keep[i]) continue;
    let a = i, b = i;
    while (a > 0 && COMMENT.test(rest[a - 1])) a--;
    while (b + 1 < rest.length && COMMENT.test(rest[b + 1])) b++;
    const attached = (a > 0 && keep[a - 1] && !COMMENT.test(rest[a - 1])) || (b + 1 < rest.length && keep[b + 1] && !COMMENT.test(rest[b + 1]));
    for (let k = a; k <= b; k++) keep[k] = attached;
    i = b;
  }
  return { decls: rest.filter((_, i) => keep[i]), procComments };
}
const DECLS = '(Declarations)';

/** A selection in the code window: offsets into the (LF-only) source. */
export interface CodeSelection { from: number; to: number }

/** Puts `codeLines` in place of exactly the selected text. A selection that starts after a line's indentation keeps it,
 *  and one that ends with a line break keeps the break. */
function replaceSelection(src: string, codeLines: string[], sel: CodeSelection): CodeApplyResult {
  const before = src.slice(0, sel.from);
  const lineStart = before.lastIndexOf('\n') + 1;
  let text = codeLines.join('\n');
  if (sel.from > lineStart && /^[ \t]*$/.test(before.slice(lineStart))) text = text.replace(/^[ \t]+/, '');
  if (src.slice(sel.from, sel.to).endsWith('\n')) text += '\n';
  const line = before.split('\n').length;
  const proc = listProcedures(src).find(p => line >= p.line && line <= p.endLine);
  return { source: before + text + src.slice(sel.to), changes: [{ name: proc?.name ?? DECLS, kind: 'selection' }] };
}

/**
 * Merges the reply's code into `source`. With a `selection` (a non-empty range of `source`), an answer without a
 * procedure heading (a bare body) replaces exactly the selection; without one it replaces the body of `currentProc`.
 */
export function applyCodeProposal(source: string, code: string, currentProc: string | null, selection?: CodeSelection | null): CodeApplyResult | null {
  const src = source.replace(/\r\n?/g, '\n');
  const codeLines = trimBlankEdges(code.replace(/\r\n?/g, '\n')).split('\n');
  if (codeLines.length === 1 && codeLines[0].trim() === '') return null;
  const procs = listProcedures(codeLines.join('\n'));
  if (!procs.length && selection && selection.to > selection.from && selection.to <= src.length) return replaceSelection(src, codeLines, selection);
  const changes: CodeApplyResult['changes'] = [];
  let lines = src.split('\n');

  const { decls: header, procComments } = procs.length ? splitHeader(codeLines.slice(0, procs[0].line - 1)) : { decls: [], procComments: [] };
  const bareDecls = !procs.length && codeLines.every(l => l.trim() === '' || DECL_ONLY.test(l) || /^\s*'/.test(l));
  const decls = bareDecls ? codeLines : header;

  if (!procs.length && !bareDecls) {
    if (!currentProc) return null;
    const r = findProcedureRange(src, currentProc);
    if (!r) return null;
    const hasTail = TAIL.test(lines[r.endLine - 1] ?? '');
    lines = [...lines.slice(0, r.line), ...codeLines, ...lines.slice(hasTail ? r.endLine - 1 : r.endLine)];
    return { source: lines.join('\n'), changes: [{ name: r.name, kind: 'body' }] };
  }

  // Declarations: after the last declaration at the top of the module (or at the very top), skipping duplicates.
  const wanted = decls.filter(l => l.trim() !== '');
  if (wanted.length) {
    const firstProc = listProcedures(lines.join('\n'))[0];
    const headEnd = firstProc ? firstProc.line - 1 : lines.length;
    const existing = new Set(lines.slice(0, headEnd).map(l => l.trim().toLowerCase()));
    const fresh: string[] = [];
    for (const l of wanted) {
      const k = l.trim().toLowerCase();
      if (!existing.has(k)) { existing.add(k); fresh.push(l); }
    }
    if (fresh.length) {
      let at = 0;
      for (let i = 0; i < headEnd; i++) if (DECL.test(lines[i])) at = i + 1;
      if (lines.every(l => l.trim() === '')) lines = fresh;
      else if (at === 0) lines.splice(0, 0, ...fresh, '');
      else lines.splice(at, 0, ...fresh);
      changes.push({ name: DECLS, kind: 'declarations' });
    }
  }

  const skipped: string[] = [];
  const inner = (t: string[]): string[] => t.slice(1, TAIL.test(t[t.length - 1] ?? '') ? -1 : undefined);
  for (const p of procs) {
    const text = codeLines.slice(p.line - 1, p.endLine);
    while (text.length > 1 && text[text.length - 1].trim() === '') text.pop();
    const cur = lines.join('\n');
    const r = findProcedureRange(cur, p.name, p.property ?? null);   // a Property Let does not replace its Get
    // A heading with only "' ... (body omitted)" (or only comments such as "' ... unchanged", where the module's procedure has code) is
    // the shortened code the model was shown, not a change: replacing would empty the real procedure. An empty body is a real change.
    const body = inner(text);
    const commentsOnly = body.some(l => l.trim() !== '') && hasNoCode(body);
    if (text.length > 1 && (isOmittedStub(body) || (r && commentsOnly && !hasNoCode(inner(lines.slice(r.line - 1, r.endLine)))))) {
      skipped.push(p.name);
      continue;
    }
    if (p === procs[0] && procComments.length) {
      // the comment block above the first procedure goes with it (unless the source already has it right there)
      const above = r ? lines.slice(Math.max(0, r.line - 1 - procComments.length), r.line - 1) : [];
      if (above.map(l => l.trim()).join('\n') !== procComments.map(l => l.trim()).join('\n')) text.unshift(...procComments);
    }
    if (r) {
      lines.splice(r.line - 1, r.endLine - r.line + 1, ...text);
      changes.push({ name: p.name, kind: 'replaced' });
    } else {
      const base = cur.replace(/\s+$/, '');
      lines = (base ? `${base}\n\n${text.join('\n')}` : text.join('\n')).split('\n');
      changes.push({ name: p.name, kind: 'added' });
    }
  }
  if (!changes.length && !skipped.length) return null;
  return { source: lines.join('\n'), changes, ...(skipped.length ? { skipped } : {}) };
}

/** The problem fed back to the model (one retry) when its reply echoed procedures without their bodies. */
export function skippedProblem(names: readonly string[]): string {
  return `These procedures came back without their code, so they were left as they are: ${names.join(', ')}. Send only the procedures you changed, each complete.`;
}
