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
  if (key.length === 1) return e.code ? e.code === `Key${key}` : e.key.toUpperCase() === key;
  if (key === 'Ins') return e.key === 'Insert';
  if (key === 'Del') return e.key === 'Delete';
  if (key === 'Bksp') return e.key === 'Backspace';
  return e.key === key;   // F1 .. F12
}
