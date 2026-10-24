// Drives the real AI flows (askAi, askAiAboutError through the RunController) against the live server with the real
// BrowserBackend, records every request, and checks what would be applied: syntax, lost code, undo, and behaviour.
import { vi } from 'vitest';
import type { Backend } from '../src/backend/backend';
import { BrowserBackend } from '../src/backend/browserBackend';
import { findSyntaxErrors } from '../src/lang/parser';
import { listProcedures } from '../src/model/procedures';
import type { FormDef, Project } from '../src/model/types';
import type { AiChatOptions } from '../src/ai/sse';
import type { ChatMessage } from '../src/ai/types';
import { driver, type DialogLog } from './driver';
import { APP, RecordingHost, Rt, runtimeBackend, settle } from './runtime';
import { newLayoutProblems, type Task } from './tasks';

export interface LiveConfig { baseUrl: string; model: string; thinking: 'low' | 'medium' | 'high' | 'server' }

export interface ReqRecord {
  kind: string; effort?: string; structured: boolean; maxTokens?: number; presencePenalty?: number;
  messages: number; promptChars: number; images: number; lastUser: string;
  ms: number; promptTokens?: number; completionTokens?: number; cachedTokens?: number;
  reasoningChars: number; reasoningTail: string; content: string; error?: string;
  key?: string;
}
export interface StepRecord {
  item: string; view: string; prompt: string;
  dialogs: DialogLog;
  proposal: boolean; applied: boolean;
  before: string; after: string;
  lost: string[]; undo: 'ok' | 'failed' | 'n/a'; undoDetail?: string;
  layoutNew?: string[];
  logStatuses: string[];
  seconds: number;
}
export interface RunRecord {
  task: string; category: string; title: string; hard: boolean; gap: boolean; run: number; thinking: string;
  steps: StepRecord[]; requests: ReqRecord[];
  error?: { triggered: boolean; number?: number; description?: string };
  syntaxErrors: string[]; inspectFails: string[]; checkFails: string[] | null; answerFail?: string | null;
  success: boolean; failure: string; seconds: number; crash?: string;
  /** The project after the conversation (forms and modules), for re-checking offline (recheck.live.ts). */
  finalProject?: Project;
}

const textOf = (c: ChatMessage['content']) => (typeof c === 'string' ? c : c.map(p => (p.type === 'text' ? p.text : '[picture]')).join('\n'));
const hash = (s: string) => { let h = 0; for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) | 0; return `${s.length}:${h}`; };

/** The backend the AI flow gets: the real BrowserBackend, with every aiChat recorded. */
function recordingBackend(reqs: ReqRecord[]): Backend {
  const base = new BrowserBackend();
  const aiChat = async (baseUrl: string, apiKey: string, model: string, messages: ChatMessage[], effort?: string, opts: AiChatOptions = {}): Promise<string> => {
    const lastUser = textOf(messages[messages.length - 1].content);
    const key = hash(messages.map(m => `${m.role}:${textOf(m.content)}`).join('\u0001'));
    const structured = opts.structuredOutputs !== undefined || opts.responseFormat !== undefined;
    const prev = reqs[reqs.length - 1];
    let kind = 'first';
    if (prev) {
      if (prev.key === key) kind = prev.structured && !structured ? 'so-fallback' : prev.maxTokens && !opts.maxTokens ? 'maxtokens-fallback' : prev.presencePenalty !== undefined && opts.presencePenalty === undefined ? 'penalty-fallback' : 'repeat';
      else if (lastUser.startsWith('Your previous answer got stuck')) kind = 'loop-retry';
      else if (lastUser.startsWith('Your answer has these problems')) kind = 'check';
      else if (lastUser.startsWith('Your answer was not valid JSON')) kind = 'json-retry';
      else if (lastUser.startsWith('Change your last answer')) kind = 'change';
      else if (messages.length > 2) kind = 'ask-more';
    }
    const rec: ReqRecord = {
      kind, effort, structured, maxTokens: opts.maxTokens, presencePenalty: opts.presencePenalty,
      messages: messages.length, promptChars: messages.reduce((n, m) => n + textOf(m.content).length, 0),
      images: messages.reduce((n, m) => n + (typeof m.content === 'string' ? 0 : m.content.filter(p => p.type === 'image_url').length), 0),
      lastUser: kind === 'first' ? lastUser.slice(-2500) : lastUser.slice(0, 4000),
      ms: 0, reasoningChars: 0, reasoningTail: '', content: '', key,
    };
    reqs.push(rec);
    const t0 = Date.now();
    let content = '', reasoning = '';
    try {
      const text = await base.aiChat(baseUrl, apiKey, model, messages, effort, {
        ...opts,
        onDelta: (k, t) => { if (k === 'content') content += t; else reasoning += t; opts.onDelta?.(k, t); },
        onUsage: u => { rec.promptTokens = u.promptTokens; rec.completionTokens = u.completionTokens; rec.cachedTokens = u.cachedTokens; opts.onUsage?.(u); },
      });
      rec.content = text;
      return text;
    } catch (e) {
      rec.error = e instanceof Error ? e.message : String(e);
      rec.content = content;
      throw e;
    } finally {
      rec.ms = Date.now() - t0;
      rec.reasoningChars = reasoning.length;
      rec.reasoningTail = reasoning.slice(-1200);
    }
  };
  return new Proxy(base, {
    get(t, k) {
      if (k === 'aiChat') return aiChat;
      const v = (t as unknown as Record<string | symbol, unknown>)[k];
      return typeof v === 'function' ? (v as (...a: unknown[]) => unknown).bind(t) : v;
    },
  }) as unknown as Backend;
}

