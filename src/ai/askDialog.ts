// Tools > Ask AI...: prompt dialog, waiting dialog (cancelable), then code mode or form mode with a preview.
// Nothing is applied unless the reply was understood and the user pressed OK in the preview.
import type { Backend } from '../backend/backend';
import { showOptions } from '../ide/optionsDialog';
import type { CodeWindow } from '../ide/codeWindow';
import type { IdeState } from '../ide/ideState';
import type { FormDef } from '../model/types';
import { listProcedures } from '../model/procedures';
import { messageBox98, showDialog98 } from '../ui98/dialogs';
import { h } from '../ui98/dom';
import { createAiAnimation } from './aiAnimation';
import { thinkingOnly } from './clean';
import { type CodeSelection, applyCodeProposal, extractCode, skippedProblem } from './codeMode';
import { buildCodeRequest, buildFixRequest, buildFormRequest, type FixError } from './context';
import { detectServer, isVisionError, withDetected } from './detect';
import { effortFor, retryEffort } from './effort';
import { renderFormImage } from './formImage';
import { layoutProblems } from './layoutCheck';
import { LoopWatch } from './loopDetect';
import { addAiLogEntry, newAiRequestId, describeRequest, finishAiLogEntry, type AiLogEntry, type AiLogMode } from './aiLog';
import { isProse, questionMode, showAnswer } from './answerDialog';
import { FORM_RESPONSE_FORMAT, FORM_STRUCTURED_OUTPUTS, NOT_UNDERSTOOD, applyFormOpsToClone, describeOps, formOpsToCommand, growForOverflow, parseFormOps } from './formMode';
import { type PreviewResult, showCodePreview, showFormPreview } from './previewDialogs';
import { type AiSettings, loadAiSettings } from './settings';
import { AI_CUT_OFF, AI_EMPTY_ANSWER, type AiChatOptions, type AiUsage, type AiResponseMetadata } from './sse';
import { classifyAiError } from './errors';
import { StreamLog } from './streamLog';
import { type ChatMessage, type ContentPart, contentChars, contentText } from './types';
import { autoFixEventNames, isSyntaxProblem, validateCode } from './validate';
import { showRequestDialog, requestInstructions, type AskRequest } from './requestDialog';
import { stripThinking } from './clean';

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
async function waitForReply(doc: Document, model: string, start: Start, log: StreamLog, label = `Waiting for ${model}...`, hold?: Hold | null): Promise<Waited> {
  const block = h('div', { style: 'position:absolute;top:1px;bottom:1px;left:0;width:40px;background:#000080' });
  const bar = h('div', { class: 'ai-progress', style: 'position:relative;height:16px;margin-top:8px;overflow:hidden;box-shadow:inset -1px -1px #fff,inset 1px 1px #808080' }, block);
  const box = h('div', {
    class: 'ai-stream', 'aria-readonly': 'true',
    style: 'box-sizing:border-box;flex:1 1 auto;height:92px;min-height:92px;margin-top:8px;padding:2px 4px;overflow-y:auto;background:#fff;color:#000;'
      + 'font:12px/14px "Courier New",monospace;white-space:pre-wrap;overflow-wrap:anywhere;user-select:text;'
      + 'box-shadow:inset -1px -1px #fff,inset 1px 1px #808080,inset -2px -2px #dfdfdf,inset 2px 2px #000',
  });
  const anim = createAiAnimation(doc);
  const labelEl = h('div', { class: 'ai-wait-label' }, label);
  // the box takes the room the dialog gets when it is made bigger (it keeps its place and size for the next request)
  const content = h('div', { style: 'min-width:420px;display:flex;flex-direction:column' }, anim.el, labelEl, bar, box);
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
  const cancelled = showDialog98(doc, { title: TITLE, content, buttons: [{ label: 'Cancel', value: 'cancel', cancel: true }], resizable: true, placeKey: 'ai-wait' })
    .then<Waited>(() => ({ kind: 'cancel' }));
  hold?.close();   // this dialog is up now: the one that covered the time before it goes
  try {
    const res = await Promise.race([answered, cancelled]);
    if (res.kind !== 'cancel') content.closest('.dlg98-overlay')?.dispatchEvent(new Event('dlg98-abort'));
    else ctrl.abort();
    return res;
  } finally { clearInterval(timer); anim.dispose(); log.detach(); }
}

/**
 * A modal "Connecting..." dialog with Cancel that covers the time before the first waiting dialog (finding what the server can
 * do, making the form picture), so the IDE cannot be used meanwhile. `close` takes it away; `result` says how it went.
 */
interface Hold { result: Promise<'cancel' | 'closed'>; cancelled(): boolean; close(): void }
function holdDialog(doc: Document, label: string): Hold {
  let closing = false, wasCancelled = false;
  const content = h('div', { style: 'min-width:420px' }, h('div', { class: 'ai-wait-label' }, label));
  const result = showDialog98(doc, { title: TITLE, content, buttons: [{ label: 'Cancel', value: 'cancel', cancel: true }] })
    .then((): 'cancel' | 'closed' => { wasCancelled = !closing; return wasCancelled ? 'cancel' : 'closed'; });
  return {
    result, cancelled: () => wasCancelled,
    close: () => { if (closing) return; closing = true; content.closest('.dlg98-overlay')?.dispatchEvent(new Event('dlg98-abort')); },
  };
}

/**
 * Runs `task` as the one AI request of the IDE: none starts while another one runs, and the program cannot be started meanwhile
 * (IdeState.busy, which Start and Make respect).
 */
async function exclusive(ide: IdeState, task: () => Promise<void>): Promise<void> {
  if (ide.busy) return;
  ide.setBusy(true);
  try { await task(); } finally { ide.setBusy(false); }
}

/** `o.prompt`: asks for the request instead of the plain prompt dialog (the AI Wizard's dialog); null cancels. */
export function askAi(ide: IdeState, backend: Backend, ui: { codeWindowFor(itemId: string): CodeWindow | null }, doc: Document = document,
  o: { prompt?: () => Promise<string | null> } = {}): Promise<void> {
  if (ide.mode !== 'design') return Promise.resolve();
  return exclusive(ide, () => askAiNow(ide, backend, ui, doc, o));
}

