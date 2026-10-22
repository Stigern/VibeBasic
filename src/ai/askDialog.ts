// Tools > Ask AI...: prompt dialog, waiting dialog (cancelable), then code mode or form mode with a preview.
// Nothing is applied unless the reply was understood and the user pressed OK in the preview.
import type { Backend } from '../backend/backend';
import { showOptions } from '../ide/optionsDialog';
import type { CodeWindow } from '../ide/codeWindow';
import type { IdeState } from '../ide/ideState';
import { listProcedures } from '../model/procedures';
import { messageBox98, showDialog98 } from '../ui98/dialogs';
import { h } from '../ui98/dom';
import { applyCodeProposal, extractCode } from './codeMode';
import { buildCodeRequest, buildFormRequest } from './context';
import { NOT_UNDERSTOOD, applyFormOpsToClone, describeOps, formOpsToCommand, parseFormOps } from './formMode';
import { showCodePreview, showFormPreview } from './previewDialogs';
import { loadAiSettings } from './settings';
import type { AiChatOptions, AiUsage } from './sse';
import { StreamLog } from './streamLog';
import type { ChatMessage } from './types';
import { autoFixEventNames, validateCode } from './validate';

const VB_EXCLAMATION = 48;
const TITLE = 'VibeBasic';

const warn = (doc: Document, prompt: string) => messageBox98(doc, { prompt, title: TITLE, buttons: VB_EXCLAMATION });

/** "The AI answer could not be understood." with OK and Details... (the whole reply in a read-only box). */
export async function showNotUnderstood(doc: Document, raw: string): Promise<void> {
  for (;;) {
    const v = await showDialog98(doc, {
      title: TITLE, content: h('div', { class: 'dlg98-text' }, NOT_UNDERSTOOD),
      buttons: [{ label: 'OK', value: 'ok', default: true, cancel: true }, { label: 'Details...', value: 'details' }],
    });
    if (v !== 'details') return;
    const box = h('textarea', { class: 'ai-details', readOnly: true, rows: '14', cols: '70', style: 'font:12px "Courier New",monospace', 'data-autofocus': '' });
    box.value = raw;
    await showDialog98(doc, { title: 'AI Answer', content: box, buttons: [{ label: 'OK', value: 'ok', default: true, cancel: true }] });
  }
}

async function promptDialog(doc: Document, title: string): Promise<string | null> {
  const box = h('textarea', { class: 'ai-prompt', rows: '6', cols: '60', 'data-autofocus': '' });
  // Enter inserts a line break (the dialog would otherwise press OK); Ctrl+Enter reaches the dialog and presses OK.
  box.addEventListener('keydown', e => {
    if (e.key !== 'Enter' || e.ctrlKey || e.metaKey) return;
    e.preventDefault();
    const a = box.selectionStart ?? box.value.length, b = box.selectionEnd ?? a;
    box.value = `${box.value.slice(0, a)}\n${box.value.slice(b)}`;
    box.selectionStart = box.selectionEnd = a + 1;
  });
  const content = h('div', {}, h('div', { style: 'margin-bottom:4px' }, 'What should the AI do?'), box);
  const v = await showDialog98(doc, {
    title, content,
    buttons: [{ label: 'OK', value: 'ok', default: true }, { label: 'Cancel', value: 'cancel', cancel: true }],
  });
  const text = box.value.trim();
  return v === 'ok' && text ? text : null;
}

/** "3,210 prompt tokens (2,900 cached) · 41 s"; only "41 s" when the server sent no token counts. */
export function formatMetrics(usage: AiUsage | undefined, ms: number): string {
  const secs = `${Math.round(ms / 1000)} s`;
  if (!usage) return secs;
  const n = (v: number) => v.toLocaleString('en-US');
  return `${n(usage.promptTokens)} prompt tokens${usage.cachedTokens === undefined ? '' : ` (${n(usage.cachedTokens)} cached)`} · ${secs}`;
}

type Waited = { kind: 'reply'; text: string; metrics: string } | { kind: 'error'; message: string } | { kind: 'cancel' };

/**
 * Waiting dialog with a back-and-forth progress bar and a box that shows the reply as it streams in.
 * Cancel closes it and aborts the request (`signal`); a reply arriving afterwards is discarded.
 * A reply carries the measurement line (token counts from the server, and the time taken).
 */
