import { expect, test } from 'vitest';
import { absoluteRect, alignRects, computeMove, computeResize, containerAt, controlsInRect, hitTest, snap } from '../../src/ide/designerLogic';
import type { ControlDef, FormDef } from '../../src/model/types';

const ctl = (id: string, type: ControlDef['type'], parentId: string | null, l: number, t: number, w?: number, h?: number): ControlDef =>
  ({ id, type, name: id, index: null, parentId, props: { Left: l, Top: t, ...(w !== undefined ? { Width: w, Height: h! } : {}) } });
const form = (controls: ControlDef[]): FormDef => ({ id: 'f', name: 'Form1', props: {}, controls, code: '' });
const O = { grid: 120, snap: true };

test('snap', () => {
  expect(snap(130, 120, true)).toBe(120); expect(snap(190, 120, true)).toBe(240); expect(snap(130, 120, false)).toBe(130);
});
test('resize se', () => expect(computeResize({ left: 0, top: 0, width: 1200, height: 480 }, 'se', 130, 10, O)).toEqual({ left: 0, top: 0, width: 1320, height: 480 }));
test('resize nw keeps opposite corner', () =>
  expect(computeResize({ left: 240, top: 240, width: 1200, height: 480 }, 'nw', -120, -120, O)).toEqual({ left: 120, top: 120, width: 1320, height: 600 }));
test('min size one grid cell', () => {
  expect(computeResize({ left: 0, top: 0, width: 240, height: 240 }, 'e', -1000, 0, O).width).toBe(120);
  expect(computeResize({ left: 0, top: 0, width: 240, height: 240 }, 'w', 1000, 0, O)).toMatchObject({ left: 120, width: 120 });
});
test('move snaps the first rect and keeps the others relative', () => {
  const r = computeMove([{ left: 100, top: 100, width: 10, height: 10 }, { left: 250, top: 100, width: 10, height: 10 }], 30, 30, O);
  expect(r.map(x => [x.left, x.top])).toEqual([[120, 120], [270, 120]]);
});
test('hit test topmost, inside frame, children above container, parentId not array order', () => {
  // child listed BEFORE its parent in the array
  const f = form([ctl('cmd', 'CommandButton', 'fr', 100, 100, 500, 300), ctl('fr', 'Frame', null, 1000, 1000, 3000, 2000),
    ctl('lbl', 'Label', null, 0, 0, 500, 500), ctl('lbl2', 'Label', null, 0, 0, 500, 500)]);
  expect(hitTest(f, 1200, 1200)).toBe('cmd');          // absolute (1100..1600) inside the frame
  expect(hitTest(f, 2500, 2500)).toBe('fr');
  expect(hitTest(f, 100, 100)).toBe('lbl2');           // later sibling is on top
  expect(hitTest(f, 9000, 9000)).toBeNull();
  expect(absoluteRect(f, 'cmd')).toEqual({ left: 1100, top: 1100, width: 500, height: 300 });
});
test('timer has fixed size', () => expect(absoluteRect(form([ctl('t', 'Timer', null, 10, 20)]), 't')).toEqual({ left: 10, top: 20, width: 420, height: 420 }));
test('controlsInRect touches direct children only', () => {
  const f = form([ctl('fr', 'Frame', null, 0, 0, 2000, 2000), ctl('in', 'Label', 'fr', 100, 100, 300, 300), ctl('far', 'Label', null, 5000, 5000, 300, 300)]);
  expect(controlsInRect(f, { left: 50, top: 50, width: 100, height: 100 }, null)).toEqual(['fr']);
  expect(controlsInRect(f, { left: 50, top: 50, width: 100, height: 100 }, 'fr')).toEqual(['in']);
});
test('containerAt skips excluded and their children', () => {
  const f = form([ctl('a', 'Frame', null, 0, 0, 3000, 3000), ctl('b', 'PictureBox', 'a', 100, 100, 1000, 1000)]);
  expect(containerAt(f, 200, 200, [])).toBe('b');
  expect(containerAt(f, 200, 200, ['b'])).toBe('a');
  expect(containerAt(f, 200, 200, ['a'])).toBeNull();
  expect(containerAt(f, 9000, 9000, [])).toBeNull();
});
test('align to primary (last)', () => {
  const rs = [{ left: 100, top: 0, width: 10, height: 10 }, { left: 300, top: 50, width: 30, height: 10 }];
  expect(alignRects(rs, 'lefts').map(r => r.left)).toEqual([300, 300]);
  expect(alignRects(rs, 'rights').map(r => r.left)).toEqual([320, 300]);
  expect(alignRects(rs, 'centers').map(r => r.left)).toEqual([310, 300]);
  expect(alignRects(rs, 'tops').map(r => r.top)).toEqual([50, 50]);
});

test('Line: bounding box from X1..Y2, hit-testing by distance to the segment, moves like a box', () => {
  const line: ControlDef = { id: 'ln', type: 'Line', name: 'Line1', index: null, parentId: null, props: { X1: 100, Y1: 100, X2: 1100, Y2: 1100 } };
  const f = form([ctl('b', 'CommandButton', null, 0, 0, 2000, 2000), line]);
  expect(absoluteRect(f, 'ln')).toEqual({ left: 100, top: 100, width: 1000, height: 1000 });
  expect(hitTest(f, 600, 620)).toBe('ln');          // on the diagonal
  expect(hitTest(f, 1000, 200)).toBe('b');          // inside the bounding box but far from the segment
  line.props.X1 = 1100; line.props.X2 = 100;        // the other diagonal
  expect(hitTest(f, 600, 620)).toBe('ln');
  expect(hitTest(f, 200, 200)).toBe('b');
});
