// ImageCombo (MSCOMCTL.OCX) items: one per line 'Text|Key|Image|SelImage|Indentation' (see fieldLines.ts). Image and SelImage are an index or a
// key of the ImageList; Indentation counts steps of 10 pixels.
import { joinFields, splitFields } from './fieldLines';

export interface ComboItemData { text: string; key: string; image: string; selImage: string; indent: number }

export const COMBO_INDENT_PX = 10;

export function parseComboItem(line: string): ComboItemData {
  const [text = '', key = '', image = '', selImage = '', indent = ''] = splitFields(line);
  return { text, key, image, selImage, indent: Math.max(0, Number(indent) || 0) };
}

export function comboItemLine(i: ComboItemData): string {
  return joinFields([i.text, i.key, i.image, i.selImage, i.indent || '']);
}