async function askAiNow(ide: IdeState, backend: Backend, ui: { codeWindowFor(itemId: string): CodeWindow | null }, doc: Document,
  o: { prompt?: () => Promise<string | null> }): Promise<void> {
  const view = ide.activeView;
  const itemId = view.kind === 'code' ? view.itemId : view.kind === 'designer' ? view.formId : null;
  const item = itemId ? ide.project.forms.find(f => f.id === itemId) ?? ide.project.modules.find(m => m.id === itemId) : undefined;
  const codeWin = view.kind === 'code' && itemId ? ui.codeWindowFor(itemId) : null;
  if (!itemId || !item || (view.kind === 'code' && !codeWin)) { await warn(doc, 'Open a form or a code window first.'); return; }

  // The wizard can be explored (or cancelled) before an AI server is configured.
  const customPrompt = o.prompt ? await o.prompt() : undefined;
  if (customPrompt === null) return;
  const stored = await settingsOrSetup(ide, backend, doc);
  if (!stored) return;
  // what the settings do not know yet (server kind, vision) is found while the user types
  const probe = new AbortController();   // stops the picture probe when the request dialog is cancelled
  const detecting = detectServer(backend, stored, probe.signal);

  const project = ide.project;
  const codeMode = view.kind === 'code';
  const form = project.forms.find(f => f.id === itemId) ?? null;
  const proc = codeWin ? listProcedures(codeWin.getSource()).find(p => codeWin.getCursorLine() >= p.line && codeWin.getCursorLine() <= p.endLine) : undefined;
  const request = customPrompt === undefined ? await showRequestDialog(doc, {
    itemName: item.name, model: stored.model, form, codeMode, selection: codeWin?.getSelection?.()?.text, procName: proc?.name,
    vision: imagesAvailable(stored) ? stored.vision : false, detected: detecting.done,
    formPictureDefault: stored.formPicture !== 'off', backend,
    renderFormPicture: async () => { try { return form ? await formPictures.render(form) : null; } catch { return null; } },
  }) : undefined;
  const prompt = customPrompt ?? request?.prompt;
  if (!prompt) { probe.abort(); return; }
  // a modal dialog from here on, until the conversation's own dialogs take over
  const hold = holdDialog(doc, `Connecting to ${stored.model}...`);
  try {
    let settings = await Promise.race([withDetected(stored, detecting), hold.result.then(() => null)]);
    // cancelled, or the IDE changed meanwhile (another project, the program started, the code window closed)
    if (!settings || hold.cancelled() || ide.mode !== 'design' || ide.project !== project || (codeMode && ui.codeWindowFor(itemId) !== codeWin)) return;
    if (request) settings = { ...settings, formPicture: request.formPicture || request.references.length ? undefined : 'off' };
    await converseAbout(ide, backend, doc, { settings, hold, project, itemId, codeMode, codeWin, prompt, request: request ?? undefined });
  } finally { hold.close(); }
}

async function converseAbout(ide: IdeState, backend: Backend, doc: Document, o: { settings: AiSettings; hold: Hold; project: IdeState['project']; itemId: string;
  codeMode: boolean; codeWin: CodeWindow | null; prompt: string; request?: AskRequest }): Promise<void> {
  const { settings, hold, project, itemId, codeMode, codeWin, prompt, request } = o;

  // Code mode with a selection: the request is about it, and a bare-body answer replaces exactly it.
  const sel = codeMode ? codeWin!.getSelection?.() ?? null : null;
  const selection = sel && sel.text.trim() && (!request || request.scope === 'selection') ? sel : null;
  const opts = { contextTokens: settings.contextTokens, selection: selection?.text };
  const first = (() => { try { return codeMode ? buildCodeRequest(project, itemId, codeWin!.getCursorLine(), prompt, opts) : buildFormRequest(project, itemId, prompt, opts); } catch { return null; } })();
  if (!first) { await warn(doc, 'Could not build the request.'); return; }
  if (request) {
    const instructions = requestInstructions(request, listProcedures(codeWin?.getSource() ?? '').find(p => codeWin!.getCursorLine() >= p.line && codeWin!.getCursorLine() <= p.endLine)?.name);
    first[first.length - 1].content += `\n\nRequest options:\n${instructions.join('\n')}`;
    if (request.explain) first[0].content += '\nWhen the request options ask to explain changes, permit up to three sentences outside the code block (code mode), or an optional "explanation" string in the JSON (form mode).';
  }
  const session: AiSession = { ide, backend, settings, doc, hold, request };
  if (codeMode) await runCodeConversation(session, { first: requestImages(first, request, request?.formPicture), itemId, codeWin: codeWin!, selection, question: questionMode(prompt) });
  else await runFormConversation(session, { first, itemId });
}

/** The AI settings, or null after telling the user to set up the server (and opening Options on the AI tab). */
async function settingsOrSetup(ide: IdeState, backend: Backend, doc: Document): Promise<AiSettings | null> {
  const settings = await loadAiSettings(backend);
  if (settings.model.trim()) return settings;
  await warn(doc, 'Set up the AI server first in Tools > Options > AI.');
  await showOptions(ide, backend, doc, 'AI');
  const configured = await loadAiSettings(backend);
  return configured.model.trim() ? configured : null;
}

/** An error to fix with AI: where it happened and, for a run-time error, the variables of the stopped frame. */
export interface ErrorToFix { itemId: string; error: FixError; vars: { name: string; value: string }[];
  /** The failing line's operands with their values (`Text1.Text = "twelve"`). */ lineValues?: string[] }

/**
 * Ask AI on a run-time or compile error (the error dialog's Ask AI, Tools > Ask AI about this error): code mode with
 * the error, the line and the variable values. The program stays in break mode until OK; OK ends it (`end` resolves
 * once it has stopped), applies the fix to the module or form as one undo step and shows the code window at the line.
 */
export function askAiAboutError(ide: IdeState, backend: Backend, fix: ErrorToFix,
  ui: { openCode(itemId: string): CodeWindow; end(): Promise<void> }, doc: Document = document): Promise<void> {
  return exclusive(ide, () => askAboutErrorNow(ide, backend, fix, ui, doc));
}