async function waitForReply(doc: Document, model: string, start: (o: AiChatOptions) => Promise<string>, log: StreamLog, label = `Waiting for ${model}...`): Promise<Waited> {
  const block = h('div', { style: 'position:absolute;top:1px;bottom:1px;left:0;width:40px;background:#000080' });
  const bar = h('div', { class: 'ai-progress', style: 'position:relative;height:16px;margin-top:8px;overflow:hidden;box-shadow:inset -1px -1px #fff,inset 1px 1px #808080' }, block);
  const box = h('div', {
    class: 'ai-stream', 'aria-readonly': 'true',
    style: 'box-sizing:border-box;width:420px;height:92px;margin-top:8px;padding:2px 4px;overflow-y:auto;background:#fff;color:#000;'
      + 'font:12px/14px "Courier New",monospace;white-space:pre-wrap;overflow-wrap:anywhere;user-select:text;'
      + 'box-shadow:inset -1px -1px #fff,inset 1px 1px #808080,inset -2px -2px #dfdfdf,inset 2px 2px #000',
  });
  const content = h('div', { style: 'min-width:420px' }, h('div', {}, label), bar, box);
  log.attach(box);
  let pos = 0, dir = 1;
  const timer = setInterval(() => {
    const max = Math.max(0, bar.clientWidth - 40);
    pos += dir * 6;
    if (pos >= max) { pos = max; dir = -1; } else if (pos <= 0) { pos = 0; dir = 1; }
    block.style.left = `${pos}px`;
  }, 40);
  const ctrl = new AbortController();
  const t0 = Date.now();
  let usage: AiUsage | undefined;
  let request: Promise<string>;
  try { request = start({ signal: ctrl.signal, onDelta: (kind, text) => log.add(kind, text), onUsage: u => { usage = u; } }); }
  catch (e) { request = Promise.reject(e); }
  const answered = request.then<Waited, Waited>(text => ({ kind: 'reply', text, metrics: formatMetrics(usage, Date.now() - t0) }), e => ({ kind: 'error', message: e instanceof Error ? e.message : String(e) }));
  const cancelled = showDialog98(doc, { title: TITLE, content, buttons: [{ label: 'Cancel', value: 'cancel', cancel: true }] })
    .then<Waited>(() => ({ kind: 'cancel' }));
  try {
    const res = await Promise.race([answered, cancelled]);
    if (res.kind !== 'cancel') content.closest('.dlg98-overlay')?.dispatchEvent(new Event('dlg98-abort'));
    else ctrl.abort();
    return res;
  } finally { clearInterval(timer); log.detach(); }
}

