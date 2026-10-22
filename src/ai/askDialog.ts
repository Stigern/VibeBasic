// Tools > Ask AI...: prompt dialog, waiting dialog (cancelable), then code mode or form mode with a preview.
// Nothing is applied unless the reply was understood and the user pressed OK in the preview.
import type { Backend } from '../backend/backend';
import { showOptions } from '../ide/optionsDialog';
import type { CodeWindow } from '../ide/codeWindow';
import type { IdeState } from '../ide/ideState';
import { listProcedures } from '../model/procedures';
import { messageBox98, showDialog98 } from '../ui98/dialogs';
import { h } from '../ui98/dom';
import { createAiAnimation } from './aiAnimation';
import { applyCodeProposal, extractCode } from './codeMode';
import { buildCodeRequest, buildFixRequest, buildFormRequest, type FixError } from './context';
import { NOT_UNDERSTOOD, applyFormOpsToClone, describeOps, formOpsToCommand, parseFormOps } from './formMode';
import { type PreviewResult, showCodePreview, showFormPreview } from './previewDialogs';
import { type AiSettings, loadAiSettings } from './settings';
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
 * Waiting dialog with a 1998-style animation (thinking or writing), a back-and-forth progress bar and a box that shows the reply as it streams in.
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
  const anim = createAiAnimation(doc);
  const content = h('div', { style: 'min-width:420px' }, anim.el, h('div', {}, label), bar, box);
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
  try { request = start({ signal: ctrl.signal, onDelta: (kind, text) => { anim.setPhase(kind === 'content' ? 'writing' : 'thinking'); log.add(kind, text); }, onUsage: u => { usage = u; } }); }
  catch (e) { request = Promise.reject(e); }
  const answered = request.then<Waited, Waited>(text => ({ kind: 'reply', text, metrics: formatMetrics(usage, Date.now() - t0) }), e => ({ kind: 'error', message: e instanceof Error ? e.message : String(e) }));
  const cancelled = showDialog98(doc, { title: TITLE, content, buttons: [{ label: 'Cancel', value: 'cancel', cancel: true }] })
    .then<Waited>(() => ({ kind: 'cancel' }));
  try {
    const res = await Promise.race([answered, cancelled]);
    if (res.kind !== 'cancel') content.closest('.dlg98-overlay')?.dispatchEvent(new Event('dlg98-abort'));
    else ctrl.abort();
    return res;
  } finally { clearInterval(timer); anim.dispose(); log.detach(); }
}

export async function askAi(ide: IdeState, backend: Backend, ui: { codeWindowFor(itemId: string): CodeWindow | null }, doc: Document = document): Promise<void> {
  if (ide.mode !== 'design') return;
  const view = ide.activeView;
  const itemId = view.kind === 'code' ? view.itemId : view.kind === 'designer' ? view.formId : null;
  const item = itemId ? ide.project.forms.find(f => f.id === itemId) ?? ide.project.modules.find(m => m.id === itemId) : undefined;
  const codeWin = view.kind === 'code' && itemId ? ui.codeWindowFor(itemId) : null;
  if (!itemId || !item || (view.kind === 'code' && !codeWin)) { await warn(doc, 'Open a form or a code window first.'); return; }

  const settings = await settingsOrSetup(ide, backend, doc);
  if (!settings) return;

  const project = ide.project;
  const codeMode = view.kind === 'code';
  const prompt = await promptDialog(doc, `Ask AI - ${item.name} (${codeMode ? 'Code' : 'Form'})`);
  if (prompt === null) return;

  const first = (() => { try { return codeMode ? buildCodeRequest(project, itemId, codeWin!.getCursorLine(), prompt) : buildFormRequest(project, itemId, prompt); } catch { return null; } })();
  if (!first) { await warn(doc, 'Could not build the request.'); return; }
  const session: AiSession = { ide, backend, settings, doc };
  if (codeMode) await runCodeConversation(session, { first, itemId, codeWin: codeWin! });
  else await runFormConversation(session, { first, itemId });
}

/** The AI settings, or null after telling the user to set up the server (and opening Options on the AI tab). */
async function settingsOrSetup(ide: IdeState, backend: Backend, doc: Document): Promise<AiSettings | null> {
  const settings = await loadAiSettings(backend);
  if (settings.model.trim()) return settings;
  await warn(doc, 'Set up the AI server first in Tools > Options > AI.');
  await showOptions(ide, backend, doc, 'AI');
  return null;
}

/** An error to fix with AI: where it happened and, for a run-time error, the variables of the stopped frame. */
export interface ErrorToFix { itemId: string; error: FixError; vars: { name: string; value: string }[] }

/**
 * Ask AI on a run-time or compile error (the error dialog's Ask AI, Tools > Ask AI about this error): code mode with
 * the error, the line and the variable values. The program stays in break mode until OK; OK ends it (`end` resolves
 * once it has stopped), applies the fix to the module or form as one undo step and shows the code window at the line.
 */
