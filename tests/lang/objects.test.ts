// Objects: member dispatch (getMember / setMember / callMethod), default
// members, control arrays, Set and Is, With, Load/Unload, errors from host
// objects, and re-entrant events (Program.runEvent while another handler waits).

import { Program } from '../../src/lang/interp/program';
import { VBRef, type VBValue } from '../../src/lang/values';
import type { BreakInfo, VBObject } from '../../src/lang/host';
import { VBRuntimeError } from '../../src/lang/errors';
import { TestHost, TEST_OPTIONS } from './testHost';
import { FakeObject } from './fakeObject';

const lines = (...l: string[]) => l.join('\n');

/** Form1 with the given code; `objects` are what host.resolveName returns. */
function form(code: string, objects: Record<string, VBObject> = {}, host = new TestHost(), sliceSize?: number) {
  for (const [k, v] of Object.entries(objects)) host.objects.set(k.toLowerCase(), v);
  const prog = new Program([{ name: 'Form1', kind: 'form', source: code }], host, { ...TEST_OPTIONS, sliceSize });
  return { prog, host };
}

async function runForm(code: string, objects: Record<string, VBObject> = {}, proc = 'Form_Load', host = new TestHost()) {
  const { prog } = form(code, objects, host);
  await prog.runEvent('Form1', proc);
  return host.lines();
}

const sub = (...body: string[]) => lines('Sub Form_Load()', ...body, 'End Sub');

/** Records every call made on it; `props` answers hasMember/getMember. */
class Spy implements VBObject {
  calls: string[] = [];
  constructor(readonly vbTypeName = 'Spy', readonly props: Record<string, VBValue> = {}, readonly defaultMember?: string) {}
  hasMember(name: string) { return name.toLowerCase() in this.props; }
  getMember(name: string, args: VBValue[]) {
    this.calls.push(`get ${name}(${args.join(',')})`);
    return this.props[name.toLowerCase()] ?? `${name}!`;
  }
  setMember(name: string, args: VBValue[], value: VBValue) {
    this.calls.push(`set ${name}(${args.join(',')})=${typeof value === 'object' ? 'object' : String(value)}`);
  }
  callMethod(name: string, args: VBValue[]) {
    this.calls.push(`call ${name}(${args.join(',')})`);
    return `${name}()`;
  }
}

const deferred = <T>() => {
  let resolve!: (v: T) => void;
  const promise = new Promise<T>(r => { resolve = r; });
  return { promise, resolve };
};

describe('brief', () => {
  test('default member get/set', async () => {
    const fake = new FakeObject();
    const out = await runForm(sub('  Text1 = "hei"', '  Debug.Print Text1'), { Text1: fake });
    expect(out).toEqual(['hei']);
    expect(fake.props.Text).toBe('hei');
  });

  test('control array item', async () => {
    const items = { 0: new FakeObject('CommandButton'), 1: new FakeObject('CommandButton'), 2: new FakeObject('CommandButton') };
    const fake = new FakeObject('CommandButton', { items });
    const out = await runForm(sub('  Command1(2).Caption = "x"'), { Command1: fake });
    expect(out).toEqual([]);
    expect(fake.elements[2].props.Caption).toBe('x');
    expect(fake.elements[1].props.Caption).toBe('');
  });

  test('with block', async () => {
    const fake = new FakeObject();
    await runForm(sub('  With Text1', '    .Text = "a"', '  End With'), { Text1: fake });
    expect(fake.props.Text).toBe('a');
  });

  test('method statement without parens', async () => {
    const fake = new FakeObject('ListBox');
    await runForm(sub('  List1.AddItem "x"'), { List1: fake });
    expect(fake.log).toEqual(['AddItem:x']);
  });

  test('missing member is 438', async () => {
    const host = new TestHost();
    await runForm(sub('  Text1.Foo = 1'), { Text1: new FakeObject() }, 'Form_Load', host);
    expect(host.output).toContain('[Error 438 at Form1:2] Object doesn\'t support this property or method');
  });

  test('is nothing', async () => {
    const out = await runForm(sub('  Dim o As Object', '  Debug.Print o Is Nothing'));
    expect(out).toEqual(['True']);
  });

  test('byref event arg', async () => {
    const { prog } = form(lines('Sub Text1_KeyPress(KeyAscii As Integer)', '  KeyAscii = 0', 'End Sub'));
    const k = new VBRef(65);
    await prog.runEvent('Form1', 'Text1_KeyPress', [k]);
    expect(k.value).toBe(0);
  });

  test('nested events during DoEvents complete first', async () => {
    const code = lines(
      'Sub A_Click()', '  Debug.Print "a1"', '  DoEvents', '  Debug.Print "a2"', 'End Sub',
      'Sub B_Click()', '  Debug.Print "b"', 'End Sub',
    );
    const host = new TestHost();
    const { prog } = form(code, {}, host);
    host.doEvents = async () => { await prog.runEvent('Form1', 'B_Click'); };
    await prog.runEvent('Form1', 'A_Click');
    expect(host.lines()).toEqual(['a1', 'b', 'a2']);
  });
});

