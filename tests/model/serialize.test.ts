import { serializeProject, parseProject, ProjectFormatError } from '../../src/model/serialize';
import { newProject } from '../../src/model/controls';

const NOT_PROJECT = 'This is not a VibeBasic project file.';

test('roundtrip', () => { const p = newProject(); expect(parseProject(serializeProject(p))).toEqual(p); });
test('condComp (conditional compilation arguments) round-trips; a non-string is rejected', () => {
  const p = { ...newProject(), condComp: 'DEBUG = 1' };
  expect(parseProject(serializeProject(p)).condComp).toBe('DEBUG = 1');
  expect(() => parseProject(serializeProject({ ...p, condComp: 5 as unknown as string }))).toThrow(NOT_PROJECT);
});
test('header first', () => expect(serializeProject(newProject()).startsWith('{\n  "format": "vibebasic-project",\n  "version": 1')).toBe(true));
test('not a project', () => expect(() => parseProject('{"a":1}')).toThrow(NOT_PROJECT));
test('newer version', () => expect(() => parseProject('{"format":"vibebasic-project","version":2}')).toThrow('This project was made with a newer version of VibeBasic.'));
test('garbage', () => expect(() => parseProject('hei')).toThrow(NOT_PROJECT));

test('errors are ProjectFormatError', () => {
  expect(() => parseProject('hei')).toThrow(ProjectFormatError);
});
test('right header but missing fields', () => {
  expect(() => parseProject('{"format":"vibebasic-project","version":1}')).toThrow(NOT_PROJECT);
  expect(() => parseProject('{"format":"vibebasic-project","version":1,"name":"P","forms":{}}')).toThrow(NOT_PROJECT);
});
test('wrong field types', () => {
  const p = JSON.parse(serializeProject(newProject()));
  p.startupForm = 5;
  expect(() => parseProject(JSON.stringify(p))).toThrow(NOT_PROJECT);
  const q = JSON.parse(serializeProject(newProject()));
  q.forms[0].controls = 'x';
  expect(() => parseProject(JSON.stringify(q))).toThrow(NOT_PROJECT);
});
test('non-object json', () => {
  expect(() => parseProject('null')).toThrow(NOT_PROJECT);
  expect(() => parseProject('[1]')).toThrow(NOT_PROJECT);
});

test('rejects files that would crash the IDE', () => {
  const bad = (f: (p: ReturnType<typeof newProject>) => void) => {
    const p = newProject(); f(p);
    expect(() => parseProject(serializeProject(p))).toThrow(NOT_PROJECT);
  };
  bad(p => { p.forms = []; });
  bad(p => { p.startupForm = 'Nope'; });
  const ctl = (type: string) => ({ id: 'c', type, name: 'C', index: null, parentId: null, props: {} }) as never;
  bad(p => { p.forms[0].controls.push(ctl('Bogus')); });
  bad(p => { p.forms[0].controls.push(ctl('Form')); });
  bad(p => { p.forms[0].controls.push(ctl('toString')); });
});
test('a class module saves and loads (kind and Instancing are optional fields)', () => {
  const p = newProject();
  p.modules.push({ id: 'c1', name: 'Class1', code: 'Public Value As Long', kind: 'class', instancing: 1 }, { id: 'm1', name: 'Module1', code: '' });
  const back = parseProject(serializeProject(p));
  expect(back.modules).toEqual(p.modules);
  expect(() => parseProject(serializeProject(p).replace('"kind": "class"', '"kind": "form"'))).toThrow(ProjectFormatError);
});
