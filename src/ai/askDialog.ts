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

type Waited = { kind: 'reply'; text: string } | { kind: 'error'; message: string } | { kind: 'cancel' };

/** Waiting dialog with a back-and-forth progress bar. Cancel closes it; a reply arriving afterwards is discarded. */
async function waitForReply(doc: Document, model: string, request: Promise<string>, label = `Waiting for ${model}...`): Promise<Waited> {
  const block = h('div', { style: 'position:absolute;top:1px;bottom:1px;left:0;width:40px;background:#000080' });
  const bar = h('div', { class: 'ai-progress', style: 'position:relative;height:16px;margin-top:8px;overflow:hidden;box-shadow:inset -1px -1px #fff,inset 1px 1px #808080' }, block);
  const content = h('div', { style: 'min-width:260px' }, h('div', {}, label), bar);
  let pos = 0, dir = 1;
  const timer = setInterval(() => {
    const max = Math.max(0, bar.clientWidth - 40);
    pos += dir * 6;
    if (pos >= max) { pos = max; dir = -1; } else if (pos <= 0) { pos = 0; dir = 1; }
    block.style.left = `${pos}px`;
  }, 40);
  const answered = request.then<Waited, Waited>(text => ({ kind: 'reply', text }), e => ({ kind: 'error', message: e instanceof Error ? e.message : String(e) }));
  const cancelled = showDialog98(doc, { title: TITLE, content, buttons: [{ label: 'Cancel', value: 'cancel', cancel: true }] })
    .then<Waited>(() => ({ kind: 'cancel' }));
  try {
    const res = await Promise.race([answered, cancelled]);
    if (res.kind !== 'cancel') content.closest('.dlg98-overlay')?.dispatchEvent(new Event('dlg98-abort'));
    return res;
  } finally { clearInterval(timer); }
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
  const send = (build: () => ChatMessage[]): Promise<string> => {
    try { return backend.aiChat(settings.baseUrl, settings.apiKey, settings.model, build(), effort); }
    catch (e) { return Promise.reject(e); }
  };
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
  const analyse = (text: string): Analysis | null => {
    const notes: string[] = [];
    if (codeMode) {
      const raw = extractCode(text);
      if (raw === null) return null;
      const code = fixer(notes)(raw);
      const before = codeWin!.getSource();
      const proc = listProcedures(before).find(p => codeWin!.getCursorLine() >= p.line && codeWin!.getCursorLine() <= p.endLine)?.name ?? null;
      const applied = applyCodeProposal(before, code, proc);
      if (!applied) return null;
      return { kind: 'code', applied, notes, problems: validateCode(code, { moduleName, form }) };
    }
    if (!form) return null;
    const parsed = parseFormOps(text, form, fixer(notes));
    if (!parsed.ok) return null;
    const extra = parsed.ops.filter((o): o is Extract<typeof o, { op: 'add' }> => o.op === 'add').map(o => ({ name: o.name, type: o.type }));
    const problems = parsed.codeText === undefined ? [] : validateCode(parsed.codeText, { moduleName, form, extraControls: extra });
    return { kind: 'form', parsed, notes, problems };
  };

  const messages = (() => { try { return codeMode ? buildCodeRequest(project, itemId, codeWin!.getCursorLine(), prompt) : buildFormRequest(project, itemId, prompt); } catch { return null; } })();
  const res = await waitForReply(doc, settings.model, send(() => { if (!messages) throw new Error('Could not build the request.'); return messages; }));
  if (res.kind === 'cancel') return;
  if (res.kind === 'error') { await warn(doc, res.message); return; }
  if (ide.project !== project) return;   // a different project was opened meanwhile

  let reply = res.text;
  let result = analyse(reply);
  if (result && result.problems.length && messages) {
    // One retry: tell the model what is wrong and keep the first answer if the second is no better understood.
    const followUp: ChatMessage[] = [...messages, { role: 'assistant', content: reply },
      { role: 'user', content: `Your answer has these problems:\n${result.problems.map(p => `- ${p}`).join('\n')}\nFix them and answer again in exactly the same format.` }];
    const again = await waitForReply(doc, settings.model, send(() => followUp), 'Checking and fixing...');
    if (again.kind === 'cancel') return;
    if (ide.project !== project) return;
    if (again.kind === 'reply') {
      const second = analyse(again.text);
      if (second) { result = second; reply = again.text; }
    }
  }
  if (!result) { await showNotUnderstood(doc, reply); return; }
  const warnings = [...result.notes, ...result.problems];

  if (result.kind === 'code') {
    const win = codeWin!;
    const before = win.getSource();
    const { applied } = result;
    if (!await showCodePreview(doc, before.replace(/\r\n?/g, '\n'), applied.source, applied.changes, warnings)) return;
    win.applyChange(0, win.getSource().length, applied.source);
    return;
  }

  const { parsed } = result;
  if (!form) return;
  let ok: boolean;
  try {
    const code = parsed.code === null ? undefined
      : { before: form.code.replace(/\r\n?/g, '\n'), after: parsed.code, changes: parsed.codeChanges ?? [] };
    ok = await showFormPreview(doc, applyFormOpsToClone(form, parsed), describeOps(parsed), [...parsed.warnings, ...warnings], project.assets, code);
  } catch (e) {
    await showNotUnderstood(doc, `${reply}\n\nError: ${e instanceof Error ? e.message : String(e)}`);
    return;
  }
  if (!ok) return;
  try { ide.stack.execute(formOpsToCommand(ide.project, itemId, parsed, 'AI changes')); }
  catch (e) { await warn(doc, e instanceof Error ? e.message : String(e)); }
}
