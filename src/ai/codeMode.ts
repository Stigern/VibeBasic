// Code mode: pull code out of the model's reply and merge it into a module's source.
import { findProcedureRange, listProcedures } from '../model/procedures';
import { stripThinking } from './clean';

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

export interface CodeApplyResult { source: string; changes: { name: string; kind: 'replaced' | 'added' | 'body' | 'declarations' }[] }

const DECL = /^\s*(Option\s|Dim\s|Const\s|Public\s|Private\s|Global\s|Static\s|Type\s|Enum\s)/i;
const DECL_ONLY = /^\s*(Dim|Const|Public|Private|Global|Static)\s/i;
const TAIL = /^\s*End\s+(Sub|Function)\b/i;
const DECLS = '(Declarations)';

export function applyCodeProposal(source: string, code: string, currentProc: string | null): CodeApplyResult | null {
  const src = source.replace(/\r\n?/g, '\n');
  const codeLines = trimBlankEdges(code.replace(/\r\n?/g, '\n')).split('\n');
  if (codeLines.length === 1 && codeLines[0].trim() === '') return null;
  const procs = listProcedures(codeLines.join('\n'));
  const changes: CodeApplyResult['changes'] = [];
  let lines = src.split('\n');

  const header = procs.length ? codeLines.slice(0, procs[0].line - 1) : [];
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

  for (const p of procs) {
    const text = codeLines.slice(p.line - 1, p.endLine);
    while (text.length > 1 && text[text.length - 1].trim() === '') text.pop();
    const cur = lines.join('\n');
    const r = findProcedureRange(cur, p.name);
    if (r) {
      lines.splice(r.line - 1, r.endLine - r.line + 1, ...text);
      changes.push({ name: p.name, kind: 'replaced' });
    } else {
      const base = cur.replace(/\s+$/, '');
      lines = (base ? `${base}\n\n${text.join('\n')}` : text.join('\n')).split('\n');
      changes.push({ name: p.name, kind: 'added' });
    }
  }
  return changes.length ? { source: lines.join('\n'), changes } : null;
}
