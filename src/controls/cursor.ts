// MousePointer (0 .. 15, 99) as a CSS cursor. The hourglass, the up arrow and the icon pointer have no CSS keyword that looks like
// Windows 98's: they are drawn here as small SVG cursors (a data URL, 32 x 32, with the hotspot where Windows has it).

/** The values of the MousePointer property with their VB6 names (the registry's enum and the constants vbArrow ... vbCustom). */
export const MOUSE_POINTERS: [number, string][] = [
  [0, 'Default'], [1, 'Arrow'], [2, 'Cross'], [3, 'I-Beam'], [4, 'Icon'], [5, 'Size'], [6, 'Size NE SW'], [7, 'Size N S'], [8, 'Size NW SE'],
  [9, 'Size W E'], [10, 'Up Arrow'], [11, 'Hourglass'], [12, 'No Drop'], [13, 'Arrow and Hourglass'], [14, 'Arrow and Question'], [15, 'Size All'],
  [99, 'Custom'],
];

const KEYWORD: Record<number, string> = {
  1: 'default', 2: 'crosshair', 3: 'text', 5: 'move', 6: 'nesw-resize', 7: 'ns-resize', 8: 'nwse-resize', 9: 'ew-resize',
  12: 'not-allowed', 13: 'progress', 14: 'help', 15: 'move',
};

const svgCursor = (body: string, x: number, y: number, fallback: string): string =>
  `url("data:image/svg+xml,${encodeURIComponent(`<svg xmlns="http://www.w3.org/2000/svg" width="32" height="32" shape-rendering="crispEdges">${body}</svg>`)}") ${x} ${y}, ${fallback}`;

/** Windows 98 hourglass: black bars, a white glass with grey sand. */
const HOURGLASS = svgCursor(
  '<rect x="8" y="3" width="16" height="3" fill="#000"/><rect x="8" y="26" width="16" height="3" fill="#000"/>'
  + '<polygon points="10,6 22,6 16,15 16,17 22,26 10,26 16,17 16,15" fill="#fff" stroke="#000" stroke-width="1"/>'
  + '<polygon points="13,8 19,8 16,14" fill="#808080"/><polygon points="16,19 21,25 11,25" fill="#808080"/>', 16, 16, 'wait');
/** The up arrow: a black arrow with a white edge, hotspot at its tip. */
const UP_ARROW = svgCursor('<polygon points="16,1 6,13 13,13 13,30 19,30 19,13 26,13" fill="#000" stroke="#fff" stroke-width="1"/>', 16, 1, 'n-resize');
/** The icon pointer: a small square inside a square. */
const ICON_POINTER = svgCursor(
  '<rect x="9" y="9" width="14" height="14" fill="#fff" stroke="#000" stroke-width="1"/><rect x="13" y="13" width="6" height="6" fill="#fff" stroke="#000" stroke-width="1"/>', 16, 16, 'default');

/**
 * The CSS cursor of a MousePointer value; '' for 0 (the control's own cursor). 99 shows `icon` (the data URL of MouseIcon) and
 * is the arrow while there is none or the browser cannot use the picture.
 */
export function cursorCss(pointer: number, icon: string | null = null): string {
  if (pointer === 0) return '';
  if (pointer === 99) return icon ? `url(${JSON.stringify(icon)}) 0 0, default` : 'default';
  if (pointer === 11) return HOURGLASS;
  if (pointer === 10) return UP_ARROW;
  if (pointer === 4) return ICON_POINTER;
  return KEYWORD[pointer] ?? '';
}
