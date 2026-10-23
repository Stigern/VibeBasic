// Rendering of the Sheridan 3D controls (THREED32.OCX): SSPanel, SSFrame, SSCommand and SSRibbon. SSCheck and SSOption use the
// CheckBox / OptionButton renderers (render.ts). Bevels are `box-shadow` layers (model/sheridan.ts).
//  - SSPanel / SSFrame: containers like Frame (`childHost`).
//  - SSCommand / SSRibbon: a <button> as inputEl; the window handles the clicks (SSRibbon: Value and its group).
import { bevelShadow, floodBox, font3dShadow, panelAlign } from '../model/sheridan';
import { h, mnemonicNodes } from '../ui98/dom';
import type { Ctx, Renderer } from './render';

type Keys = ReadonlySet<string> | null;
const has = (k: Keys, ...names: string[]): boolean => k === null || names.some(n => k.has(n));

/** SSPanel: an outer and an inner bevel (BevelOuter / BevelInner, BevelWidth, a BorderWidth gap between them), the flood bar under
 *  the caption (or the percentage), and a host for the children. */
export function ssPanel(c: Ctx): Renderer {
  let outer: HTMLElement, inner: HTMLElement, flood: HTMLElement, box: HTMLElement, caption: HTMLElement;
  /** Pixels between the panel's edge and its content (both bevels and the border). */
  const inset = (): number => {
    const bw = Math.max(1, c.num('BevelWidth'));
    return (c.num('BevelOuter') ? bw : 0) + Math.max(0, c.num('BorderWidth')) + (c.num('BevelInner') ? bw : 0);
  };
  function layout() {
    const bw = Math.max(1, c.num('BevelWidth')), out = c.num('BevelOuter') ? bw : 0, gap = out + Math.max(0, c.num('BorderWidth'));
    outer.style.boxShadow = bevelShadow(c.num('BevelOuter'), bw);
    Object.assign(inner.style, { left: `${gap}px`, top: `${gap}px`, right: `${gap}px`, bottom: `${gap}px`, boxShadow: bevelShadow(c.num('BevelInner'), bw) });
    const n = inset(), auto = c.num('AutoSize') > 0;
    const edges = auto ? { left: '', top: '', right: '', bottom: '', padding: `${n + 2}px` } : { left: `${n}px`, top: `${n}px`, right: `${n}px`, bottom: `${n}px`, padding: '2px' };
    Object.assign(box.style, edges);
    Object.assign(flood.parentElement!.style, { left: `${n}px`, top: `${n}px`, right: `${n}px`, bottom: `${n}px` });
  }
  const pct = (): number => Math.max(0, Math.min(100, Math.round(c.num('FloodPercent'))));
  function paintText() {
    const shown = c.bool('FloodShowPct') && c.num('FloodType') > 0;
    if (shown) caption.textContent = `${pct()}%`; else caption.replaceChildren(...mnemonicNodes(c.str('Caption')));
  }
  function paintFlood() {
    const b = floodBox(c.num('FloodType'), pct());
    flood.style.display = b ? '' : 'none';
    flood.dataset.flood = b ? `${c.num('FloodType')}:${pct()}` : '';
    if (!b) return;
    Object.assign(flood.style, { left: b.left, top: b.top, width: b.width, height: b.height, clipPath: b.clipPath, backgroundColor: c.color('FloodColor') });
  }
  return {
    build() {
      outer = h('div', { class: 'ssp-outer' });
      inner = h('div', { class: 'ssp-inner' });
      flood = h('div', { class: 'ssp-flood' });
      caption = h('span', { class: 'ssp-caption' });
      box = h('div', { class: 'ssp-text' }, caption);
      const host = h('div', { class: 'vb-host' });
      c.el.replaceChildren(outer, inner, h('div', { class: 'ssp-flood-area' }, flood), box, host);
      c.setHost(host);
    },
    patch(k) {
      if (has(k, 'BevelOuter', 'BevelInner', 'BevelWidth', 'BorderWidth', 'AutoSize')) layout();
      if (has(k, 'Caption', 'FloodShowPct', 'FloodType', 'FloodPercent')) paintText();
      if (has(k, 'FloodType', 'FloodPercent', 'FloodColor')) paintFlood();
      if (has(k, 'Alignment')) { const a = panelAlign(c.num('Alignment')); box.style.justifyContent = a.justify; box.style.alignItems = a.align; }
      if (has(k, 'Font3D')) caption.style.textShadow = font3dShadow(c.num('Font3D'));
      if (has(k, 'RoundedCorners')) c.el.classList.toggle('ss-round', c.bool('RoundedCorners'));
      if (has(k, 'Outline')) c.el.classList.toggle('ss-outline', c.bool('Outline'));
      if (has(k, 'AutoSize', 'Width', 'Height')) {
        const a = c.num('AutoSize');
        c.el.classList.toggle('ssp-auto', a > 0);
        c.applySize();
        if (a === 1) c.el.style.width = 'auto'; else if (a === 2) c.el.style.height = 'auto';
      }
    },
  };
}

