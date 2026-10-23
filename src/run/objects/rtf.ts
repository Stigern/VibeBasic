// RichTextBox: the runs and paragraph formats of the control as RTF (TextRTF, SelRTF, SaveFile) and back (LoadFile). A subset of
// RTF 1.x: the font table and the colour table, \f \fs \cf, \b \i \ul \strike, \par \tab \line, \qc \ql \qr, \li \ri \fi, bullets,
// \uN and \'hh. Whatever else a file holds (pictures, styles, tables, fields) is skipped, its text kept where it is plain.

import { chr1252 } from '../../lang/builtins/strings';
import { vbColorToCss } from '../../model/colors';
import { RTF_KEYS, trimParas, type ParaFmt, type Paras, type Run, type RtfFormat, type RtfPatch } from '../../controls/richText';

export interface RtfDoc { runs: Run[]; paras: Paras }

const rgbOf = (c: number): [number, number, number] => {
  const css = vbColorToCss(c);
  return [parseInt(css.slice(1, 3), 16), parseInt(css.slice(3, 5), 16), parseInt(css.slice(5, 7), 16)];
};

/** The text of a run, or of a paragraph's part of it, as RTF (a line break is not here: the caller splits at it). */
function escapeText(s: string): string {
  let out = '';
  for (let i = 0; i < s.length; i++) {
    const ch = s[i], c = s.charCodeAt(i);
    if (ch === '\\' || ch === '{' || ch === '}') out += '\\' + ch;
    else if (ch === '\t') out += '\\tab ';
    else if (c >= 0x20 && c < 0x7f) out += ch;
    else out += `\\u${c > 32767 ? c - 65536 : c}?`;
  }
  return out;
}

/** The control's content as an RTF document. `base` is the control's own format (the document's default). */
export function toRtf(runs: Run[], paras: Paras, base: RtfFormat): string {
  const fonts = [base.fontName], colors: number[] = [];
  const colorIndex = (c: number): number => {
    const key = vbColorToCss(c);
    let i = colors.findIndex(x => vbColorToCss(x) === key);
    if (i < 0) { colors.push(c); i = colors.length - 1; }
    return i + 1;
  };
  const fontIndex = (n: string): number => { let i = fonts.indexOf(n); if (i < 0) { fonts.push(n); i = fonts.length - 1; } return i; };
  const baseColor = colorIndex(base.color);
  // pieces of the body, so the tables (which the runs add to) can be written first
  const body: string[] = [];
  const ps = trimParas(paras);
  let para = 0;
  const startPara = (): void => {
    const f: ParaFmt = ps[para] ?? {};
    const indent = f.indent ?? 0, hang = f.hanging ?? 0;
    let s = '\\pard';
    if (f.align === 1) s += '\\qr'; else if (f.align === 2) s += '\\qc';
    if (indent + hang !== 0) s += `\\li${indent + hang}`;
    if (hang !== 0) s += `\\fi${-hang}`;
    if (f.rightIndent) s += `\\ri${f.rightIndent}`;
    body.push(s + ' ');
    if (f.bullet) body.push("{\\*\\pn\\pnlvlblt\\pnf0\\pnindent0{\\pntxtb\\'B7}}");
  };
  startPara();
  for (const r of runs) {
    const pieces = r.text.split('\n');
    pieces.forEach((piece, i) => {
      if (i > 0) { body.push('\\par '); para++; startPara(); }
      if (piece === '') return;
      const f = r.fmt;
      let ctl = '';
      if (f.bold !== undefined) ctl += f.bold ? '\\b' : '\\b0';
      if (f.italic !== undefined) ctl += f.italic ? '\\i' : '\\i0';
      if (f.underline !== undefined) ctl += f.underline ? '\\ul' : '\\ulnone';
      if (f.strike !== undefined) ctl += f.strike ? '\\strike' : '\\strike0';
      if (f.color !== undefined) ctl += `\\cf${colorIndex(f.color)}`;
      if (f.fontName !== undefined) ctl += `\\f${fontIndex(f.fontName)}`;
      if (f.fontSize !== undefined) ctl += `\\fs${Math.round(f.fontSize * 2)}`;
      body.push(ctl === '' ? escapeText(piece) : `{${ctl} ${escapeText(piece)}}`);
    });
  }
  body.push('\\par');
  const fontTbl = fonts.map((n, i) => `{\\f${i}\\fnil\\fcharset0 ${n.replace(/[;{}\\]/g, '')};}`).join('');
  const colorTbl = colors.map(c => { const [r, g, b] = rgbOf(c); return `\\red${r}\\green${g}\\blue${b};`; }).join('');
  let head = `\\f0\\fs${Math.round(base.fontSize * 2)}\\cf${baseColor}`;
  if (base.bold) head += '\\b';
  if (base.italic) head += '\\i';
  if (base.underline) head += '\\ul';
  return `{\\rtf1\\ansi\\ansicpg1252\\deff0\\uc1{\\fonttbl${fontTbl}}{\\colortbl ;${colorTbl}}${head} ${body.join('')}}`;
}

