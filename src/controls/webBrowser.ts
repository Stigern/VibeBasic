// WebBrowser (SHDOCVW.DLL), Inet (MSINET.OCX) and Winsock (MSWINSCK.OCX) renderers.
//
// The WebBrowser is a sandboxed iframe. The run session sends `Src` with a sequence number `NavSeq`; when the iframe has loaded
// that page the view fires `vbwebload` { seq } (the window reports it, and the run session raises NavigateComplete2 and
// DocumentComplete). Only http(s) pages and about:blank are shown, never a page of the app's own origin: with
// `allow-same-origin` such a page could reach the form window (and its IPC), so it is refused here as well as in the run session.
// about:blank gets the strictest sandbox (an opaque origin, no scripts). Inet and Winsock are designer icons only.
import { h } from '../ui98/dom';
import type { Ctx, Renderer } from './render';

/** The sandbox an iframe gets for `url`; null when the URL must not be shown. */
export function frameSandbox(url: string, appOrigin: string): string | null {
  if (/^about:blank$/i.test(url.trim())) return '';
  let u: URL;
  try { u = new URL(url); } catch { return null; }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') return null;
  if (u.origin === appOrigin) return null;
  return 'allow-scripts allow-forms allow-same-origin';
}

const GLOBE = '<circle cx="16" cy="17" r="9" fill="#00a0e0" stroke="#000080" stroke-width="1.5"/>'
  + '<path d="M7 17h18M16 8v18M12 9.5c-3 4.5-3 10.5 0 15M20 9.5c3 4.5 3 10.5 0 15M9 12.5h14M9 21.5h14" stroke="#000080" fill="none"/>';
const svg32 = (body: string): string =>
  `<svg viewBox="0 0 32 32" width="32" height="32" xmlns="http://www.w3.org/2000/svg" shape-rendering="crispEdges">${body}</svg>`;
const INET_SVG = svg32(GLOBE + '<path d="M25 18v8M21.500 23l3.500 4 3.500-4" stroke="#008000" stroke-width="2.500" fill="none"/>');
const WINSOCK_SVG = svg32('<rect x="2.5" y="4.5" width="11" height="9" fill="#c0c0c0" stroke="#000"/><rect x="4" y="6" width="8" height="6" fill="#008080"/>'
  + '<rect x="18.5" y="18.5" width="11" height="9" fill="#c0c0c0" stroke="#000"/><rect x="20" y="20" width="8" height="6" fill="#008080"/>'
  + '<path d="M8 13.5v9h10.5M13.5 9h10v9.5" stroke="#000" fill="none" stroke-width="1.5"/><path d="M5 15.5h6M21 29.5h6" stroke="#000"/>');

/** Invisible at run time; in the designer an icon, like the Timer. */
export function inetIcon(c: Ctx): Renderer {
  return { build() { c.el.innerHTML = INET_SVG; }, patch() { /* the icon is fixed */ } };
}
export function winsockIcon(c: Ctx): Renderer {
  return { build() { c.el.innerHTML = WINSOCK_SVG; }, patch() { /* the icon is fixed */ } };
}

export function webBrowser(c: Ctx): Renderer {
  let frame: HTMLIFrameElement | null = null;
  let waiting = 0;   // the NavSeq whose load has not been reported yet
  return {
    build() {
      if (c.mode === 'design') {   // a white, sunken area as in VB6
        c.el.replaceChildren(h('div', { class: 'vb-web-design' }));
        return;
      }
      frame = h('iframe', { class: 'vb-web-frame', title: 'WebBrowser' }) as HTMLIFrameElement;
      frame.setAttribute('sandbox', '');
      frame.setAttribute('referrerpolicy', 'no-referrer');
      frame.setAttribute('allow', '');
      frame.addEventListener('load', () => {
        if (!waiting || !frame) return;
        const seq = waiting;
        waiting = 0;
        c.fire('vbwebload', { seq });
      });
      c.el.replaceChildren(frame);
      c.setInput(frame);
    },
    patch(k) {
      if (!frame || (k !== null && !k.has('NavSeq'))) return;   // k null: the first render (a Navigate in Form_Load)
      const url = c.str('Src'), seq = c.num('NavSeq');
      if (!url || !seq) return;
      const sandbox = frameSandbox(url, c.el.ownerDocument.defaultView?.location.origin ?? '');
      if (sandbox === null) return;
      waiting = seq;
      frame.setAttribute('sandbox', sandbox);   // applies to the navigation below
      frame.src = url;
    },
    bg: () => null,
  };
}