export async function askAi(ide: IdeState, backend: Backend, ui: { codeWindowFor(itemId: string): CodeWindow | null }, doc: Document = document): Promise<void> {
  if (ide.mode !== 'design') return;
  const view = ide.activeView;
  const itemId = view.kind === 'code' ? view.itemId : view.kind === 'designer' ? view.formId : null;
  const item = itemId ? ide.project.forms.find(f => f.id === itemId) ?? ide.project.modules.find(m => m.id === itemId) : undefined;
  const codeWin = view.kind === 'code' && itemId ? ui.codeWindowFor(itemId) : null;
  if (!itemId || !item || (view.kind === 'code' && !codeWin)) { await warn(doc, 'Open a form or a code window first.'); return; }

  const settings = await loadAiSettings(backend);
  if (!settings.model.trim()) {
    await warn(doc, 'Set up the AI server first in Tools > Options > AI.');
    await showOptions(ide, backend, doc, 'AI');
    return;
  }

  const project = ide.project;
  const codeMode = view.kind === 'code';
  const prompt = await promptDialog(doc, `Ask AI - ${item.name} (${codeMode ? 'Code' : 'Form'})`);
  if (prompt === null) return;

  const effort = settings.thinking === 'server' ? undefined : settings.thinking;
  const send = (build: () => ChatMessage[]) => (o: AiChatOptions): Promise<string> => {
    try { return backend.aiChat(settings.baseUrl, settings.apiKey, settings.model, build(), effort, o); }
    catch (e) { return Promise.reject(e); }
  };
  const log = new StreamLog();
  const form = project.forms.find(f => f.id === itemId) ?? null;
  const moduleName = item.name;

  // One answer, understood: fixed event names, the problems left in it, and what the preview needs.
  type Analysis =
    | { kind: 'code'; applied: NonNullable<ReturnType<typeof applyCodeProposal>>; notes: string[]; problems: string[] }
    | { kind: 'form'; parsed: Extract<ReturnType<typeof parseFormOps>, { ok: true }>; notes: string[]; problems: string[] };
  const fixer = (notes: string[]) => (code: string): string => {
    if (!form) return code;
    const r = autoFixEventNames(code, form.name);
    notes.push(...r.notes);
    return r.code;
  };
  // Why the last form-mode answer was not usable JSON (null when it was, or in code mode).
  let jsonReason: string | null = null;
  const analyse = (text: string): Analysis | null => {
    const notes: string[] = [];
    jsonReason = null;
    if (codeMode) {
      const raw = extractCode(text);
      if (raw === null) return null;
      const code = fixer(notes)(raw);
      const before = codeWin!.getSource();
      const proc = listProcedures(before).find(p => codeWin!.getCursorLine() >= p.line && codeWin!.getCursorLine() <= p.endLine)?.name ?? null;
      const applied = applyCodeProposal(before, code, proc);
      if (!applied) return null;
      return { kind: 'code', applied, notes, problems: validateCode(code, { moduleName, form, project }) };
    }
    if (!form) return null;
    const parsed = parseFormOps(text, form, fixer(notes));
    if (!parsed.ok) { jsonReason = parsed.reason; return null; }
    const extra = parsed.ops.filter((o): o is Extract<typeof o, { op: 'add' }> => o.op === 'add').map(o => ({ name: o.name, type: o.type }));
    const problems = parsed.codeText === undefined ? [] : validateCode(parsed.codeText, { moduleName, form, extraControls: extra, project });
    return { kind: 'form', parsed, notes, problems };
  };

  const messages = (() => { try { return codeMode ? buildCodeRequest(project, itemId, codeWin!.getCursorLine(), prompt) : buildFormRequest(project, itemId, prompt); } catch { return null; } })();
  const res = await waitForReply(doc, settings.model, send(() => { if (!messages) throw new Error('Could not build the request.'); return messages; }), log);
  if (res.kind === 'cancel') return;
  if (res.kind === 'error') { await warn(doc, res.message); return; }
  if (ide.project !== project) return;   // a different project was opened meanwhile

  let reply = res.text;
  let metrics = res.metrics;
  let result = analyse(reply);
  // One retry at most: for the problems the checks found, or (form mode) for an answer that was not usable JSON.
  const complaint = result?.problems.length
    ? `Your answer has these problems:\n${result.problems.map(p => `- ${p}`).join('\n')}\nFix them and answer again in exactly the same format.`
    : !result && jsonReason !== null ? `Your answer was not valid JSON (${jsonReason}). Answer again with ONLY the JSON object.` : null;
  if (complaint && messages) {
    // Keep the first answer if the second is no better understood.
    const followUp: ChatMessage[] = [...messages, { role: 'assistant', content: reply }, { role: 'user', content: complaint }];
    log.separator();
    const again = await waitForReply(doc, settings.model, send(() => followUp), log, 'Checking and fixing...');
    if (again.kind === 'cancel') return;
    if (ide.project !== project) return;
    if (again.kind === 'reply') {
      const second = analyse(again.text);
      if (second) { result = second; reply = again.text; metrics = again.metrics; }
      else if (!result) reply = again.text;   // neither was understood: Details shows the latest
    }
  }
  if (!result) { await showNotUnderstood(doc, reply); return; }
  const warnings = [...result.notes, ...result.problems];

  if (result.kind === 'code') {
    const win = codeWin!;
    const before = win.getSource();
    const { applied } = result;
    if (!await showCodePreview(doc, before.replace(/\r\n?/g, '\n'), applied.source, applied.changes, warnings, metrics)) return;
    win.applyChange(0, win.getSource().length, applied.source);
    return;
  }

  const { parsed } = result;
  if (!form) return;
  let ok: boolean;
  try {
    const code = parsed.code === null ? undefined
      : { before: form.code.replace(/\r\n?/g, '\n'), after: parsed.code, changes: parsed.codeChanges ?? [] };
    ok = await showFormPreview(doc, applyFormOpsToClone(form, parsed), describeOps(parsed), [...parsed.warnings, ...warnings], project.assets, code, metrics);
  } catch (e) {
    await showNotUnderstood(doc, `${reply}\n\nError: ${e instanceof Error ? e.message : String(e)}`);
    return;
  }
  if (!ok) return;
  try { ide.stack.execute(formOpsToCommand(ide.project, itemId, parsed, 'AI changes')); }
  catch (e) { await warn(doc, e instanceof Error ? e.message : String(e)); }
}
