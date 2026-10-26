// Content-free diagnostics for the last 30 AI requests, in memory only.
import { showDialog98 } from '../ui98/dialogs';
import { h } from '../ui98/dom';
import type { AiUsage } from './sse';
import type { ChatMessage } from './types';
import { classifyAiError, type AiErrorKind } from './errors';

export type AiLogMode = 'code' | 'form' | 'fix' | 'change' | 'retry' | 'test';
export type AiLogStatus = 'ok' | 'cancelled' | 'error' | 'not understood' | 'loop';
export interface AiLogEntry {
  time: Date; mode: AiLogMode; model: string; seconds: number; status: AiLogStatus;
  requestId?: string; serverRequestId?: string; reasoningEffort?: string; maxTokens?: number;
  promptTokens?: number; completionTokens?: number; reasoningTokens?: number; cachedTokens?: number;
  finishReason?: string; httpStatus?: number; errorKind?: AiErrorKind;
  /** Compatibility fields. Only metadata is retained; reply/reasoning are always empty. */
  sent: string; reply: string; reasoning: string; error?: string;
}
export const AI_LOG_SIZE = 30;
const entries: AiLogEntry[] = [];
export const aiLogEntries = (): readonly AiLogEntry[] => entries;
export const clearAiLog = (): void => { entries.length = 0; };
export const newAiRequestId = (): string => `vb-${globalThis.crypto?.randomUUID?.() ?? `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`}`;
const safeId = (id: string | undefined) => id && /^[a-zA-Z0-9_.:-]{1,200}$/.test(id) ? id : undefined;

