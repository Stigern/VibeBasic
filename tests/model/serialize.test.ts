import { serializeProject, parseProject, ProjectFormatError } from '../../src/model/serialize';
import { newProject } from '../../src/model/controls';

const NOT_PROJECT = 'This is not a VibeBasic project file.';

test('roundtrip', () => { const p = newProject(); expect(parseProject(serializeProject(p))).toEqual(p); });
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