describe('member dispatch', () => {
  test('a.b is getMember(b, []) even when hasMember is false', async () => {
    const spy = new Spy();
    const out = await runForm(sub('  Debug.Print Obj.Thing'), { Obj: spy });
    expect(spy.calls).toEqual(['get Thing()']);
    expect(out).toEqual(['Thing!']);
  });

  test('a.b(1) is getMember when hasMember, else callMethod', async () => {
    const spy = new Spy('Spy', { list: 'L' });
    const out = await runForm(sub('  Debug.Print Obj.List(1)', '  Debug.Print Obj.Calc(2, 3)'), { Obj: spy });
    expect(spy.calls).toEqual(['get List(1)', 'call Calc(2,3)']);
    expect(out).toEqual(['L', 'Calc()']);
  });

  test('a statement a.b … is callMethod, with or without parens or Call', async () => {
    const spy = new Spy('Spy', { show: 1 });
    await runForm(sub('  Obj.Show', '  Obj.Show 1, "x"', '  Obj.Move (5)', '  Call Obj.Move(6, 7)'), { Obj: spy });
    expect(spy.calls).toEqual(['call Show()', 'call Show(1,x)', 'call Move(5)', 'call Move(6,7)']);
  });

  test('object arguments to callMethod are passed as their default member when they have one', async () => {
    const list = new FakeObject('ListBox');
    const t1 = new FakeObject('TextBox', { props: { Text: 'typed', Caption: '' } });
    const spy = new Spy('Form', { });
    const form1 = new FakeObject('Form', { defaultMember: undefined, props: { Caption: '' } });
    await runForm(sub('  List1.AddItem Text1', '  Dim x', '  x = Form2.Show(1, Form1)', '  Form2.Show 1, Form1'), { List1: list, Text1: t1, Form2: spy, Form1: form1 });
    expect(list.log).toEqual(['AddItem:typed']);
    let received: VBValue[] = [];
    const spy2: VBObject = { vbTypeName: 'Form', hasMember: () => false, getMember: () => 0, setMember: () => {}, callMethod: (_n, a) => { received = a; return 0; } };
    await runForm(sub('  Form2.Show 1, Form1, Text1'), { Form2: spy2, Form1: form1, Text1: t1 });
    expect(received[1]).toBe(form1);
    expect(received[2]).toBe('typed');
    expect(spy.calls).toEqual(['call Show(1,[object Object])', 'call Show(1,[object Object])']);
  });

  test('method statement on a With object and on a control array element', async () => {
    const list = new FakeObject('ListBox');
    const items = { 3: new FakeObject('ListBox') };
    const arr = new FakeObject('ListBox', { items });
    await runForm(sub('  With List1', '    .AddItem "a"', '  End With', '  Lists(3).AddItem "b"'), { List1: list, Lists: arr });
    expect(list.log).toEqual(['AddItem:a']);
    expect(items[3].log).toEqual(['AddItem:b']);
  });

  test('setting a property is setMember(name, [], value)', async () => {
    const spy = new Spy('Spy', { caption: '' });
    await runForm(sub('  Obj.Caption = "Hi"', '  Obj.Caption(2) = 5'), { Obj: spy });
    // a Let to a member first reads it to see whether it is an object (default member)
    expect(spy.calls).toEqual(['get Caption()', 'set Caption()=Hi', 'get Caption(2)', 'set Caption(2)=5']);
  });

  test('Let of an object to a member that holds an object passes the object (Picture1.Picture = LoadPicture(...))', async () => {
    const pic0 = new Spy('Picture');
    const spy = new Spy('PictureBox', { picture: pic0 });
    const pic = new Spy('Picture');
    await runForm(sub('  Obj.Picture = LoadPicture("")', '  Obj.Picture = Pic'), { Obj: spy, Pic: pic });
    expect(spy.calls).toEqual(['get Picture()', 'set Picture()=object', 'get Picture()', 'set Picture()=object']);
    expect(pic.calls).toEqual([]);
    expect(pic0.calls).toEqual([]);
  });

  test('Let of an object to a plain member stores its default value (Label1.Caption = Text1)', async () => {
    const label1 = new FakeObject('Label', { defaultMember: 'Caption' });
    const t1 = new FakeObject('TextBox', { props: { Text: 'from text1', Caption: '' } });
    const t2 = new FakeObject('TextBox', { props: { Text: 'from text2', Caption: '' } });
    const out = await runForm(sub('  Label1.Caption = Text1', '  Text1.Text = Text2', '  Debug.Print TypeName(Label1.Caption); Label1.Caption; "|"; Text1.Text'),
      { Label1: label1, Text1: t1, Text2: t2 });
    expect(out).toEqual(['Stringfrom text1|from text2']);
    expect(label1.props.Caption).toBe('from text1');
    expect(t1.props.Text).toBe('from text2');
  });

  test('Let of an object without a default member to a plain member is 438', async () => {
    const form1 = new FakeObject('Form', { defaultMember: undefined, props: { Caption: '' } });
    expect(await runForm(sub('  Label1.Caption = Form1'), { Label1: new FakeObject('Label'), Form1: form1 }))
      .toEqual(['[Error 438 at Form1:2] Object doesn\'t support this property or method']);
  });

  test('Set to a member passes the reference', async () => {
    const spy = new Spy('PictureBox', { picture: 0 });
    await runForm(sub('  Set Obj.Picture = Obj2', '  Set Obj.Picture = Nothing'), { Obj: spy, Obj2: new Spy() });
    expect(spy.calls).toEqual(['set Picture()=object', 'set Picture()=object']);
  });
});

