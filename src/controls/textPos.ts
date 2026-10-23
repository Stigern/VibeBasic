// A TextBox's text as VB sees it and as the DOM field holds it. VB6 line breaks are CR LF (2 characters); a textarea holds
// LF only, and a single-line input drops line breaks. SelStart / SelLength count VB characters.

/** The field's value for a VB text (multi-line: CR LF and a lone CR become LF; single line: line breaks are dropped). */
export function domText(vb: string, multiLine: boolean): string {
  return multiLine ? vb.replace(/\r\n?/g, '\n') : vb.replace(/[\r\n]/g, '');
}

/** The VB text of a field's value (a textarea's LF line breaks become CR LF). */
export function vbText(dom: string, multiLine: boolean): string {
  return multiLine ? dom.replace(/\r?\n/g, '\r\n') : dom;
}

/** A position in the VB text as a position in the field's value. */
export function domPos(vb: string, pos: number, multiLine: boolean): number {
  return domText(vb.slice(0, Math.max(0, pos)), multiLine).length;
}

/** A position in the field's value as a position in `vb` (the VB text that value shows). */
export function vbPos(vb: string, pos: number, multiLine: boolean): number {
  let i = 0;
  for (let d = 0; i < vb.length && d < pos;) {
    const ch = vb[i];
    if (ch === '\r' && vb[i + 1] === '\n') { i += 2; if (multiLine) d++; }
    else if (ch === '\r' || ch === '\n') { i++; if (multiLine) d++; }
    else { i++; d++; }
  }
  return i;
}
