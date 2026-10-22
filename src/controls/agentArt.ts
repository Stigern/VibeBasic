// The Agent characters: ORIGINAL pixel figures drawn for VibeBasic (32 x 32 pixels, shown three times larger), not copies of any
// Microsoft character. Robby is a boxy 1998 robot with a screen face; Wizard is a small wizard in a green robe with a crooked maroon
// hat, a ginger beard and a staff with a pink crystal.
//
// A figure is made of parts (<g class="p-...">) that the CSS animations in controls.css move: p-all (everything), p-arm-l, p-arm-r
// (turning at the shoulder), p-eyes, p-talk (the open mouth while speaking) and the effects p-think, p-spark, p-bang and p-puff.

type Px = [x: number, y: number, w: number, h: number, fill: string];
const K = '#101010';

const rects = (list: Px[]): string => list.map(([x, y, w, h, f]) => `<rect x="${x}" y="${y}" width="${w}" height="${h}" fill="${f}"/>`).join('');
/** Filled boxes with a one-pixel black outline: all outlines first, then the fills, so touching boxes share one outline. */
const outlined = (list: Px[]): string => rects(list.map(([x, y, w, h]) => [x - 1, y - 1, w + 2, h + 2, K] as Px)) + rects(list);
const part = (cls: string, body: string, origin?: [number, number]): string =>
  `<g class="${cls}"${origin ? ` style="transform-origin:${origin[0]}px ${origin[1]}px"` : ''}>${body}</g>`;

// effects shared by both figures (hidden until an animation shows them)
const sparks = part('p-spark', rects([
  [2, 4, 1, 3, '#ffff00'], [1, 5, 3, 1, '#ffff00'], [28, 8, 1, 3, '#ffff00'], [27, 9, 3, 1, '#ffff00'],
  [4, 16, 1, 1, '#ffffff'], [29, 18, 1, 1, '#ffffff'], [6, 1, 1, 1, '#00ffff'], [25, 1, 1, 1, '#ff00ff'],
]));
const thought = (x: number, y: number): string => part('p-think', outlined([[x, y + 5, 1, 1, '#fff'], [x + 2, y + 2, 2, 2, '#fff'], [x + 4, y - 2, 4, 3, '#fff']]));
const bang = (x: number, y: number): string => part('p-bang', outlined([[x, y, 2, 5, '#ff0000'], [x, y + 6, 2, 2, '#ff0000']]));
const puff = part('p-puff', rects([
  [6, 18, 20, 10, '#ffffff'], [9, 14, 14, 4, '#ffffff'], [4, 21, 24, 5, '#e0e0e0'], [11, 11, 9, 3, '#e0e0e0'],
]));

const ROBBY = [
  thought(24, 4), bang(28, 1), sparks,
  part('p-all', [
    // antenna with its blinking bulb
    rects([[14, 4, 1, 2, K], [17, 4, 1, 2, K], [15, 4, 2, 2, '#808080']]),
    outlined([[15, 1, 2, 2, '#ff0000']]).replace('fill="#ff0000"', 'class="p-bulb" fill="#ff0000"'),
    // treads and legs
    outlined([[9, 29, 14, 2, '#808080'], [12, 27, 2, 1, '#808080'], [18, 27, 2, 1, '#808080']]),
    part('p-wheels', rects([[10, 30, 1, 1, '#c0c0c0'], [13, 30, 1, 1, '#c0c0c0'], [16, 30, 1, 1, '#c0c0c0'], [19, 30, 1, 1, '#c0c0c0'], [22, 30, 1, 1, '#c0c0c0']])),
    // body with the chest panel and its lights
    outlined([[10, 19, 12, 7, '#008080'], [14, 17, 4, 1, '#808080']]),
    rects([[10, 19, 1, 7, '#00b0b0'], [10, 19, 12, 1, '#00b0b0']]),
    outlined([[13, 21, 6, 3, '#c0c0c0']]),
    rects([[14, 22, 1, 1, '#ff0000'], [16, 22, 1, 1, '#ffff00'], [18, 22, 1, 1, '#00ff00']]),
    // arms (turn at the shoulders)
    part('p-arm-l', outlined([[6, 19, 2, 2, '#c0c0c0'], [6, 21, 2, 4, '#c0c0c0'], [5, 25, 4, 1, '#808080']]) + rects([[5, 26, 1, 1, K], [8, 26, 1, 1, K]]), [7, 20]),
    part('p-arm-r', outlined([[24, 19, 2, 2, '#c0c0c0'], [24, 21, 2, 4, '#c0c0c0'], [23, 25, 4, 1, '#808080']]) + rects([[23, 26, 1, 1, K], [26, 26, 1, 1, K]]), [25, 20]),
    // head: ears, the grey box, the screen face
    outlined([[6, 10, 1, 3, '#808080'], [25, 10, 1, 3, '#808080'], [9, 7, 14, 9, '#c0c0c0']]),
    rects([[9, 7, 14, 1, '#ffffff'], [9, 7, 1, 9, '#ffffff'], [9, 15, 14, 1, '#808080'], [22, 7, 1, 9, '#808080']]),
    outlined([[11, 9, 10, 5, '#000080']]),
    part('p-eyes', rects([[12, 10, 2, 2, '#00ffff'], [18, 10, 2, 2, '#00ffff']])),
    part('p-mouth', rects([[13, 13, 1, 1, '#00ffff'], [15, 13, 1, 1, '#00ffff'], [17, 13, 1, 1, '#00ffff'], [19, 13, 1, 1, '#00ffff']])),
    part('p-talk', rects([[14, 12, 4, 2, '#00ffff']])),
  ].join('')),
].join('');

