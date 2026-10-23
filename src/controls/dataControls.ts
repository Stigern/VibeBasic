// Rendering of the data controls: the Data control and the ADO Data Control (the arrow bar |< < Caption > >|).
// Run mode: a click on an arrow dispatches `vbuseraction` { nav: 'first' | 'previous' | 'next' | 'last' }; the run session moves
// the recordset (run/data/dataControl.ts).
import { h } from '../ui98/dom';
import type { Ctx, Renderer } from './render';

const SVG = 'http://www.w3.org/2000/svg';

/** A black arrow glyph: `bar` draws the |< / >| stop line, `dir` is the direction. */
function arrow(dir: 'left' | 'right', bar: boolean): SVGSVGElement {
  const svg = document.createElementNS(SVG, 'svg');
  svg.setAttribute('width', '8');
  svg.setAttribute('height', '8');
  svg.setAttribute('viewBox', '0 0 8 8');
  svg.setAttribute('shape-rendering', 'crispEdges');
  const path = document.createElementNS(SVG, 'path');
  // a triangle 4 wide, 7 high, plus a 1-pixel bar at the outer side
  const tri = dir === 'left' ? 'M6 0.5 L2 4 L6 7.5 Z' : 'M2 0.5 L6 4 L2 7.5 Z';
  const stop = !bar ? '' : dir === 'left' ? ' M0.5 0.5 H1.5 V7.5 H0.5 Z' : ' M6.5 0.5 H7.5 V7.5 H6.5 Z';
  path.setAttribute('d', tri + stop);
  path.setAttribute('fill', 'currentColor');
  svg.appendChild(path);
  return svg;
}

export function dataBar(c: Ctx): Renderer {
  let root: HTMLElement, caption: HTMLElement;
  const btn = (nav: string, dir: 'left' | 'right', bar: boolean): HTMLElement =>
    h('div', { class: 'vb-data-btn', dataset: { nav } }, arrow(dir, bar));
  return {
    build() {
      caption = h('div', { class: 'vb-data-caption' });
      root = h('div', { class: 'vb-data' },
        btn('first', 'left', true), btn('previous', 'left', false), caption, btn('next', 'right', false), btn('last', 'right', true));
      c.el.replaceChildren(root);
      if (c.mode !== 'run') return;
      c.setInput(root);
      root.addEventListener('click', e => {
        const b = (e.target as Element).closest<HTMLElement>('.vb-data-btn');
        if (b && root.getAttribute('aria-disabled') !== 'true') c.fire('vbuseraction', { nav: b.dataset.nav });
      });
    },
    patch(k) {
      if (k === null || k.has('Caption')) caption.textContent = c.str('Caption');
      if (k === null || k.has('BackColor')) caption.style.backgroundColor = c.color('BackColor');
    },
    bg: () => null,
  };
}
