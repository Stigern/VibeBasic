// A small 1998-style animation for the AI waiting dialog (in the spirit of the Win98 "Copying files" dialog):
// a pixel-art AI head thinks (blinking eyes, rising thought bubbles) or writes (code sheets fly in an arc to a
// Win98 monitor whose green code lines light up). Inline SVG, no images; driven by one timer that `dispose` stops.

export type AiPhase = 'thinking' | 'writing';

const TICK_MS = 90;
const W = 260, H = 60;
const PX = 4;                                   // size of one "big pixel" in the head
const HEAD_X = 10, HEAD_Y = 12;
const HEAD = [                                  // k black, g silver, d grey, w white, b navy
  '....bb....',
  '.....k....',
  '.kkkkkkkk.',
  '.kwggggdk.',
  '.kgggggdk.',
  '.kgggggdk.',
  '.kgggggdk.',
  '.kgkkkkdk.',
  '.kgggggdk.',
  '.kddddddk.',
  '..kkkkkk..',
];
const COLORS: Record<string, string> = { k: '#000', g: '#c0c0c0', d: '#808080', w: '#fff', b: '#000080' };
const SHEETS = 3;
const SHEET_W = 12, SHEET_H = 14;
const FROM_X = 52, TO_X = 196, BASE_Y = 30, ARC = 22;   // the arc of a flying sheet, head to monitor

const rect = (x: number, y: number, w: number, hh: number, fill: string, extra = '') =>
  `<rect x="${x}" y="${y}" width="${w}" height="${hh}" fill="${fill}" ${extra}/>`;

function headPixels(): string {
  let out = '';
  HEAD.forEach((row, r) => [...row].forEach((ch, c) => {
    if (ch !== '.') out += rect(HEAD_X + c * PX, HEAD_Y + r * PX, PX, PX, COLORS[ch]);
  }));
  return out;
}

function sheetMarkup(): string {
  let lines = '';
  for (let i = 0; i < 4; i++) lines += rect(2, 3 + i * 3, i === 3 ? 4 : 8, 1, '#000080');
  return `<g class="ai-sheet" opacity="0">${rect(0, 0, SHEET_W, SHEET_H, '#fff', 'stroke="#000" stroke-width="1" shape-rendering="crispEdges"')}${lines}</g>`;
}

function markup(): string {
  let bubbles = '', sheets = '', code = '';
  for (let i = 0; i < 3; i++) bubbles += `<rect class="ai-bubble" width="2" height="2" fill="#fff" stroke="#000" stroke-width="1" opacity="0"/>`;
  for (let i = 0; i < SHEETS; i++) sheets += sheetMarkup();
  for (let i = 0; i < 3; i++) code += `<rect class="ai-codeline" x="209" y="${29 + i * 4}" width="${[26, 18, 22][i]}" height="2" fill="#00ff00" opacity="0"/>`;
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}" shape-rendering="crispEdges" aria-hidden="true">`
    + rect(0, 0, W, H, '#008080')
    // head, with eyes drawn over the face
    + headPixels()
    + `<g class="ai-eyes">${rect(18, 28, 8, 8, '#000080', 'class="ai-eye"')}${rect(30, 28, 8, 8, '#000080', 'class="ai-eye"')}`
    + `${rect(19, 29, 2, 2, '#fff', 'class="ai-shine"')}${rect(31, 29, 2, 2, '#fff', 'class="ai-shine"')}</g>`
    + bubbles + sheets
    // monitor
    + rect(200, 6, 56, 42, '#c0c0c0', 'stroke="#000" stroke-width="1"')
    + rect(201, 7, 54, 40, '#fff') + rect(202, 8, 53, 39, '#808080') + rect(202, 8, 52, 38, '#c0c0c0')
    + rect(205, 11, 46, 30, '#000')
    + rect(209, 15, 2, 2, '#00ff00') + rect(211, 17, 2, 2, '#00ff00') + rect(213, 19, 2, 2, '#00ff00')
    + rect(211, 21, 2, 2, '#00ff00') + rect(209, 23, 2, 2, '#00ff00')
    + rect(217, 23, 6, 2, '#00ff00', 'class="ai-cursor"')
    + code
    + rect(210, 48, 36, 3, '#808080') + rect(204, 51, 48, 4, '#c0c0c0', 'stroke="#000" stroke-width="1"')
    + '</svg>';
}

