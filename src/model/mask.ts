// MaskedEdit (MSMASK32.OCX): the mask and typing into it. The text of the control is the mask's display string, one character
// per mask position: the entered character, the literal, or the prompt character for an empty position. Pure: no DOM.

/** One position of a mask: a literal, or a place for a character. */
export type MaskSlot =
  | { lit: true; ch: string }
  | { lit: false; type: '#' | '9' | '?' | 'A' | 'a' | '&' | 'C'; required: boolean; fold: 'u' | 'l' | null };

/**
 * Mask characters: # digit, 9 optional digit, ? letter, A alphanumeric, a optional alphanumeric, & any character, C optional
 * any character, > upper case and < lower case for what follows, \ makes the next character a literal; everything else
 * (. , : / - ( ) $ ...) is a literal.
 */
export function parseMask(mask: string): MaskSlot[] {
  const out: MaskSlot[] = [];
  let fold: 'u' | 'l' | null = null;
  for (let i = 0; i < mask.length; i++) {
    const ch = mask[i];
    if (ch === '\\') { if (i + 1 < mask.length) out.push({ lit: true, ch: mask[++i] }); continue; }
    if (ch === '>') { fold = 'u'; continue; }
    if (ch === '<') { fold = 'l'; continue; }
    if ('#9?AaC&'.includes(ch)) out.push({ lit: false, type: ch as '#', required: ch === '#' || ch === '?' || ch === 'A' || ch === '&', fold });
    else out.push({ lit: true, ch });
  }
  return out;
}

const isDigit = (c: string) => /^\d$/.test(c);
const isLetter = (c: string) => /^\p{L}$/u.test(c);

/** Whether a character may be typed at the position. */
export function accepts(slot: MaskSlot, ch: string): boolean {
  if (slot.lit || ch.length !== 1) return false;
  switch (slot.type) {
    case '#': case '9': return isDigit(ch);
    case '?': return isLetter(ch);
    case 'A': case 'a': return isDigit(ch) || isLetter(ch);
    default: return ch >= ' ' && ch !== '\x7f';
  }
}

const fold = (slot: MaskSlot, ch: string): string => (slot.lit ? ch : slot.fold === 'u' ? ch.toUpperCase() : slot.fold === 'l' ? ch.toLowerCase() : ch);

/** The text of an empty control: the literals and a prompt character for every other position. */
export function emptyText(slots: readonly MaskSlot[], prompt: string): string {
  return slots.map(s => (s.lit ? s.ch : prompt)).join('');
}

/** Whether the position holds no entry (shows the prompt character). */
const emptyAt = (text: string, i: number, prompt: string): boolean => text[i] === undefined || text[i] === prompt;

/** The entered characters without literals and prompts (ClipText). */
export function clipText(slots: readonly MaskSlot[], text: string, prompt: string): string {
  let out = '';
  slots.forEach((s, i) => { if (!s.lit && !emptyAt(text, i, prompt)) out += text[i]; });
  return out;
}

/** Text: the literals and entries; an empty position is the prompt character (PromptInclude) or a space. */
export function maskedText(slots: readonly MaskSlot[], text: string, prompt: string, includePrompt: boolean): string {
  return includePrompt ? text : slots.map((s, i) => (s.lit ? s.ch : emptyAt(text, i, prompt) ? ' ' : text[i])).join('');
}

/** Every required position holds an entry. */
export function isComplete(slots: readonly MaskSlot[], text: string, prompt: string): boolean {
  return slots.every((s, i) => s.lit || !s.required || !emptyAt(text, i, prompt));
}

export interface TypeResult {
  text: string;
  /** Where the insertion point goes. */
  caret: number;
  /** The typed character does not fit: the event ValidationError(InvalidText, StartPosition) with this position. */
  error?: { text: string; pos: number };
}

const setAt = (text: string, i: number, ch: string): string => text.slice(0, i) + ch + text.slice(i + 1);