describe('default member', () => {
  test('nested Form1.Text1 = "x" sets Text1\'s default member', async () => {
    const text1 = new FakeObject();
    const form1 = new FakeObject('Form', { defaultMember: undefined, props: { Caption: '' }, children: { Text1: text1 } });
    const out = await runForm(sub('  Form1.Text1 = "x"', '  Debug.Print Form1.Text1', '  Form1.Text1.Text = "y"', '  Debug.Print Form1.Text1 & "!"'), { Form1: form1 });
    expect(out).toEqual(['x', 'y!']);
    expect(text1.props.Text).toBe('y');
  });

  test('object used as a value gives its default member, in operators, builtins and arguments', async () => {
    const text1 = new FakeObject('TextBox', { props: { Text: '41' } });
    const out = await runForm(lines(
      'Sub Form_Load()', '  Dim s As String, v', '  s = Text1', '  v = Text1', '  Debug.Print s; v; Text1 + 1; Len(Text1); Twice(Text1)',
      '  If Text1 = "41" Then Debug.Print "eq"', 'End Sub',
      'Function Twice(n As Integer) As Integer', '  Twice = n * 2', 'End Function',
    ), { Text1: text1 });
    expect(out).toEqual(['4141 42  2  82 ', 'eq']);
  });

  test('Text1 = Text2 copies the default value', async () => {
    const t1 = new FakeObject();
    const t2 = new FakeObject('TextBox', { props: { Text: 'two' } });
    await runForm(sub('  Text1 = Text2'), { Text1: t1, Text2: t2 });
    expect(t1.props.Text).toBe('two');
  });

  test('no default member: 438 when read or assigned', async () => {
    const form1 = new FakeObject('Form', { defaultMember: undefined, props: { Caption: '' } });
    expect(await runForm(sub('  Dim x', '  x = Form1'), { Form1: form1 }))
      .toEqual(['[Error 438 at Form1:3] Object doesn\'t support this property or method']);
    expect(await runForm(sub('  Debug.Print Len(Form1)'), { Form1: form1 }))
      .toEqual(['[Error 438 at Form1:2] Object doesn\'t support this property or method']);
    expect(await runForm(sub('  Form1 = 5'), { Form1: form1 }))
      .toEqual(['[Error 438 at Form1:2] Object doesn\'t support this property or method']);
  });

  test('Let into an object variable sets the default member of the object it holds', async () => {
    const t1 = new FakeObject();
    expect(await runForm(sub('  Dim o As TextBox', '  Set o = Text1', '  o = "via o"', '  Debug.Print o'), { Text1: t1 }))
      .toEqual(['via o']);
    expect(t1.props.Text).toBe('via o');
    expect(await runForm(sub('  Dim p As Object', '  p = "x"')))
      .toEqual(['[Error 91 at Form1:3] Object variable or With block variable not set']);
  });
});

describe('control arrays', () => {
  const makeArr = () => {
    const items = { 0: new FakeObject('TextBox', { props: { Text: 'zero', Caption: 'c0' } }), 1: new FakeObject('TextBox', { props: { Text: 'one', Caption: 'c1' } }) };
    return { items, arr: new FakeObject('TextBox', { items }) };
  };

  test('read item members and default members', async () => {
    const { arr } = makeArr();
    expect(await runForm(sub('  Debug.Print Text2(1).Caption; Text2(0)', '  Dim i As Integer', '  i = 1', '  Debug.Print Text2(i)'), { Text2: arr }))
      .toEqual(['c1zero', 'one']);
  });

  test('assign to an item\'s default member', async () => {
    const { arr, items } = makeArr();
    await runForm(sub('  Text2(0) = "z"'), { Text2: arr });
    expect(items[0].props.Text).toBe('z');
  });

  test('missing element is the object\'s error (340)', async () => {
    const { arr } = makeArr();
    expect(await runForm(sub('  Text2(5).Caption = "x"'), { Text2: arr }))
      .toEqual(['[Error 340 at Form1:2] Control array element \'n\' doesn\'t exist']);
  });

  test('item is not used when the object has none: default member with arguments', async () => {
    const spy = new Spy('ListBox', {}, 'List');
    await runForm(sub('  Debug.Print Obj(2)', '  Obj(3) = "x"'), { Obj: spy });
    expect(spy.calls).toEqual(['get List(2)', 'set List(3)=x']);
  });
});