const WIZARD = [
  thought(2, 6), bang(3, 1), sparks,
  part('p-all', [
    // shoes, robe, belt
    outlined([[11, 30, 3, 1, '#603000'], [19, 30, 3, 1, '#603000']]),
    outlined([[10, 16, 13, 5, '#008000'], [9, 21, 15, 5, '#008000'], [8, 26, 17, 4, '#008000']]),
    rects([[10, 17, 1, 4, '#40b040'], [9, 22, 1, 4, '#40b040'], [8, 29, 17, 1, '#005000'], [9, 23, 15, 1, '#ffff00'], [15, 23, 3, 1, '#808000']]),
    // the left sleeve and hand
    part('p-arm-l', outlined([[7, 18, 3, 5, '#008000'], [7, 24, 3, 2, '#ffcc99']]) + rects([[7, 22, 3, 1, '#005000']]), [9, 18]),
    // the face, the beard (with the mouth) and the hat
    outlined([[12, 11, 9, 4, '#ffcc99']]),
    rects([[13, 11, 2, 1, '#e07020'], [18, 11, 2, 1, '#e07020'], [16, 13, 1, 1, '#e0a070'], [12, 13, 1, 1, '#ff9999'], [20, 13, 1, 1, '#ff9999']]),
    part('p-eyes', rects([[14, 12, 1, 1, K], [18, 12, 1, 1, K]])),
    outlined([[12, 14, 9, 2, '#ff8000'], [13, 16, 7, 2, '#ff8000'], [14, 18, 5, 2, '#ff8000'], [15, 20, 3, 1, '#ff8000']]),
    rects([[12, 15, 1, 1, '#c05000'], [20, 15, 1, 1, '#c05000'], [16, 19, 1, 2, '#c05000']]),
    part('p-mouth', rects([[15, 15, 3, 1, '#802000']])),
    part('p-talk', rects([[15, 15, 3, 2, '#400000']])),
    outlined([[20, 1, 2, 1, '#800000'], [18, 2, 3, 1, '#800000'], [16, 3, 4, 2, '#800000'], [15, 5, 5, 2, '#800000'], [14, 7, 6, 2, '#800000'], [9, 9, 15, 2, '#800000']]),
    rects([[9, 9, 15, 1, '#a83030'], [14, 8, 6, 1, '#ffff00'], [17, 3, 1, 1, '#ffff00'], [16, 4, 1, 2, '#ffff00'], [17, 6, 1, 1, '#ffff00']]),
    // the right sleeve with the staff and its crystal
    part('p-arm-r', [
      outlined([[27, 8, 1, 23, '#804000']]),
      outlined([[26, 4, 3, 3, '#ff00ff']]).replace(/fill="#ff00ff"/, 'class="p-orb" fill="#ff00ff"'), rects([[26, 4, 1, 1, '#ffffff']]),
      outlined([[23, 18, 3, 5, '#008000'], [24, 24, 3, 2, '#ffcc99']]), rects([[23, 22, 3, 1, '#005000']]),
    ].join(''), [24, 18]),
  ].join('')),
  puff,
].join('');

const ART: Record<string, string> = { robby: ROBBY, wizard: WIZARD };

/** The figure as an SVG string (viewBox 32 x 32, drawn at `size` pixels). */
export function agentSvg(sprite: string, size: number): string {
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32" width="${size}" height="${size}" shape-rendering="crispEdges" class="ag-${sprite}">${ART[sprite] ?? ROBBY}</svg>`;
}

/** The designer icon of the Agent control: a small robot head with a speech balloon (32 x 32). */
export const AGENT_ICON = '<svg viewBox="0 0 32 32" width="32" height="32" xmlns="http://www.w3.org/2000/svg" shape-rendering="crispEdges">'
  + '<rect x="2.5" y="2.5" width="17" height="11" rx="3" fill="#ffffe1" stroke="#000"/><path d="M7 13.5l-2 4 6-4" fill="#ffffe1" stroke="#000"/>'
  + '<path d="M6 6h10M6 9h7" stroke="#000"/>'
  + '<rect x="15.5" y="17.5" width="13" height="11" fill="#c0c0c0" stroke="#000"/><rect x="17.5" y="19.5" width="9" height="6" fill="#000080" stroke="#000"/>'
  + '<rect x="19" y="21" width="2" height="2" fill="#00ffff"/><rect x="23" y="21" width="2" height="2" fill="#00ffff"/>'
  + '<rect x="21" y="14" width="2" height="3" fill="#808080"/><rect x="20.5" y="12.5" width="3" height="2" fill="#ff0000" stroke="#000"/></svg>';
