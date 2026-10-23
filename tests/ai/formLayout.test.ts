// @vitest-environment jsdom
// The AI and the form design: relative placement ops, the layout check, the ASCII map and the form picture's layout.
import { expect, test, vi } from 'vitest';
import { describeForm } from '../../src/ai/context';
import { drawFormImage, layoutFormImage, type Ctx } from '../../src/ai/formImage';
import { parseFormOps } from '../../src/ai/formMode';
import { checkLayout } from '../../src/ai/layoutCheck';
import { newControl, newProject } from '../../src/model/controls';
import type { ControlType, FormDef } from '../../src/model/types';

/** A clean form: Label1 "Name:" left of Text1, Command1 "OK" at the bottom right. */
function clean(): FormDef {
  const f = newProject().forms[0];
  const add = (type: Exclude<ControlType, 'Form'>, left: number, top: number, width: number, height: number, props: Record<string, string> = {}) => {
    const c = newControl(f, type, { left, top, width, height }, null);
    Object.assign(c.props, props);
    f.controls.push(c);
    return c;
  };
  add('Label', 240, 300, 1095, 255, { Caption: 'Name:' });
  add('TextBox', 1455, 240, 2400, 315);
  add('CommandButton', 2640, 2400, 1215, 375, { Caption: 'OK' });
  return f;
}
const ok = (r: ReturnType<typeof parseFormOps>) => { if (!r.ok) throw new Error(r.reason); return r; };
const props = (r: ReturnType<typeof ok>, name: string) => Object.assign({}, ...r.ops.filter(o => (o.op === 'add' || o.op === 'set') && o.name === name).map(o => (o as { props: object }).props));

test('place below with a gap resolves to Left/Top of the reference', () => {
  const f = clean();
  const r = ok(parseFormOps(JSON.stringify({ ops: [
    { op: 'add', type: 'Label', name: 'lblHint', props: { Caption: 'Hint', Height: 255 }, place: { below: 'Text1', gap: 200 } },
    { op: 'set', name: 'Command1', place: { rightOf: 'lblHint' } },
  ] }), f));
  expect(props(r, 'lblHint')).toMatchObject({ Left: 1455, Top: 240 + 315 + 200 });
  // rightOf with the default gap 120, tops lined up
  expect(props(r, 'Command1')).toMatchObject({ Left: 1455 + 1215 + 120, Top: 755 });
});

test('arrange as a row and autosize', () => {
  const f = clean();
  const r = ok(parseFormOps(JSON.stringify({ ops: [
    { op: 'add', type: 'CommandButton', name: 'cmdA', props: { Caption: 'A', Width: 1215, Height: 375 } },
    { op: 'add', type: 'CommandButton', name: 'cmdB', props: { Caption: 'B', Width: 1215, Height: 375 } },
    { op: 'arrange', names: ['Command1', 'cmdA', 'cmdB'], as: 'row', left: 120, top: 2000 },
    { op: 'autosize', names: ['Label1', 'Command1'] },
  ] }), f));
  expect([props(r, 'Command1').Left, props(r, 'cmdA').Left, props(r, 'cmdB').Left]).toEqual([120, 1455, 2790]);
  expect([props(r, 'Command1').Top, props(r, 'cmdA').Top, props(r, 'cmdB').Top]).toEqual([2000, 2000, 2000]);
  // "Name:" is about 31 px (+4) and one line; "OK" gets the button minimum
  expect(props(r, 'Label1')).toMatchObject({ Width: 525, Height: 195 });
  expect(props(r, 'Command1').Width).toBe(735);
});

test('the layout check finds overlap, out of bounds, a too small button, a cut caption and a misalignment; nothing on a clean form', () => {
  expect(checkLayout(clean())).toEqual([]);
  const with_ = (change: (f: FormDef) => void) => { const f = clean(); change(f); return checkLayout(f).join('\n'); };
  const add = (f: FormDef, type: Exclude<ControlType, 'Form'>, left: number, top: number, width: number, height: number, caption?: string) => {
    const c = newControl(f, type, { left, top, width, height }, null);
    if (caption !== undefined) c.props.Caption = caption;
    f.controls.push(c);
  };
  expect(with_(f => add(f, 'CommandButton', 2700, 2500, 1215, 375, 'X'))).toMatch(/Command1 .* and Command2 .* overlap by 1155 x 275 twips/);
  expect(with_(f => add(f, 'TextBox', 3000, 1200, 2400, 315))).toContain('Text2 (Left 3000, Width 2400) goes 720 twips past the right edge of the form (client area 4680 x 3210).');
  expect(with_(f => add(f, 'CommandButton', 240, 2400, 1215, 200, 'Go'))).toContain('Command2 is 200 twips high; a CommandButton needs at least 255');
  expect(with_(f => add(f, 'CommandButton', 240, 2400, 735, 375, 'A very long caption here'))).toMatch(/The Caption "A very long caption here" of Command2 needs about \d+ twips but the CommandButton is 735 wide/);
  expect(with_(f => { add(f, 'TextBox', 240, 1000, 2400, 315); add(f, 'TextBox', 270, 1500, 2400, 315); }))
    .toContain('Text2 (Left 240) and Text3 (Left 270) are in one column but 30 twips apart; give them the same Left.');
});

test('the ASCII layout map shows each control by name', () => {
  const text = describeForm(clean(), { map: true });
  const map = text.slice(text.indexOf('Layout map'));
  for (const n of ['+Label1', '+Text1', '+Command1']) expect(map).toContain(n);
  expect(map.split('\n').slice(1).every(l => l.length === 48)).toBe(true);
  expect(map.split('\n')).toHaveLength(17);
  expect(describeForm(clean())).not.toContain('Layout map');
});

