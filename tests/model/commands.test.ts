import {
  CommandStack, addControlsCmd, deleteControlsCmd, moveResizeCmd, setPropertyCmd, renameCmd, zOrderCmd,
  compositeCmd, addFormCmd, addModuleCmd, removeItemCmd, type Command,
} from '../../src/model/commands';
import { newProject, newControl, newId } from '../../src/model/controls';
import type { ControlDef, FormDef, Project } from '../../src/model/types';

function setup() {
  const project: Project = newProject();
  const form = project.forms[0];
  let changes = 0;
  const stack = new CommandStack(() => project, () => { changes++; });
  return { project, form, stack, changes: () => changes };
}
/** Build n controls with unique names without going through commands. */
function seed(form: FormDef, ...types: ControlDef['type'][]): ControlDef[] {
  return types.map((t, i) => { const c = newControl(form, t, { left: i * 100, top: i * 100 }, null); form.controls.push(c); return c; });
}
const names = (f: FormDef) => f.controls.map(c => c.name);

test('add then undo then redo', () => {
  const { form, stack } = setup();
  const c = newControl(form, 'CommandButton', { left: 120, top: 240 }, null);
  stack.execute(addControlsCmd(form.id, [c]));
  expect(form.controls).toHaveLength(1);
  expect(form.controls[0].id).toBe(c.id);
  expect(stack.undo()).toBe(true);
  expect(form.controls).toHaveLength(0);
  expect(stack.redo()).toBe(true);
  expect(form.controls).toHaveLength(1);
  expect(form.controls[0]).toEqual(c);
});

test('dirty tracking', () => {
  const { form, stack } = setup();
  expect(stack.isDirty).toBe(false);
  stack.execute(addControlsCmd(form.id, [newControl(form, 'Label', { left: 0, top: 0 }, null)]));
  expect(stack.isDirty).toBe(true);
  stack.markSaved();
  expect(stack.isDirty).toBe(false);
  stack.undo();
  expect(stack.isDirty).toBe(true);
  stack.redo();
  expect(stack.isDirty).toBe(false);
});

test('markDirtyExternal sets dirty until markSaved', () => {
  const { stack, changes } = setup();
  stack.markDirtyExternal();
  expect(stack.isDirty).toBe(true);
  expect(changes()).toBe(1);
  stack.markSaved();
  expect(stack.isDirty).toBe(false);
});

test('dirty is permanent when saved state was discarded by a new execute', () => {
  const { form, stack } = setup();
  const [a] = seed(form, 'Label');
  stack.execute(setPropertyCmd(form.id, a.id, 'Caption', 'x'));
  stack.markSaved();
  stack.undo();
  stack.execute(setPropertyCmd(form.id, a.id, 'Caption', 'y')); // same depth as saved, different state
  expect(stack.isDirty).toBe(true);
});

test('delete frame deletes children and undo restores order', () => {
  const { form, stack } = setup();
  const [a, frame] = seed(form, 'CommandButton', 'Frame');
  const kid = newControl(form, 'CommandButton', { left: 10, top: 10 }, frame.id);
  form.controls.push(kid);
  const [z] = seed(form, 'Label');
  const before = JSON.parse(JSON.stringify(form.controls));
  stack.execute(deleteControlsCmd(form.id, [frame.id]));
  expect(form.controls.map(c => c.id)).toEqual([a.id, z.id]);
  stack.undo();
  expect(form.controls).toEqual(before);
  expect(form.controls[2].parentId).toBe(frame.id);
  stack.redo();
  expect(form.controls.map(c => c.id)).toEqual([a.id, z.id]);
});

test('delete nested containers and several non-adjacent controls round-trips', () => {
  const { form, stack } = setup();
  const [f1, b1] = seed(form, 'Frame', 'Label');
  const f2 = newControl(form, 'Frame', { left: 0, top: 0 }, f1.id); form.controls.push(f2);
  const deep = newControl(form, 'TextBox', { left: 0, top: 0 }, f2.id); form.controls.push(deep);
  const [t] = seed(form, 'Timer');
  const before = JSON.parse(JSON.stringify(form.controls));
  stack.execute(deleteControlsCmd(form.id, [f1.id, t.id]));
  expect(form.controls.map(c => c.id)).toEqual([b1.id]);
  stack.undo();
  expect(form.controls).toEqual(before);
});

test('rename leaves code untouched', () => {
  const { form, stack } = setup();
  const code = 'Private Sub Command1_Click()\nEnd Sub';
  form.code = code;
  const [c] = seed(form, 'CommandButton');
  expect(c.name).toBe('Command1');
  stack.execute(renameCmd(form.id, c.id, 'cmdOK', null));
  expect(form.code).toBe(code);
  expect(form.controls[0].name).toBe('cmdOK');
  stack.undo();
  expect(form.controls[0].name).toBe('Command1');
  expect(form.code).toBe(code);
});

