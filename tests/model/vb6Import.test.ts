// VB6 import (.vbp / .frm / .frx / .bas / .cls) from the hand-written fixtures in tests/fixtures/vb6 (Windows-1252, CRLF).
import { expect, test } from 'vitest';
import { readFileSync } from 'node:fs';
import { decodeBmp } from '../../src/model/vb6Image';
import { importVb6File, importVbp, parseValue } from '../../src/model/vb6Import';
import type { ControlDef, FormDef } from '../../src/model/types';

const DIR = 'tests/fixtures/vb6';
const read = async (p: string): Promise<Uint8Array> => new Uint8Array(readFileSync(p));
const ctl = (f: FormDef, name: string, index: number | null = null): ControlDef => f.controls.find(c => c.name === name && c.index === index)!;

test('a .vbp with two forms, a module and a class', async () => {
  const { project: p, warnings } = await importVbp(`${DIR}/Project1.vbp`, read);
  expect(p.forms.map(f => f.name)).toEqual(['Form1', 'Form2']);
  expect(p.modules.map(m => [m.name, m.kind ?? 'module'])).toEqual([['Module1', 'module'], ['Konto', 'class']]);
  expect(p.modules[0].code).toBe('Option Explicit\nPublic Teller As Long\n\nPublic Sub Tell()\n    Teller = Teller + 1\nEnd Sub\n');
  expect(p).toMatchObject({ name: 'Demo', title: 'Syltetøy', startupForm: 'Form2', components: ['MSCOMCTL.OCX'] });
  expect(warnings).toEqual(expect.arrayContaining([
    'The component MSHFLXGD.OCX is not supported.',
    'The reference "Microsoft DAO 3.6 Object Library" is not supported.',
    'UserControl=Knapp.ctl: UserControl files are not supported; it was left out.',
  ]));
  expect(warnings.some(w => /OLE Automation/.test(w))).toBe(false);
  expect(warnings.some(w => /^Konto/.test(w))).toBe(false);   // class modules are supported: no code warnings
  expect(p.versionInfo).toEqual({ major: 1, minor: 2, revision: 3, companyName: 'Eksempel' });   // AutoIncrementVer=0 is absent
  expect(p.subMain).toBeUndefined();
  expect(p.commandLine).toBeUndefined();
});

test('a .vbp: Startup="Sub Main", Command32, CondComp and the version texts', async () => {
  const files: Record<string, string> = {
    '/p/P.vbp': 'Type=Exe\r\nModule=Module1; Main.bas\r\nStartup="Sub Main"\r\nCommand32="/demo 1"\r\nCondComp="BETA = 1 : DEMO = 0"\r\n'
      + 'VersionProductName="Kalk"\r\nVersionLegalCopyright="(c) 2026"\r\nAutoIncrementVer=1\r\n',
    '/p/Main.bas': 'Attribute VB_Name = "Module1"\r\nSub Main()\r\nEnd Sub\r\n',
  };
  const { project: p } = await importVbp('/p/P.vbp', async f => { if (!(f in files)) throw new Error('ENOENT'); return new TextEncoder().encode(files[f]); });
  expect(p).toMatchObject({ subMain: true, startupForm: 'Form1', commandLine: '/demo 1', condComp: 'BETA = 1 : DEMO = 0' });
  expect(p.versionInfo).toEqual({ major: 1, minor: 0, revision: 0, autoIncrement: true, productName: 'Kalk', legalCopyright: '(c) 2026' });
});