describe('Set and Is', () => {
  test('Set stores the reference; Is compares identity', async () => {
    const t1 = new FakeObject();
    const t2 = new FakeObject();
    const out = await runForm(sub(
      '  Dim a As Object, b As TextBox, v',
      '  Set a = Text1', '  Set b = Text1', '  Set v = Text1',
      '  Debug.Print a Is b', '  Debug.Print a Is Text2', '  Debug.Print v Is Text1',
      '  a.Text = "via a"', '  Debug.Print Text1.Text',
      '  Set a = Nothing', '  Debug.Print a Is Nothing', '  Debug.Print b Is Nothing',
    ), { Text1: t1, Text2: t2 });
    expect(out).toEqual(['True', 'False', 'True', 'via a', 'True', 'False']);
  });

  test('Set needs an object; Set into a non-object variable is a type mismatch', async () => {
    expect(await runForm(sub('  Dim a As Object', '  Set a = 5'))).toEqual(['[Error 424 at Form1:3] Object required']);
    expect(await runForm(sub('  Dim s As String', '  Set s = Text1'), { Text1: new FakeObject() }))
      .toEqual(['[Error 13 at Form1:3] Type mismatch']);
  });

  test('a Variant without Set gets the default value, not the object', async () => {
    const out = await runForm(sub('  Dim v', '  v = Text1', '  Text1.Text = "changed"', '  Debug.Print v; TypeName(v)'),
      { Text1: new FakeObject('TextBox', { props: { Text: 'orig' } }) });
    expect(out).toEqual(['origString']);
  });

  test('Is with a non-object is 424', async () => {
    expect(await runForm(sub('  Debug.Print 5 Is Nothing'))).toEqual(['[Error 424 at Form1:2] Object required']);
  });
});

describe('With', () => {
  test('nested With, .Font.Bold and With .Font', async () => {
    const font = new FakeObject('Font', { defaultMember: 'Name', props: { Name: 'Arial', Bold: false } });
    const t1 = new FakeObject('TextBox', { props: { Text: '', Caption: '' }, children: { Font: font } });
    const t2 = new FakeObject();
    const out = await runForm(sub(
      '  With Text1',
      '    .Font.Bold = True',
      '    With .Font',
      '      .Name = "Courier"',
      '      Debug.Print .Bold; .Name',
      '    End With',
      '    .Text = .Font.Name',
      '    With Text2',
      '      .Text = "inner"',
      '    End With',
      '    .Caption = "outer again"',
      '  End With',
    ), { Text1: t1, Text2: t2 });
    expect(out).toEqual(['TrueCourier']);
    expect(font.props).toEqual({ Name: 'Courier', Bold: true });
    expect(t1.props).toEqual({ Text: 'Courier', Caption: 'outer again' });
    expect(t2.props.Text).toBe('inner');
  });

  test('the With object is evaluated once', async () => {
    const t1 = new FakeObject();
    const form1 = new FakeObject('Form', { defaultMember: undefined, props: {}, children: { Text1: t1 } });
    form1.logAccess = true;
    await runForm(sub('  With Form1.Text1', '    .Text = "a"', '    .Caption = .Text', '  End With'), { Form1: form1 });
    expect(form1.log).toEqual(['get:Text1']);
    expect(t1.props).toEqual({ Text: 'a', Caption: 'a' });
  });

  test('With Nothing is 91', async () => {
    expect(await runForm(sub('  Dim o As Object', '  With o', '    .Text = 1', '  End With')))
      .toEqual(['[Error 91 at Form1:3] Object variable or With block variable not set']);
  });
});

describe('Load and Unload', () => {
  test('Unload X / Load X / Unload Me call the methods', async () => {
    const me = new FakeObject('Form');
    const form2 = new FakeObject('Form');
    await runForm(sub('  Load Form2', '  Unload Form2', '  Unload Me'), { Me: me, Form2: form2 });
    expect(form2.log).toEqual(['Load', 'Unload']);
    expect(me.log).toEqual(['Unload']);
  });

  test('an async Unload is awaited', async () => {
    const order: string[] = [];
    const form2 = new FakeObject('Form', {
      methods: { Unload: () => new Promise<VBValue>(r => setTimeout(() => { order.push('unloaded'); r(0); }, 5)) },
    });
    const host = new TestHost();
    host.debugPrint = (t: string) => { order.push(t); };
    await runForm(sub('  Unload Form2', '  Debug.Print "after"'), { Form2: form2 }, 'Form_Load', host);
    expect(order).toEqual(['unloaded', 'after']);
  });

  test('Unload Nothing is 91, Unload of a non-object is 424', async () => {
    expect(await runForm(sub('  Dim o As Object', '  Unload o'))).toEqual(['[Error 91 at Form1:3] Object variable or With block variable not set']);
    expect(await runForm(sub('  Dim n As Integer', '  Unload n'))).toEqual(['[Error 424 at Form1:3] Object required']);
  });
});

