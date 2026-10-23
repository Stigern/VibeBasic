import { parseExpression, Parser } from '../../src/lang/parser';
import { argNames, exprToString } from '../../src/lang/ast';
import { tokenize } from '../../src/lang/lexer';
import { VBSyntaxError } from '../../src/lang/errors';

const p = (s: string) => exprToString(parseExpression(s));

test('precedence', () => expect(p('1 + 2 * 3 ^ 2')).toBe('(+ 1 (* 2 (^ 3 2)))'));
test('unary minus below power', () => expect(p('-2 ^ 2')).toBe('(neg (^ 2 2))'));
test('concat below plus', () => expect(p('a & b + c')).toBe('(& a (+ b c))'));
test('int div below mul', () => expect(p('a * b \\ c')).toBe('(\\ (* a b) c)'));
test('not below compare', () => expect(p('Not a = b')).toBe('(not (= a b))'));
test('member chain and call', () => expect(p('Form1.Command1(2).Caption')).toBe('(. (call (. Form1 Command1) 2) Caption)'));
test('missing args', () => expect(p('MsgBox("x", , "t")')).toBe('(call MsgBox "x" <missing> "t")'));
test('named args are kept by position; positional after named is an error', () => {
  const e = parseExpression('f(1, Title:=2)');
  expect(e.kind === 'call' && argNames(e.args)).toEqual([undefined, 'Title']);
  expect(() => p('f(x:=1, 2)')).toThrow('Expected: named parameter');
});