export async function askAiAboutError(ide: IdeState, backend: Backend, fix: ErrorToFix,
  ui: { openCode(itemId: string): CodeWindow; end(): Promise<void> }, doc: Document = document): Promise<void> {
  if (!ide.project.forms.some(f => f.id === fix.itemId) && !ide.project.modules.some(m => m.id === fix.itemId)) return;
  const settings = await settingsOrSetup(ide, backend, doc);
  if (!settings) return;
  const win = ui.openCode(fix.itemId);
  win.gotoLine(fix.error.line);   // the cursor marks the failing procedure for the merge
  const first = (() => { try { return buildFixRequest(ide.project, fix.itemId, fix.error, fix.error.compile ? [] : fix.vars); } catch { return null; } })();
  if (!first) { await warn(doc, 'Could not build the request.'); return; }
  const applied = await runCodeConversation({ ide, backend, settings, doc }, { first, itemId: fix.itemId, codeWin: win, beforeApply: ui.end });
  if (applied) ui.openCode(fix.itemId).gotoLine(fix.error.line);
}

export interface AiSession { ide: IdeState; backend: Backend; settings: AiSettings; doc: Document }

/** The conversation is trimmed above about this many characters (24 000 is roughly 8 000 tokens). */
export const MAX_CONVERSATION_CHARS = 24000;

/**
 * Drops the oldest (assistant answer, change request) pairs until the conversation fits.
 * Always keeps the system message, the first question, the latest answer and the newest request.
 */
export function trimConversation(messages: ChatMessage[], max = MAX_CONVERSATION_CHARS): ChatMessage[] {
  const out = [...messages];
  const size = () => out.reduce((n, m) => n + m.content.length, 0);
  while (size() > max && out.length >= 6) out.splice(2, 2);
  return out;
}

const changeRequest = (wish: string): ChatMessage => ({ role: 'user', content: `Change your last answer: ${wish}\nAnswer with the complete result again, in exactly the same format.` });

/** One answer, understood (or `result` null), the conversation up to and including it, and the measurement line. */
type Round<A> = { kind: 'done'; result: A | null; reply: string; metrics: string; messages: ChatMessage[] } | { kind: 'error'; message: string } | { kind: 'cancel' };
type Understood<A> = { result: A | null; jsonReason: string | null };

/**
 * The shared flow: send `first`, check the answer (one retry at most), show the preview, and on Change... send the conversation
 * so far plus the wish. The conversation only grows at the end, so the server's prefix cache keeps working.
 */
async function converse<A extends { notes: string[]; problems: string[] }>(
  s: AiSession, first: ChatMessage[], analyse: (text: string) => Understood<A>,
  preview: (a: A, reply: string, metrics: string) => Promise<PreviewResult>, apply: (a: A) => void | Promise<void>,
): Promise<boolean> {
  const { ide, backend, settings, doc } = s;
  const project = ide.project;
  const effort = settings.thinking === 'server' ? undefined : settings.thinking;
  const log = new StreamLog();
  const send = (messages: ChatMessage[]) => (o: AiChatOptions): Promise<string> => {
    try { return backend.aiChat(settings.baseUrl, settings.apiKey, settings.model, messages, effort, o); }
    catch (e) { return Promise.reject(e); }
  };

  const round = async (messages: ChatMessage[]): Promise<Round<A>> => {
    const res = await waitForReply(doc, settings.model, send(messages), log);
    if (res.kind !== 'reply') return res;
    if (ide.project !== project) return { kind: 'cancel' };   // a different project was opened meanwhile
    let reply = res.text, metrics = res.metrics;
    let convo: ChatMessage[] = [...messages, { role: 'assistant', content: reply }];
    let got = analyse(reply);
    // One retry at most: for the problems the checks found, or (form mode) for an answer that was not usable JSON.
    const complaint = got.result?.problems.length
      ? `Your answer has these problems:\n${got.result.problems.map(p => `- ${p}`).join('\n')}\nFix them and answer again in exactly the same format.`
      : !got.result && got.jsonReason !== null ? `Your answer was not valid JSON (${got.jsonReason}). Answer again with ONLY the JSON object.` : null;
    if (complaint) {
      // Keep the first answer if the second is no better understood.
      const followUp: ChatMessage[] = [...convo, { role: 'user', content: complaint }];
      log.separator();
      const again = await waitForReply(doc, settings.model, send(followUp), log, 'Checking and fixing...');
      if (again.kind === 'cancel' || ide.project !== project) return { kind: 'cancel' };
      if (again.kind === 'reply') {
        const second = analyse(again.text);
        if (second.result) { got = second; reply = again.text; metrics = again.metrics; convo = [...followUp, { role: 'assistant', content: again.text }]; }
        else if (!got.result) reply = again.text;   // neither was understood: Details shows the latest
      }
    }
    return { kind: 'done', result: got.result, reply, metrics, messages: convo };
  };

  let cur = await round(first);
  if (cur.kind === 'cancel') return false;
  if (cur.kind === 'error') { await warn(doc, cur.message); return false; }
  if (!cur.result) { await showNotUnderstood(doc, cur.reply); return false; }
  for (;;) {
    let out: PreviewResult;
    try { out = await preview(cur.result!, cur.reply, cur.metrics); }
    catch (e) { await showNotUnderstood(doc, `${cur.reply}\n\nError: ${e instanceof Error ? e.message : String(e)}`); return false; }
    if (out === 'cancel') return false;
    if (out === 'ok') { await apply(cur.result!); return true; }
    // Change...: a new answer to the whole conversation. If it is not understood, the last proposal stays.
    const next = await round(trimConversation([...cur.messages, changeRequest(out.change)]));
    if (ide.project !== project) return false;
    if (next.kind === 'error') await warn(doc, next.message);
    else if (next.kind === 'done' && !next.result) await showNotUnderstood(doc, next.reply);
    else if (next.kind === 'done') cur = next;
  }
}