describe('errors', () => {
  test('errors thrown by objects are run-time errors at the right line', async () => {
    const bad: VBObject = {
      vbTypeName: 'Bad', hasMember: () => true,
      getMember: () => { throw new VBRuntimeError(380); },
      setMember: () => { throw new VBRuntimeError(383); },
      callMethod: () => { throw new VBRuntimeError(5); },
    };
    expect(await runForm(sub('  Dim x', '  x = Bad.Value'), { Bad: bad })).toEqual(['[Error 380 at Form1:3] Invalid property value']);
    expect(await runForm(sub('  Debug.Print "a"', '  Bad.Go'), { Bad: bad })).toEqual(['a', '[Error 5 at Form1:3] Invalid procedure call or argument']);
  });

  test('a rejected callMethod promise is a run-time error at the right line', async () => {
    const obj = new FakeObject('Form', { methods: { Show: () => Promise.reject(new VBRuntimeError(380)) } });
    expect(await runForm(sub('  Debug.Print "a"', '', '  Form2.Show 1'), { Form2: obj }))
      .toEqual(['a', '[Error 380 at Form1:4] Invalid property value']);
  });

  test('member access on Nothing is 91', async () => {
    const msg = 'Object variable or With block variable not set';
    expect(await runForm(sub('  Dim o As Object', '  Debug.Print o.Text'))).toEqual([`[Error 91 at Form1:3] ${msg}`]);
    expect(await runForm(sub('  Dim o As Object', '  o.Text = 1'))).toEqual([`[Error 91 at Form1:3] ${msg}`]);
    expect(await runForm(sub('  Dim o As Form', '  o.Show'))).toEqual([`[Error 91 at Form1:3] ${msg}`]);
    expect(await runForm(sub('  Dim o As Object, x', '  x = o'))).toEqual([`[Error 91 at Form1:3] ${msg}`]);
  });

  test('member access on a non-object is 424', async () => {
    expect(await runForm(sub('  Dim v', '  v.Text = 1'))).toEqual(['[Error 424 at Form1:3] Object required']);
  });
});

describe('async methods', () => {
  test('callMethod promises are awaited in statements and expressions', async () => {
    const order: string[] = [];
    const later = (v: VBValue) => new Promise<VBValue>(r => setTimeout(() => { order.push(`resolved ${String(v)}`); r(v); }, 5));
    const obj = new FakeObject('Form', { methods: { Show: () => later(0), Ask: a => later((a[0] as number) * 2) } });
    const host = new TestHost();
    host.debugPrint = (t: string) => { order.push(t); };
    await runForm(sub('  Form2.Show 1', '  Debug.Print Form2.Ask(21)'), { Form2: obj }, 'Form_Load', host);
    expect(order).toEqual(['resolved 0', 'resolved 42', ' 42 ']);
  });
});

describe('fast path', () => {
  test('a host property is read once even when the expression falls back to the generator path', async () => {
    const t1 = new FakeObject('TextBox', { props: { Text: 't', Caption: '' } });
    t1.logAccess = true;
    const out = await runForm(lines(
      'Sub Form_Load()', '  Dim o As Object', '  Set o = Text1',
      '  Debug.Print (o & "x") & F()', 'End Sub', 'Function F()', '  F = "!"', 'End Function',
    ), { Text1: t1 });
    expect(out).toEqual(['tx!']);
    expect(t1.log).toEqual(['get:Text']);
  });
});