test('a .frm: nested frames, a control array, a Font block, .frx picture, list and text', async () => {
  const { forms: [f], assets } = await importVb6File(`${DIR}/Form1.frm`, read);
  const [f1, f2] = [ctl(f, 'Frame1'), ctl(f, 'Frame2')];
  expect([f1.parentId, f2.parentId]).toEqual([null, f1.id]);
  expect([ctl(f, 'Option1', 0), ctl(f, 'Option1', 1)].map(o => [o.parentId, o.props.Caption, o.props.Value])).toEqual([[f2.id, 'Ja', true], [f2.id, 'Nei', false]]);
  expect(f.props.Font).toEqual({ name: 'Arial', size: 9.75, bold: true, italic: true, underline: false });
  expect(f.props.StartUpPosition).toBe(2);
  const pic = ctl(f, 'Picture1');
  expect(pic.props.BackColor).toBe(0xffffff);
  const asset = assets[(pic.props.Picture as { asset: string }).asset];
  expect(asset.mime).toBe('image/png');
  expect(atob(asset.dataBase64).slice(1, 4)).toBe('PNG');
  expect(ctl(f, 'List1').props.List).toEqual(['Ærlig', 'Øl og brød']);
  expect(ctl(f, 'Text1').props.Text).toBe('Linje én\r\nLinje to');
  // menus keep their order after the other controls, with the ^O shortcut
  expect(f.controls.filter(c => c.type === 'Menu').map(m => [m.name, m.props.Caption, m.props.Shortcut])).toEqual([
    ['mnuFile', '&Fil', 0], ['mnuOpen', '&Åpne...', 15], ['mnuSep', '-', 0], ['mnuExit', '&Avslutt', 0]]);
  // the code without the Attribute lines
  expect(f.code.startsWith('Option Explicit\nPrivate Declare Function')).toBe(true);
});

test('a BMP from the .frx decodes to its pixels', () => {
  const frx = readFileSync(`${DIR}/Form1.frx`);
  const img = decodeBmp(new Uint8Array(frx).subarray(12, 12 + 70));
  expect([...img.rgba]).toEqual([255, 0, 0, 255, 0, 255, 0, 255, 0, 0, 255, 255, 255, 255, 255, 255]);
});

test('a crafted BMP header neither hangs nor allocates: palette, data length and size are checked first', () => {
  // BITMAPFILEHEADER + BITMAPINFOHEADER (pixels at 54), then `extra` bytes
  const bmp = (w: number, h: number, bpp: number, clrUsed: number, extra: number): Uint8Array => {
    const b = new Uint8Array(54 + extra), v = new DataView(b.buffer);
    b[0] = 0x42; b[1] = 0x4d; v.setUint32(10, 54, true); v.setUint32(14, 40, true);
    v.setInt32(18, w, true); v.setInt32(22, h, true); v.setUint16(26, 1, true); v.setUint16(28, bpp, true);
    v.setUint32(46, clrUsed, true);
    return b;
  };
  const t0 = performance.now();
  expect(() => decodeBmp(bmp(1, 1, 8, 0xffffffff, 10))).toThrow('cut short');   // 2^32-1 palette entries claimed
  expect(() => decodeBmp(bmp(8000, 8000, 1, 0, 100))).toThrow('cut short');     // 8 MB of pixels claimed, none there
  expect(() => decodeBmp(bmp(8193, 1, 24, 0, 8193 * 3 + 3))).toThrow('the picture is too big');
  expect(performance.now() - t0).toBeLessThan(200);
  expect(decodeBmp(bmp(1, 1, 1, 5, 2 * 4 + 4)).width).toBe(1);   // biClrUsed 5 on a 1-bit bitmap: 2 entries are read
});

test('a .frm value with a long run of digits is parsed in linear time', () => {
  const t0 = performance.now();
  expect(parseValue(`${'1'.repeat(200_000)}x`).kind).toBe('raw');
  expect(performance.now() - t0).toBeLessThan(200);
  expect(['1.5', '.5', '12.', '-3E2'].map(v => parseValue(v))).toEqual([1.5, 0.5, 12, -300].map(n => ({ kind: 'num', n })));
});