// Extra coverage
test('full precedence ladder', () => {
  expect(p('a Imp b Eqv c Xor d Or e And f')).toBe('(imp a (eqv b (xor c (or d (and e f)))))');
});
test('and binds tighter than or', () => expect(p('a Or b And c')).toBe('(or a (and b c))'));
test('mod between intdiv and plus', () => {
  expect(p('a + b Mod c \\ d')).toBe('(+ a (mod b (\\ c d)))');
  expect(p('a \\ b * c')).toBe('(\\ a (* b c))');
});
test('left associativity', () => {
  expect(p('a - b - c')).toBe('(- (- a b) c)');
  expect(p('a / b / c')).toBe('(/ (/ a b) c)');
  expect(p('2 ^ 3 ^ 2')).toBe('(^ (^ 2 3) 2)');
});
test('comparison operators', () => {
  expect(p('a <> b')).toBe('(<> a b)');
  expect(p('a <= b')).toBe('(<= a b)');
  expect(p('a >= b')).toBe('(>= a b)');
  expect(p('a < b')).toBe('(< a b)');
  expect(p('a > b')).toBe('(> a b)');
  expect(p('a Like "x*"')).toBe('(like a "x*")');
  expect(p('a Is Nothing')).toBe('(is a Nothing)');
});
test('compare below concat, above not/and', () => {
  expect(p('a & b = c')).toBe('(= (& a b) c)');
  expect(p('Not a And b')).toBe('(and (not a) b)');
  expect(p('a = 1 And b = 2')).toBe('(and (= a 1) (= b 2))');
});
test('not on the right side of a comparison', () => expect(p('x = Not y')).toBe('(= x (not y))'));
test('unary minus', () => {
  expect(p('-a * b')).toBe('(* (neg a) b)');
  expect(p('a * -b')).toBe('(* a (neg b))');
  expect(p('2 ^ -2')).toBe('(^ 2 (neg 2))');
  expect(p('--a')).toBe('(neg (neg a))');
  expect(p('+a')).toBe('a');
});
test('parentheses', () => expect(p('(1 + 2) * 3')).toBe('(* (+ 1 2) 3)'));
test('literals', () => {
  expect(p('42')).toBe('42');
  expect(p('1.5')).toBe('1.5');
  expect(p('"hi ""there"""')).toBe('"hi \\"there\\""');
  expect(p('#1/2/2000#')).toBe('#1/2/2000#');
  expect(p('True')).toBe('True');
  expect(p('false')).toBe('False');
  expect(p('Nothing')).toBe('Nothing');
});
test('literal node shapes', () => {
  expect(parseExpression('&HFFFF')).toMatchObject({ kind: 'number', value: -1, line: 1 });
  expect(parseExpression('5#')).toMatchObject({ kind: 'number', value: 5, suffix: '#' });
  expect(parseExpression('"a"')).toMatchObject({ kind: 'string', value: 'a' });
  expect(parseExpression('#1/2/2000#')).toMatchObject({ kind: 'date', text: '1/2/2000' });
  expect(parseExpression('True')).toMatchObject({ kind: 'bool', value: true });
  expect(parseExpression('Nothing')).toMatchObject({ kind: 'nothing' });
});
test('Me, Empty, Null parse as names', () => {
  expect(parseExpression('Me')).toMatchObject({ kind: 'name', name: 'Me' });
  expect(p('Me.Caption')).toBe('(. Me Caption)');
  expect(parseExpression('Empty')).toMatchObject({ kind: 'name', name: 'Empty' });
  expect(parseExpression('Null')).toMatchObject({ kind: 'name', name: 'Null' });
});
test('keyword-named builtins parse as names and calls', () => {
  expect(p('Date')).toBe('Date');
  expect(p('String(3, "x")')).toBe('(call String 3 "x")');
  expect(p('Error')).toBe('Error');
  expect(p('Err.Error')).toBe('(. Err Error)');
  expect(p('Date + 1')).toBe('(+ Date 1)');
});
test('type suffix on names', () => {
  expect(parseExpression('Left$(s, 2)')).toMatchObject({ kind: 'call', target: { kind: 'name', name: 'Left', suffix: '$' } });
  expect(p('x% + y&')).toBe('(+ x% y&)');
  expect(parseExpression('String$(3, "x")')).toMatchObject({ kind: 'call', target: { kind: 'name', name: 'String', suffix: '$' } });
});
test('calls', () => {
  expect(p('f()')).toBe('(call f)');
  expect(p('f(1)(2)')).toBe('(call (call f 1) 2)');
  expect(p('a(1, 2 + 3)')).toBe('(call a 1 (+ 2 3))');
  expect(p('f(, 1)')).toBe('(call f <missing> 1)');
  expect(p('f(1, )')).toBe('(call f 1 <missing>)');
  expect(p('f(g(1), h)')).toBe('(call f (call g 1) h)');
});
test('missing arg node', () => {
  const e = parseExpression('f(1, , 2)');
  if (e.kind !== 'call') throw new Error('expected call');
  expect(e.args[1]).toMatchObject({ kind: 'missing' });
});
test('member access', () => {
  expect(p('a.b.c')).toBe('(. (. a b) c)');
  expect(p('Err.Number')).toBe('(. Err Number)');
  expect(p('a.b(1).c(2)')).toBe('(call (. (call (. a b) 1) c) 2)');
});
test('with member', () => {
  expect(parseExpression('.Text')).toMatchObject({ kind: 'withMember', name: 'Text' });
  expect(p('.Text')).toBe('(with. Text)');
  expect(p('.Font.Bold')).toBe('(. (with. Font) Bold)');
  expect(p('.Items(2) + 1')).toBe('(+ (call (with. Items) 2) 1)');
  expect(p('x & .Text')).toBe('(& x (with. Text))');
});
test('new', () => expect(p('New Collection')).toBe('(new Collection)'));
test('TypeOf ... Is', () => {
  expect(p('Not TypeOf x.y Is VB.TextBox And b')).toBe('(and (not (typeof (. x y) VB.TextBox)) b)');
  expect(() => p('TypeOf x')).toThrow('Expected: Is');
});
test('every node carries line, also across continuations', () => {
  const e = parseExpression('a + _\n b');
  expect(e.line).toBe(1);
  if (e.kind !== 'binary') throw new Error('expected binary');
  expect(e.right.line).toBe(2);
});
test('syntax errors', () => {
  expect(() => p('')).toThrow(VBSyntaxError);
  expect(() => p('1 +')).toThrow(VBSyntaxError);
  expect(() => p('(1')).toThrow('Expected: )');
  expect(() => p('f(1')).toThrow('Expected: )');
  expect(() => p('1 2')).toThrow(VBSyntaxError);
  expect(() => p('* 2')).toThrow(VBSyntaxError);
  expect(() => p('Dim')).toThrow(VBSyntaxError);
});
test('syntax error carries position', () => {
  try { p('1 + )'); throw new Error('no throw'); } catch (e) {
    expect(e).toBeInstanceOf(VBSyntaxError);
    expect(e).toMatchObject({ line: 1, col: 5 });
  }
});

// Reuse by the statement parser: expression parsing leaves terminators alone.
test('Parser stops at tokens that cannot continue an expression', () => {
  for (const [src, rest] of [
    ['a + 1 Then', 'then'], ['1 To 10', 'to'], ['2 Step 1', 'step'],
    ['x, y', ','], ['x)', ')'], ['x : y', ':'], ["x ' c", "' c"], ['x\ny', '\n'],
  ] as const) {
    const ps = new Parser(tokenize(src));
    ps.parseExpression();
    expect(ps.peek().text.toLowerCase()).toBe(rest);
  }
  const ps = new Parser(tokenize('x'));
  ps.parseExpression();
  expect(ps.peek().kind).toBe('eof');
});
test('Parser parses consecutive expressions in one stream', () => {
  const ps = new Parser(tokenize('For i = 1 To n + 1 Step 2'));
  ps.advance(); ps.advance(); ps.advance(); // For i =
  expect(exprToString(ps.parseExpression())).toBe('1');
  ps.advance(); // To
  expect(exprToString(ps.parseExpression())).toBe('(+ n 1)');
});