/** The app's modules, imported fresh for every conversation: the flow's per-session memory (no structured output for this
 *  server, no pictures ...) must not leak from one task into the next. */
async function fresh() {
  vi.resetModules();
  const [ask, ideState, codeWindow, runController, cm, aiLog] = await Promise.all([
    import('../src/ai/askDialog'), import('../src/ide/ideState'), import('../src/ide/codeWindow'), import('../src/ide/runController'),
    import('@codemirror/commands'), import('../src/ai/aiLog'),
  ]);
  return { ask, ideState, codeWindow, runController, cm, aiLog };
}
type Fresh = Awaited<ReturnType<typeof fresh>>;

const itemOf = (p: Project, name: string) => p.forms.find(f => f.name === name) ?? p.modules.find(m => m.name === name);
const itemById = (p: Project, id: string) => p.forms.find(f => f.id === id) ?? p.modules.find(m => m.id === id);
function cursorLine(code: string, cursor: number | string | undefined): number {
  if (typeof cursor === 'number') return cursor;
  if (typeof cursor === 'string') { const p = listProcedures(code).find(x => x.name.toLowerCase() === cursor.toLowerCase()); return p ? p.line + 1 : 1; }
  return 1;
}

/** Names the preview listed as changed ("Replace Command1_Click", "Add code: Fib", "Replace body of X"). */
function changedNames(d: DialogLog): Set<string> {
  const out = new Set<string>();
  for (const p of d.previews) for (const l of p.lines) {
    const m = /^(?:Replace selection in|Replace body of|Replace code:|Add code:|Replace|Add) (\S+)$/.exec(l.trim());
    if (m) out.add(m[1].toLowerCase());
  }
  return out;
}

/** Procedures and declarations of `before` that are gone or changed in `after` without the preview saying so. */
export function lostCode(before: string, after: string, changed: Set<string>): string[] {
  const out: string[] = [];
  const L = (s: string) => s.replace(/\r\n?/g, '\n').split('\n');
  const bl = L(before), al = L(after);
  const ap = listProcedures(after);
  for (const p of listProcedures(before)) {
    const q = ap.find(x => x.name.toLowerCase() === p.name.toLowerCase() && (x.property ?? null) === (p.property ?? null));
    if (!q) { out.push(`${p.name} removed`); continue; }
    const t1 = bl.slice(p.line - 1, p.endLine).join('\n'), t2 = al.slice(q.line - 1, q.endLine).join('\n');
    if (t1 !== t2 && !changed.has(p.name.toLowerCase())) out.push(`${p.name} changed but not listed`);
  }
  const decls = (s: string, ls: string[]) => ls.slice(0, (listProcedures(s)[0]?.line ?? ls.length + 1) - 1).map(x => x.trim()).filter(x => x && !x.startsWith("'"));
  const ad = new Set(decls(after, al).map(x => x.toLowerCase()));
  for (const d of decls(before, bl)) if (!ad.has(d.toLowerCase())) out.push(`declaration gone: ${d}`);
  return out;
}

