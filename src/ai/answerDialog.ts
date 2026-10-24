// Code mode answers without code: a question ("what does...", "why...", "explain...") or a reply in plain prose is shown
// in a read-only Win98 "AI Answer" dialog. Ask more... continues the same conversation, like Change... does.
import { showDialog98 } from '../ui98/dialogs';
import { h } from '../ui98/dom';
import { stripThinking } from './clean';

/** A request that asks about the code rather than for a change (also "Can you ...", which may be either; see questionMode). */
export const isQuestion = (prompt: string): boolean => questionMode(prompt) !== false;

/**
 * How a request is answered: true for a question (what, why, explain, how do I, can I, is this ...: the reply is shown as
 * text), 'unless-code' for "Can you / Could you ..." (a question or a polite request: a reply with usable code is a proposal,
 * one in words an answer), false for a request for a change.
 */
export function questionMode(prompt: string): boolean | 'unless-code' {
  const p = prompt.trim();
  if (/^(can|could|would|will) you\b/i.test(p)) return /^\w+ you (please )?(explain|tell|describe|say|help me understand)\b/i.test(p) ? true : 'unless-code';
  return /^(what|what's|whats|why|explain|describe|how (does|do|is|can|should|would)|can i|could i|should i|is (this|that|it|there)|are there|does (this|it|that))\b/i.test(p);
}

/**
 * A reply that reads as plain prose: some words, closed code fences, mostly letters, and not the start of JSON or code.
 * Anything else that was not understood is garbled and gets "could not be understood".
 */
export function isProse(reply: string): boolean {
  const t = stripThinking(reply);
  if (!t || /^[{[<]/.test(t)) return false;
  if ((t.match(/```/g)?.length ?? 0) % 2 !== 0) return false;
  const words = t.match(/[A-Za-zÀ-ɏ]{2,}/g) ?? [];
  const visible = t.replace(/\s/g, '');
  const letters = visible.replace(/[^A-Za-zÀ-ɏ]/g, '').length;
  return words.length >= 3 && letters >= visible.length * 0.5;
}

/** The answer as plain text, with ``` blocks in Courier. */
function renderAnswer(text: string): HTMLElement[] {
  const out: HTMLElement[] = [];
  const parts = text.split(/```[^\n]*\n?/);
  parts.forEach((p, i) => {
    if (!p) return;
    const code = i % 2 === 1;
    out.push(h(code ? 'pre' : 'div', {
      class: code ? 'ai-answer-code' : 'ai-answer-text',
      style: code ? 'margin:4px 0;padding:0;font:12px/14px "Courier New",monospace;white-space:pre;overflow-x:auto' : 'white-space:pre-wrap;overflow-wrap:anywhere',
    }, code ? p.replace(/\n$/, '') : p.replace(/^\n+|\n+$/g, '')));
  });
  return out;
}

/** "What else do you want to ask?" box. The trimmed text, or null on Cancel / empty text. */
async function askMore(doc: Document): Promise<string | null> {
  const box = h('input', { type: 'text', class: 'ai-ask-more', style: 'width:360px', 'data-autofocus': '' });
  const v = await showDialog98(doc, {
    title: 'AI Answer', content: h('div', {}, h('div', { style: 'margin-bottom:4px' }, 'What else do you want to ask?'), box),
    buttons: [{ label: 'OK', value: 'ok', default: true }, { label: 'Cancel', value: 'cancel', cancel: true }],
  });
  const text = box.value.trim();
  return v === 'ok' && text ? text : null;
}

/** Shows the answer until OK (resolves 'ok') or Ask more... with a text typed in. Copy copies the whole answer. */
export async function showAnswer(doc: Document, reply: string, metrics: string, copy: (text: string) => Promise<void> | void): Promise<'ok' | { more: string }> {
  const text = stripThinking(reply);
  const box = h('div', {
    class: 'ai-answer-box', 'aria-readonly': 'true', tabindex: '0',
    style: 'box-sizing:border-box;width:520px;max-height:320px;overflow-y:auto;padding:4px 6px;background:#fff;color:#000;user-select:text;'
      + 'box-shadow:inset -1px -1px #fff,inset 1px 1px #808080,inset -2px -2px #dfdfdf,inset 2px 2px #0a0a0a',
  }, ...renderAnswer(text));
  const content = h('div', {}, ...(metrics ? [h('div', { class: 'ai-metrics', style: 'color:#808080;margin-bottom:4px' }, metrics)] : []), box);
  for (;;) {
    const top = box.scrollTop;
    const shown = showDialog98(doc, {
      title: 'AI Answer', content,
      buttons: [{ label: 'OK', value: 'ok', default: true, cancel: true }, { label: 'Copy', value: 'copy' }, { label: 'Ask more...', value: 'more' }],
    });
    box.scrollTop = top;
    const v = await shown;
    if (v === 'copy') { try { await copy(text); } catch { /* clipboard unavailable */ } continue; }
    if (v !== 'more') return 'ok';
    const more = await askMore(doc);
    if (more !== null) return { more };
  }
}