describe('re-entrant events', () => {
  const code = lines(
    'Sub A_Click()', '  Debug.Print "a1"', '  DoEvents', '  Debug.Print "a2"', 'End Sub',
    'Sub B_Click()', '  Debug.Print "b1"', '  Slow.Wait', '  Debug.Print "b2"', 'End Sub',
  );
  const slow = () => new FakeObject('Timer', { methods: { Wait: () => new Promise<VBValue>(r => setTimeout(() => r(0), 10)) } });

  test('a nested event started (not awaited) by DoEvents finishes before the outer handler resumes', async () => {
    const host = new TestHost();
    const { prog } = form(code, { Slow: slow() }, host);
    let inner: Promise<void> | undefined;
    // the host starts B and lets DoEvents return at once, without waiting for B
    host.doEvents = () => new Promise<void>(resolve => setTimeout(() => { inner = prog.runEvent('Form1', 'B_Click'); resolve(); }, 0));
    await prog.runEvent('Form1', 'A_Click');
    expect(host.lines()).toEqual(['a1', 'b1', 'b2', 'a2']);
    await inner;
    expect(prog.state).toBe('idle');
  });

  test('an event started while a handler waits for an async method runs nested', async () => {
    const host = new TestHost();
    const gate = deferred<VBValue>();
    const dlg = new FakeObject('Form', { methods: { Show: () => gate.promise } });
    const { prog } = form(lines(
      'Sub A_Click()', '  Debug.Print "a1"', '  Dlg.Show', '  Debug.Print "a2"', 'End Sub',
      'Sub B_Click()', '  Debug.Print "b1"', '  Slow.Wait', '  Debug.Print "b2"', 'End Sub',
    ), { Dlg: dlg, Slow: slow() }, host);
    const a = prog.runEvent('Form1', 'A_Click');
    await new Promise(r => setTimeout(r, 0));
    const b = prog.runEvent('Form1', 'B_Click');
    gate.resolve(0); // the dialog closes while B is still running
    await a;
    await b;
    expect(host.lines()).toEqual(['a1', 'b1', 'b2', 'a2']);
  });

  test('events arriving during a busy loop wait until the handler is done', async () => {
    const host = new TestHost();
    const { prog } = form(lines(
      'Sub A_Click()', '  Dim i As Long', '  For i = 1 To 500', '  Next', '  Debug.Print "a"', 'End Sub',
      'Sub B_Click()', '  Debug.Print "b"', 'End Sub',
    ), {}, host, 10);
    let b: Promise<void> | undefined;
    setTimeout(() => { b = prog.runEvent('Form1', 'B_Click'); }, 0);
    await prog.runEvent('Form1', 'A_Click');
    await b;
    expect(host.lines()).toEqual(['a', 'b']);
  });

  test('events queued during a busy loop run at the next DoEvents', async () => {
    const host = new TestHost();
    const { prog } = form(lines(
      'Sub A_Click()', '  Dim i As Long', '  For i = 1 To 500', '    If i = 400 Then DoEvents', '  Next', '  Debug.Print "a"', 'End Sub',
      'Sub B_Click()', '  Debug.Print "b"', 'End Sub',
    ), {}, host, 10);
    let b: Promise<void> | undefined;
    setTimeout(() => { b = prog.runEvent('Form1', 'B_Click'); }, 0);
    await prog.runEvent('Form1', 'A_Click');
    await b;
    expect(host.lines()).toEqual(['b', 'a']);
  });

  test('End in a nested event stops the waiting outer handler too', async () => {
    const host = new TestHost();
    const { prog } = form(lines(
      'Sub A_Click()', '  Debug.Print "a1"', '  DoEvents', '  Debug.Print "a2"', 'End Sub',
      'Sub B_Click()', '  Debug.Print "b"', '  End', 'End Sub',
    ), {}, host);
    let inner: Promise<void> | undefined;
    host.doEvents = () => new Promise<void>(resolve => setTimeout(() => { inner = prog.runEvent('Form1', 'B_Click'); resolve(); }, 0));
    await prog.runEvent('Form1', 'A_Click');
    await inner;
    expect(host.lines()).toEqual(['a1', 'b']);
    expect(prog.state).toBe('ended');
    expect(host.endCalls).toBe(1);
  });

  test('a handler fired synchronously by a property set runs to completion before the setter statement finishes', async () => {
    const host = new TestHost();
    let prog!: Program;
    const text1 = new FakeObject();
    const origSet = text1.setMember.bind(text1);
    // like a real TextBox: setting Text fires Text1_Change
    text1.setMember = (name, args, value) => { origSet(name, args, value); void prog.runEvent('Form1', 'Text1_Change'); };
    ({ prog } = form(lines(
      'Sub Form_Load()', '  Text1.Text = "x"', '  Debug.Print "after"', 'End Sub',
      'Sub Text1_Change()', '  Debug.Print "c1"', '  Slow.Wait', '  Debug.Print "c2"', 'End Sub',
    ), { Text1: text1, Slow: slow() }, host));
    await prog.runEvent('Form1', 'Form_Load');
    expect(host.lines()).toEqual(['c1', 'c2', 'after']);
  });

  test('End while a nested handler waits forever still finishes the outer handler', async () => {
    const host = new TestHost();
    const never = new FakeObject('Form', { methods: { Show: () => new Promise<VBValue>(() => {}) } });
    const { prog } = form(lines(
      'Sub A_Click()', '  Debug.Print "a1"', '  DoEvents', '  Debug.Print "a2"', 'End Sub',
      'Sub B_Click()', '  Debug.Print "b1"', '  Dlg.Show', 'End Sub',
    ), { Dlg: never }, host);
    host.doEvents = () => new Promise<void>(resolve => setTimeout(() => { void prog.runEvent('Form1', 'B_Click'); resolve(); }, 0));
    const a = prog.runEvent('Form1', 'A_Click');
    setTimeout(() => prog.end(), 20);
    await a;
    expect(host.lines()).toEqual(['a1', 'b1']);
    expect(prog.state).toBe('ended');
  });

  test('an event fired synchronously by its own handler recursing is error 28, not a JS stack overflow', async () => {
    const host = new TestHost();
    let prog!: Program;
    const text1 = new FakeObject();
    const origSet = text1.setMember.bind(text1);
    text1.setMember = (name, args, value) => { origSet(name, args, value); void prog.runEvent('Form1', 'Text1_Change'); };
    ({ prog } = form(lines(
      'Dim n As Long',
      'Sub Text1_Change()',
      '  n = n + 1',
      '  Text1.Text = CStr(n)',
      'End Sub',
    ), { Text1: text1 }, host));
    // (an unhandled rejection from a JS stack overflow would also fail the Vitest run)
    await prog.runEvent('Form1', 'Text1_Change');
    await new Promise(r => setTimeout(r, 20));
    expect(host.lines()).toEqual(['[Error 28 at Form1:4] Out of stack space']);
    expect(prog.state).toBe('ended');
    expect(host.endCalls).toBe(1);
  });

  test('synchronously fired events may nest below the limit', async () => {
    const host = new TestHost();
    let prog!: Program;
    const text1 = new FakeObject();
    const origSet = text1.setMember.bind(text1);
    text1.setMember = (name, args, value) => { origSet(name, args, value); void prog.runEvent('Form1', 'Text1_Change'); };
    ({ prog } = form(lines(
      'Dim n As Long',
      'Sub Text1_Change()',
      '  n = n + 1',
      '  If n < 90 Then Text1.Text = CStr(n) Else Debug.Print n',
      'End Sub',
    ), { Text1: text1 }, host));
    await prog.runEvent('Form1', 'Text1_Change');
    expect(host.lines()).toEqual([' 90 ']);
    expect(prog.state).toBe('idle');
  });

  test('events arriving while an unhandled error is reported are dropped', async () => {
    class ErrHost extends TestHost {
      prog!: Program;
      inner?: Promise<void>;
      override async onRuntimeError(...a: Parameters<TestHost['onRuntimeError']>) {
        this.inner = this.prog.runEvent('Form1', 'Tick'); // a Timer tick while the error dialog is open
        await new Promise(r => setTimeout(r, 5));
        return super.onRuntimeError(...a);
      }
    }
    const host = new ErrHost();
    const { prog } = form(lines(
      'Sub A_Click()', '  Debug.Print 1 / 0', 'End Sub',
      'Sub Tick()', '  Debug.Print "tick"', 'End Sub',
    ), {}, host);
    host.prog = prog;
    await prog.runEvent('Form1', 'A_Click');
    await host.inner;
    expect(host.lines()).toEqual(['[Error 11 at Form1:2] Division by zero']);
  });

  test('events queued during a busy loop that then fails are not run', async () => {
    const host = new TestHost();
    host.errorChoice = 'end';
    const { prog } = form(lines(
      'Sub A_Click()', '  Dim i As Long', '  For i = 1 To 500', '  Next', '  Debug.Print 1 / 0', 'End Sub',
      'Sub B_Click()', '  Debug.Print "b"', 'End Sub',
    ), {}, host, 10);
    let b: Promise<void> | undefined;
    setTimeout(() => { b = prog.runEvent('Form1', 'B_Click'); }, 0);
    await prog.runEvent('Form1', 'A_Click');
    await b;
    expect(b).toBeDefined();
    expect(host.lines()).toEqual(['[Error 11 at Form1:5] Division by zero']);
  });

  test('many DoEvents waits with nested events do not pile up end listeners', async () => {
    const host = new TestHost();
    const { prog } = form(lines(
      'Sub A_Click()', '  Dim i As Long', '  For i = 1 To 300', '    DoEvents', '  Next', '  Debug.Print "done"', 'End Sub',
      'Sub B_Click()', 'End Sub',
    ), {}, host);
    host.doEvents = () => new Promise<void>(resolve => setTimeout(() => { void prog.runEvent('Form1', 'B_Click'); resolve(); }, 0));
    await prog.runEvent('Form1', 'A_Click');
    expect(host.lines()).toEqual(['done']);
    // internal: no waiter left registered on program end
    expect((prog as unknown as { rt: { endWaiters: Set<unknown> } }).rt.endWaiters.size).toBe(0);
  });

  test('events are dropped while the program is in break mode', async () => {
    class BreakHost extends TestHost {
      gate = deferred<'continue' | 'end'>();
      onBreakCalled = deferred<void>();
      override onBreak(info: BreakInfo) {
        this.breaks.push(info);
        this.onBreakCalled.resolve();
        return this.gate.promise;
      }
    }
    const host = new BreakHost();
    const { prog } = form(lines(
      'Sub A_Click()', '  Debug.Print "a1"', '  Stop', '  Debug.Print "a2"', 'End Sub',
      'Sub B_Click()', '  Debug.Print "b"', 'End Sub',
    ), {}, host);
    const a = prog.runEvent('Form1', 'A_Click');
    await host.onBreakCalled.promise;
    expect(prog.state).toBe('break');
    await prog.runEvent('Form1', 'B_Click'); // resolves at once, B does not run
    host.gate.resolve('continue');
    await a;
    expect(host.lines()).toEqual(['a1', 'a2']);
  });
});