// ---------------------------------------------------------------------------------------------------------------

/** Destinations whose content is not text of the document. */
const SKIPPED = new Set(['stylesheet', 'info', 'pict', 'object', 'header', 'footer', 'headerl', 'headerr', 'headerf', 'footerl', 'footerr', 'footerf',
  'listtable', 'listoverridetable', 'generator', 'colorschememapping', 'themedata', 'datastore', 'latentstyles', 'xmlnstbl', 'rsidtbl', 'pgdsctbl',
  'revtbl', 'fldinst', 'bkmkstart', 'bkmkend', 'pntext', 'pntxta', 'pntxtb', 'pn', 'footnote', 'private', 'falt', 'panose', 'fname']);
const SPECIAL: Record<string, string> = { emdash: '—', endash: '–', lquote: '‘', rquote: '’', ldblquote: '“', rdblquote: '”', bullet: '•', emspace: ' ', enspace: ' ', tab: '\t' };

interface State { fmt: RtfPatch; skip: boolean; tbl: 'font' | 'color' | null; uc: number }

/** The runs and paragraph formats of an RTF document; null when the text is not RTF. Formats equal to `base` (the control's own) are left out. */
export function fromRtf(src: string, base?: RtfFormat): RtfDoc | null {
  if (!/^\s*\{\\rtf/.test(src)) return null;
  const fonts = new Map<number, string>(), colors: (number | null)[] = [];
  let state: State = { fmt: {}, skip: false, tbl: null, uc: 1 };
  const stack: State[] = [];
  const runs: Run[] = [];
  const paras: ParaFmt[] = [];
  let cur = { align: 0, li: 0, fi: 0, ri: 0, bullet: false };
  let para = 0, textInPara = false, endedWithPar = false;
  let fontIdx = -1, fontBuf = '', rgb = [-1, -1, -1], rgbSet = false, pendingSkip = 0;

  const add = (s: string): void => {
    if (s === '') return;
    const last = runs[runs.length - 1];
    const f = state.fmt;
    if (last && RTF_KEYS.every(k => last.fmt[k] === f[k])) last.text += s; else runs.push({ text: s, fmt: { ...f } });
  };
  const text = (s: string): void => {
    if (state.skip) return;
    if (pendingSkip > 0) { pendingSkip--; return; }
    add(s);
    textInPara = true;
    endedWithPar = false;
  };
  const endPara = (closing = true): void => {
    const f: ParaFmt = {};
    if (cur.align) f.align = cur.align;
    if (cur.bullet) f.bullet = true;
    if (cur.li + cur.fi) f.indent = cur.li + cur.fi;
    if (cur.ri) f.rightIndent = cur.ri;
    if (cur.fi) f.hanging = -cur.fi;
    paras[para] = f;
    para++;
    if (closing) add('\n');
    textInPara = false;
    endedWithPar = closing;
  };

  let i = 0;
  const n = src.length;
  while (i < n) {
    const ch = src[i];
    if (ch === '{') {
      stack.push(state);
      state = { ...state, fmt: { ...state.fmt } };
      i++;
    } else if (ch === '}') {
      if (state.tbl === 'font' && fontBuf.trim() !== '') { fonts.set(fontIdx, fontBuf.trim().replace(/;$/, '')); fontBuf = ''; }
      state = stack.pop() ?? state;
      i++;
    } else if (ch === '\\') {
      i++;
      const c = src[i] ?? '';
      if (c === '\\' || c === '{' || c === '}') { text(c); i++; }
      else if (c === '*') { state.skip = true; i++; }
      else if (c === "'") {
        const hex = src.slice(i + 1, i + 3);
        i += 3;
        if (/^[0-9a-fA-F]{2}$/.test(hex)) {
          if (state.tbl === 'font') fontBuf += chr1252(parseInt(hex, 16)); else text(chr1252(parseInt(hex, 16)));
        }
      } else if (c === '~') { text(' '); i++; }
      else if (c === '_') { text('-'); i++; }
      else if (c === '\n' || c === '\r') { if (!state.skip) endPara(); i++; }
      else if (/[a-zA-Z]/.test(c)) {
        let j = i;
        while (j < n && /[a-zA-Z]/.test(src[j])) j++;
        const word = src.slice(i, j);
        let k = j;
        if (src[k] === '-') k++;
        while (k < n && /[0-9]/.test(src[k])) k++;
        const numText = src.slice(j, k);
        const num = numText === '' ? null : Number(numText);
        if (src[k] === ' ') k++;
        i = k;
        pendingSkip = 0;
        if (SKIPPED.has(word)) { state.skip = true; continue; }
        if (word === 'fonttbl') { state.tbl = 'font'; continue; }
        if (word === 'colortbl') { state.tbl = 'color'; continue; }
        if (state.tbl === 'color') {
          if (word === 'red') { rgb[0] = num ?? 0; rgbSet = true; } else if (word === 'green') { rgb[1] = num ?? 0; rgbSet = true; } else if (word === 'blue') { rgb[2] = num ?? 0; rgbSet = true; }
          continue;
        }
        if (state.tbl === 'font') { if (word === 'f' && num !== null) { fontIdx = num; fontBuf = ''; } continue; }
        if (word === 'pnlvlblt') { cur.bullet = true; continue; }
        if (state.skip) continue;
        switch (word) {
          case 'par': case 'line': endPara(); break;
          case 'tab': text('\t'); break;
          case 'pard': cur = { align: 0, li: 0, fi: 0, ri: 0, bullet: false }; break;
          case 'plain': state.fmt = {}; break;
          case 'b': case 'i': case 'strike': {
            const key = word === 'b' ? 'bold' : word === 'i' ? 'italic' : 'strike';
            state.fmt[key] = num !== 0;
            break;
          }
          case 'ul': case 'uld': case 'uldb': case 'ulw': case 'uldash': case 'ulth': state.fmt.underline = num !== 0; break;
          case 'ulnone': state.fmt.underline = false; break;
          case 'cf': {
            const c0 = num === null || num === 0 ? null : colors[num];
            if (c0 === null || c0 === undefined) delete state.fmt.color; else state.fmt.color = c0;
            break;
          }
          case 'f': { const name = fonts.get(num ?? -1); if (name !== undefined) state.fmt.fontName = name; break; }
          case 'fs': if (num !== null && num > 0) state.fmt.fontSize = num / 2; break;
          case 'qc': cur.align = 2; break;
          case 'qr': cur.align = 1; break;
          case 'ql': case 'qj': cur.align = 0; break;
          case 'li': cur.li = num ?? 0; break;
          case 'ri': cur.ri = num ?? 0; break;
          case 'fi': cur.fi = num ?? 0; break;
          case 'uc': state.uc = num ?? 1; break;
          case 'u': {
            if (num !== null) { text(String.fromCharCode(num < 0 ? num + 65536 : num)); pendingSkip = state.uc; }
            break;
          }
          default: if (word in SPECIAL) text(SPECIAL[word]);
        }
      } else i++;
    } else if (ch === '\n' || ch === '\r') {
      i++;
    } else if (state.tbl === 'font') {
      fontBuf += ch;
      i++;
      if (ch === ';') { fonts.set(fontIdx, fontBuf.trim().replace(/;$/, '')); fontBuf = ''; }
    } else if (state.tbl === 'color') {
      i++;
      if (ch === ';') { colors.push(rgbSet ? rgb[0] + rgb[1] * 256 + rgb[2] * 65536 : null); rgb = [-1, -1, -1]; rgbSet = false; }
    } else {
      // a run of plain characters
      let j = i;
      while (j < n && !'{}\\\r\n'.includes(src[j])) j++;
      const s = src.slice(i, j);
      i = j;
      if (state.skip) continue;
      if (pendingSkip > 0) { const cut = Math.min(pendingSkip, s.length); pendingSkip -= cut; text(s.slice(cut)); } else text(s);
    }
  }
  if (textInPara) endPara(false);   // the last paragraph has no closing line break
  else if (endedWithPar) {
    // the final \par is the end mark of the last paragraph: it adds no line break
    const last = runs[runs.length - 1];
    if (last) { last.text = last.text.slice(0, -1); if (last.text === '') runs.pop(); }
  }
  const cleaned = base ? runs.map(r => ({ text: r.text, fmt: withoutBase(r.fmt, base) })) : runs;
  return { runs: mergeSame(cleaned), paras: trimParas(paras) };
}

function withoutBase(f: RtfPatch, base: RtfFormat): RtfPatch {
  const out: RtfPatch = {};
  for (const k of RTF_KEYS) {
    const v = f[k];
    if (v === undefined) continue;
    const same = k === 'color' ? vbColorToCss(v as number) === vbColorToCss(base.color) : v === base[k];
    if (!same) (out as Record<string, string | number | boolean>)[k] = v;
  }
  return out;
}

function mergeSame(runs: Run[]): Run[] {
  const out: Run[] = [];
  for (const r of runs) {
    if (r.text === '') continue;
    const last = out[out.length - 1];
    if (last && RTF_KEYS.every(k => last.fmt[k] === r.fmt[k])) last.text += r.text; else out.push(r);
  }
  return out;
}
