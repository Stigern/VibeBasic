// MSComm (MSCOMM32.OCX) and SysInfo (SYSINFO.OCX): invisible at run time; in the designer an icon, like the Timer. Original drawings:
// a desk telephone for MSComm, a monitor with an "i" for SysInfo.
import type { Ctx, Renderer } from './render';

const svg32 = (body: string): string =>
  `<svg viewBox="0 0 32 32" width="32" height="32" xmlns="http://www.w3.org/2000/svg" shape-rendering="crispEdges">${body}</svg>`;

const PHONE_SVG = svg32('<path d="M4.5 12.5c0-4 4-6 11.5-6s11.5 2 11.5 6v2h-6v-3h-11v3h-6z" fill="#000" stroke="#000"/>'
  + '<path d="M9.5 15.5h13l3 11h-19z" fill="#c0c0c0" stroke="#000"/>'
  + '<rect x="12" y="18" width="2" height="2" fill="#000"/><rect x="15" y="18" width="2" height="2" fill="#000"/><rect x="18" y="18" width="2" height="2" fill="#000"/>'
  + '<rect x="12" y="21" width="2" height="2" fill="#000"/><rect x="15" y="21" width="2" height="2" fill="#000"/><rect x="18" y="21" width="2" height="2" fill="#000"/>'
  + '<path d="M27 22c2 1 3 3 2 6" stroke="#808080" fill="none"/>');
const SYSINFO_SVG = svg32('<rect x="3.5" y="4.5" width="25" height="18" fill="#c0c0c0" stroke="#000"/><rect x="6" y="7" width="20" height="13" fill="#008080"/>'
  + '<rect x="15" y="9" width="2" height="2" fill="#fff"/><rect x="15" y="12" width="2" height="6" fill="#fff"/><rect x="14" y="17" width="4" height="1" fill="#fff"/>'
  + '<path d="M12.5 22.5v3h7v-3" fill="#c0c0c0" stroke="#000"/><rect x="7.5" y="25.5" width="17" height="3" fill="#c0c0c0" stroke="#000"/>');

export function msCommIcon(c: Ctx): Renderer {
  return { build() { c.el.innerHTML = PHONE_SVG; }, patch() { /* the icon is fixed */ } };
}
export function sysInfoIcon(c: Ctx): Renderer {
  return { build() { c.el.innerHTML = SYSINFO_SVG; }, patch() { /* the icon is fixed */ } };
}
