// Code mode: pull code out of the model's reply and merge it into a module's source.
import { findProcedureRange, listProcedures } from '../model/procedures';
import { stripThinking } from './clean';
import { hasNoCode, isOmittedStub } from './omitted';
import { CONTINUED, declaredNames, isDeclaration, type Unit, type UnitKind, units } from './codeUnits';
import { parseModuleLenient } from '../lang/parser';

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

const DECL_ONLY = /^\s*(Dim|Const|Public|Private|Global|Static)\s/i;
const TAIL = /^\s*End\s+(Sub|Function|Property)\b/i;
const COMMENT = /^\s*('|Rem(\s|$))/i;
/** A member attribute (`Attribute Item.VB_UserMemId = 0`); `Attribute VB_Name = ...` is file metadata, not code. */
const MEMBER_ATTRIBUTE = /^\s*Attribute\s+[A-Za-z_][A-Za-z0-9_]*\.VB_/i;
const DIRECTIVE = /^\s*#/;

const norm = (ls: readonly string[]): string => ls.map(l => l.trim().toLowerCase()).filter(Boolean).join('\n');

/** A #If block (or #Const) of declarations only: it may go into the declarations section. */
const declarativeCond = (ls: readonly string[]): boolean =>
  ls.every(l => l.trim() === '' || DIRECTIVE.test(l) || COMMENT.test(l) || DECL_ONLY.test(l));

/** One declaration statement of an answer (`stmt`, empty for a comment on its own) with the comments right above and below it. */
interface DeclGroup { before: string[]; stmt: string[]; after: string[] }

/**
 * Splits module-level lines of the answer (before, between or after its procedures) into whole declaration statements, each
 * with the comments directly attached to it (no blank line between), and (with `procComments`) the comment block right above
 * the next procedure, which belongs to that procedure. Prose and stray statements are dropped; a continued statement, a Type
 * or Enum block and a #If ... #End If block stay whole.
 */
function splitHeader(header: string[], procComments = true): { decls: DeclGroup[]; procComments: string[] } {
  let end = header.length;
  while (end > 0 && header[end - 1].trim() === '') end--;
  let start = end;
  if (procComments) while (start > 0 && COMMENT.test(header[start - 1])) start--;
  const above = header.slice(start, end);
  const us = units(header, 0, start);
  const text = (u: Unit) => header.slice(u.start, u.end);
  const keep = us.map(u => u.kind === 'decl' || u.kind === 'block' || u.kind === 'cond' || (u.kind === 'attr' && MEMBER_ATTRIBUTE.test(header[u.start])));
  const decls: DeclGroup[] = [];
  for (let i = 0; i < us.length; i++) {
    if (us[i].kind !== 'comment') { if (keep[i]) decls.push({ before: [], stmt: text(us[i]), after: [] }); continue; }
    // a run of comment units: with the declaration right below it, else with the one right above it, else dropped
    let j = i;
    while (j + 1 < us.length && us[j + 1].kind === 'comment') j++;
    const lines = us.slice(i, j + 1).flatMap(text);
    if (j + 1 < us.length && keep[j + 1]) { decls.push({ before: lines, stmt: text(us[j + 1]), after: [] }); i = j + 1; continue; }
    if (i > 0 && keep[i - 1] && decls.length) decls[decls.length - 1].after.push(...lines);
    else if (!procComments) decls.push({ before: lines, stmt: [], after: [] });   // a reply of declarations only: its comments too
    i = j;
  }
  return { decls, procComments: above };
}
const DECLS = '(Declarations)';

/**
 * Puts the declaration groups of an answer into the declarations section of `lines`: a statement that is already there is
 * skipped, one that declares again all the names of existing declarations takes their place, the others go after the last
 * declaration statement there, never inside a Type, Enum or #If block or a continued line. Comment lines the section already has
 * are not repeated. Null when nothing changed.
 */
function mergeDeclarations(lines: string[], groups: DeclGroup[]): string[] | null {
  const firstProc = listProcedures(lines.join('\n'))[0];
  const headEnd = firstProc ? firstProc.line - 1 : lines.length;
  const us = units(lines, 0, headEnd);
  const text = (i: number) => lines.slice(us[i].start, us[i].end);
  const texts = new Set(us.filter(u => u.kind !== 'blank').map(u => norm(lines.slice(u.start, u.end))));
  const headerLines = new Set(lines.slice(0, headEnd).map(l => l.trim().toLowerCase()));
  const newComments = (ls: string[]) => ls.filter(l => l.trim() !== '' && !headerLines.has(l.trim().toLowerCase()));
  const named = (k: UnitKind) => k === 'decl' || k === 'block';
  const namesOf = us.map((u, i) => (named(u.kind) ? declaredNames(text(i)) : []));
  const byName = new Map<string, number[]>();
  namesOf.forEach((ns, i) => { for (const n of ns) byName.set(n, [...byName.get(n) ?? [], i]); });
  const kindOf = (stmt: string[]) => units(stmt)[0]?.kind ?? 'blank';
  const allNames = new Set(groups.flatMap(g => (named(kindOf(g.stmt)) ? declaredNames(g.stmt) : [])));
  /** Existing units every name of which the answer declares again: they are replaced. */
  const removable = (i: number) => namesOf[i].length > 0 && namesOf[i].every(n => allNames.has(n));
  const replaced = new Map<number, string[]>();
  const fresh: string[][] = [];
  const freshByName = new Map<string, number>();
  for (const { before, stmt, after } of groups) {
    if (!stmt.length) {   // comments on their own (a reply of declarations only)
      const c = newComments(before);
      if (c.length) fresh.push(c);
      continue;
    }
    const k = norm(stmt);
    if (texts.has(k)) continue;
    texts.add(k);
    const names = named(kindOf(stmt)) ? declaredNames(stmt) : [];
    const g = [...newComments(before), ...stmt, ...newComments(after)];
    const earlier = names.map(n => freshByName.get(n)).find(i => i !== undefined);
    if (earlier !== undefined) { fresh[earlier] = g; continue; }   // the answer declared it twice: the later one counts
    const hits = [...new Set(names.flatMap(n => byName.get(n) ?? []))].sort((x, y) => x - y);
    if (hits.length && hits.every(removable)) {
      const own = hits.find(i => !replaced.has(i)) ?? hits[0];
      replaced.set(own, [...replaced.get(own) ?? [], ...g]);
      for (const i of hits) if (!replaced.has(i)) replaced.set(i, []);
      continue;
    }
    fresh.push(g);
    for (const n of names) freshByName.set(n, fresh.length - 1);
  }
  if (!fresh.length && !replaced.size) return null;
  const add = fresh.flat();
  if (lines.every(l => l.trim() === '')) return add;
  let at = -1;
  us.forEach((u, i) => { if (isDeclaration(u)) at = i; });
  const head: string[] = at < 0 && add.length ? [...add, ''] : [];
  us.forEach((u, i) => {
    head.push(...(replaced.get(i) ?? text(i)));
    if (i === at) head.push(...add);
  });
  return [...head, ...lines.slice(headEnd)];
}

/** The last line (1-based) of the procedure header starting at `line`, past its continuation lines. */
function headerEnd(lines: readonly string[], line: number, last = lines.length): number {
  let end = line;
  while (end < last && CONTINUED.test(lines[end - 1] ?? '')) end++;
  return end;
}

/** The lines inside a procedure (without its header, with continuations, its Attribute lines and its End line). */
function innerOf(t: string[]): string[] {
  let s = headerEnd(t, 1);
  while (s < t.length && MEMBER_ATTRIBUTE.test(t[s])) s++;
  return t.slice(s, TAIL.test(t[t.length - 1] ?? '') && t.length > s ? -1 : undefined);
}

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

/** How many times each name is declared in the declarations section (outside #If blocks). */
function declarationCounts(src: string): Map<string, number> {
  const lines = src.split('\n');
  const first = listProcedures(src)[0];
  const out = new Map<string, number>();
  for (const u of units(lines, 0, first ? first.line - 1 : lines.length)) {
    if (u.kind !== 'decl' && u.kind !== 'block') continue;
    for (const n of declaredNames(lines.slice(u.start, u.end))) out.set(n, (out.get(n) ?? 0) + 1);
  }
  return out;
}

/**
 * Why the merged module must not replace `before`: it has more syntax errors than `before` plus the ones of the answer itself
 * (`ownErrors`, which the check shows the user), or declares a name twice that was not declared twice before. Null when it is
 * fine. The last check of every merge, so a merge that went wrong never reaches the code.
 */
export function mergeRefusal(before: string, after: string, ownErrors = 0): string | null {
  if (before === after) return null;
  const errorsAfter = parseModuleLenient(after, 'Module').errors;
  if (errorsAfter.length > parseModuleLenient(before, 'Module').errors.length + ownErrors) {
    return `Merging the answer into the module would break it:\n${errorsAfter.slice(0, 5).map(e => `Line ${e.line}: ${e.message}`).join('\n')}`;
  }
  const was = declarationCounts(before);
  for (const [n, c] of declarationCounts(after)) {
    if (c > 1 && c > (was.get(n) ?? 0)) return `Merging the answer into the module would declare ${n} twice.`;
  }
  return null;
}

/** An answer of declarations (and comments) only, without a procedure. */
function isBareDecls(codeLines: string[]): boolean {
  return units(codeLines).every(u => u.kind === 'blank' || u.kind === 'comment'
    || ((u.kind === 'decl' || u.kind === 'block') && DECL_ONLY.test(codeLines[u.start]))
    || (u.kind === 'cond' && declarativeCond(codeLines.slice(u.start, u.end))));
}

/** The syntax errors of the answer on its own (a bare body inside a Sub, without an End line it repeats). */
function ownErrorCount(code: string): number {
  const codeLines = trimBlankEdges(code.replace(/\r\n?/g, '\n')).split('\n');
  if (listProcedures(codeLines.join('\n')).length || isBareDecls(codeLines)) return parseModuleLenient(codeLines.join('\n'), 'Module').errors.length;
  while (codeLines.length && TAIL.test(codeLines[codeLines.length - 1])) codeLines.pop();
  return parseModuleLenient(`Sub AiBody__()\n${codeLines.join('\n')}\nEnd Sub`, 'Module').errors.length;
}

/**
 * Merges the reply's code into `source`. With a `selection` (a non-empty range of `source`), an answer without a
 * procedure heading (a bare body) replaces exactly the selection; without one it replaces the body of `currentProc`.
 * Null when the reply could not be merged; when the merge would break the module (mergeRefusal), also null, with the reason
 * in `out.refused`.
 */
export function applyCodeProposal(source: string, code: string, currentProc: string | null, selection?: CodeSelection | null, out?: { refused?: string }): CodeApplyResult | null {
  const src = source.replace(/\r\n?/g, '\n');
  const r = merge(src, code, currentProc, selection);
  if (!r) return null;
  const refused = r.source === src ? null : mergeRefusal(src, r.source, ownErrorCount(code));
  if (refused) { if (out) out.refused = refused; return null; }
  return r;
}

function merge(src: string, code: string, currentProc: string | null, selection?: CodeSelection | null): CodeApplyResult | null {
  const codeLines = trimBlankEdges(code.replace(/\r\n?/g, '\n')).split('\n');
  if (codeLines.length === 1 && codeLines[0].trim() === '') return null;
  const procs = listProcedures(codeLines.join('\n'));
  if (!procs.length && selection && selection.to > selection.from && selection.to <= src.length) return replaceSelection(src, codeLines, selection);
  const changes: CodeApplyResult['changes'] = [];
  let lines = src.split('\n');

  const bareDecls = !procs.length && isBareDecls(codeLines);

  if (!procs.length && !bareDecls) {
    if (!currentProc) return null;
    const r = findProcedureRange(src, currentProc);
    if (!r) return null;
    const hasTail = TAIL.test(lines[r.endLine - 1] ?? '');
    // the whole header (a continued one too) and the procedure's Attribute lines stay
    let head = headerEnd(lines, r.line, hasTail ? r.endLine - 1 : r.endLine);
    while (head < (hasTail ? r.endLine - 1 : r.endLine) && MEMBER_ATTRIBUTE.test(lines[head])) head++;
    // a body that ends with the End line the procedure keeps would close it twice
    const body = [...codeLines];
    if (hasTail) {
      while (body.length && TAIL.test(body[body.length - 1])) body.pop();
      while (body.length && body[body.length - 1].trim() === '') body.pop();
    }
    lines = [...lines.slice(0, head), ...body, ...lines.slice(hasTail ? r.endLine - 1 : r.endLine)];
    return { source: lines.join('\n'), changes: [{ name: r.name, kind: 'body' }] };
  }

  // The module-level parts of the answer: before, between and after its procedures (only comments may follow an End Sub, so
  // declarations there belong in the declarations section), and the comment block above each procedure.
  const decls: DeclGroup[] = [];
  const procComments = new Map<number, string[]>();
  if (bareDecls) decls.push(...splitHeader(codeLines, false).decls);
  else {
    let prev = 0;
    procs.forEach((p, i) => {
      const s = splitHeader(codeLines.slice(prev, p.line - 1));
      decls.push(...s.decls);
      procComments.set(i, s.procComments);
      prev = p.endLine;
    });
    decls.push(...splitHeader(codeLines.slice(prev)).decls);
  }
  const merged = decls.length ? mergeDeclarations(lines, decls) : null;
  if (merged) { lines = merged; changes.push({ name: DECLS, kind: 'declarations' }); }

  const skipped: string[] = [];
  procs.forEach((p, idx) => {
    const text = codeLines.slice(p.line - 1, p.endLine);
    while (text.length > 1 && text[text.length - 1].trim() === '') text.pop();
    const cur = lines.join('\n');
    const r = findProcedureRange(cur, p.name, p.property ?? null);   // a Property Let does not replace its Get
    // A heading with only "' ... (body omitted)" (or only comments such as "' ... unchanged", where the module's procedure has code) is
    // the shortened code the model was shown, not a change: replacing would empty the real procedure. An empty body is a real change.
    const body = innerOf(text);
    const naive = text.slice(1, TAIL.test(text[text.length - 1] ?? '') ? -1 : undefined);   // a stub under a continued header
    const commentsOnly = body.some(l => l.trim() !== '') && hasNoCode(body);
    if (text.length > 1 && (isOmittedStub(body) || isOmittedStub(naive) || (r && commentsOnly && !hasNoCode(innerOf(lines.slice(r.line - 1, r.endLine)))))) {
      skipped.push(p.name);
      return;
    }
    if (r) {
      // the procedure's Attribute lines (a class's default member, its enumerator) stay when the answer left them out
      const old = lines.slice(r.line - 1, r.endLine);
      const attrs = old.filter(l => MEMBER_ATTRIBUTE.test(l));
      if (attrs.length && !text.some(l => MEMBER_ATTRIBUTE.test(l))) text.splice(headerEnd(text, 1), 0, ...attrs);
    }
    const comments = procComments.get(idx) ?? [];
    if (comments.length) {
      // the comment block above the procedure goes with it (unless the source already has it right there)
      const above = r ? lines.slice(Math.max(0, r.line - 1 - comments.length), r.line - 1) : [];
      if (above.map(l => l.trim()).join('\n') !== comments.map(l => l.trim()).join('\n')) text.unshift(...comments);
    }
    if (r) {
      lines.splice(r.line - 1, r.endLine - r.line + 1, ...text);
      changes.push({ name: p.name, kind: 'replaced' });
    } else {
      const base = cur.replace(/\s+$/, '');
      lines = (base ? `${base}\n\n${text.join('\n')}` : text.join('\n')).split('\n');
      changes.push({ name: p.name, kind: 'added' });
    }
  });
  if (!changes.length && !skipped.length) return null;
  return { source: lines.join('\n'), changes, ...(skipped.length ? { skipped } : {}) };
}

/** The problem fed back to the model (one retry) when its reply echoed procedures without their bodies. */
export function skippedProblem(names: readonly string[]): string {
  return `These procedures came back without their code, so they were left as they are: ${names.join(', ')}. Send only the procedures you changed, each complete.`;
}
