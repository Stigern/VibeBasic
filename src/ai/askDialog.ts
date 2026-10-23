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
import { type CodeSelection, applyCodeProposal, extractCode, skippedProblem } from './codeMode';
import { buildCodeRequest, buildFixRequest, buildFormRequest, type FixError } from './context';
import { addAiLogEntry, describeRequest, finishAiLogEntry, type AiLogEntry, type AiLogMode } from './aiLog';
import { isProse, isQuestion, showAnswer } from './answerDialog';
import { FORM_RESPONSE_FORMAT, FORM_STRUCTURED_OUTPUTS, NOT_UNDERSTOOD, applyFormOpsToClone, describeOps, formOpsToCommand, parseFormOps } from './formMode';
import { type PreviewResult, showCodePreview, showFormPreview } from './previewDialogs';
import { type AiSettings, type Thinking, loadAiSettings } from './settings';
import { AI_CUT_OFF, type AiChatOptions, type AiUsage } from './sse';
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
type Start = (o: AiChatOptions, ui: { setLabel(text: string): void }) => Promise<string>;
async function waitForReply(doc: Document, model: string, start: Start, log: StreamLog, label = `Waiting for ${model}...`): Promise<Waited> {
  const block = h('div', { style: 'position:absolute;top:1px;bottom:1px;left:0;width:40px;background:#000080' });
  const bar = h('div', { class: 'ai-progress', style: 'position:relative;height:16px;margin-top:8px;overflow:hidden;box-shadow:inset -1px -1px #fff,inset 1px 1px #808080' }, block);
  const box = h('div', {
    class: 'ai-stream', 'aria-readonly': 'true',
    style: 'box-sizing:border-box;width:420px;height:92px;margin-top:8px;padding:2px 4px;overflow-y:auto;background:#fff;color:#000;'
      + 'font:12px/14px "Courier New",monospace;white-space:pre-wrap;overflow-wrap:anywhere;user-select:text;'
      + 'box-shadow:inset -1px -1px #fff,inset 1px 1px #808080,inset -2px -2px #dfdfdf,inset 2px 2px #000',
  });
  const anim = createAiAnimation(doc);
  const labelEl = h('div', { class: 'ai-wait-label' }, label);
  const content = h('div', { style: 'min-width:420px' }, anim.el, labelEl, bar, box);
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
  try {
    request = start({ signal: ctrl.signal, onDelta: (kind, text) => { anim.setPhase(kind === 'content' ? 'writing' : 'thinking'); log.add(kind, text); }, onUsage: u => { usage = u; } },
      { setLabel: t => { labelEl.textContent = t; } });
  }
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

  // Code mode with a selection: the request is about it, and a bare-body answer replaces exactly it.
  const sel = codeMode ? codeWin!.getSelection?.() ?? null : null;
  const selection = sel && sel.text.trim() ? sel : null;
  const opts = { contextTokens: settings.contextTokens, selection: selection?.text };
  const first = (() => { try { return codeMode ? buildCodeRequest(project, itemId, codeWin!.getCursorLine(), prompt, opts) : buildFormRequest(project, itemId, prompt, opts); } catch { return null; } })();
  if (!first) { await warn(doc, 'Could not build the request.'); return; }
  const session: AiSession = { ide, backend, settings, doc };
  if (codeMode) await runCodeConversation(session, { first, itemId, codeWin: codeWin!, selection, question: isQuestion(prompt) });
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
  const first = (() => { try { return buildFixRequest(ide.project, fix.itemId, fix.error, fix.error.compile ? [] : fix.vars, { contextTokens: settings.contextTokens }); } catch { return null; } })();
  if (!first) { await warn(doc, 'Could not build the request.'); return; }
  const applied = await runCodeConversation({ ide, backend, settings, doc }, { first, itemId: fix.itemId, codeWin: win, beforeApply: ui.end, mode: 'fix' });
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

/**
 * max_tokens for a request. On vLLM the thinking counts as well, so the cap is room for the answer (8,192) plus room for the
 * thinking at the level sent: Low 4,096, Medium 8,192, High 16,384, and 16,384 for Server default (the level is unknown).
 * With a known context size it is lowered so that prompt + answer fit (vLLM rejects more); when not even 1,024 tokens
 * are left over, no cap is sent and the server decides.
 */
export const ANSWER_TOKENS = 8192;
const THINKING_TOKENS: Record<Thinking, number> = { server: 16384, low: 4096, medium: 8192, high: 16384 };
export function maxTokensFor(thinking: Thinking, contextTokens: number | undefined, promptChars: number): number | undefined {
  const cap = ANSWER_TOKENS + THINKING_TOKENS[thinking];
  if (!contextTokens) return cap;
  const room = contextTokens - Math.ceil(promptChars / 3) - 256;   // about 3 characters per token errs on the safe side
  return room < 1024 ? undefined : Math.min(cap, room);
}

/** "baseUrl|model" of servers whose structured output failed in this session: their later requests go without it. */
const noStructuredOutput = new Set<string>();
/** An HTTP 400/422 about the structured output field (the server does not support it, or not this schema). */
const rejectsStructuredOutput = (message: string): boolean =>
  /\b(400|422)\b/.test(message) && /response_format|json_schema|structured_output|guided|grammar/i.test(message);
/**
 * A structured answer cut off at max_tokens with only whitespace after its opening `{...` (the xgrammar whitespace runaway:
 * `{"ops"` and then blanks until the limit). Treated like a server without structured output.
 */
export const isWhitespaceRunaway = (content: string): boolean => {
  if (!content.trimStart().startsWith('{')) return false;
  const tail = content.length - content.trimEnd().length;
  return tail >= 64 && tail >= content.length / 2;
};
/** A dropped connection, a timeout or a 5xx: worth one more try. */
export const isTransientError = (message: string): boolean =>
  /^Could not connect to|did not answer within|did not finish within|stopped sending for|^The AI server answered 5\d\d\b/.test(message);
/** The pause before the automatic retry of a transient error (tests shorten it). */
export const aiRetry = { delayMs: 2000 };
const pause = (ms: number, signal?: AbortSignal) => new Promise<void>((resolve, reject) => {
  if (signal?.aborted) { reject(new Error('cancelled')); return; }
  const t = setTimeout(() => { signal?.removeEventListener('abort', onAbort); resolve(); }, ms);
  const onAbort = () => { clearTimeout(t); reject(new Error('cancelled')); };
  signal?.addEventListener('abort', onAbort, { once: true });
});

/** A structured output schema, sent as `structured_outputs` to vLLM and as `response_format` to other (and unknown) servers. */
export interface StructuredOutput { responseFormat: unknown; structuredOutputs: unknown }

const changeRequest = (wish: string): ChatMessage => ({ role: 'user', content: `Change your last answer: ${wish}\nAnswer with the complete result again, in exactly the same format.` });

/** One answer, understood (or `result` null), the conversation up to and including it, and the measurement line. `answer`: show it as text. */
type Done<A> = { kind: 'done'; result: A | null; reply: string; metrics: string; messages: ChatMessage[]; answer: boolean };
type Round<A> = Done<A> | { kind: 'error'; message: string } | { kind: 'cancel' };
type Understood<A> = { result: A | null; jsonReason: string | null };

/** How a conversation runs: its log mode, its structured output (form mode), whether answers in prose are shown (code mode). */
interface ConverseOptions { mode: AiLogMode; structured?: StructuredOutput; answers?: boolean; question?: boolean }

/**
 * The shared flow: send `first`, check the answer (one retry at most), show the preview, and on Change... send the conversation
 * so far plus the wish. The conversation only grows at the end, so the server's prefix cache keeps working.
 * With `answers`, a question or a reply in prose is shown in the AI Answer dialog; its Ask more... continues the conversation.
 * Every request goes into the AI log. A transient error (no connection, timeout, 5xx) is tried once more after a pause.
 */
async function converse<A extends { notes: string[]; problems: string[] }>(
  s: AiSession, first: ChatMessage[], analyse: (text: string) => Understood<A>,
  preview: (a: A, reply: string, metrics: string) => Promise<PreviewResult>, apply: (a: A) => void | Promise<void>,
  co: ConverseOptions,
): Promise<boolean> {
  const { ide, backend, settings, doc } = s;
  const project = ide.project;
  const effort = settings.thinking === 'server' ? undefined : settings.thinking;
  const log = new StreamLog();
  const server = `${settings.baseUrl.trim()}|${settings.model.trim()}`;
  const secret = settings.apiKey;
  /** The log entry of the request that gave the latest reply (marked "not understood" when it was). */
  let lastEntry: AiLogEntry | null = null;

  /** One request to the server, logged. `partial` gets the answer text that streamed in, also when the request fails. */
  const attempt = async (messages: ChatMessage[], level: string | undefined, x: AiChatOptions, mode: AiLogMode, partial: { content: string }): Promise<string> => {
    const entry = addAiLogEntry({
      mode, model: settings.model, seconds: 0, status: 'ok', reply: '', reasoning: '',
      sent: describeRequest(settings.baseUrl, settings.model, messages, {
        reasoning_effort: level, max_tokens: x.maxTokens,
        ...(x.structuredOutputs !== undefined ? { structured_outputs: 'json schema' } : {}), ...(x.responseFormat !== undefined ? { response_format: 'json_schema' } : {}),
      }),
    }, secret);
    lastEntry = entry;
    const t0 = Date.now();
    let reasoning = '', usage: AiUsage | undefined;
    partial.content = '';
    try {
      const text = await backend.aiChat(settings.baseUrl, settings.apiKey, settings.model, messages, level, {
        ...x,
        onDelta: (k, t) => { if (k === 'content') partial.content += t; else reasoning += t; x.onDelta?.(k, t); },
        onUsage: u => { usage = u; x.onUsage?.(u); },
      });
      finishAiLogEntry(entry, { status: 'ok', reply: text, reasoning, usage, ms: Date.now() - t0 }, secret);
      return text;
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      const cancelled = x.signal?.aborted || message === 'cancelled';
      finishAiLogEntry(entry, { status: cancelled ? 'cancelled' : 'error', reply: partial.content, reasoning, usage, error: cancelled ? undefined : message, ms: Date.now() - t0 }, secret);
      throw e;
    }
  };

  /** Follow-up rounds (the check-and-fix retry, Change...) think 'low' with "Fast follow-up rounds"; Server default stays unsent. */
  const send = (messages: ChatMessage[], followUp: boolean, mode: AiLogMode): Start => async (o, ui) => {
    const level = effort && followUp && settings.fastFollowUp !== false ? 'low' : effort;
    const opts: AiChatOptions = { ...o, maxTokens: maxTokensFor(level ?? 'server', settings.contextTokens, messages.reduce((n, m) => n + m.content.length, 0)) };
    const partial = { content: '' };
    const once = async (m: AiLogMode): Promise<string> => {
      const so = co.structured;
      if (so === undefined || noStructuredOutput.has(server)) return attempt(messages, level, opts, m, partial);
      const field = settings.serverKind === 'vllm' ? { structuredOutputs: so.structuredOutputs } : { responseFormat: so.responseFormat };
      try { return await attempt(messages, level, { ...opts, ...field }, m, partial); }
      catch (e) {
        // Structured output failed (rejected, or the whitespace runaway): once more at once without it, and never again for this server and model.
        const message = e instanceof Error ? e.message : String(e);
        if (o.signal?.aborted || !(rejectsStructuredOutput(message) || (message === AI_CUT_OFF && isWhitespaceRunaway(partial.content)))) throw e;
        noStructuredOutput.add(server);
        return attempt(messages, level, opts, 'retry', partial);
      }
    };
    try { return await once(mode); }
    catch (e) {
      if (o.signal?.aborted || !isTransientError(e instanceof Error ? e.message : String(e))) throw e;
      ui.setLabel('Retrying...');
      await pause(aiRetry.delayMs, o.signal);
      return once('retry');
    }
  };

  const round = async (messages: ChatMessage[], later: boolean, mode: AiLogMode, question = false): Promise<Round<A>> => {
    const res = await waitForReply(doc, settings.model, send(messages, later, mode), log);
    if (res.kind !== 'reply') return res;
    if (ide.project !== project) return { kind: 'cancel' };   // a different project was opened meanwhile
    let reply = res.text, metrics = res.metrics;
    let convo: ChatMessage[] = [...messages, { role: 'assistant', content: reply }];
    // A question is answered in words: no checks, no retry.
    if (co.answers && question) return { kind: 'done', result: null, reply, metrics, messages: convo, answer: true };
    const firstEntry = lastEntry;
    let got = analyse(reply);
    const garbled = (u: Understood<A>, text: string) => !u.result && !(co.answers && isProse(text));
    if (garbled(got, reply) && firstEntry) firstEntry.status = 'not understood';
    // One retry at most: for the problems the checks found, or (form mode) for an answer that was not usable JSON.
    const complaint = got.result?.problems.length
      ? `Your answer has these problems:\n${got.result.problems.map(p => `- ${p}`).join('\n')}\nFix them and answer again in exactly the same format.`
      : !got.result && got.jsonReason !== null ? `Your answer was not valid JSON (${got.jsonReason}). Answer again with ONLY the JSON object.` : null;
    if (complaint) {
      // Keep the first answer if the second is no better understood.
      const followUp: ChatMessage[] = [...convo, { role: 'user', content: complaint }];
      log.separator();
      const again = await waitForReply(doc, settings.model, send(followUp, true, 'retry'), log, 'Checking and fixing...');
      if (again.kind === 'cancel' || ide.project !== project) return { kind: 'cancel' };
      if (again.kind === 'reply') {
        const second = analyse(again.text);
        if (garbled(second, again.text) && lastEntry) lastEntry.status = 'not understood';
        if (second.result) { got = second; reply = again.text; metrics = again.metrics; convo = [...followUp, { role: 'assistant', content: again.text }]; }
        else if (!got.result) reply = again.text;   // neither was understood: Details shows the latest
      }
    }
    return { kind: 'done', result: got.result, reply, metrics, messages: convo, answer: !got.result && !!co.answers && isProse(reply) };
  };

  const copy = (text: string) => backend.clipboardSetText(text);
  /** The proposal on screen in the preview (null until there is one). */
  let shown: Done<A> | null = null;
  let next: Round<A> = await round(first, false, co.mode, co.question);
  for (;;) {
    if (ide.project !== project) return false;
    if (next.kind === 'error') await warn(doc, next.message);
    else if (next.kind === 'done' && next.answer) {
      const a = await showAnswer(doc, next.reply, next.metrics, copy);
      if (a !== 'ok') { next = await round(trimConversation([...next.messages, { role: 'user', content: a.more }]), true, 'change', isQuestion(a.more)); continue; }
    }
    else if (next.kind === 'done' && !next.result) await showNotUnderstood(doc, next.reply);
    else if (next.kind === 'done') shown = next;
    // Without a proposal the conversation ends; otherwise (a failed Change... too) the last proposal stays.
    if (!shown) return false;
    let out: PreviewResult;
    try { out = await preview(shown.result!, shown.reply, shown.metrics); }
    catch (e) { await showNotUnderstood(doc, `${shown.reply}\n\nError: ${e instanceof Error ? e.message : String(e)}`); return false; }
    if (out === 'cancel') return false;
    if (out === 'ok') { await apply(shown.result!); return true; }
    // Change...: a new answer to the whole conversation.
    next = await round(trimConversation([...shown.messages, changeRequest(out.change)]), true, 'change');
  }
}

/**
 * Code mode: `first` is the finished request; the proposal is checked against `codeWin` and applied there on OK
 * (after `beforeApply`, which Ask AI on an error uses to end the program). With `selection` (the code window's selection
 * when the request was made), an answer without a procedure heading replaces exactly that. True when a proposal was applied.
 */
export async function runCodeConversation(s: AiSession, o: { first: ChatMessage[]; itemId: string; codeWin: CodeWindow; beforeApply?: () => Promise<void>; selection?: CodeSelection | null;
  /** The request asks about the code (the answer is shown as text). */ question?: boolean; mode?: AiLogMode }): Promise<boolean> {
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
    const applied = applyCodeProposal(before, code, proc, o.selection);
    if (!applied) return none;
    const problems = validateCode(code, { moduleName, form, project });
    if (applied.skipped) problems.push(skippedProblem(applied.skipped));   // the retry asks for the changed procedures only
    return { result: { applied, notes, problems }, jsonReason: null };
  };
  return converse<A>(s, o.first, analyse,
    (a, _reply, metrics) => showCodePreview(doc, win.getSource().replace(/\r\n?/g, '\n'), a.applied.source, a.applied.changes, [...a.notes, ...a.problems], metrics),
    async a => { await o.beforeApply?.(); win.applyChange(0, win.getSource().length, a.applied.source); },
    { mode: o.mode ?? 'code', answers: true, question: o.question });
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
    if (parsed.codeSkipped) problems.push(skippedProblem(parsed.codeSkipped));
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
    }, { mode: 'form', structured: { responseFormat: FORM_RESPONSE_FORMAT, structuredOutputs: FORM_STRUCTURED_OUTPUTS } });
}

/** Fixes wrong event-procedure names in AI code (Form1_Load etc.) and records what it did in `notes`. */
function fixEventNames(form: { name: string } | null, code: string, notes: string[]): string {
  if (!form) return code;
  const r = autoFixEventNames(code, form.name);
  notes.push(...r.notes);
  return r.code;
}