test('rename can set and restore control array index', () => {
  const { form, stack } = setup();
  const [c] = seed(form, 'CommandButton');
  stack.execute(renameCmd(form.id, c.id, 'cmdOK', 3));
  expect(form.controls[0].index).toBe(3);
  stack.undo();
  expect(form.controls[0].index).toBeNull();
  stack.execute(renameCmd(form.id, c.id, 'cmdOK', 3));
  stack.execute(renameCmd(form.id, c.id, 'cmdOK', null));
  expect(form.controls[0].index).toBeNull();
  stack.undo();
  expect(form.controls[0].index).toBe(3);
});

test('rename form updates startupForm and undo restores it', () => {
  const { project, form, stack } = setup();
  expect(project.startupForm).toBe(form.name);
  const oldName = form.name;
  stack.execute(renameCmd(form.id, 'form', 'frmMain', null));
  expect(form.name).toBe('frmMain');
  expect(project.startupForm).toBe('frmMain');
  stack.undo();
  expect(form.name).toBe(oldName);
  expect(project.startupForm).toBe(oldName);
  stack.redo();
  expect(project.startupForm).toBe('frmMain');
});

test('rename non-startup form leaves startupForm alone', () => {
  const { project, form, stack } = setup();
  const f2: FormDef = { ...structuredClone(form), id: newId(), name: 'Form2', controls: [] };
  project.forms.push(f2);
  stack.execute(renameCmd(f2.id, 'form', 'frmOther', null));
  expect(project.startupForm).toBe(form.name);
});

test('composite undoes as one step', () => {
  const { form, stack } = setup();
  const c = newControl(form, 'Label', { left: 0, top: 0 }, null);
  stack.execute(compositeCmd('Add and set', [
    addControlsCmd(form.id, [c]),
    setPropertyCmd(form.id, c.id, 'Caption', 'Hello'),
  ]));
  expect(form.controls[0].props.Caption).toBe('Hello');
  expect(stack.undoLabel).toBe('Add and set');
  stack.undo();
  expect(form.controls).toHaveLength(0);
  expect(stack.canUndo).toBe(false);
  stack.redo();
  expect(form.controls[0].props.Caption).toBe('Hello');
});

test('composite undoes in reverse order', () => {
  const { project, stack } = setup();
  const log: string[] = [];
  const mkc = (n: string): Command => ({ label: n, do: () => log.push('do ' + n), undo: () => log.push('undo ' + n) });
  const c = compositeCmd('x', [mkc('a'), mkc('b'), mkc('c')]);
  c.do(project); c.undo(project);
  expect(log).toEqual(['do a', 'do b', 'do c', 'undo c', 'undo b', 'undo a']);
  void stack;
});

test('execute clears redo', () => {
  const { form, stack } = setup();
  const [a] = seed(form, 'Label');
  stack.execute(setPropertyCmd(form.id, a.id, 'Caption', '1'));
  stack.undo();
  expect(stack.canRedo).toBe(true);
  stack.execute(setPropertyCmd(form.id, a.id, 'Caption', '2'));
  expect(stack.canRedo).toBe(false);
  expect(stack.redo()).toBe(false);
});

test('undo/redo return false when nothing to do; labels; onChange', () => {
  const { form, stack, changes } = setup();
  expect(stack.undo()).toBe(false);
  expect(stack.redo()).toBe(false);
  expect(stack.undoLabel).toBeNull();
  expect(changes()).toBe(0);
  const [a] = seed(form, 'Label');
  stack.execute(setPropertyCmd(form.id, a.id, 'Caption', 'q'));
  expect(stack.undoLabel).toBe(setPropertyCmd(form.id, a.id, 'Caption', 'q').label);
  expect(changes()).toBe(1);
  stack.undo(); expect(changes()).toBe(2);
  stack.redo(); expect(changes()).toBe(3);
  stack.markSaved(); expect(changes()).toBe(4);
});

test('setProperty on control: value, undo restores, absent key removed', () => {
  const { form, stack } = setup();
  const [a] = seed(form, 'Label');
  stack.execute(setPropertyCmd(form.id, a.id, 'Caption', 'New'));
  expect(a.props.Caption).toBe('New');
  stack.undo();
  expect(a.props.Caption).toBe('Label1');
  stack.execute(setPropertyCmd(form.id, a.id, 'Bogus', 5));
  expect(a.props.Bogus).toBe(5);
  stack.undo();
  expect('Bogus' in a.props).toBe(false);
});

test('setProperty on form target and font object value', () => {
  const { form, stack } = setup();
  const oldCaption = form.props.Caption;
  stack.execute(setPropertyCmd(form.id, 'form', 'Caption', 'Hi'));
  expect(form.props.Caption).toBe('Hi');
  stack.undo();
  expect(form.props.Caption).toBe(oldCaption);
  const font = { name: 'Arial', size: 10, bold: true, italic: false, underline: false };
  stack.execute(setPropertyCmd(form.id, 'form', 'Font', font));
  font.size = 99; // later mutation by caller must not leak in
  expect((form.props.Font as { size: number }).size).toBe(10);
});