/**
 * Code mode: `first` is the finished request; the proposal is checked against `codeWin` and applied there on OK
 * (after `beforeApply`, which Ask AI on an error uses to end the program). True when a proposal was applied.
 */
export async function runCodeConversation(s: AiSession, o: { first: ChatMessage[]; itemId: string; codeWin: CodeWindow; beforeApply?: () => Promise<void> }): Promise<boolean> {
  const { ide, doc } = s;
  const project = ide.project;
  const win = o.codeWin;
  const item = project.forms.find(f => f.id === o.itemId) ?? project.modules.find(m => m.id === o.itemId);
  if (!item) return false;
  const form = project.forms.find(f => f.id === o.itemId) ?? null;
  const moduleName = item.name;
  type A = { applied: NonNullable<ReturnType<typeof applyCodeProposal>>; notes: string[]; problems: string[] };
  const analyse = (text: string): Understood<A> => {
    const notes: string[] = [];
    const none = { result: null, jsonReason: null };
    const raw = extractCode(text);
    if (raw === null) return none;
    const code = fixEventNames(form, raw, notes);
    const before = win.getSource();
    const proc = listProcedures(before).find(p => win.getCursorLine() >= p.line && win.getCursorLine() <= p.endLine)?.name ?? null;
    const applied = applyCodeProposal(before, code, proc);
    if (!applied) return none;
    return { result: { applied, notes, problems: validateCode(code, { moduleName, form, project }) }, jsonReason: null };
  };
  return converse<A>(s, o.first, analyse,
    (a, _reply, metrics) => showCodePreview(doc, win.getSource().replace(/\r\n?/g, '\n'), a.applied.source, a.applied.changes, [...a.notes, ...a.problems], metrics),
    async a => { await o.beforeApply?.(); win.applyChange(0, win.getSource().length, a.applied.source); });
}

/** Form mode: `first` is the finished request; the proposal is applied to the form as one undo step on OK. */
export async function runFormConversation(s: AiSession, o: { first: ChatMessage[]; itemId: string }): Promise<boolean> {
  const { ide, doc } = s;
  const project = ide.project;
  const form = project.forms.find(f => f.id === o.itemId);
  if (!form) return false;
  type A = { parsed: Extract<ReturnType<typeof parseFormOps>, { ok: true }>; notes: string[]; problems: string[] };
  const analyse = (text: string): Understood<A> => {
    const notes: string[] = [];
    const parsed = parseFormOps(text, form, code => fixEventNames(form, code, notes));
    if (!parsed.ok) return { result: null, jsonReason: parsed.reason };
    const extra = parsed.ops.filter((o): o is Extract<typeof o, { op: 'add' }> => o.op === 'add').map(o => ({ name: o.name, type: o.type }));
    const problems = parsed.codeText === undefined ? [] : validateCode(parsed.codeText, { moduleName: form.name, form, extraControls: extra, project });
    return { result: { parsed, notes, problems }, jsonReason: null };
  };
  return converse<A>(s, o.first, analyse,
    (a, _reply, metrics) => {
      const { parsed } = a;
      const code = parsed.code === null ? undefined
        : { before: form.code.replace(/\r\n?/g, '\n'), after: parsed.code, changes: parsed.codeChanges ?? [] };
      return showFormPreview(doc, applyFormOpsToClone(form, parsed), describeOps(parsed), [...parsed.warnings, ...a.notes, ...a.problems], project.assets, code, metrics);
    },
    async a => {
      try { ide.stack.execute(formOpsToCommand(ide.project, o.itemId, a.parsed, 'AI changes')); }
      catch (e) { await warn(doc, e instanceof Error ? e.message : String(e)); }
    });
}

/** Fixes wrong event-procedure names in AI code (Form1_Load etc.) and records what it did in `notes`. */
function fixEventNames(form: { name: string } | null, code: string, notes: string[]): string {
  if (!form) return code;
  const r = autoFixEventNames(code, form.name);
  notes.push(...r.notes);
  return r.code;
}
