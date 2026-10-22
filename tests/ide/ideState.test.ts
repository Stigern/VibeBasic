// @vitest-environment jsdom
import { expect, test, vi } from 'vitest';
import { IdeState } from '../../src/ide/ideState';
import { addFormCmd } from '../../src/model/commands';

test('ide state emits selection', () => {
  const s = new IdeState();
  const cb = vi.fn();
  s.on('selection', cb);
  s.setSelection({ formId: s.project.forms[0].id, ids: [] });
  expect(cb).toHaveBeenCalledTimes(1);
  expect(s.selection?.ids).toEqual([]);
});

test('tool, mode and options events', () => {
  const s = new IdeState();
  const ev: string[] = [];
  for (const e of ['tool', 'mode', 'options', 'project', 'activeView'] as const) s.on(e, () => ev.push(e));
  s.setTool('Label'); s.setTool('Pointer'); s.setMode('run'); s.setOptions({ showGrid: false });
  expect(ev).toEqual(['tool', 'tool', 'mode', 'options']);
  expect(s.currentTool).toBe('Pointer');
  expect(s.options.showGrid).toBe(false);
  expect(s.options.gridWidth).toBe(120);
});

test('stack changes emit project; setProject resets state', () => {
  const s = new IdeState();
  const cb = vi.fn();
  s.on('project', cb);
  s.stack.execute(addFormCmd({ id: 'f2', name: 'Form2', props: {}, controls: [], code: '' }));
  expect(cb).toHaveBeenCalledTimes(1);
  expect(s.stack.canUndo).toBe(true);
  s.setSelection({ formId: 'f2', ids: ['x'] });
  s.setProject(new IdeState().project, '/a.vbb');
  expect(s.filePath).toBe('/a.vbb');
  expect(s.stack.canUndo).toBe(false);
  expect(s.selection).toBeNull();
});

test('on() returns an unsubscribe function', () => {
  const s = new IdeState();
  let n = 0;
  const off = s.on('project', () => { n++; });
  s.emit('project'); off(); s.emit('project');
  expect(n).toBe(1);
});