test('moveResize of several controls round-trips', () => {
  const { form, stack } = setup();
  const [a, b, t] = seed(form, 'CommandButton', 'Label', 'Timer');
  const before = JSON.parse(JSON.stringify(form.controls));
  stack.execute(moveResizeCmd(form.id, [
    { id: a.id, left: 1, top: 2, width: 3, height: 4 },
    { id: b.id, left: 5, top: 6, width: 7, height: 8 },
    { id: t.id, left: 9, top: 10, width: 11, height: 12 },
  ]));
  expect(a.props).toMatchObject({ Left: 1, Top: 2, Width: 3, Height: 4 });
  expect(b.props).toMatchObject({ Left: 5, Top: 6, Width: 7, Height: 8 });
  expect(t.props.Left).toBe(9);
  expect(t.props.Top).toBe(10);
  expect('Width' in t.props).toBe(false); // Timer has no size
  stack.undo();
  expect(form.controls).toEqual(before);
  stack.redo();
  expect(a.props.Width).toBe(3);
});

test('zOrder front and back', () => {
  const { form, stack } = setup();
  const [a, b, c, d] = seed(form, 'Label', 'Label', 'Label', 'Label');
  const ids = () => form.controls.map(x => x.id);
  stack.execute(zOrderCmd(form.id, [b.id, a.id], 'front'));
  expect(ids()).toEqual([c.id, d.id, a.id, b.id]); // keeps relative order of the moved ones
  stack.undo();
  expect(ids()).toEqual([a.id, b.id, c.id, d.id]);
  stack.execute(zOrderCmd(form.id, [c.id, d.id], 'back'));
  expect(ids()).toEqual([c.id, d.id, a.id, b.id]);
  stack.undo();
  expect(ids()).toEqual([a.id, b.id, c.id, d.id]);
  stack.redo();
  expect(ids()).toEqual([c.id, d.id, a.id, b.id]);
});

test('addForm / addModule / undo / redo', () => {
  const { project, form, stack } = setup();
  const f2: FormDef = { id: newId(), name: 'Form2', props: {}, controls: [], code: '' };
  stack.execute(addFormCmd(f2));
  expect(project.forms.map(f => f.name)).toEqual([form.name, 'Form2']);
  const m = { id: newId(), name: 'Module1', code: '' };
  stack.execute(addModuleCmd(m));
  expect(project.modules).toEqual([m]);
  stack.undo(); expect(project.modules).toEqual([]);
  stack.undo(); expect(project.forms).toHaveLength(1);
  stack.redo(); stack.redo();
  expect(project.forms).toHaveLength(2);
  expect(project.modules).toHaveLength(1);
});

test('removeItem form restores index and startupForm on undo', () => {
  const { project, form, stack } = setup();
  const f2: FormDef = { id: newId(), name: 'Form2', props: {}, controls: [], code: 'x' };
  const f3: FormDef = { id: newId(), name: 'Form3', props: {}, controls: [], code: '' };
  project.forms.push(f2, f3);
  stack.execute(removeItemCmd(form.id)); // the startup form
  expect(project.forms.map(f => f.name)).toEqual(['Form2', 'Form3']);
  // the command is dumb about startupForm; caller picks the new one
  project.startupForm = 'Form2';
  stack.undo();
  expect(project.forms.map(f => f.id)).toEqual([form.id, f2.id, f3.id]);
  expect(project.startupForm).toBe(form.name);
  stack.redo();
  expect(project.forms).toHaveLength(2);
  stack.undo();
  stack.execute(removeItemCmd(f2.id));
  expect(project.forms.map(f => f.id)).toEqual([form.id, f3.id]);
  expect(project.startupForm).toBe(form.name);
  stack.undo();
  expect(project.forms[1]).toBe(f2);
});

test('removeItem module', () => {
  const { project, stack } = setup();
  const m1 = { id: newId(), name: 'M1', code: 'a' };
  const m2 = { id: newId(), name: 'M2', code: 'b' };
  project.modules.push(m1, m2);
  stack.execute(removeItemCmd(m1.id));
  expect(project.modules).toEqual([m2]);
  stack.undo();
  expect(project.modules).toEqual([m1, m2]);
});

test('commands still work after unrelated commands ran in between (in stack order)', () => {
  const { form, stack } = setup();
  const [a, b] = seed(form, 'Label', 'Label');
  stack.execute(deleteControlsCmd(form.id, [a.id]));
  stack.execute(setPropertyCmd(form.id, b.id, 'Caption', 'z'));
  stack.undo(); stack.undo();
  expect(names(form)).toEqual([a.name, b.name]);
});