const formJson = (f: FormDef | undefined) => JSON.stringify(f ? { props: f.props, controls: f.controls, code: f.code } : null);
function withTimeout<T>(p: Promise<T>, ms: number, what: string): Promise<T> {
  return Promise.race([p, new Promise<T>((_, rej) => setTimeout(() => rej(new Error(`${what} timed out after ${ms / 1000} s`)), ms))]);
}

function installSettings(cfg: LiveConfig): void {
  // as after Test Connection with this server; no form picture (no canvas in jsdom, see the report)
  localStorage.setItem('vibebasic.settings:ai', JSON.stringify({
    baseUrl: cfg.baseUrl, model: cfg.model, apiKey: '', thinking: cfg.thinking, contextTokens: 262144, serverKind: 'vllm', vision: true, formPicture: 'off',
  }));
}

/** One code-mode or form-mode request from the window of `step.item`, as Tools > Ask AI... does it. */
async function askStep(m: Fresh, ide: InstanceType<Fresh['ideState']['IdeState']>, step: Task['steps'][number], backend: Backend, mdi: HTMLElement): Promise<StepRecord> {
  const item = itemOf(ide.project, step.item);
  if (!item) throw new Error(`no item ${step.item}`);
  const id = item.id;
  const isForm = step.view === 'designer';
  const form = ide.project.forms.find(f => f.id === id);
  const before = item.code;
  const beforeForm = form ? structuredClone(form) : undefined;
  let win: ReturnType<Fresh['codeWindow']['openCodeWindow']> | null = null;
  if (isForm) ide.setActiveView({ kind: 'designer', formId: id });
  else {
    win = m.codeWindow.openCodeWindow(ide, id, { mdiHost: mdi });
    win.gotoLine(cursorLine(before, step.cursor));
    ide.setActiveView({ kind: 'code', itemId: id });
  }
  driver.reset(step.prompt, step.changes, step.askMore);
  m.aiLog.clearAiLog();
  const t0 = Date.now();
  await m.ask.askAi(ide, backend, { codeWindowFor: x => (x === id ? win : null) }, document);
  const seconds = (Date.now() - t0) / 1000;
  const now = itemById(ide.project, id)!;
  const nowForm = ide.project.forms.find(f => f.id === id);
  const after = now.code;
  const applied = isForm ? formJson(nowForm) !== formJson(beforeForm) : after !== before;
  const dialogs = driver.log;
  const rec: StepRecord = {
    item: step.item, view: step.view, prompt: step.prompt, dialogs, proposal: dialogs.previews.length > 0, applied, before, after,
    lost: applied ? lostCode(before, after, changedNames(dialogs)) : [], undo: 'n/a', logStatuses: m.aiLog.aiLogEntries().map(e => e.status), seconds,
  };
  if (isForm && nowForm) {
    rec.layoutNew = newLayoutProblems(beforeForm, nowForm);
    for (const c of beforeForm?.controls ?? []) {
      if (!nowForm.controls.some(x => x.id === c.id) && !dialogs.previews.some(p => p.lines.some(l => l === `Delete ${c.name}` || l.startsWith(`Delete ${c.name}(`)))) rec.lost.push(`control ${c.name} gone`);
    }
  }
  if (applied) {
    // one undo restores the state before, redo brings the change back
    if (isForm) {
      const afterJson = formJson(nowForm);
      ide.stack.undo();
      const u = formJson(ide.project.forms.find(f => f.id === id)) === formJson(beforeForm);
      ide.stack.redo();
      const r = formJson(ide.project.forms.find(f => f.id === id)) === afterJson;
      rec.undo = u && r ? 'ok' : 'failed';
      if (!u || !r) rec.undoDetail = `undo restores: ${u}, redo restores: ${r}`;
    } else if (win) {
      const view = (win as unknown as { view: import('@codemirror/view').EditorView }).view;
      m.cm.undo(view);
      const u = itemById(ide.project, id)!.code === before;
      m.cm.redo(view);
      const r = itemById(ide.project, id)!.code === after;
      rec.undo = u && r ? 'ok' : 'failed';
      if (!u || !r) rec.undoDetail = `undo restores: ${u}, redo restores: ${r}`;
    }
  }
  return rec;
}

