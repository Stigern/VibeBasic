import { tokenize } from '../../src/lang/lexer';
import { KEYWORDS } from '../../src/lang/tokens';
import { VBSyntaxError } from '../../src/lang/errors';

const kinds = (s: string) => tokenize(s).map(t => t.kind);

test('dim statement', () => expect(kinds('Dim x As Integer')).toEqual(['keyword','ident','keyword','keyword','eof']));
test('hex and octal', () => { expect(tokenize('&HFF')[0].value).toBe(255); expect(tokenize('&O17')[0].value).toBe(15); });
test('doubled quotes', () => expect(tokenize('"He said ""hi"""')[0].value).toBe('He said "hi"'));
test('comment and rem', () => { expect(kinds("x = 1 ' hei")).toEqual(['ident','op','number','comment','eof']); expect(tokenize('Rem hei')[0].kind).toBe('comment'); });
test('line continuation joins lines', () => expect(kinds('x = 1 + _\n  2')).toEqual(['ident','op','number','op','number','eof']));
test('colon separates statements', () => expect(kinds('a = 1: b = 2')).toContain('colon'));
test('type suffix', () => expect(tokenize('name$')[0]).toMatchObject({ kind: 'ident', text: 'name$', suffix: '$' }));
test('date literal', () => expect(tokenize('#1/2/2000#')[0].kind).toBe('date'));
test('two-char ops', () => expect(tokenize('a <> b <= c >= d').filter(t => t.kind === 'op').map(t => t.text)).toEqual(['<>','<=','>=']));
test('line numbers', () => expect(tokenize('a\nb')[2]).toMatchObject({ text: 'b', line: 2, col: 1 }));
test('unterminated string', () => expect(() => tokenize('"abc')).toThrow(VBSyntaxError));

// Extra coverage
test('keywords are case-insensitive and keep original text', () => {
  expect(tokenize('dIm')[0]).toMatchObject({ kind: 'keyword', text: 'dIm' });
});
test('Debug, MsgBox and Print are identifiers', () => {
  expect(kinds('Debug.Print MsgBox')).toEqual(['ident','op','ident','ident','eof']);
});
test('operator words and type names are keywords', () => {
  for (const w of ['And','Or','Not','Xor','Eqv','Imp','Mod','Like','Is','New','Integer','Long','Single','Double','String','Boolean','Variant','Date','Declare','Property','Implements','Open','Event','RaiseEvent']) {
    expect(KEYWORDS.has(w.toLowerCase()), w).toBe(true);
  }
});
test('keyword after a dot is a member name', () => {
  expect(kinds('x.Close')).toEqual(['ident','op','ident','eof']);
  expect(kinds('Err.Error')).toEqual(['ident','op','ident','eof']);
});
test('keyword with type suffix is an identifier', () => {
  expect(tokenize('String$')[0]).toMatchObject({ kind: 'ident', suffix: '$' });
});
test('numbers', () => {
  expect(tokenize('42')[0]).toMatchObject({ kind: 'number', value: 42 });
  expect(tokenize('1.5')[0].value).toBe(1.5);
  expect(tokenize('.5')[0].value).toBe(0.5);
  expect(tokenize('1.5E-3')[0].value).toBeCloseTo(0.0015);
  expect(tokenize('3#')[0]).toMatchObject({ value: 3, suffix: '#' });
  expect(tokenize('7&')[0]).toMatchObject({ value: 7, suffix: '&' });
});
test('hex/octal follow VB6 integer/long sign rules', () => {
  expect(tokenize('&HFFFF')[0].value).toBe(-1);
  expect(tokenize('&HFFFF&')[0].value).toBe(65535);
  expect(tokenize('&H80000005')[0].value).toBe(-2147483643);
  expect(tokenize('&HFF0000')[0].value).toBe(16711680);
  expect(tokenize('&O177777')[0].value).toBe(-1);
});
test('ampersand as concatenation operator', () => {
  expect(kinds('a & b')).toEqual(['ident','op','ident','eof']);
  expect(tokenize('"a" & "b"')[1]).toMatchObject({ kind: 'op', text: '&' });
});
test('member access vs leading-dot number', () => {
  expect(kinds('.Text')).toEqual(['op','ident','eof']);
});
test('named argument op', () => expect(tokenize('f x:=1')[2]).toMatchObject({ kind: 'op', text: ':=' }));
test('newline tokens, not collapsed, no trailing newline unless present', () => {
  expect(kinds('a\n\nb')).toEqual(['ident','newline','newline','ident','eof']);
  expect(kinds('a\r\nb\n')).toEqual(['ident','newline','ident','newline','eof']);
});
test('line numbers after continuation', () => {
  expect(tokenize('a + _\n b\nc').find(t => t.text === 'c')).toMatchObject({ line: 3, col: 1 });
  expect(tokenize('a + _\n b').find(t => t.text === 'b')).toMatchObject({ line: 2, col: 2 });
});
test('rem only at statement start', () => {
  expect(kinds('a: Rem hi')).toEqual(['ident','colon','comment','eof']);
  expect(kinds('Remark = 1')).toEqual(['ident','op','number','eof']);
});
test('non-ASCII identifiers and strings', () => {
  expect(tokenize('blåbær')[0]).toMatchObject({ kind: 'ident', text: 'blåbær' });
  expect(tokenize('"æøå"')[0].value).toBe('æøå');
});
test('hash that is not a date is an operator', () => {
  expect(kinds('Print #1, x')).toEqual(['ident','op','number','op','ident','eof']);
});
test('invalid character', () => expect(() => tokenize('a @ b')).toThrow(VBSyntaxError));
test('error carries line and col', () => {
  try { tokenize('a\n  "abc'); throw new Error('no throw'); }
  catch (e) { expect(e).toBeInstanceOf(VBSyntaxError); expect(e).toMatchObject({ line: 2, col: 3 }); }
});
