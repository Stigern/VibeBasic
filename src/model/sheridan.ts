// Sheridan 3D Controls (THREED32.OCX): the pure parts of SSPanel, SSCommand, SSCheck, SSOption, SSFrame and SSRibbon,
// i.e. the Win98 bevels, the Font3D text shadows, the flood bar and the SSRibbon groups.

/** A CSS `box-shadow` that draws a Win98 bevel `width` pixels wide inside the box. `kind`: 0 none, 1 inset (sunken), 2 raised. */
export function bevelShadow(kind: number, width: number): string {
  const w = Math.max(1, Math.round(width));
  if (kind !== 1 && kind !== 2) return 'none';
  const raised = kind === 2;
  // [top-left, bottom-right] per layer: a single layer is plain, two or more are the 98.css double bevel
  const pairs: [string, string][] = w === 1
    ? [raised ? ['#fff', '#808080'] : ['#808080', '#fff']]
    : raised ? [['#fff', '#0a0a0a'], ['#dfdfdf', '#808080']] : [['#808080', '#fff'], ['#0a0a0a', '#dfdfdf']];
  const layers: string[] = [];
  for (let i = 1; i <= w; i++) {
    const [tl, br] = pairs[Math.min(i, pairs.length) - 1];
    layers.push(`inset ${i}px ${i}px 0 ${tl}`, `inset -${i}px -${i}px 0 ${br}`);
  }
  return layers.join(', ');
}

/** Font3D: 0 none, 1 raised light, 2 raised heavy, 3 inset light, 4 inset heavy, as a CSS `text-shadow` (1 px light / dark; heavy 2 px). */
export function font3dShadow(n: number): string {
  switch (n) {
    case 1: return '-1px -1px 0 #fff, 1px 1px 0 #808080';
    case 2: return '-1px -1px 0 #fff, -2px -2px 0 #fff, 1px 1px 0 #808080, 2px 2px 0 #808080';
    case 3: return '1px 1px 0 #fff, -1px -1px 0 #808080';
    case 4: return '1px 1px 0 #fff, 2px 2px 0 #fff, -1px -1px 0 #808080, -2px -2px 0 #808080';
    default: return '';
  }
}

/** SSPanel Alignment 0-8 (Left / Right / Center, each Top / Middle / Bottom) as flexbox values. */
export function panelAlign(n: number): { justify: string; align: string } {
  const a = Math.max(0, Math.min(8, Math.floor(n) || 0));
  const col = Math.floor(a / 3), row = a % 3;
  return { justify: ['flex-start', 'flex-end', 'center'][col], align: ['flex-start', 'center', 'flex-end'][row] };
}

/** The flood bar of an SSPanel as CSS in percent of the panel's inner area; null when nothing is flooded.
 *  FloodType 1 left to right, 2 right to left, 3 top to bottom, 4 bottom to top, 5 widening circle (clipped to a circle). */
export function floodBox(type: number, percent: number): { left: string; top: string; width: string; height: string; clipPath: string } | null {
  const p = Math.max(0, Math.min(100, Math.round(percent) || 0));
  if (p === 0 || type < 1 || type > 5) return null;
  const box = { left: '0%', top: '0%', width: '100%', height: '100%', clipPath: '' };
  switch (type) {
    case 1: box.width = `${p}%`; break;
    case 2: box.left = `${100 - p}%`; box.width = `${p}%`; break;
    case 3: box.height = `${p}%`; break;
    case 4: box.top = `${100 - p}%`; box.height = `${p}%`; break;
    default: box.clipPath = `circle(${(p * Math.SQRT1_2).toFixed(2)}% at 50% 50%)`;   // 100 % reaches the corners
  }
  return box;
}

/** A click on an SSRibbon. `group` 0 is a plain toggle. In a group (same container, same GroupNumber above 0) a click presses the
 *  ribbon and releases the others (`release`: the ids of the ones that are down); a click on the pressed one releases it when
 *  GroupAllowAllUp is True. */
export function ribbonClick(self: { value: boolean; group: number; allowAllUp: boolean }, peersDown: readonly string[]): { value: boolean; release: string[] } {
  if (self.group <= 0) return { value: !self.value, release: [] };
  if (self.value) return { value: !self.allowAllUp, release: [] };
  return { value: true, release: [...peersDown] };
}