test('a .vbp follows the name rules: invalid and taken names, controls sharing a name, a second MDI form', async () => {
  const frm = (cls: string, name: string, body = '') => `VERSION 5.00\r\nBegin VB.${cls} ${name}\r\n${body}End\r\nAttribute VB_Name = "${name}"\r\n`;
  const button = (caption: string) => `   Begin VB.CommandButton Command1\r\n      Caption = "${caption}"\r\n   End\r\n`;
  const files: Record<string, string> = {
    'P.vbp': 'Type=Exe\r\nForm=A.frm\r\nForm=B.frm\r\nForm=M1.frm\r\nForm=M2.frm\r\nModule=Module1; Mod.bas\r\nClass=Bad; Bad.cls\r\nName="Proj"\r\n',
    'A.frm': frm('Form', 'Form1', button('a') + button('b')),
    'B.frm': frm('Form', 'Form1'),
    'M1.frm': frm('MDIForm', 'MDIForm1'),
    'M2.frm': frm('MDIForm', 'MDIForm2'),
    'Mod.bas': 'Attribute VB_Name = "Form1"\r\n',
    'Bad.cls': 'VERSION 1.0 CLASS\r\nBEGIN\r\n  MultiUse = -1\r\nEND\r\nAttribute VB_Name = "Bad Name"\r\n',
  };
  const readMem = async (path: string) => {
    const t = files[path.split('/').pop()!];
    if (t === undefined) throw new Error('ENOENT');
    return new TextEncoder().encode(t);
  };
  const { project: p, warnings } = await importVbp('/p/P.vbp', readMem);
  expect(p.forms.map(f => f.name)).toEqual(['Form1', 'Form1_2', 'MDIForm1']);
  expect(p.modules.map(m => m.name)).toEqual(['Form1_3', 'Class1']);
  expect(p.forms[0].controls.map(c => [c.name, c.index, c.props.Caption])).toEqual([['Command1', 0, 'b'], ['Command1', 1, 'a']]);
  expect(warnings).toEqual(expect.arrayContaining([
    'A.frm: more than one control is named Command1; they became the control array Command1.',
    'M2.frm: a project can have only one MDI form; it was left out.',
    'The name Form1 is already used; the form was renamed Form1_2.',
    'The name Form1 is already used; the module was renamed Form1_3.',
    '"Bad Name" is not a valid name; the class module was renamed Class1.',
  ]));
});

test('a .cls becomes a class module with its Instancing', async () => {
  const { modules: [m] } = await importVb6File(`${DIR}/Class1.cls`, read);
  expect(m).toMatchObject({ name: 'Konto', kind: 'class', instancing: 1 });
  expect(m.code).toBe('Option Explicit\nPrivate mSaldo As Currency\n\nPublic Property Get Saldo() As Currency\n    Saldo = mSaldo\nEnd Property\n');
});

test('unknown controls and unsupported code are warnings', async () => {
  const { forms: [f], warnings } = await importVb6File(`${DIR}/Form1.frm`, read);
  expect(f.controls.some(c => c.name === 'Gadget1')).toBe(false);
  expect(warnings).toContain('Form1.frm: Gadget1 (Foo.Gadget) is not supported; it was left out.');
  expect(warnings.some(w => w.startsWith('Form1, line 2:'))).toBe(true);   // the Declare
  expect(ctl(f, 'ProgressBar1').type).toBe('ProgressBar');
});

test('ClientWidth / ClientHeight become the outer Width / Height', async () => {
  const { project: p } = await importVbp(`${DIR}/Project1.vbp`, read);
  const [f1, f2] = p.forms;
  // Sizable: 4 px borders, 18 px title bar, and the menu bar (19 px)
  expect([f1.props.Width, f1.props.Height]).toEqual([4680 + 8 * 15, 3195 + (8 + 18 + 19) * 15]);
  // Fixed Dialog: 3 px borders, no menu; ScaleMode 3 positions are pixels
  expect([f2.props.Width, f2.props.Height, f2.props.BorderStyle]).toEqual([3000 + 6 * 15, 1500 + 24 * 15, 3]);
  expect([ctl(f2, 'cmdOK').props.Left, ctl(f2, 'cmdOK').props.Width]).toEqual([120, 1215]);
});

test('Windows-1252 text decodes (æøå)', async () => {
  const { forms: [f] } = await importVb6File(`${DIR}/Form1.frm`, read);
  expect(f.props.Caption).toBe('Blåbærsyltetøy');
  expect(f.code).toContain('"Hei på deg"');
});