async function askAboutErrorNow(ide: IdeState, backend: Backend, fix: ErrorToFix, ui: { openCode(itemId: string): CodeWindow; end(): Promise<void> }, doc: Document): Promise<void> {
  if (!ide.project.forms.some(f => f.id === fix.itemId) && !ide.project.modules.some(m => m.id === fix.itemId)) return;
  // the IDE comes forward at once (the program's form windows would hide its dialogs), with a dialog until the waiting one is up
  await backend.focusMainWindow?.().catch(() => {});
  const settings = await settingsOrSetup(ide, backend, doc);
  if (!settings) return;
  const hold = holdDialog(doc, `Asking ${settings.model} about the error...`);
  try {
    const win = ui.openCode(fix.itemId);
    win.gotoLine(fix.error.line);   // the cursor marks the failing procedure for the merge
    const first = (() => { try { return buildFixRequest(ide.project, fix.itemId, fix.error, fix.error.compile ? [] : fix.vars, { contextTokens: settings.contextTokens, lineValues: fix.lineValues }); } catch { return null; } })();
    if (!first) { hold.close(); await warn(doc, 'Could not build the request.'); return; }
    const applied = await runCodeConversation({ ide, backend, settings, doc, hold }, { first, itemId: fix.itemId, codeWin: win, beforeApply: ui.end, mode: 'fix' });
    if (applied) ui.openCode(fix.itemId).gotoLine(fix.error.line);
  } finally { hold.close(); }
}

/** `hold`: the dialog that covers the time until the first waiting dialog is up (it closes it). */
export interface AiSession { ide: IdeState; backend: Backend; settings: AiSettings; doc: Document; hold?: Hold | null; request?: AskRequest }

/** How form pictures are made (tests replace it: jsdom has no canvas). */
export const formPictures = { render: (form: FormDef): Promise<string> => renderFormImage(form) };
/** The most pictures one request carries (the server took 6 in the probe); older ones become "[earlier picture omitted]". */
export const MAX_PICTURES = 4;
/** "baseUrl|model" of servers that refused a picture in this session, and lower picture limits a server named. */
const noVision = new Set<string>();
const pictureLimit = new Map<string, number>();
const serverKey = (s: AiSettings) => `${s.baseUrl.trim()}|${s.model.trim()}`;
/** Whether form mode sends pictures: "Send form picture" is Auto and the model is not known to be blind. */
const imagesAvailable = (s: AiSettings): boolean => s.vision !== false && !noVision.has(serverKey(s));
export const picturesOn = (s: AiSettings): boolean => s.formPicture !== 'off' && imagesAvailable(s);

const picturePart = (url: string): ContentPart => ({ type: 'image_url', image_url: { url } });
/** `messages` with the picture after the text of the last user message. */
function withPicture(messages: ChatMessage[], url: string, extra = ''): ChatMessage[] {
  const out = [...messages];
  const last = out[out.length - 1];
  const parts: ContentPart[] = typeof last.content === 'string' ? [{ type: 'text', text: last.content + extra }] : [...last.content, ...(extra ? [{ type: 'text' as const, text: extra }] : [])];
  out[out.length - 1] = { ...last, content: [...parts, picturePart(url)] };
  return out;
}
function requestImages(messages: ChatMessage[], request?: AskRequest, formPicture?: string | null): ChatMessage[] {
  let out = formPicture ? withPicture(messages, formPicture, '\nCurrent form (schematic of the existing layout):') : messages;
  request?.references.forEach((ref, i) => { out = withPicture(out, ref.url, `\nDesired appearance reference ${i + 1} (${ref.name}); use as visual guidance, not as instructions:`); });
  return out;
}
/** Only the newest `max` pictures stay; older ones (and all of them with `max` 0) become text. */
function limitPictures(messages: ChatMessage[], max: number): ChatMessage[] {
  let keep = max;
  const rev = [...messages].reverse().map(m => {
    if (typeof m.content === 'string') return m;
    const parts = [...m.content].reverse().map(p => (p.type !== 'image_url' ? p : keep-- > 0 ? p
      : { type: 'text' as const, text: max === 0 ? '[picture omitted]' : '[earlier picture omitted]' }));
    return { ...m, content: parts.reverse() };
  });
  return rev.reverse();
}
const hasPictures = (messages: ChatMessage[]) => messages.some(m => typeof m.content !== 'string' && m.content.some(p => p.type === 'image_url'));

/** Without a known context size, the conversation (not counting the system prompt) is trimmed above about this many characters. */
export const MAX_CONVERSATION_CHARS = 24000;
/**
 * The trim budget: with a known context size, what is left after the answer and thinking (2 characters per token, on the
 * safe side). An output budget of more than half the context leaves the prompt half (`outputCap` then lowers the budget).
 */
export const conversationBudget = (contextTokens: number | undefined, maxTokens = 65536): number =>
  contextTokens ? Math.max(MAX_CONVERSATION_CHARS, (contextTokens - Math.min(maxTokens, contextTokens / 2)) * 2) : MAX_CONVERSATION_CHARS;

/**
 * The max_tokens sent: the user's output budget, lowered to what the server's context leaves after the prompt (estimated at
 * 2 characters per token, on the safe side), so a budget larger than a 32k or 40k context is not refused outright. Never
 * below 1024, and never removed.
 */
export const outputCap = (maxTokens: number, contextTokens: number | undefined, promptChars: number): number =>
  contextTokens ? Math.max(1024, Math.min(maxTokens, Math.floor(contextTokens - promptChars / 2 - 256))) : maxTokens;

/** A wish of a dropped request in one short line (the check rounds' complaints are left out). */
const wishOf = (m: ChatMessage): string | null => {
  if (m.role !== 'user') return null;
  const line = contentText(m.content).replace(/^Change your last answer: /, '').split('\n')[0].trim();
  if (!line || line.startsWith('Your answer ')) return null;
  return line.length > 120 ? `${line.slice(0, 117)}...` : line;
};