describe('form members without Me (final review)', () => {
  const meForm = (props: Record<string, VBValue> = {}) =>
    new FakeObject('Form', { defaultMember: undefined, props: { Caption: 'Form1', Width: 4800, Left: 120, ...props }, methods: { Hide: () => 0 } });

  test('Caption = "x" sets the form\'s Caption; a bare Caption reads it', async () => {
    const me = meForm();
    expect(await runForm(sub('  Caption = "Hello"', '  Debug.Print Caption'), { Me: me, Form1: me })).toEqual(['Hello']);
    expect(me.props.Caption).toBe('Hello');
  });

  test('Width is read and written through the form', async () => {
    const me = meForm();
    expect(await runForm(sub('  Width = Width + 1200', '  Debug.Print Width'), { Me: me })).toEqual([' 6000 ']);
    expect(me.props.Width).toBe(6000);
  });

  test('a bare method name calls the form\'s method; an unknown one is Sub or Function not defined', async () => {
    const me = meForm();
    expect(await runForm(sub('  Hide', '  Debug.Print "after"', '  Frobnicate 1'), { Me: me }))
      .toEqual(['after', '[Error 0 at Form1:4] Compile error: Sub or Function not defined']);
    expect(me.log).toEqual(['Hide']);
  });

  test('Me.Caption still works', async () => {
    const me = meForm();
    expect(await runForm(sub('  Me.Caption = "M"', '  Debug.Print Me.Caption; Caption'), { Me: me })).toEqual(['MM']);
  });

  test('Option Explicit: form members are declared names; other names are not', async () => {
    const me = meForm();
    const code = lines('Option Explicit', 'Sub Form_Load()', '  Caption = "OE"', '  Debug.Print Caption', '  y = 1', 'End Sub');
    expect(await runForm(code, { Me: me })).toEqual(['OE', '[Error 0 at Form1:5] Compile error: Variable not defined']);
    expect(me.props.Caption).toBe('OE');
  });

  test('a built-in with call arguments wins over a form property of the same name', async () => {
    const me = meForm();
    expect(await runForm(sub('  Debug.Print Left("abc", 2); Left'), { Me: me })).toEqual(['ab 120 ']);
  });

  test('control and form members come before global Publics inside the form, not in other modules', async () => {
    const host = new TestHost();
    const text1 = new FakeObject('TextBox', { props: { Text: '', Caption: '' } });
    const me = meForm();
    host.objects.set('me', me);
    host.objects.set('text1', text1);
    const prog = new Program([
      { name: 'Module1', kind: 'module', source: lines('Public Text1 As String', 'Public Caption As String', 'Sub SetGlobals()', '  Text1 = "global"', '  Caption = "gcap"', 'End Sub') },
      { name: 'Form1', kind: 'form', source: sub('  SetGlobals', '  Text1 = "control"', '  Caption = "form"', '  Debug.Print Module1.Text1; " "; Module1.Caption') },
    ], host, TEST_OPTIONS);
    await prog.runEvent('Form1', 'Form_Load');
    expect(host.lines()).toEqual(['global gcap']);
    expect(text1.props.Text).toBe('control');
    expect(me.props.Caption).toBe('form');
  });

  test('the module\'s own variables come before form members', async () => {
    const me = meForm();
    const code = lines('Dim Caption As String', 'Sub Form_Load()', '  Caption = "var"', '  Debug.Print Caption', 'End Sub');
    expect(await runForm(code, { Me: me })).toEqual(['var']);
    expect(me.props.Caption).toBe('Form1');
  });

  test('a form property is read once per use (no extra read by the fast path)', async () => {
    const me = meForm();
    me.logAccess = true;
    expect(await runForm(sub('  Dim x', '  x = Width * 2', '  x = Width * 2', '  Debug.Print x'), { Me: me })).toEqual([' 9600 ']);
    expect(me.log).toEqual(['get:Width', 'get:Width']);
  });

  test('a standard module does not see the form\'s members', async () => {
    const host = new TestHost();
    const me = meForm();
    host.objects.set('me', me);
    const prog = new Program([{ name: 'Module1', kind: 'module', source: lines('Sub Main()', '  Caption = "x"', '  Debug.Print Caption', 'End Sub') }], host, TEST_OPTIONS);
    await prog.runEvent('Module1', 'Main');
    expect(host.lines()).toEqual(['x']);
    expect(me.props.Caption).toBe('Form1');
  });

  test('Set of a form property and an indexed form property', async () => {
    const pic = new FakeObject('Picture', { defaultMember: undefined, props: {} });
    const me = meForm({ Picture: pic, List: ['a', 'b'] as unknown as VBValue });
    expect(await runForm(sub('  Set Picture = Picture', '  List(1) = "z"', '  Debug.Print List(0); List(1)'), { Me: me })).toEqual(['az']);
    expect(me.props.Picture).toBe(pic);
  });
});

