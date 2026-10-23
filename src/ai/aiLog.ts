// Tools > AI Log...: the last 30 AI exchanges of this app session, in memory only (the troubleshooting tool for the AI).
// Every entry is scrubbed of the API key; the key is never shown.
import { showDialog98 } from '../ui98/dialogs';
import { h } from '../ui98/dom';
import type { AiUsage } from './sse';
import { THINKING_COLOR } from './streamLog';
import { type ChatMessage, contentText } from './types';

export type AiLogMode = 'code' | 'form' | 'fix' | 'change' | 'retry' | 'test';
export type AiLogStatus = 'ok' | 'cancelled' | 'error' | 'not understood';

export interface AiLogEntry {
  time: Date; mode: AiLogMode; model: string;
  promptTokens?: number; completionTokens?: number; seconds: number; status: AiLogStatus;
  /** What was sent: the request line and the full messages. */
  sent: string;
  reply: string; reasoning: string;
  error?: string;
}

export const AI_LOG_SIZE = 30;
const entries: AiLogEntry[] = [];

/** Newest first. */
export const aiLogEntries = (): readonly AiLogEntry[] => entries;
export const clearAiLog = (): void => { entries.length = 0; };

const MASK = '********';
/** Replaces the API key (when it is set) everywhere in `text`. */
const scrub = (text: string, secret: string): string => {
  const k = secret.trim();
  return k ? text.split(k).join(MASK) : text;
};

/** The request as text: a header line with the options, then every message. */
export function describeRequest(baseUrl: string, model: string, messages: ChatMessage[], options: Record<string, unknown>): string {
  const opts = Object.entries(options).filter(([, v]) => v !== undefined).map(([k, v]) => `${k}: ${typeof v === 'string' || typeof v === 'number' ? v : JSON.stringify(v)}`);
  return [`POST ${baseUrl.trim().replace(/\/+$/, '')}/chat/completions`, `model: ${model}`, ...opts, '',
    ...messages.map(m => `--- ${m.role} ---\n${contentText(m.content)}`)].join('\n');
}

/** Adds an entry (scrubbed of `secret`) and returns it, so the caller can finish or mark it later. */
export function addAiLogEntry(e: Omit<AiLogEntry, 'time'> & { time?: Date }, secret = ''): AiLogEntry {
  const entry: AiLogEntry = { ...e, time: e.time ?? new Date() };
  scrubEntry(entry, secret);
  entries.unshift(entry);
  if (entries.length > AI_LOG_SIZE) entries.length = AI_LOG_SIZE;
  return entry;
}

function scrubEntry(e: AiLogEntry, secret: string): void {
  e.sent = scrub(e.sent, secret); e.reply = scrub(e.reply, secret); e.reasoning = scrub(e.reasoning, secret);
  if (e.error !== undefined) e.error = scrub(e.error, secret);
}

/** Records the outcome of an entry started with status 'ok' and no reply yet. */
export function finishAiLogEntry(e: AiLogEntry, r: { status: AiLogStatus; reply: string; reasoning: string; usage?: AiUsage; error?: string; ms: number }, secret = ''): void {
  e.status = r.status; e.reply = r.reply; e.reasoning = r.reasoning; e.seconds = Math.round(r.ms / 100) / 10;
  if (r.usage) { e.promptTokens = r.usage.promptTokens; e.completionTokens = r.usage.completionTokens; }
  if (r.error !== undefined) e.error = r.error;
  scrubEntry(e, secret);
}