const reducedMotion = (doc: Document): boolean => {
  try { return doc.defaultView?.matchMedia?.('(prefers-reduced-motion: reduce)').matches === true; } catch { return false; }
};

const STILL_TICK = 5;

/** The element goes into the dialog; `setPhase` switches between thinking and writing; `dispose` stops the timer. */
export function createAiAnimation(doc: Document): { el: HTMLElement; setPhase(p: AiPhase): void; dispose(): void } {
  const el = doc.createElement('div');
  el.className = 'ai-anim';
  el.style.cssText = `width:${W}px;height:${H}px;margin:0 auto 8px;box-shadow:inset -1px -1px #fff,inset 1px 1px #808080,inset -2px -2px #dfdfdf,inset 2px 2px #000;`
    + 'box-sizing:content-box;overflow:hidden';
  el.innerHTML = markup();
  el.setAttribute('role', 'img');
  el.setAttribute('aria-label', 'The AI is working');
  const all = (sel: string) => [...el.querySelectorAll<SVGElement>(sel)];
  const eyes = all('.ai-eye'), shines = all('.ai-shine'), bubbles = all('.ai-bubble'), sheets = all('.ai-sheet');
  const lines = all('.ai-codeline'), cursor = el.querySelector('.ai-cursor')!;

  let phase: AiPhase = 'thinking';
  let tick = 0;
  const render = (): void => {
    const thinking = phase === 'thinking';
    // Eyes: blink now and then while thinking; wide open and looking at the monitor while writing.
    const shut = thinking && tick % 14 < 2;
    eyes.forEach(e => { e.setAttribute('y', shut ? '32' : '28'); e.setAttribute('height', shut ? '2' : '8'); });
    shines.forEach((s, i) => { s.setAttribute('x', String((thinking ? 19 : 23) + i * 12)); s.setAttribute('opacity', shut ? '0' : '1'); });
    // Thought bubbles rise and grow while thinking.
    bubbles.forEach((b, i) => {
      const p = (tick + i * 4) % 12;
      const s = 2 + Math.floor(p / 4) * 2;
      b.setAttribute('width', String(s)); b.setAttribute('height', String(s));
      b.setAttribute('x', String(46 + p + i * 2)); b.setAttribute('y', String(10 - p));
      b.setAttribute('opacity', thinking ? (p > 9 ? '0.4' : '1') : '0');
    });
    // Code sheets: parked and faint while thinking, flying in an arc from the head to the monitor while writing.
    sheets.forEach((g, i) => {
      const t = thinking ? 0.15 + i * 0.3 : ((tick * 0.07) + i / SHEETS) % 1;
      const x = Math.round(FROM_X + t * (TO_X - FROM_X) - SHEET_W / 2);
      const y = Math.round(BASE_Y - ARC * 4 * t * (1 - t) - SHEET_H / 2);
      g.setAttribute('transform', `translate(${x} ${y})`);
      g.setAttribute('opacity', thinking ? '0.3' : t > 0.92 ? '0' : '1');
    });
    // Monitor: blinking cursor; green code lines light up one by one, then start over.
    cursor.setAttribute('opacity', tick % 8 < 4 ? '1' : '0');
    const lit = thinking ? 0 : 1 + Math.floor(tick / 5) % 4;   // 1, 2, 3 lines, then a blank screen for a moment
    lines.forEach((l, i) => l.setAttribute('opacity', i < lit ? '1' : '0'));
  };
  const setAttr = (): void => { el.dataset.phase = phase; el.classList.toggle('ai-anim-writing', phase === 'writing'); };

  let timer: ReturnType<typeof setInterval> | null = null;
  const mq = (() => { try { return doc.defaultView?.matchMedia?.('(prefers-reduced-motion: reduce)') ?? null; } catch { return null; } })();
  const stop = (): void => { if (timer !== null) { clearInterval(timer); timer = null; } };
  const sync = (): void => {
    stop();
    if (reducedMotion(doc)) { tick = STILL_TICK; render(); return; }
    timer = setInterval(() => { tick++; render(); }, TICK_MS);
  };
  const onMotionChange = (): void => sync();
  mq?.addEventListener?.('change', onMotionChange);

  setAttr(); render(); sync();
  return {
    el,
    setPhase(p) { if (p === phase) return; phase = p; setAttr(); render(); },
    dispose() { stop(); mq?.removeEventListener?.('change', onMotionChange); },
  };
}
