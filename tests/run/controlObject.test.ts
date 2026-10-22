import { describe, expect, test, vi } from 'vitest';
import { PatchQueue } from '../../src/run/patchQueue';
import type { ToWindow } from '../../src/run/protocol';
import { ControlArrayObject, ControlObject, type RunContext } from '../../src/run/objects/controlObject';
import { FakeObject } from '../lang/fakeObject';
import { Nothing } from '../../src/lang/values';
import type { ControlDef, ControlType, PropValue } from '../../src/model/types';

function fakeQueue() {
  const sent: [string, ToWindow][] = [];
  const q = new PatchQueue((k, m) => { sent.push([k, m]); }) as PatchQueue & { sent: typeof sent };
  q.sent = sent;
  return q;
}
const ctx = () => {
  const timerChanged = vi.fn();
  return { resolveAsset: () => null, loadPicture: async () => Nothing, timerChanged, } satisfies RunContext as RunContext & { timerChanged: typeof timerChanged };
};
let n = 0;
function ctl(type: Exclude<ControlType, 'Form'>, q: PatchQueue, props: Record<string, PropValue> = {}, index: number | null = null, c = ctx()) {
  const def: ControlDef = { id: `id${++n}`, type, name: `${type}1`, index, parentId: null, props };
  return new ControlObject(def, 'f1', q, c);
}
const err = (n: number) => expect.objectContaining({ number: n });

describe('ControlObject', () => {
  test('set caption queues patch', () => {
    const q = fakeQueue(); const c = ctl('CommandButton', q);
    c.setMember('Caption', [], 'OK'); q.flush();
    expect(q.sent).toEqual([['f1', { t: 'patch', id: c.def.id, props: { Caption: 'OK' } }]]);
  });
  test('progress value out of range is 380', () => {
    const pb = ctl('ProgressBar', fakeQueue());
    expect(() => pb.setMember('Value', [], 101)).toThrow(err(380));
    pb.setMember('Value', [], 50); expect(pb.getMember('value', [])).toBe(50);
  });
  test('bool coercion, enum validity, case-insensitive names', () => {
    const chk = ctl('CheckBox', fakeQueue());
    chk.setMember('enabled', [], 0); expect(chk.props.Enabled).toBe(false);
    expect(() => chk.setMember('Value', [], 5)).toThrow(err(380));
  });
  test('read-only, unsupported and unknown members', () => {
    const q = fakeQueue();
    const lst = ctl('ListBox', q);
    expect(() => lst.setMember('ListCount', [], 3)).toThrow(err(383));
    expect(() => lst.setMember('Name', [], 'x')).toThrow(err(383));
    expect(() => lst.getMember('Bogus', [])).toThrow(err(438));
    expect(lst.hasMember('Bogus')).toBe(false);
    expect(() => lst.callMethod('Bogus', [])).toThrow(err(438));
    expect(() => ctl('Label', q).callMethod('AddItem', ['x'])).toThrow(err(438));
  });
  test('additem/removeitem/listindex', () => {
    const q = fakeQueue(); const lst = ctl('ListBox', q);
    lst.callMethod('AddItem', ['a']); lst.callMethod('AddItem', ['b']); lst.setMember('ListIndex', [], 1);
    expect(lst.getMember('Text', [])).toBe('b');
    expect(() => lst.setMember('ListIndex', [], 2)).toThrow(err(380));
    expect(() => lst.callMethod('RemoveItem', [5])).toThrow(err(5));
    lst.callMethod('RemoveItem', [0]);
    expect(lst.getMember('ListCount', [])).toBe(1);
    expect(lst.getMember('ListIndex', [])).toBe(0);
    lst.setMember('List', [0], 'z'); expect(lst.getMember('List', [0])).toBe('z');
    lst.callMethod('Clear', []); expect(lst.getMember('ListIndex', [])).toBe(-1);
    expect(lst.getMember('ListCount', [])).toBe(0);
  });
  test('additem with index', () => {
    const lst = ctl('ListBox', fakeQueue());
    lst.callMethod('AddItem', ['a']); lst.callMethod('AddItem', ['c']); lst.callMethod('AddItem', ['b', 1]);
    expect(lst.props.List).toEqual(['a', 'b', 'c']); expect(lst.getMember('NewIndex', [])).toBe(1);
    expect(() => lst.callMethod('AddItem', ['x', 9])).toThrow(err(5));
  });
  test('sorted additem', () => {
    const lst = ctl('ListBox', fakeQueue(), { Sorted: true });
    lst.callMethod('AddItem', ['b']); lst.callMethod('AddItem', ['a']);
    expect(lst.props.List).toEqual(['a', 'b']); expect(lst.getMember('NewIndex', [])).toBe(0);
  });
  test('combo text follows ListIndex', () => {
    const cb = ctl('ComboBox', fakeQueue());
    cb.callMethod('AddItem', ['x']); cb.setMember('ListIndex', [], 0);
    expect(cb.getMember('Text', [])).toBe('x');
  });
  test('control array missing index is 340', () => {
    const q = fakeQueue();
    const arr = new ControlArrayObject('Command1', [ctl('CommandButton', q, {}, 0), ctl('CommandButton', q, {}, 2)]);
    expect(() => arr.item(5)).toThrow(expect.objectContaining({ number: 340, description: "Control array element '5' doesn't exist" }));
    expect(arr.item(2).index).toBe(2);
    expect([arr.getMember('Count', []), arr.getMember('LBound', []), arr.getMember('ubound', [])]).toEqual([2, 0, 2]);
    expect(arr.items().length).toBe(2);
  });
  test('applyState does not echo', () => {
    const q = fakeQueue(); const txt = ctl('TextBox', q);
    txt.applyState({ Text: 'hei' }); q.flush();
    expect(q.sent).toEqual([]); expect(txt.getMember('Text', [])).toBe('hei');
  });
  test('patches coalesce per control', () => {
    const q = fakeQueue(); const c = ctl('CommandButton', q);
    c.setMember('Caption', [], 'a'); c.setMember('Caption', [], 'b'); c.setMember('Left', [], 5);
    expect(q.pending).toBe(true); q.flush();
    expect(q.sent.length).toBe(1); expect(q.sent[0][1]).toEqual({ t: 'patch', id: c.def.id, props: { Caption: 'b', Left: 5 } });
    expect(q.pending).toBe(false);
  });
  test('object value resolves to its default member', () => {
    const txt = ctl('TextBox', fakeQueue());
    txt.setMember('Text', [], new FakeObject('Text2', { defaultMember: 'Text', props: { Text: 'from2' } }));
    expect(txt.props.Text).toBe('from2');
  });
  test('textbox selection, Move, SetFocus, timer', () => {
    const q = fakeQueue(); const t = ctl('TextBox', q, { Text: 'hello' });
    t.setMember('SelStart', [], 1); t.setMember('SelLength', [], 3);
    expect(t.getMember('SelText', [])).toBe('ell');
    t.setMember('SelText', [], 'a'); expect(t.props.Text).toBe('hao');
    t.callMethod('Move', [10, 20]); expect(t.props.Left).toBe(10); expect(t.props.Top).toBe(20);
    q.flush(); q.sent.length = 0;
    t.callMethod('SetFocus', []);
    expect(q.sent).toEqual([['f1', { t: 'focus', id: t.def.id }]]);
    const c = ctx(); const tm = ctl('Timer', q, {}, null, c);
    tm.setMember('Interval', [], 500); tm.setMember('Enabled', [], true);
    expect(c.timerChanged).toHaveBeenCalledTimes(2);
  });
});