test('the form picture: rulers every 600 twips, every control placed and named', () => {
  const f = clean();
  const L = layoutFormImage(f);
  expect(L.width).toBeLessThanOrEqual(801);
  expect(L.xMarks.map(m => m.twips)).toEqual([0, 600, 1200, 1800, 2400, 3000, 3600, 4200]);
  expect(L.controls.map(c => c.name)).toEqual(['Label1', 'Text1', 'Command1']);
  const t1 = L.controls[1];
  expect(t1.x).toBeCloseTo(L.ox + (1455 / 15) * L.scale);
  const written: string[] = [];
  const ctx = new Proxy({ font: '', measureText: (t: string) => ({ width: t.length * 6 }), fillText: (t: string) => { written.push(t); } } as Record<string, unknown>,
    { get: (o, k) => (k in o ? o[k as string] : vi.fn()), set: (o, k, v) => { o[k as string] = v; return true; } }) as unknown as Ctx;
  drawFormImage(ctx, f, L);
  expect(written).toEqual(expect.arrayContaining(['Label1', 'Text1', 'Command1', 'Name:', 'OK', '600']));
});

test('placement relative to a control added without Left/Top starts where it is created (240, 240)', () => {
  const f = clean();
  const r = ok(parseFormOps(JSON.stringify({ ops: [
    { op: 'add', type: 'CommandButton', name: 'cmdX', props: { Caption: 'OK' } },
    { op: 'add', type: 'CommandButton', name: 'cmdY', props: { Caption: 'Y' }, place: { rightOf: 'cmdX' } },
  ] }), f));
  expect(props(r, 'cmdY')).toMatchObject({ Left: 240 + 1215 + 120, Top: 240 });
});

test('place on a whole control array stacks its members in a column, in their order', () => {
  const f = clean();
  for (let i = 0; i < 3; i++) {
    const o = newControl(f, 'OptionButton', { left: 3000, top: 600 + i * 400, width: 1215, height: 255 }, null);
    o.name = 'Option1'; o.index = i;
    f.controls.push(o);
  }
  const r = ok(parseFormOps(JSON.stringify({ ops: [{ op: 'set', name: 'Option1', props: { BackColor: 255 }, place: { below: 'Label1' } }] }), f));
  const tops = [0, 1, 2].map(i => (r.ops.find(o => o.op === 'set' && o.index === i) as unknown as { props: { Left: number; Top: number } }).props);
  expect(tops).toEqual([{ Left: 240, Top: 675 }, { Left: 240, Top: 675 + 375 }, { Left: 240, Top: 675 + 750 }]);
  expect(r.ops.some(o => o.op === 'set' && o.index === null && 'BackColor' in o.props && !('Top' in o.props))).toBe(true);
});

test('an add renamed because its name was taken: later ops in the same answer go to the new control', () => {
  const f = clean();
  const r = ok(parseFormOps(JSON.stringify({ ops: [
    { op: 'add', type: 'Label', name: 'Label1', props: { Caption: 'Hi' } },
    { op: 'arrange', names: ['Label1'], as: 'row', left: 0, top: 0 },
  ] }), f));
  expect(r.ops.map(o => (o.op === 'form' ? 'form' : o.name))).toEqual(['Label11']);
  expect(props(r, 'Label11')).toMatchObject({ Left: 0, Top: 0 });
  expect(r.renamed).toEqual([{ from: 'Label1', to: 'Label11' }]);
});

test('the layout check leaves valid VB6 idioms alone: a Frame without caption, a separator Label, a background Image', () => {
  const f = clean();
  const fr = newControl(f, 'Frame', { left: 240, top: 1000, width: 2000, height: 1000 }, null);
  fr.props.Caption = '';
  f.controls.push(fr);
  const opt = newControl(f, 'OptionButton', { left: 120, top: 60, width: 1215, height: 255 }, fr.id);
  opt.props.Caption = 'A';
  f.controls.push(opt);
  const line = newControl(f, 'Label', { left: 2400, top: 1000, width: 1800, height: 15 }, null);
  line.props.Caption = ''; line.props.BorderStyle = 1;
  f.controls.push(line);
  f.controls.splice(0, 0, newControl(f, 'Image', { left: 0, top: 0, width: 4000, height: 900 }, null));
  expect(checkLayout(f)).toEqual([]);
  fr.props.Caption = 'Group';
  expect(checkLayout(f).join('\n')).toContain('is under the caption of Frame Frame1');
});

test('place and arrange skip Lines and docked controls with a warning', () => {
  const f = clean();
  f.controls.push(newControl(f, 'Line', { left: 100, top: 100, width: 1000, height: 0 }, null));
  const r = ok(parseFormOps(JSON.stringify({ ops: [
    { op: 'set', name: 'Line1', place: { below: 'Command1' } },
    { op: 'arrange', names: ['Line1', 'Label1'], as: 'row', left: 120, top: 120 },
    { op: 'set', name: 'Label1', props: { Caption: 'x' } },
  ] }), f));
  expect(r.ops.filter(o => o.op !== 'form' && o.name === 'Line1')).toEqual([]);
  expect(r.warnings.join('\n')).toContain('Ignored place of Line1: a Line is placed by X1, Y1, X2 and Y2.');
  expect(r.warnings.join('\n')).toContain('Ignored arrange of Line1');
});
