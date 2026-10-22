import { expect, test } from 'vitest';
import { buildEventStub, findProcedureRange, insertProcedure, listProcedures } from '../../src/model/procedures';

test('event stub', () => expect(buildEventStub('Command1', false, { name: 'Click', params: '' })).toBe('Private Sub Command1_Click()\n\nEnd Sub'));
test('array stub', () => expect(buildEventStub('Text1', true, { name: 'KeyPress', params: 'KeyAscii As Integer' })).toBe('Private Sub Text1_KeyPress(Index As Integer, KeyAscii As Integer)\n\nEnd Sub'));
test('form stub', () => expect(buildEventStub('Form', false, { name: 'Load', params: '' })).toBe('Private Sub Form_Load()\n\nEnd Sub'));
test('list procedures tolerant', () => expect(listProcedures('Option Explicit\nPrivate Sub A()\nx = \nEnd Sub\nFunction B() As Integer\nEnd Function').map(p => [p.name, p.line, p.endLine])).toEqual([['A', 2, 4], ['B', 5, 6]]));
test('insert procedure', () => expect(insertProcedure('Option Explicit', 'Private Sub A()\n\nEnd Sub')).toEqual({ source: 'Option Explicit\n\nPrivate Sub A()\n\nEnd Sub', cursorLine: 4 }));
test('insert into empty source', () => expect(insertProcedure('', 'Sub A()\n\nEnd Sub')).toEqual({ source: 'Sub A()\n\nEnd Sub', cursorLine: 2 }));
test('find is case-insensitive; missing End Sub closes before next head', () => {
  const src = 'Sub A()\nx = 1\nSub B()\nEnd Sub';
  expect(findProcedureRange(src, 'a')).toMatchObject({ name: 'A', line: 1, endLine: 2 });
  expect(findProcedureRange(src, 'B')).toMatchObject({ line: 3, endLine: 4 });
  expect(findProcedureRange(src, 'C')).toBeNull();
});