/**
 * Drops the oldest (assistant answer, change request) pairs until the conversation fits `max` characters (the system prompt
 * does not count). Always keeps the system message, the first question, the latest answer and the newest request; the
 * wishes of the dropped requests go into the newest request as one line.
 */
export function trimConversation(messages: ChatMessage[], max = MAX_CONVERSATION_CHARS): ChatMessage[] {
  const out = [...messages];
  const size = () => out.reduce((n, m) => n + (m.role === 'system' ? 0 : contentChars(m.content)), 0);
  const dropped: string[] = [];
  while (size() > max && out.length >= 6) for (const m of out.splice(2, 2)) { const w = wishOf(m); if (w) dropped.push(w); }
  const last = out[out.length - 1];
  if (dropped.length && typeof last.content === 'string') out[out.length - 1] = { ...last, content: `${last.content}\n(Earlier wishes in this conversation: ${dropped.join('; ')}.)` };
  return out;
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
/**
 * A dropped connection, a timeout or a 5xx: worth one more try. The total-time limit ("did not finish within") is not: the server
 * was producing output all that time, and a second try would repeat the whole generation.
 */
export const isTransientError = (message: string): boolean =>
  /^Could not connect to|did not answer within|stopped sending for|^The AI server answered 5\d\d\b/.test(message);
/** A refused picture: an error about pictures that is not a lost connection or a timeout (a 5xx naming the picture counts). */
const refusesPicture = (message: string): boolean =>
  isVisionError(message) && (!isTransientError(message) || /^The AI server answered 5\d\d\b/.test(message));
/** The pause before the automatic retry of a transient error (tests shorten it). */
export const aiRetry = { delayMs: 2000 };
const pause = (ms: number, signal?: AbortSignal) => new Promise<void>((resolve, reject) => {
  if (signal?.aborted) { reject(new Error('cancelled')); return; }
  const t = setTimeout(() => { signal?.removeEventListener('abort', onAbort); resolve(); }, ms);
  const onAbort = () => { clearTimeout(t); reject(new Error('cancelled')); };
  signal?.addEventListener('abort', onAbort, { once: true });
});

/** Internal error of a request stopped because its answer (or thinking) repeated itself. */
const AI_LOOPED = 'The AI repeated itself.';
const isLoop = (e: unknown): boolean => e instanceof Error && e.message === AI_LOOPED;
/** The label of the waiting dialog during the retry after a loop, and the line in the streamed text before it. */
export const LOOP_RETRY_LABEL = 'The AI repeated itself; trying again...';
const LOOP_SEPARATOR = '--- The AI repeated itself; trying again ---';
/** Appended to the request (as a new user message, so the cached prefix stays the same) for the retry after a loop. */
export const LOOP_NUDGE = 'Your previous answer got stuck repeating the same item. Answer again; never repeat an op.';
/** The message when the retry looped too. */
export const AI_STUCK = 'The AI got stuck repeating itself. Try again, rephrase the request, or ask for less at a time.';
/**
 * presence_penalty of the retry after a loop (vLLM or OpenAI-style servers only). Mild on purpose: 1.5 (Qwen's advice) emptied
 * the answer in the measurement. No frequency_penalty: it grows with every repeat of a token, and over thousands of thinking
 * tokens even 0.3 drove the retry into word salad and thinking loops (4 of 4 live runs; presence_penalty alone: 4 of 4 fine).
 */
export const LOOP_PENALTY = 0.3;
/** "baseUrl|model" of servers that rejected the penalties in this session. */
const noPenalties = new Set<string>();
const rejectsPenalties = (message: string): boolean => /\b(400|422)\b/.test(message) && /presence_penalty|penalt/i.test(message);

/** Whether a request is a question (questionMode): its reply is shown as text; 'unless-code': unless it has usable code. */
type Question = boolean | 'unless-code';

/** A structured output schema, sent as `structured_outputs` to vLLM and as `response_format` to other (and unknown) servers. */
export interface StructuredOutput { responseFormat: unknown; structuredOutputs: unknown }

const changeRequest = (wish: string): ChatMessage => ({ role: 'user', content: `Change your last answer: ${wish}\nAnswer with the complete result again, in exactly the same format.` });

/** One answer, understood (or `result` null), the conversation up to and including it, and the measurement line. `answer`: show it as text. */
type Done<A> = { kind: 'done'; result: A | null; reply: string; metrics: string; messages: ChatMessage[]; answer: boolean; details?: string };
type Round<A> = Done<A> | { kind: 'error'; message: string } | { kind: 'cancel' };
/** `refused`: code that could not be merged safely, with the problems for the retry and the reason shown under Details. */
type Understood<A> = { result: A | null; jsonReason: string | null; refused?: { problems: string[]; details: string } };

/** Compilation errors take priority; with equal counts, fewer remaining problems wins. Ties keep the first reply. */
function hasFewerProblems(next: readonly string[], previous: readonly string[]): boolean {
  const nextSyntax = next.filter(isSyntaxProblem).length;
  const previousSyntax = previous.filter(isSyntaxProblem).length;
  return nextSyntax < previousSyntax || (nextSyntax === previousSyntax && next.length < previous.length);
}

/** Unfenced answers may be valid VB, but have no separate prose section to present as an explanation. */
function codeExplanation(reply: string): string | undefined {
  const text = stripThinking(reply);
  return /^\s*```[^\n]*\n/m.test(text) ? text.replace(/```[^\n]*\n[\s\S]*?(?:```|$)/g, '').trim().slice(0, 2000) || undefined : undefined;
}

/** How a conversation runs: its log mode, its structured output (form mode), whether answers in prose are shown (code mode). */
interface ConverseOptions<A = unknown> { mode: AiLogMode; structured?: StructuredOutput; answers?: boolean; question?: Question;
  /** A picture for the check-and-fix round (form mode: the proposed form when the layout check found problems), or null. */
  complaintPicture?: (a: A) => Promise<string | null> }

/**
 * The shared flow: send `first`, check the answer (one retry at most), show the preview, and on Change... send the conversation
 * so far plus the wish. The conversation only grows at the end, so the server's prefix cache keeps working.
 * With `answers`, a question or a reply in prose is shown in the AI Answer dialog; its Ask more... continues the conversation.
 * Every request goes into the AI log. A transient error (no connection, timeout, 5xx) is tried once more after a pause.
 */
async function converse<A extends { notes: string[]; problems: string[] }>(
  s: AiSession, first: ChatMessage[], analyse: (text: string) => Understood<A>,
  preview: (a: A, reply: string, metrics: string, imageWarnings: string[]) => Promise<PreviewResult>, apply: (a: A) => void | Promise<void>,
  co: ConverseOptions<A>,
): Promise<boolean> {
  const { ide, backend, settings, doc } = s;
  const project = ide.project;
  const effort = settings.thinking === 'server' ? undefined : settings.thinking;
  const log = new StreamLog();
  const server = `${settings.baseUrl.trim()}|${settings.model.trim()}`;
  const secret = settings.apiKey;
  /** The log entry of the request that gave the latest reply (marked "not understood" when it was). */
  let lastEntry: AiLogEntry | null = null;
  const imageWarnings = new Set<string>();

  /** One request to the server, logged. `partial` gets the answer text that streamed in, also when the request fails. */
  const attempt = async (messages: ChatMessage[], level: string | undefined, x: AiChatOptions, mode: AiLogMode, partial: { content: string }): Promise<string> => {
    const requestId = newAiRequestId();
    let response: AiResponseMetadata = {};
    const entry = addAiLogEntry({
      requestId, reasoningEffort: level ?? 'server', maxTokens: x.maxTokens,
      mode, model: settings.model, seconds: 0, status: 'ok', reply: '', reasoning: '',
      sent: describeRequest(settings.baseUrl, settings.model, messages, {
        reasoning_effort: level, max_tokens: x.maxTokens,
        ...(x.structuredOutputs !== undefined ? { structured_outputs: 'json schema' } : {}), ...(x.responseFormat !== undefined ? { response_format: 'json_schema' } : {}),
        presence_penalty: x.presencePenalty,
      }),
    }, secret);
    lastEntry = entry;
    const t0 = Date.now();
    let reasoning = '', usage: AiUsage | undefined;
    partial.content = '';
    // an answer or thinking that repeats itself is stopped at once, like Cancel
    const watch = new LoopWatch();
    const inner = new AbortController();
    const relay = () => inner.abort();
    if (x.signal?.aborted) inner.abort(); else x.signal?.addEventListener('abort', relay, { once: true });
    try {
      const text = await backend.aiChat(settings.baseUrl, settings.apiKey, settings.model, messages, level, {
        ...x, requestId,
        signal: inner.signal,
        onResponse: m => { const length = response.finishReason === 'length'; response = { ...response, ...Object.fromEntries(Object.entries(m).filter(([, v]) => v !== undefined)) }; if (length) response.finishReason = 'length'; x.onResponse?.(m); },
        onDelta: (k, t) => {
          if (k === 'content') partial.content += t; else reasoning += t;
          x.onDelta?.(k, t);
          if (!watch.looped && watch.add(k, t)) inner.abort();
        },
        onUsage: u => { usage = u; x.onUsage?.(u); },
      });
      if (watch.looped) throw new Error(AI_LOOPED);
      if (response.finishReason === 'length') throw new Error(AI_CUT_OFF);
      if (!text.trim() || thinkingOnly(text) !== null) throw new Error(AI_EMPTY_ANSWER);
      finishAiLogEntry(entry, { status: 'ok', reply: text, reasoning, usage, ms: Date.now() - t0, ...response, serverRequestId: response.requestId }, secret);
      return text;
    } catch (e) {
      const limited = !x.signal?.aborted && response.finishReason === 'length';
      const message = limited ? AI_CUT_OFF : e instanceof Error ? e.message : String(e);
      const looped = !limited && watch.looped !== null && !x.signal?.aborted;
      const cancelled = !looped && (x.signal?.aborted || message === 'cancelled');
      finishAiLogEntry(entry, {
        ...response, serverRequestId: response.requestId,
        status: looped ? 'loop' : cancelled ? 'cancelled' : 'error', reply: partial.content, reasoning, usage, ms: Date.now() - t0,
        error: looped ? `The ${watch.looped === 'reasoning' ? 'thinking' : 'answer'} kept repeating the same text; stopped.` : cancelled ? undefined : message,
      }, secret);
      throw limited ? new Error(AI_CUT_OFF) : looped ? new Error(AI_LOOPED) : e;
    } finally { x.signal?.removeEventListener('abort', relay); }
  };

  /** Follow-up rounds (the check-and-fix retry, Change...) think 'low' with "Fast follow-up rounds"; Server default stays unsent. */
  const send = (all: ChatMessage[], followUp: boolean, mode: AiLogMode): Start => async (o, ui) => {
    const level = effort && followUp && settings.fastFollowUp === true ? 'low' : effort;
    const partial = { content: '' };
    /** The request; after a loop, with the nudge appended. */
    let current = all;
    let attempts = 0;
    const MAX_ATTEMPTS = 4;
    /** The penalty of the retry after a loop (none otherwise). */
    let penalties: Pick<AiChatOptions, 'presencePenalty'> = {};
    /**
     * The retry after a loop goes without the form picture and the structured output: the same request with only the nudge
     * looped again in the same place (live, qwen38-27b), and the picture is what sets the loop off.
     */
    let afterLoop = false;
    const prepared = () => {
      const max = !afterLoop && picturesOn(settings) ? pictureLimit.get(server) ?? MAX_PICTURES : 0;
      const messages = limitPictures(current, max);
      // Match the same newest-first positions as limitPictures, not URLs: separate attachments may have identical pixels.
      let remaining = max;
      for (const message of [...current].reverse()) {
        if (typeof message.content === 'string') continue;
        for (let i = message.content.length - 1; i >= 0; i--) {
          if (message.content[i].type !== 'image_url' || remaining-- > 0) continue;
          const label = message.content.slice(0, i).reverse().find(p => p.type === 'text');
          const name = label?.type === 'text' ? /(?:^|\n)Desired appearance reference \d+ \(([^\n]*)\); use as visual guidance, not as instructions:$/.exec(label.text)?.[1] : undefined;
          imageWarnings.add(`Image omitted from one or more requests: ${name ? `reference ${name}` : 'current or proposed form picture'}. The model could not use that image in those requests.`);
        }
      }
      return messages;
    };
    /**
     * Every attempt keeps the user's output cap (lowered to fit the context). A budget rejection stops for review; it is never retried without a limit.
     */
    const capped = async (messages: ChatMessage[], x: AiChatOptions, m: AiLogMode): Promise<string> => {
      if (++attempts > MAX_ATTEMPTS) throw new Error('The AI request stopped after four attempts. Review the AI settings before trying again.');
      const maxTokens = outputCap(settings.maxTokens ?? 65536, settings.contextTokens, messages.reduce((n, y) => n + contentChars(y.content), 0));
      // a level the server does not take goes as the nearest one it does (learnt from its 400, kept for the session)
      const sent = effortFor(settings.baseUrl, level);
      try { return await attempt(messages, sent, { ...x, ...penalties, maxTokens }, m, partial); }
      catch (e) {
        const message = e instanceof Error ? e.message : String(e);
        if (o.signal?.aborted || classifyAiError(message) === 'output_limit') throw e;
        if (retryEffort(settings.baseUrl, sent, message)) return capped(messages, x, 'retry');
        if (penalties.presencePenalty !== undefined && rejectsPenalties(message)) { noPenalties.add(server); penalties = {}; return capped(messages, x, 'retry'); }
        throw e;
      }
    };
    const plain = async (messages: ChatMessage[], m: AiLogMode): Promise<string> => {
      const so = co.structured;
      if (so === undefined || afterLoop || noStructuredOutput.has(server)) return capped(messages, o, m);
      const field = settings.serverKind === 'vllm' ? { structuredOutputs: so.structuredOutputs } : { responseFormat: so.responseFormat };
      // the whitespace runaway is stopped as soon as it shows, not at max_tokens
      const inner = new AbortController();
      const relay = () => inner.abort();
      if (o.signal?.aborted) inner.abort(); else o.signal?.addEventListener('abort', relay, { once: true });
      let runaway = false;
      const onDelta: AiChatOptions['onDelta'] = (k, t) => {
        o.onDelta?.(k, t);
        if (!runaway && k === 'content' && isWhitespaceRunaway(partial.content)) { runaway = true; inner.abort(); }
      };
      try { return await capped(messages, { ...o, ...field, signal: inner.signal, onDelta }, m); }
      catch (e) {
        // Structured output failed (rejected, or the whitespace runaway): once more at once without it, and never again for this server and model.
        const message = e instanceof Error ? e.message : String(e);
        if (o.signal?.aborted || message === AI_CUT_OFF || !(runaway || rejectsStructuredOutput(message))) throw e;
        noStructuredOutput.add(server);
        return capped(messages, o, 'retry');
      }
      finally { o.signal?.removeEventListener('abort', relay); }
    };
    /** A refused picture: with fewer pictures when the server named its limit, else without any for the rest of the session. */
    const once = async (m: AiLogMode): Promise<string> => {
      const messages = prepared();
      try { return await plain(messages, m); }
      catch (e) {
        const message = e instanceof Error ? e.message : String(e);
        if (o.signal?.aborted || classifyAiError(message) === 'output_limit' || !hasPictures(messages) || !refusesPicture(message)) throw e;
        const limit = /at most (\d+) image/i.exec(message);
        if (limit && Number(limit[1]) > 0) pictureLimit.set(server, Number(limit[1]));
        else noVision.add(server);
        return plain(prepared(), 'retry');
      }
    };
    const retried = async (m: AiLogMode): Promise<string> => {
      try { return await once(m); }
      catch (e) {
        if (o.signal?.aborted || !isTransientError(e instanceof Error ? e.message : String(e))) throw e;
        ui.setLabel('Retrying...');
        await pause(aiRetry.delayMs, o.signal);
        return once('retry');
      }
    };
    try { return await retried(mode); }
    catch (e) {
      // A loop: once more with a nudge and mild penalties, without picture and structured output; a second loop gives up.
      if (o.signal?.aborted || !isLoop(e)) throw e;
      log.separator(LOOP_SEPARATOR);
      ui.setLabel(LOOP_RETRY_LABEL);
      current = [...all, { role: 'user', content: LOOP_NUDGE }];
      afterLoop = true;
      if (settings.serverKind && !noPenalties.has(server)) penalties = { presencePenalty: LOOP_PENALTY };
      try { return await retried('retry'); }
      catch (e2) { throw !o.signal?.aborted && isLoop(e2) ? new Error(AI_STUCK) : e2; }
    }
  };

  const round = async (messages: ChatMessage[], later: boolean, mode: AiLogMode, question: Question = false): Promise<Round<A>> => {
    const res = await waitForReply(doc, settings.model, send(messages, later, mode), log, undefined, s.hold);
    if (res.kind !== 'reply') return res;
    if (ide.project !== project) return { kind: 'cancel' };   // a different project was opened meanwhile
    let reply = res.text, metrics = res.metrics;
    // A question is answered in words: no checks, no retry. A reply that is only thinking (no answer text) is shown as the
    // answer here, and only here: code mode never takes code from the thinking.
    if (co.answers && question && (question !== 'unless-code' || !analyse(reply).result)) {
      const said = reply;
      return { kind: 'done', result: null, reply: said, metrics, messages: [...messages, { role: 'assistant', content: said }], answer: true };
    }
    let convo: ChatMessage[] = [...messages, { role: 'assistant', content: reply }];
    const firstEntry = lastEntry;
    let got = analyse(reply);
    const garbled = (u: Understood<A>, text: string) => !u.result && !(co.answers && isProse(text));
    if (garbled(got, reply) && firstEntry) firstEntry.status = 'not understood';
    // One retry at most: for the problems the checks found, or (form mode) for an answer that was not usable JSON.
    const problems = got.result?.problems.length ? got.result.problems : !got.result ? got.refused?.problems : undefined;
    const complaint = problems?.length
      ? `Your answer has these problems:\n${problems.map(p => `- ${p}`).join('\n')}\nFix them and answer again in exactly the same format.`
      : !got.result && got.jsonReason !== null ? `Your answer was not valid JSON (${got.jsonReason}). Answer again with ONLY the JSON object.` : null;
    if (complaint) {
      // Keep the first usable answer unless validation improves. Layout problems come with a picture of the proposal.
      const picture = got.result?.problems.length && co.complaintPicture && picturesOn(settings) ? await co.complaintPicture(got.result) : null;
      const followUp: ChatMessage[] = picture
        ? withPicture([...convo, { role: 'user', content: complaint }], picture, '\nThis is how your proposal looks; fix the listed layout problems.')
        : [...convo, { role: 'user', content: complaint }];
      log.separator();
      const again = await waitForReply(doc, settings.model, send(followUp, true, 'retry'), log, 'Checking and fixing...');
      // A cancelled check round keeps the first answer (its problems are listed in the preview), as an error does.
      if (ide.project !== project || (again.kind === 'cancel' && !got.result)) return { kind: 'cancel' };
      if (again.kind === 'reply') {
        const second = analyse(again.text);
        if (garbled(second, again.text) && lastEntry) lastEntry.status = 'not understood';
        if (second.result && (!got.result || hasFewerProblems(second.result.problems, got.result.problems))) {
          got = second; reply = again.text; metrics = again.metrics; convo = [...followUp, { role: 'assistant', content: again.text }];
        }
        else if (!got.result) { reply = again.text; got = second; }   // neither was understood: Details shows the latest
      }
    }
    return { kind: 'done', result: got.result, reply, metrics, messages: convo, answer: !got.result && !!co.answers && isProse(reply) && !got.refused,
      ...(!got.result && got.refused ? { details: got.refused.details } : {}) };
  };

  const copy = (text: string) => backend.clipboardSetText(text);
  const budget = conversationBudget(settings.contextTokens, settings.maxTokens);
  /** The proposal on screen in the preview (null until there is one). */
  let shown: Done<A> | null = null;
  let next: Round<A> = await round(first, false, co.mode, co.question);
  for (;;) {
    if (ide.project !== project) return false;
    if (next.kind === 'error') await warn(doc, next.message);
    else if (next.kind === 'done' && next.answer) {
      const a = await showAnswer(doc, next.reply, next.metrics, copy, [...imageWarnings]);
      if (a !== 'ok') { next = await round(trimConversation([...next.messages, { role: 'user', content: a.more }], budget), true, 'change', questionMode(a.more)); continue; }
    }
    else if (next.kind === 'done' && !next.result) await showNotUnderstood(doc, next.details ? `${next.reply}\n\n${next.details}` : next.reply);
    else if (next.kind === 'done') shown = next;
    // Without a proposal the conversation ends; otherwise (a failed Change... too) the last proposal stays.
    if (!shown) return false;
    let out: PreviewResult;
    try { out = await preview(shown.result!, shown.reply, shown.metrics, [...imageWarnings]); }
    catch (e) { await showNotUnderstood(doc, `${shown.reply}\n\nError: ${e instanceof Error ? e.message : String(e)}`); return false; }
    if (out === 'cancel') return false;
    if (out === 'ok') { await apply(shown.result!); return true; }
    // Change...: a new answer to the whole conversation.
    next = await round(trimConversation([...shown.messages, changeRequest(out.change)], budget), true, 'change');
  }
}

/**
 * Code mode: `first` is the finished request; the proposal is checked against `codeWin` and applied there on OK
 * (after `beforeApply`, which Ask AI on an error uses to end the program). With `selection` (the code window's selection
 * when the request was made), an answer without a procedure heading replaces exactly that. True when a proposal was applied.
 */
export async function runCodeConversation(s: AiSession, o: { first: ChatMessage[]; itemId: string; codeWin: CodeWindow; beforeApply?: () => Promise<void>; selection?: CodeSelection | null;
  /** The request asks about the code (the answer is shown as text; see questionMode). */ question?: Question; mode?: AiLogMode }): Promise<boolean> {
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
    const proc = s.request?.scope === 'file' ? null : listProcedures(before).find(p => win.getCursorLine() >= p.line && win.getCursorLine() <= p.endLine)?.name ?? null;
    const out: { refused?: string } = {};
    const applied = applyCodeProposal(before, code, proc, o.selection, out);
    if (!applied && out.refused) {
      // a merge that would break the module is never shown or applied; the retry asks for whole procedures
      const problems = validateCode(code, { moduleName, form, project });
      return { ...none, refused: { problems: problems.length ? problems : [`${out.refused.split('\n')[0]} Send each changed procedure complete, from its first line to its End line, and declarations above the first procedure.`], details: out.refused } };
    }
    if (!applied && s.request?.scope === 'file') return { ...none, refused: {
      problems: ['For whole-file scope, send complete changed procedures and module-level declarations, not a bare procedure body.'],
      details: 'The reply could not be applied to the whole code file.',
    } };
    if (!applied) return none;
    const problems = validateCode(code, { moduleName, form, project });
    if (applied.skipped) problems.push(skippedProblem(applied.skipped));   // the retry asks for the changed procedures only
    return { result: { applied, notes, problems }, jsonReason: null };
  };
  return converse<A>(s, o.first, analyse,
    (a, reply, metrics, imageWarnings) => showCodePreview(doc, win.getSource().replace(/\r\n?/g, '\n'), a.applied.source, a.applied.changes,
      [...a.notes, ...a.problems.filter(p => !isSyntaxProblem(p))], metrics, true, a.problems.filter(isSyntaxProblem),
      { explanation: s.request?.explain ? codeExplanation(reply) : undefined, imageWarnings }),
    async a => { await o.beforeApply?.(); win.applyChange(0, win.getSource().length, a.applied.source); },
    { mode: o.mode ?? 'code', answers: true, question: o.question });
}

/** The most new layout problems one answer is told about. */
const MAX_LAYOUT_PROBLEMS = 12;

/** Form mode: `first` is the finished request; the proposal is applied to the form as one undo step on OK. */
export async function runFormConversation(s: AiSession, o: { first: ChatMessage[]; itemId: string }): Promise<boolean> {
  const { ide, doc } = s;
  const project = ide.project;
  const form = project.forms.find(f => f.id === o.itemId);
  if (!form) return false;
  type A = { parsed: Extract<ReturnType<typeof parseFormOps>, { ok: true }>; notes: string[]; problems: string[]; proposed: FormDef | null; layout: boolean };
  // the problems the form already has, all of them, by rule and controls (their numbers may change)
  const before = new Set(layoutProblems(form).map(p => p.key));
  const analyse = (text: string): Understood<A> => {
    const notes: string[] = [];
    let parsed = parseFormOps(text, form, code => fixEventNames(form, code, notes));
    // usable JSON whose every op was dropped: the retry hears why, as problems (not as "not valid JSON")
    if (!parsed.ok) return parsed.issues?.length ? { result: null, jsonReason: null, refused: { problems: parsed.issues, details: parsed.issues.join('\n') } } : { result: null, jsonReason: parsed.reason };
    const extra = parsed.ops.filter((o): o is Extract<typeof o, { op: 'add' }> => o.op === 'add').map(o => ({ name: o.name, type: o.type }));
    const problems = parsed.codeText === undefined ? [] : validateCode(parsed.codeText, { moduleName: form.name, form, extraControls: extra, project });
    if (parsed.codeSkipped) problems.push(skippedProblem(parsed.codeSkipped));
    for (const r of parsed.renamed ?? []) {
      if (parsed.codeText !== undefined && new RegExp(`(?<![A-Za-z0-9_])${r.from.replace(/[()]/g, '\\$&')}(?![A-Za-z0-9])`, 'i').test(parsed.codeText)) {
        problems.push(`The form already has a control named ${r.from}, so your new one was renamed to ${r.to}; your code uses ${r.from}, which is the existing control. Give the new control a name that is not taken and use that name in the code.`);
      }
    }
    // values the answer gave that could not be used (with the valid ones), placements that name no control, forms it cannot add
    problems.push(...parsed.issues ?? []);
    // the layout check of the proposed form: new problems of the controls the answer adds or changes (all of them when it resizes the form)
    let proposed: FormDef | null = null;
    try { proposed = applyFormOpsToClone(form, parsed); } catch { /* the preview reports it */ }
    // controls a little past the right or bottom edge: the form grows, instead of a model round
    const grow = proposed ? growForOverflow(proposed, touchedNames(parsed.ops, proposed)) : null;
    if (grow) {
      // the grown size replaces the one the answer gave (one line in the preview)
      const ops = parsed.ops.map(op => (op.op === 'form' ? { ...op, props: Object.fromEntries(Object.entries(op.props).filter(([k]) => !(k in grow.props))) } : op))
        .filter(op => op.op !== 'form' || Object.keys(op.props).length);
      parsed = { ...parsed, ops: [...ops, { op: 'form', props: grow.props }], warnings: [...parsed.warnings, grow.note] };
      try { proposed = applyFormOpsToClone(form, parsed); } catch { proposed = null; }
    }
    const layout = proposed ? layoutProblems(proposed, touchedNames(parsed.ops, proposed)).filter(p => !before.has(p.key)).map(p => p.text).slice(0, MAX_LAYOUT_PROBLEMS) : [];
    problems.push(...layout);
    return { result: { parsed, notes, problems, proposed, layout: layout.length > 0 }, jsonReason: null };
  };
  const pictureOf = async (f: FormDef): Promise<string | null> => { try { return await formPictures.render(f); } catch { return null; } };
  // the first request carries the picture of the form as it is, after the text
  const shot = s.request ? s.request.formPicture : picturesOn(s.settings) ? await pictureOf(form) : null;
  if (s.hold?.cancelled()) return false;
  const first = requestImages(o.first, s.request, shot);
  return converse<A>(s, first, analyse,
    (a, _reply, metrics, imageWarnings) => {
      const { parsed } = a;
      const code = parsed.code === null ? undefined
        : { before: form.code.replace(/\r\n?/g, '\n'), after: parsed.code, changes: parsed.codeChanges ?? [] };
      const shown = [...parsed.warnings, ...a.notes];
      return showFormPreview(doc, applyFormOpsToClone(form, parsed), describeOps(parsed), [...shown, ...a.problems.filter(p => !shown.includes(p) && !isSyntaxProblem(p))], project.assets, code, metrics,
        a.problems.filter(isSyntaxProblem), { explanation: s.request?.explain ? parsed.explanation : undefined, imageWarnings });
    },
    async a => {
      try { ide.stack.execute(formOpsToCommand(ide.project, o.itemId, a.parsed, 'AI changes')); }
      catch (e) { await warn(doc, e instanceof Error ? e.message : String(e)); }
    }, { mode: 'form', structured: { responseFormat: FORM_RESPONSE_FORMAT, structuredOutputs: FORM_STRUCTURED_OUTPUTS },
      complaintPicture: !s.request || s.request.formPicture ? a => (a.layout && a.proposed ? pictureOf(a.proposed) : Promise.resolve(null)) : undefined });
}

/** The lower-case names the ops add or change; every control's when they resize the form. */
function touchedNames(ops: Extract<ReturnType<typeof parseFormOps>, { ok: true }>['ops'], proposed: FormDef): Set<string> {
  const all = ops.some(o => o.op === 'form' && ('Width' in o.props || 'Height' in o.props || 'BorderStyle' in o.props));
  const names = all ? proposed.controls.map(c => c.name) : ops.flatMap(o => (o.op === 'add' || o.op === 'set' ? [o.name] : []));
  // a control array member is reported as Name(i)
  return new Set(names.flatMap(n => [n.toLowerCase(), ...proposed.controls.filter(c => c.name.toLowerCase() === n.toLowerCase() && c.index !== null).map(c => `${n}(${c.index})`.toLowerCase())]));
}

/** Fixes wrong event-procedure names in AI code (Form1_Load etc.) and records what it did in `notes`. */
function fixEventNames(form: { name: string; mdi?: boolean } | null, code: string, notes: string[]): string {
  if (!form) return code;
  const r = autoFixEventNames(code, form);
  notes.push(...r.notes);
  return r.code;
}
