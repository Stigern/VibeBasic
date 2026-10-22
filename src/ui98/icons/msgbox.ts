/**
 * MsgBox icons, drawn from scratch as 32x32 SVGs in the Win98 style
 * (no Microsoft bitmaps). Names match the `buttons & 0x70` values of VB6.
 */
export type MsgIconName = 'critical' | 'question' | 'exclamation' | 'information';

const svg = (inner: string) =>
  `<svg xmlns="http://www.w3.org/2000/svg" width="32" height="32" viewBox="0 0 32 32" aria-hidden="true">${inner}</svg>`;

/** Rounded speech bubble with a tail at the lower left. */
const BUBBLE = 'M16 3C8.8 3 3 7.6 3 13.3c0 3.3 1.9 6.1 4.9 8L6 28l7.4-4.6c.9.2 1.7.2 2.6.2 7.2 0 13-4.6 13-10.3S23.2 3 16 3z';

const bubble = (glyph: string) =>
  `<path d="${BUBBLE}" fill="#000000" transform="translate(1 1)"/>` +
  `<path d="${BUBBLE}" fill="#ffffff" stroke="#000080" stroke-width="1"/>` + glyph;

/** Red circle with a white X. */
export const ICON_CRITICAL = svg(
  '<circle cx="16" cy="16" r="14" fill="#800000"/>' +
  '<circle cx="15" cy="15" r="13" fill="#ff0000"/>' +
  '<path d="M9 9l12 12M21 9L9 21" stroke="#ffffff" stroke-width="3.5" stroke-linecap="square"/>');

/** Speech bubble with a "?". */
export const ICON_QUESTION = svg(bubble(
  '<path d="M12 10.5C12.2 8.2 13.8 7 16 7c2.3 0 3.9 1.3 3.9 3.3 0 2.6-3.2 2.9-3.2 5.7h-2.6c0-3.6 3-3.7 3-5.6 0-.8-.5-1.3-1.2-1.3-.9 0-1.3.6-1.4 1.5z" fill="#000080"/>' +
  '<rect x="14.1" y="17.8" width="2.8" height="2.8" fill="#000080"/>'));

/** Yellow triangle with a "!". */
export const ICON_EXCLAMATION = svg(
  '<path d="M16 2L30 29H2z" fill="#000000" transform="translate(1 1)"/>' +
  '<path d="M16 2L30 29H2z" fill="#ffff00" stroke="#000000" stroke-width="1.2"/>' +
  '<path d="M14.2 10h3.6l-.6 10h-2.4z" fill="#000000"/>' +
  '<rect x="14.2" y="22" width="3.6" height="3.2" fill="#000000"/>');

/** Speech bubble with an "i". */
export const ICON_INFORMATION = svg(bubble(
  '<rect x="14.2" y="6.5" width="3.6" height="3.4" fill="#000080"/>' +
  '<path d="M12.8 12h5v8h1.8v2.4h-7.2V20h1.8v-5.6h-1.4z" fill="#000080"/>'));

export const MSGBOX_ICONS: Record<MsgIconName, string> = {
  critical: ICON_CRITICAL,
  question: ICON_QUESTION,
  exclamation: ICON_EXCLAMATION,
  information: ICON_INFORMATION,
};

/** Maps the `buttons & 0x70` bits of MsgBox to an icon name (undefined = no icon). */
export function msgIconFromBits(bits: number): MsgIconName | undefined {
  switch (bits & 0x70) {
    case 16: return 'critical';
    case 32: return 'question';
    case 48: return 'exclamation';
    case 64: return 'information';
    default: return undefined;
  }
}