export function redactUrl(url: string): string {
  const t = url.trim();
  try {
    const u = new URL(t);
    u.username = ''; u.password = ''; u.search = ''; u.hash = '';
    return u.toString().replace(/\/+$/, '');
  } catch {
    const head = t.slice(0, t.search(/[?#]/) < 0 ? t.length : t.search(/[?#]/));
    const scheme = head.indexOf('://'), at = head.lastIndexOf('@');
    return (at > scheme ? (scheme >= 0 ? head.slice(0, scheme + 3) : '') + head.slice(at + 1) : head).replace(/\/+$/, '');
  }
}

/** A metadata summary, never the prompt, images, tool arguments or endpoint credentials. */
export function describeRequest(_baseUrl: string, model: string, _messages: ChatMessage[], options: Record<string, unknown>): string {
  return ['POST /chat/completions', `model: ${model}`, ...['reasoning_effort', 'max_tokens'].filter(k => options[k] !== undefined).map(k => `${k}: ${options[k]}`)].join('\n');
}

export function addAiLogEntry(e: Omit<AiLogEntry, 'time'> & { time?: Date }, _secret = ''): AiLogEntry {
  const entry: AiLogEntry = { time: e.time ?? new Date(), mode: e.mode, model: e.model, seconds: e.seconds, status: e.status,
    requestId: safeId(e.requestId) ?? newAiRequestId(), reasoningEffort: e.reasoningEffort, maxTokens: e.maxTokens,
    promptTokens: e.promptTokens, completionTokens: e.completionTokens, reasoningTokens: e.reasoningTokens,
    finishReason: e.finishReason, httpStatus: e.httpStatus, sent: '', reply: '', reasoning: '' };
  if (e.error !== undefined) {
    entry.errorKind = classifyAiError(e.error);
    entry.httpStatus ??= httpStatusOf(e.error);
    entry.error = safeFailure(entry.errorKind, entry.httpStatus);
  }
  entry.sent = metadata(entry);
  entries.unshift(entry);
  if (entries.length > AI_LOG_SIZE) entries.length = AI_LOG_SIZE;
  return entry;
}
const httpStatusOf = (message: string): number | undefined => {
  const code = /(?:answered |request \()(\d{3})\b/.exec(message)?.[1];
  return code ? Number(code) : undefined;
};
const safeFailure = (kind: AiErrorKind, status?: number): string => kind === 'http' ? `HTTP ${status ?? 'error'}` : kind.replaceAll('_', ' ');
function metadata(e: AiLogEntry): string {
  return [`Request ID: ${e.requestId}`, `Model: ${e.model}`, `Reasoning effort: ${e.reasoningEffort ?? 'unknown'}`,
    `max_tokens: ${e.maxTokens ?? 'not supplied'}`, `Server request ID: ${e.serverRequestId ?? 'not reported'}`,
    `HTTP status: ${e.httpStatus ?? 'not received'}`, `finish_reason: ${e.finishReason ?? 'not reported'}`,
    `Prompt tokens: ${e.promptTokens ?? 'not reported'}`, `Completion tokens: ${e.completionTokens ?? 'not reported'}`,
    `Reasoning tokens: ${e.reasoningTokens ?? 'not reported'}`, `Cached tokens: ${e.cachedTokens ?? 'not reported'}`,
    `Status: ${e.status}`, `Failure: ${e.errorKind ?? 'none'}`].join('\n');
}
export function finishAiLogEntry(e: AiLogEntry, r: { status: AiLogStatus; reply: string; reasoning: string; usage?: AiUsage; error?: string; ms: number; finishReason?: string; serverRequestId?: string; httpStatus?: number }, _secret = ''): void {
  e.status = r.status; e.seconds = Math.round(r.ms / 100) / 10;
  e.reply = ''; e.reasoning = '';
  if (r.usage) { e.promptTokens = r.usage.promptTokens; e.completionTokens = r.usage.completionTokens; e.reasoningTokens = r.usage.reasoningTokens; e.cachedTokens = r.usage.cachedTokens; }
  e.finishReason = r.finishReason; e.serverRequestId = safeId(r.serverRequestId); e.httpStatus = r.httpStatus;
  if (r.error !== undefined || r.status === 'cancelled') {
    e.errorKind = r.finishReason === 'length' ? 'output_limit' : classifyAiError(r.status === 'cancelled' ? 'cancelled' : r.error!);
    e.httpStatus ??= r.error ? httpStatusOf(r.error) : undefined;
    e.error = safeFailure(e.errorKind, e.httpStatus);
  }
  e.sent = metadata(e);
}
const pad = (n: number) => String(n).padStart(2, '0');
const num = (n: number | undefined) => n === undefined ? '' : n.toLocaleString('en-US');
export const aiLogRow = (e: AiLogEntry): string[] =>
  [`${pad(e.time.getHours())}:${pad(e.time.getMinutes())}:${pad(e.time.getSeconds())}`, e.mode, e.model, num(e.promptTokens), num(e.completionTokens), e.seconds.toFixed(1), e.status];

export async function showAiLog(doc: Document, copy: (text: string) => Promise<void> | void): Promise<void> {
  const details = h('pre', { class: 'ai-log-sent', style: 'white-space:pre-wrap;user-select:text;height:260px;overflow:auto;background:white;padding:8px' });
  const tbody = h('tbody', {});
  const table = h('table', { style: 'width:100%;font-size:12px;cursor:default' },
    h('thead', {}, h('tr', {}, ...['Time', 'Mode', 'Model', 'Prompt', 'Completion', 'Seconds', 'Status'].map(t => h('th', {}, t)))), tbody);
  let selected: AiLogEntry | undefined;
  for (const entry of entries) {
    const row = h('tr', { class: 'ai-log-row' }, ...aiLogRow(entry).map(t => h('td', {}, t)));
    row.addEventListener('mousedown', () => {
      selected = entry; details.textContent = metadata(entry);
      for (const r of tbody.children) (r as HTMLElement).style.background = '';
      row.style.background = '#dfdfdf';
    });
    tbody.append(row);
  }
  if (entries[0]) { selected = entries[0]; details.textContent = metadata(selected); }
  else details.textContent = 'No AI requests yet in this session.';
  const content = h('div', { style: 'width:min(700px,calc(100vw - 64px))' },
    h('div', {}, 'Diagnostics contain metadata only. Prompts, images, reasoning, answers and tool arguments are not recorded.'),
    h('div', { style: 'max-height:170px;overflow:auto' }, table), details,
    h('button', { type: 'button', onclick: () => { if (selected) void copy(metadata(selected)); } }, 'Copy metadata'));
  await showDialog98(doc, { title: 'AI Log', content, buttons: [{ label: 'Close', value: 'close', default: true, cancel: true }] });
}
