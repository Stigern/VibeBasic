// Endless repetition in a streamed AI answer: the same block over and over (seen on a quantized Qwen with a form picture:
// `{"op":"form","props":{...}},` until max_tokens or Cancel). The answer and the thinking are watched separately.

/** The shortest and longest block that counts as a loop. */
export const MIN_PERIOD = 16, MAX_PERIOD = 800;
/** Only the end of the text is looked at, and only after this many new characters. */
export const LOOP_WINDOW = 4000, LOOP_CHECK_EVERY = 500;
/** The repeated stretch must be at least this long, so a few identical short lines in real code never count. */
const MIN_SPAN = 256;
/**
 * A block that is itself a run of something shorter than MIN_PERIOD ("End If End If ", "=====", "STOP STOP ") needs a longer
 * stretch: a few End Ifs or a banner comment are normal, a word repeated for 600 characters is not.
 */
const SHORT_SPAN = 600;
const SHORT_PERIOD = MIN_PERIOD - 1;

/** How many characters at the end of `s` repeat with period `p` (s[i] === s[i - p]), looking back at most `max`. */
function periodicRun(s: string, p: number, max: number): number {
  const n = s.length;
  let k = 0;
  while (k < max && n - 1 - k - p >= 0 && s.charCodeAt(n - 1 - k) === s.charCodeAt(n - 1 - k - p)) k++;
  return k;
}

/** Whether `block` repeats with a period shorter than MIN_PERIOD over its whole length. */
function short(block: string): boolean {
  for (let q = 1; q <= SHORT_PERIOD && q < block.length; q++) {
    let ok = true;
    for (let i = q; i < block.length && ok; i++) ok = block.charCodeAt(i) === block.charCodeAt(i - q);
    if (ok) return true;
  }
  return false;
}

/**
 * The loop at the end of `text`, or null: one block of 16-800 characters repeated at least 4 times in a row (3 times from
 * 200 characters on), whitespace-normalised, over at least 256 characters (600 when the block is a run of something shorter).
 * The text may end inside the next copy of the block. Blocks that differ anywhere (other names, numbers or list items) never count.
 */
export function findLoop(text: string): { period: number; repeats: number } | null {
  const s = text.slice(-LOOP_WINDOW).replace(/\s+/g, ' ');
  for (let p = MIN_PERIOD; p <= MAX_PERIOD && 3 * p <= s.length; p++) {
    const need = Math.max(p >= 200 ? 3 : 4, Math.ceil(MIN_SPAN / p));
    // the stretch is the run plus the first copy it is compared against
    if (periodicRun(s, p, (need - 1) * p) < (need - 1) * p) continue;
    if (short(s.slice(-p)) && periodicRun(s, p, SHORT_SPAN) + p < SHORT_SPAN) continue;
    return { period: p, repeats: Math.floor((periodicRun(s, p, s.length) + p) / p) };
  }
  return null;
}

/** Watches one request's stream: `add` is true once the answer or the thinking has started to loop. */
export class LoopWatch {
  private text: Record<'content' | 'reasoning', string> = { content: '', reasoning: '' };
  private checked: Record<'content' | 'reasoning', number> = { content: 0, reasoning: 0 };
  looped: 'content' | 'reasoning' | null = null;

  add(kind: 'content' | 'reasoning', delta: string): boolean {
    if (this.looped) return true;
    // only the window is ever looked at, so older text is dropped
    let t = this.text[kind] + delta;
    if (t.length > 2 * LOOP_WINDOW) { this.checked[kind] -= t.length - LOOP_WINDOW; t = t.slice(-LOOP_WINDOW); }
    this.text[kind] = t;
    if (t.length - this.checked[kind] < LOOP_CHECK_EVERY) return false;
    this.checked[kind] = t.length;
    if (findLoop(t)) this.looped = kind;
    return this.looped !== null;
  }
}