const pad = (n: number) => String(n).padStart(2, '0');
const timeText = (d: Date) => `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
const num = (n: number | undefined) => n === undefined ? '' : n.toLocaleString('en-US');

/** The columns of a row: time, mode, model, prompt tokens, completion tokens, seconds, status. */
export const aiLogRow = (e: AiLogEntry): string[] =>
  [timeText(e.time), e.mode, e.model, num(e.promptTokens), num(e.completionTokens), e.seconds.toFixed(1), e.status];

const INSET = 'background:#fff;box-shadow:inset -1px -1px #fff,inset 1px 1px #808080,inset -2px -2px #dfdfdf,inset 2px 2px #0a0a0a;';
const TEXT_BOX = `${INSET}box-sizing:border-box;width:640px;height:150px;overflow:auto;padding:2px 4px;font:12px/14px "Courier New",monospace;white-space:pre-wrap;overflow-wrap:anywhere;user-select:text;`;

/** The AI Log window: the list on top, the selected exchange (sent / reply, each with Copy) below. */
export async function showAiLog(doc: Document, copy: (text: string) => Promise<void> | void): Promise<void> {
  const heads = ['Time', 'Mode', 'Model', 'Prompt', 'Completion', 'Seconds', 'Status'];
  const cell = 'padding:1px 4px;white-space:nowrap;text-align:left;';
  const tbody = h('tbody', {});
  const table = h('table', { class: 'ai-log-list', style: 'border-collapse:collapse;width:100%;font:12px sans-serif;cursor:default' },
    h('thead', {}, h('tr', {}, ...heads.map(t => h('th', { style: `${cell}position:sticky;top:0;background:#c0c0c0;font-weight:normal;box-shadow:inset -1px -1px #808080,inset 1px 1px #fff` }, t)))),
    tbody);
  const list = h('div', { style: `${INSET}width:640px;height:170px;overflow:auto` }, table);
  const sent = h('div', { class: 'ai-log-sent', style: TEXT_BOX });
  const reply = h('div', { class: 'ai-log-reply', style: TEXT_BOX });
  let current: AiLogEntry | null = null;
  const replyText = (e: AiLogEntry) => [e.reasoning, e.reply, e.error === undefined ? '' : `Error: ${e.error}`].filter(Boolean).join('\n\n');
  const copyBtn = (cls: string, get: (e: AiLogEntry) => string) =>
    h('button', { type: 'button', class: cls, onclick: () => { if (current) void copy(get(current)); } }, 'Copy');
  const section = (title: string, box: HTMLElement, btn: HTMLElement) =>
    h('div', { style: 'margin-top:6px' }, h('div', { style: 'display:flex;justify-content:space-between;align-items:end;margin-bottom:2px' }, h('span', {}, title), btn), box);

  const select = (e: AiLogEntry, row: HTMLElement) => {
    current = e;
    for (const r of tbody.children) { (r as HTMLElement).style.background = ''; (r as HTMLElement).style.color = ''; }
    row.style.background = '#000080'; row.style.color = '#fff';
    sent.textContent = e.sent;
    reply.replaceChildren(
      ...(e.reasoning ? [h('span', { class: 'ai-thinking', style: `color:${THINKING_COLOR}` }, e.reasoning + (e.reply || e.error ? '\n\n' : ''))] : []),
      h('span', { class: 'ai-answer' }, e.reply),
      ...(e.error === undefined ? [] : [h('span', { class: 'ai-error' }, `${e.reply ? '\n\n' : ''}Error: ${e.error}`)]));
  };
  for (const e of entries) {
    const row = h('tr', { class: 'ai-log-row' }, ...aiLogRow(e).map(t => h('td', { style: cell }, t)));
    row.addEventListener('mousedown', () => select(e, row));
    tbody.append(row);
  }
  if (!entries.length) tbody.append(h('tr', {}, h('td', { style: cell, colspan: String(heads.length) }, '(no AI requests yet in this session)')));
  else select(entries[0], tbody.firstElementChild as HTMLElement);

  const content = h('div', {}, list, section('Sent:', sent, copyBtn('ai-log-copy-sent', e => e.sent)),
    section('Reply (thinking in grey):', reply, copyBtn('ai-log-copy-reply', replyText)));
  await showDialog98(doc, { title: 'AI Log', content, buttons: [{ label: 'Close', value: 'close', default: true, cancel: true }] });
}
