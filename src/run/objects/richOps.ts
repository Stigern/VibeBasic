// RichTextBox searches on the plain text: Find, Span, UpTo and GetLineFromChar.

export const RTF_WHOLE_WORD = 2, RTF_MATCH_CASE = 4, RTF_NO_HIGHLIGHT = 8;

const isWordChar = (c: string | undefined): boolean => c !== undefined && /[\p{L}\p{N}_]/u.test(c);

/** Find: the position of the first match of `what` in text[start, end), or -1. The default is any case and any part of a word. */
export function findText(text: string, what: string, start: number, end: number, options: number): number {
  if (what === '') return -1;
  const matchCase = (options & RTF_MATCH_CASE) !== 0, whole = (options & RTF_WHOLE_WORD) !== 0;
  const hay = matchCase ? text : text.toLowerCase(), needle = matchCase ? what : what.toLowerCase();
  const stop = Math.min(end, text.length);
  for (let i = hay.indexOf(needle, Math.max(0, start)); i >= 0 && i + needle.length <= stop; i = hay.indexOf(needle, i + 1)) {
    if (!whole || (!isWordChar(text[i - 1]) && !isWordChar(text[i + needle.length]))) return i;
  }
  return -1;
}

/** The selection Span makes: from `from` over the characters that are in `set` (or not in it with `negate`), forward or backward. */
export function spanText(text: string, from: number, set: string, forward: boolean, negate: boolean): { start: number; length: number } {
  const ok = (c: string): boolean => set.includes(c) !== negate;
  let i = from;
  if (forward) {
    while (i < text.length && ok(text[i])) i++;
    return { start: from, length: i - from };
  }
  while (i > 0 && ok(text[i - 1])) i--;
  return { start: i, length: from - i };
}

/** The insertion point UpTo moves to: just before the first character of `set` (or not of it with `negate`) forward, just after it backward; the end of the text (the start) when there is none. */
export function upToText(text: string, from: number, set: string, forward: boolean, negate: boolean): number {
  const hit = (c: string): boolean => set.includes(c) !== negate;
  if (forward) {
    let i = from;
    while (i < text.length && !hit(text[i])) i++;
    return i;
  }
  let i = from;
  while (i > 0 && !hit(text[i - 1])) i--;
  return i;
}

/** GetLineFromChar: the line (0-based) a character position is on; lines end at line breaks (wrapping is the window's). */
export function lineFromChar(text: string, pos: number): number {
  let n = 0;
  for (let i = text.indexOf('\n'); i >= 0 && i < pos; i = text.indexOf('\n', i + 1)) n++;
  return n;
}