/** Ask AI on an error: run in the RunController until the error (or compile error) box, answer Ask AI, follow the flow. */
async function errorStep(m: Fresh, ide: InstanceType<Fresh['ideState']['IdeState']>, task: Task, backend: Backend, mdi: HTMLElement,
  env: ReturnType<typeof runtimeBackend>): Promise<{ step: StepRecord; error: RunRecord['error'] }> {
  const layer = document.body.appendChild(document.createElement('div'));
  ide.filePath = `${APP}/Project1.vbp`;
  const wins = new Map<string, ReturnType<Fresh['codeWindow']['openCodeWindow']>>();
  const openCode = (id: string) => { const w = wins.get(id) ?? m.codeWindow.openCodeWindow(ide, id, { mdiHost: mdi }); wins.set(id, w); return w; };
  let flow: Promise<void> | undefined;
  let fixItem: string | undefined;
  const host = new RecordingHost(layer, env.backend);
  host.errorAnswer = 'ai';
  const rc: InstanceType<Fresh['runController']['RunController']> = new m.runController.RunController(ide, () => host, openCode, {
    doc: document,
    onAskAi: fix => { fixItem = fix.itemId; flow = m.ask.askAiAboutError(ide, backend, fix, { openCode, end: () => rc.endAndWait() }, document); },
  });
  const before = new Map([...ide.project.forms, ...ide.project.modules].map(x => [x.id, x.code]));
  driver.reset('');
  driver.compileChoice = 'ai';
  m.aiLog.clearAiLog();
  const t0 = Date.now();
  await rc.start(false);
  await settle();
  if (task.error?.click) {
    const f = ide.project.forms[0];
    const c = f.controls.find(x => x.name === task.error!.click);
    layer.querySelector<HTMLElement>(`[data-control-id="${c?.id}"] button`)?.dispatchEvent(new MouseEvent('click', { bubbles: true, button: 0 }));
  }
  for (let i = 0; i < 200 && !flow; i++) await new Promise(r => setTimeout(r, 25));
  const error = { triggered: !!flow, number: host.errors[0]?.number, description: host.errors[0]?.description };
  if (flow) await flow;
  if (ide.mode !== 'design') await rc.endAndWait();
  layer.remove();
  const seconds = (Date.now() - t0) / 1000;
  const id = fixItem ?? ide.project.forms[0].id;
  const item = itemById(ide.project, id)!;
  const dialogs = driver.log;
  const applied = item.code !== before.get(id);
  const step: StepRecord = {
    item: item.name, view: 'code', prompt: '(Ask AI on the error)', dialogs, proposal: dialogs.previews.length > 0, applied, before: before.get(id) ?? '', after: item.code,
    lost: applied ? lostCode(before.get(id) ?? '', item.code, changedNames(dialogs)) : [], undo: 'n/a', logStatuses: m.aiLog.aiLogEntries().map(e => e.status), seconds,
  };
  if (applied) {
    const win = wins.get(id);
    if (win) {
      const view = (win as unknown as { view: import('@codemirror/view').EditorView }).view;
      m.cm.undo(view);
      const u = itemById(ide.project, id)!.code === step.before;
      m.cm.redo(view);
      const r = itemById(ide.project, id)!.code === step.after;
      step.undo = u && r ? 'ok' : 'failed';
      if (!u || !r) step.undoDetail = `undo restores: ${u}, redo restores: ${r}`;
    }
  }
  return { step, error };
}

