// Toolbar (MSCOMCTL.OCX) buttons: one per line 'Caption|Key|Style|Image|ToolTipText' at design time (see fieldLines.ts). At run
// time the lines carry the state as well: 'Caption|Key|Style|Image|ToolTipText|Value|Enabled|Visible' (Enabled and Visible '0'
// = False, anything else True).
import { joinFields, splitFields } from './fieldLines';

export const TBR_DEFAULT = 0, TBR_CHECK = 1, TBR_BUTTON_GROUP = 2, TBR_SEPARATOR = 3, TBR_PLACEHOLDER = 4, TBR_DROPDOWN = 5;

export interface ToolbarButtonData {
  caption: string; key: string; style: number; image: string; tip: string; value: number; enabled: boolean; visible: boolean;
}

export function parseButton(line: string): ToolbarButtonData {
  const [caption = '', key = '', style = '', image = '', tip = '', value = '', enabled = '', visible = ''] = splitFields(line);
  return { caption, key, style: Number(style) || 0, image, tip, value: Number(value) ? 1 : 0, enabled: enabled !== '0', visible: visible !== '0' };
}

export function buttonLine(b: ToolbarButtonData): string {
  return joinFields([b.caption, b.key, b.style || '', b.image, b.tip, b.value || '', b.enabled ? '' : '0', b.visible ? '' : '0']);
}

/** Sets button `index` (1-based) pressed or not. Pressing a tbrButtonGroup button releases the others of its group (the run of
 *  adjacent tbrButtonGroup buttons). Returns the new lines. */
export function setPressed(lines: readonly string[], index: number, on: boolean): string[] {
  const bs = lines.map(parseButton);
  const b = bs[index - 1];
  if (!b) return [...lines];
  b.value = on ? 1 : 0;
  if (on && b.style === TBR_BUTTON_GROUP) {
    for (let i = index - 2; i >= 0 && bs[i].style === TBR_BUTTON_GROUP; i--) bs[i].value = 0;
    for (let i = index; i < bs.length && bs[i].style === TBR_BUTTON_GROUP; i++) bs[i].value = 0;
  }
  return bs.map(buttonLine);
}

/** A click by the user on button `index`: tbrCheck toggles, tbrButtonGroup presses (and stays pressed). Null when the click does nothing
 *  (a separator, a placeholder, a disabled or hidden button), otherwise the new lines. */
export function userClickButton(lines: readonly string[], index: number): string[] | null {
  const b = lines[index - 1] === undefined ? null : parseButton(lines[index - 1]);
  if (!b || !b.enabled || !b.visible || b.style === TBR_SEPARATOR || b.style === TBR_PLACEHOLDER) return null;
  if (b.style === TBR_CHECK) return setPressed(lines, index, !b.value);
  if (b.style === TBR_BUTTON_GROUP) return setPressed(lines, index, true);
  return [...lines];
}
