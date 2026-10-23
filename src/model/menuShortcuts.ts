// The Shortcut keys a VB6 menu item can have, in the order of the Menu Editor's list (the Shortcut property's value is the
// position in it: 0 = none). No imports: the control registry builds the Shortcut property from this table.

const LETTERS = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ'.split('');
const fkeys = (prefix: string): string[] => Array.from({ length: 12 }, (_, i) => `${prefix}F${i + 1}`);

/** "(None)", Ctrl+A .. Ctrl+Z, F1 .. F12, Ctrl+F1 .., Shift+F1 .., Shift+Ctrl+F1 .., Ctrl+Ins, Shift+Ins, Del, Shift+Del, Alt+Bksp. */
export const SHORTCUT_LABELS: readonly string[] = [
  '(None)', ...LETTERS.map(l => `Ctrl+${l}`), ...fkeys(''), ...fkeys('Ctrl+'), ...fkeys('Shift+'), ...fkeys('Shift+Ctrl+'),
  'Ctrl+Ins', 'Shift+Ins', 'Del', 'Shift+Del', 'Alt+Bksp',
];

/** The text a menu shows right-aligned for a Shortcut value ('' for none or an unknown value). */
export function shortcutText(v: unknown): string {
  return typeof v === 'number' && v > 0 && v < SHORTCUT_LABELS.length ? SHORTCUT_LABELS[v] : '';
}

/** The Shortcut value of a label like "Ctrl+O" or "shift+ctrl+f2" (also "Ctrl+Shift+F2", "Delete", "Insert"); 0 for none, null when unknown. */
export function shortcutValue(label: string): number | null {
  const parts = label.trim().toLowerCase().split('+').map(p => p.trim()).filter(Boolean);
  if (!parts.length || label.trim().toLowerCase() === '(none)' || label.trim().toLowerCase() === 'none') return 0;
  const key = ({ delete: 'del', insert: 'ins', backspace: 'bksp', control: 'ctrl', cmd: 'ctrl' } as Record<string, string>)[parts[parts.length - 1]] ?? parts[parts.length - 1];
  const mods = new Set(parts.slice(0, -1).map(m => (m === 'control' || m === 'cmd' ? 'ctrl' : m)));
  const norm = [mods.has('shift') ? 'shift' : '', mods.has('ctrl') ? 'ctrl' : '', mods.has('alt') ? 'alt' : '', key].filter(Boolean).join('+');
  const i = SHORTCUT_LABELS.findIndex(l => l.toLowerCase() === norm);
  return i >= 0 ? i : null;
}

/** The key event fields a shortcut is matched on. */
export interface ShortcutKey { key: string; code?: string; ctrlKey: boolean; metaKey: boolean; shiftKey: boolean; altKey: boolean }

/** Whether the key event is the Shortcut `v`. Ctrl also matches Cmd (the Mac's own command key). */
export function shortcutMatches(v: number, e: ShortcutKey): boolean {
  const label = shortcutText(v);
  if (!label) return false;
  const parts = label.split('+');
  const key = parts[parts.length - 1];
  const ctrl = parts.includes('Ctrl'), shift = parts.includes('Shift'), alt = parts.includes('Alt');
  if (ctrl !== (e.ctrlKey || e.metaKey) || shift !== e.shiftKey || alt !== e.altKey) return false;
  if (key.length === 1) {   // the letter the key types (Ctrl+Z on a German keyboard is the key QWERTY has Y on); else the key's place
    const typed = e.key.length === 1 ? e.key.toUpperCase() : '';
    return /^[A-Z]$/.test(typed) ? typed === key : e.code === `Key${key}`;
  }
  const special = ({ Ins: 'Insert', Del: 'Delete', Bksp: 'Backspace' } as Record<string, string>)[key] ?? key;   // F1 .. F12 as they are
  return e.key === special || e.code === special;
}

/**
 * The letter or digit of a key press for a menu's or caption's & (lower case; '' for none): the character the key types, so the
 * keyboard layout counts. With Alt (Option on a Mac types another character: Option+Z is Ω) or a layout without Latin letters,
 * the letter of the key's code.
 */
export function keyLetter(e: { key: string; code?: string; altKey: boolean }): string {
  const typed = e.key.length === 1 ? e.key.toLowerCase() : '';
  if (/^[a-z0-9]$/.test(typed) || (typed !== '' && !e.altKey)) return typed;
  const c = /^Key([A-Z])$/.exec(e.code ?? '') ?? /^Digit(\d)$/.exec(e.code ?? '');
  return c ? c[1].toLowerCase() : typed;
}