/** Runs the task's behaviour check on a copy of the result. */
async function runCheck(task: Task, p: Project): Promise<string[]> {
  const env = runtimeBackend();
  task.seed?.(env);
  const rt = new Rt(structuredClone(p), env);
  try {
    await withTimeout(rt.start(), 20000, 'start');
    return await withTimeout(task.check!(rt, rt.project), 30000, 'check');
  } catch (e) {
    return [`check crashed: ${e instanceof Error ? e.message : String(e)}`];
  } finally { rt.end(); }
}

export async function runTask(task: Task, run: number, cfg: LiveConfig): Promise<RunRecord> {
  installSettings(cfg);
  const reqs: ReqRecord[] = [];
  const backend = recordingBackend(reqs);
  const rec: RunRecord = {
    task: task.id, category: task.category, title: task.title, hard: !!task.hard, gap: !!task.gap, run, thinking: cfg.thinking,
    steps: [], requests: reqs, syntaxErrors: [], inspectFails: [], checkFails: null, success: false, failure: '', seconds: 0,
  };
  const t0 = Date.now();
  document.body.innerHTML = '';
  const mdi = document.body.appendChild(document.createElement('div'));
  try {
    const m = await fresh();
    const ide = new m.ideState.IdeState(task.project());
    if (task.error) {
      const env = runtimeBackend();
      task.seed?.(env);
      const r = await errorStep(m, ide, task, backend, mdi, env);
      rec.steps.push(r.step);
      rec.error = r.error;
    } else {
      for (const step of task.steps) rec.steps.push(await askStep(m, ide, step, backend, mdi));
    }
    rec.finalProject = structuredClone(ide.project);
    await judge(task, rec);
  } catch (e) {
    rec.crash = e instanceof Error ? `${e.message}\n${e.stack ?? ''}`.slice(0, 2000) : String(e);
    rec.failure = `harness crash: ${rec.crash.split('\n')[0]}`;
  }
  rec.seconds = (Date.now() - t0) / 1000;
  for (const r of reqs) delete r.key;
  return rec;
}

/** Syntax, static and behaviour checks of `rec.finalProject`, and the verdict (also used to re-check stored runs). */
export async function judge(task: Task, rec: RunRecord): Promise<void> {
  const p = rec.finalProject!;
  rec.syntaxErrors = [];
  for (const x of [...p.forms, ...p.modules]) for (const e of findSyntaxErrors(x.code, x.name)) rec.syntaxErrors.push(`${x.name} line ${e.line}: ${e.message}`);
  if (task.category === 'question') {
    const ans = rec.steps.flatMap(s => s.dialogs.answers.map(a => a.text)).join('\n');
    rec.answerFail = !ans ? 'no answer shown' : task.answerCheck ? task.answerCheck(ans) : null;
  }
  const allApplied = rec.steps.length > 0 && rec.steps.every(s => s.applied);
  rec.inspectFails = task.inspect && allApplied ? task.inspect(p) : [];
  rec.checkFails = task.check && allApplied && !rec.syntaxErrors.length ? await runCheck(task, p) : null;
  const fails: string[] = [];
  if (task.category === 'question') {
    if (rec.answerFail) fails.push(`answer: ${rec.answerFail}`);
    if (rec.steps.some(s => s.applied)) fails.push('code changed by a question');
  } else {
    if (task.error && !rec.error?.triggered) fails.push('the error did not happen');
    const noProp = rec.steps.filter(s => !s.proposal);
    if (noProp.length) fails.push(`no proposal (${noProp.map(s => s.dialogs.notUnderstood.length ? 'not understood' : s.dialogs.warnings[0] ?? (s.dialogs.answers.length ? 'answered in prose' : 'nothing')).join('; ')})`);
    else if (!allApplied) fails.push('proposal changed nothing');
    if (rec.syntaxErrors.length) fails.push(`syntax: ${rec.syntaxErrors[0]}`);
    const lost = rec.steps.flatMap(s => s.lost);
    if (lost.length) fails.push(`lost: ${lost.join('; ')}`);
    if (rec.inspectFails.length) fails.push(`inspect: ${rec.inspectFails.join('; ')}`);
    if (rec.checkFails?.length) fails.push(`check: ${rec.checkFails.join('; ')}`);
  }
  rec.success = fails.length === 0;
  rec.failure = fails.join(' | ');
}