/** SSFrame: a Frame whose box is ShadowStyle inset (etched) or raised, with the caption at the left, right or centre. */
export function ssFrame(c: Ctx): Renderer {
  let legend: HTMLElement;
  return {
    build() {
      legend = h('span', { class: 'vb-frame-legend' });
      const host = h('div', { class: 'vb-host' });
      c.el.replaceChildren(h('div', { class: 'vb-frame-box' }), legend, host);
      c.setHost(host);
    },
    patch(k) {
      if (has(k, 'Caption')) {
        legend.replaceChildren(...mnemonicNodes(c.str('Caption')));
        legend.classList.toggle('vb-empty', c.str('Caption') === '');
      }
      if (has(k, 'BackColor')) legend.style.backgroundColor = c.color('BackColor');
      if (has(k, 'Alignment')) {
        const a = c.num('Alignment');
        Object.assign(legend.style, { left: a === 0 ? '8px' : a === 2 ? '50%' : 'auto', right: a === 1 ? '8px' : 'auto', transform: a === 2 ? 'translateX(-50%)' : '' });
      }
      if (has(k, 'ShadowStyle')) c.el.classList.toggle('ssf-raised', c.num('ShadowStyle') === 1);
      if (has(k, 'Font3D')) legend.style.textShadow = font3dShadow(c.num('Font3D'));
    },
  };
}

/** The button body SSCommand and SSRibbon share: a <button> with the picture and the caption, bevel width, Font3D, Outline and
 *  RoundedCorners. `down` is the pressed look (the SSRibbon's Value; SSCommand's comes from :active in CSS). */
function threeDButton(c: Ctx, ribbon: boolean): Renderer {
  let btn: HTMLButtonElement, img: HTMLImageElement, cap: HTMLElement;
  const picture = (): string | null => (ribbon && c.bool('Value') ? c.pic('PictureDn') : null) ?? c.pic(ribbon ? 'PictureUp' : 'Picture');
  function paintPicture() {
    const u = picture();
    img.style.display = u ? '' : 'none';
    if (u) img.src = u; else img.removeAttribute('src');
  }
  function paintBevel() {
    const bw = Math.max(1, c.num('BevelWidth'));
    btn.style.setProperty('--ssc-up', bevelShadow(2, bw));
    btn.style.setProperty('--ssc-dn', bevelShadow(1, bw));
  }
  /** SSCommand AutoSize: 1 stretches the picture over the button, 2 sizes the button to the picture. */
  function paintAutoSize() {
    const a = ribbon ? 0 : c.num('AutoSize');
    btn.classList.toggle('ssc-fit', a === 1 && !!picture());
    c.applySize();
    if (a === 2 && picture() && img.naturalWidth > 0) {
      const pad = 2 * (Math.max(1, c.num('BevelWidth')) + 2);
      c.el.style.width = `${img.naturalWidth + pad}px`;
      c.el.style.height = `${img.naturalHeight + pad}px`;
    }
  }
  return {
    build() {
      img = h('img', { class: 'ssc-pic', draggable: 'false', alt: '' });
      cap = h('span', { class: 'ssc-cap' });
      btn = h('button', { type: 'button', class: `vb-btn ssc${ribbon ? ' ssr' : ''}` }, img, cap);
      img.addEventListener('load', paintAutoSize);
      c.el.replaceChildren(btn);
      c.setInput(btn);
    },
    patch(k) {
      if (has(k, 'Caption')) cap.replaceChildren(...mnemonicNodes(c.str('Caption')));
      if (has(k, 'Picture', 'PictureUp', 'PictureDn', 'Value')) paintPicture();
      if (has(k, 'BevelWidth')) paintBevel();
      if (has(k, 'Value') && ribbon) btn.classList.toggle('down', c.bool('Value'));
      if (has(k, 'Font3D')) cap.style.textShadow = font3dShadow(c.num('Font3D'));
      if (has(k, 'BackColor')) btn.style.backgroundColor = c.color('BackColor');
      if (has(k, 'RoundedCorners')) c.el.classList.toggle('ss-round', c.bool('RoundedCorners'));
      if (has(k, 'Outline')) c.el.classList.toggle('ss-outline', c.bool('Outline'));
      if (has(k, 'AutoSize', 'Picture', 'Width', 'Height', 'BevelWidth')) paintAutoSize();
    },
    bg: () => null,
  };
}

export const ssCommand = (c: Ctx): Renderer => threeDButton(c, false);
export const ssRibbon = (c: Ctx): Renderer => threeDButton(c, true);