/** Empties the entries from `start` up to (not including) `end`. */
export function clearRange(slots: readonly MaskSlot[], text: string, prompt: string, start: number, end: number): string {
  let t = text;
  for (let i = Math.max(0, start); i < Math.min(end, slots.length); i++) if (!slots[i].lit) t = setAt(t, i, prompt);
  return t;
}

/**
 * A character typed with the insertion point at `pos`: it goes into the next free position at or after `pos` (literals are
 * skipped; typing a literal that is next steps over it). A selection is emptied first. `allowPrompt`: the prompt character
 * itself may be typed (it empties the position).
 */
export function typeChar(slots: readonly MaskSlot[], text: string, prompt: string, pos: number, selLength: number, ch: string, allowPrompt = true): TypeResult {
  let t = selLength > 0 ? clearRange(slots, text, prompt, pos, pos + selLength) : text;
  let i = pos;
  if (i < slots.length && slots[i].lit && (slots[i] as { ch: string }).ch === ch) return { text: t, caret: i + 1 };
  while (i < slots.length && slots[i].lit) i++;
  if (i >= slots.length) return { text: t, caret: slots.length };
  const slot = slots[i];
  if (allowPrompt && ch === prompt && !slot.lit && !slot.required) { t = setAt(t, i, prompt); return { text: t, caret: i + 1 }; }
  if (!accepts(slot, ch)) {   // the literal that comes next (typed "1." in ##.##): the rest of the group stays empty
    const j = slots.findIndex((s, k) => k > i && s.lit);
    if (j >= 0 && (slots[j] as { ch: string }).ch === ch) return { text: t, caret: j + 1 };
  }
  if (!accepts(slot, ch) || (ch === prompt && !allowPrompt)) return { text, caret: pos, error: { text: ch, pos: i } };
  return { text: setAt(t, i, fold(slot, ch)), caret: i + 1 };
}

/** Backspace: empties the selection, or the entry before the insertion point. */
export function backspace(slots: readonly MaskSlot[], text: string, prompt: string, pos: number, selLength: number): TypeResult {
  if (selLength > 0) return { text: clearRange(slots, text, prompt, pos, pos + selLength), caret: pos };
  let i = pos - 1;
  while (i >= 0 && slots[i].lit) i--;
  if (i < 0) return { text, caret: pos };
  return { text: setAt(text, i, prompt), caret: i };
}

/** Delete: empties the selection, or the entry at the insertion point. */
export function deleteForward(slots: readonly MaskSlot[], text: string, prompt: string, pos: number, selLength: number): TypeResult {
  if (selLength > 0) return { text: clearRange(slots, text, prompt, pos, pos + selLength), caret: pos };
  let i = pos;
  while (i < slots.length && slots[i].lit) i++;
  if (i >= slots.length) return { text, caret: pos };
  return { text: setAt(text, i, prompt), caret: pos };
}

/**
 * What a text assigned by code (or pasted) means: the whole display string with its literals, or just the entries (ClipText).
 * Null when it does not fit the mask.
 */
export function fromText(slots: readonly MaskSlot[], prompt: string, input: string): string | null {
  if (input === '') return emptyText(slots, prompt);
  if (input.length === slots.length) {
    let t = '';
    let ok = true;
    slots.forEach((s, i) => {
      const c = input[i];
      if (s.lit) { if (c !== s.ch) ok = false; t += s.ch; }
      else if (c === prompt || c === ' ') t += prompt;
      else if (accepts(s, c)) t += fold(s, c);
      else ok = false;
    });
    if (ok) return t;
  }
  let t = emptyText(slots, prompt);
  let pos = 0;
  for (const ch of input) {
    const r = typeChar(slots, t, prompt, pos, 0, ch);
    if (r.error) return null;
    t = r.text; pos = r.caret;
  }
  return t;
}

/** The text of a masked control after its Mask or PromptChar changed or a Text was set: fitted to the mask (empty when it does not fit). */
export function fitText(mask: string, prompt: string, text: string): string {
  const slots = parseMask(mask);
  if (slots.length === 0) return text;
  return fromText(slots, prompt || '_', text) ?? emptyText(slots, prompt || '_');
}