describe('For Each over objects and End in a sync-fired event (final review)', () => {
  const makeArr = () => {
    const items = {
      2: new FakeObject('CommandButton', { props: { Caption: 'two' } }),
      0: new FakeObject('CommandButton', { props: { Caption: 'zero' } }),
      1: new FakeObject('CommandButton', { props: { Caption: 'one' } }),
    };
    return new FakeObject('CommandButton', { defaultMember: undefined, items });
  };

  test('For Each c In Command1 visits the control array in index order', async () => {
    const code = lines('Option Explicit', 'Sub Form_Load()', '  Dim c As Variant, b As CommandButton', '  For Each c In Command1',
      '    Debug.Print c.Caption', '  Next', '  For Each b In Command1', '    b.Caption = UCase(b.Caption)', '  Next', '  Debug.Print Command1(2).Caption', 'End Sub');
    expect(await runForm(code, { Command1: makeArr() })).toEqual(['zero', 'one', 'two', 'TWO']);
  });

  test('For Each over an object without items is 438, over Nothing 91', async () => {
    const text1 = new FakeObject('TextBox');
    expect(await runForm(sub('  Dim c', '  For Each c In Text1', '  Next'), { Text1: text1 }))
      .toEqual(['[Error 438 at Form1:3] Object doesn\'t support this property or method']);
    expect(await runForm(sub('  Dim c, o As Object', '  For Each c In o', '  Next')))
      .toEqual(['[Error 91 at Form1:3] Object variable or With block variable not set']);
  });

  test('End in an event fired synchronously by a host call stops the outer statement at once', async () => {
    const host = new TestHost();
    let prog!: Program;
    class Firing extends Spy {
      override getMember(name: string, args: VBValue[]) {
        void prog.runEvent('Form1', 'Obj_Change');
        return super.getMember(name, args);
      }
    }
    const obj = new Firing('Spy', { fire: 'v' });
    ({ prog } = form(lines('Sub Form_Load()', '  Debug.Print Obj.Fire; "after"', '  Debug.Print "next"', 'End Sub',
      'Sub Obj_Change()', '  End', 'End Sub'), { Obj: obj }, host));
    await prog.runEvent('Form1', 'Form_Load');
    expect(host.lines()).toEqual([]);
    expect(prog.state).toBe('ended');
    expect(host.endCalls).toBe(1);
  });
});
