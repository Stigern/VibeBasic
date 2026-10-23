import { expect, test } from 'vitest';
import { autoFixEventNames, validateCode } from '../../src/ai/validate';
import { newControl, newForm, newProject } from '../../src/model/controls';

const form = () => {
  const f = newProject().forms[0];
  f.controls.push(newControl(f, 'CommandButton', { left: 0, top: 0 }, null), newControl(f, 'Timer', { left: 0, top: 0 }, null));
  return f;   // Command1, Timer1
};

test('autoFixEventNames renames FormName_Event headers only', () => {
  const r = autoFixEventNames('Private Sub Form1_Load()\n    Form1_Resize\n    x = 1\nEnd Sub\n\nPublic Sub form1_click ()\nEnd Sub\nSub Form1_Custom()\nEnd Sub', 'Form1');
  expect(r.code).toBe('Private Sub Form_Load()\n    Form1_Resize\n    x = 1\nEnd Sub\n\nPublic Sub Form_Click ()\nEnd Sub\nSub Form1_Custom()\nEnd Sub');
  expect(r.notes).toEqual(['Renamed Form1_Load to Form_Load', 'Renamed form1_click to Form_Click']);
  expect(autoFixEventNames('Sub Form_Load()\nEnd Sub', 'Form1').notes).toEqual([]);
});

test('validateCode: clean code has no problems', () => {
  const f = form();
  expect(validateCode('Private Sub Command1_Click()\n    MsgBox "hi"\nEnd Sub\nPrivate Sub Form_Load()\nEnd Sub\nPrivate Sub Timer1_Timer()\nEnd Sub', { moduleName: 'Form1', form: f })).toEqual([]);
  expect(validateCode('Dim x As Integer', { moduleName: 'Form1', form: f })).toEqual([]);
  expect(validateCode('x = 1\nMsgBox x', { moduleName: 'Form1', form: f })).toEqual([]);
});

test('validateCode: syntax errors with line numbers', () => {
  const p = validateCode('Private Sub A()\n    If x Then\nEnd Sub', { moduleName: 'Form1', form: null });
  expect(p.length).toBeGreaterThan(0);
  expect(p[0]).toMatch(/^Line \d+: /);
  const bare = validateCode('x = 1\ny = = 2', { moduleName: 'Form1', form: null });
  expect(bare[0]).toMatch(/^Line 2: /);
});

test('validateCode: unknown control and wrong event', () => {
  const f = form();
  const p = validateCode('Private Sub Command9_Click()\nEnd Sub\nPrivate Sub Command1_Timer()\nEnd Sub\nPrivate Sub Helper_Work()\nEnd Sub\nPrivate Sub Do_It()\nEnd Sub', { moduleName: 'Form1', form: f });
  expect(p).toEqual(['There is no control named Command9, so Command9_Click would never run.', 'A CommandButton has no Timer event.']);
});

test('validateCode: extra controls and module code', () => {
  const f = form();
  const code = 'Private Sub lblHi_Click()\nEnd Sub';
  expect(validateCode(code, { moduleName: 'Form1', form: f })).toHaveLength(1);
  expect(validateCode(code, { moduleName: 'Form1', form: f, extraControls: [{ name: 'lblHi', type: 'Label' }] })).toEqual([]);
  expect(validateCode(code, { moduleName: 'Module1', form: null })).toEqual([]);
});

// ---- smarter checks (plan 07 task 2) ----

/** Form1: Label1, Text1(0..1), Command1, List1, TreeView1, Check1, Timer1. Form2: Command1. Module1: Public gCount, APP_NAME, Twice. */
function project() {
  const p = newProject();
  const f = p.forms[0];
  const add = (type: Parameters<typeof newControl>[1], index: number | null = null, name?: string) => {
    const c = newControl(f, type, { left: 0, top: 0 }, null);
    if (name) c.name = name;
    c.index = index;
    f.controls.push(c);
  };
  add('Label'); add('TextBox', 0); add('TextBox', 1, 'Text1'); add('CommandButton'); add('ListBox'); add('TreeView'); add('CheckBox'); add('Timer');
  f.code = 'Option Explicit\nPrivate mTotal As Long\n';
  const f2 = newForm('Form2');
  f2.controls.push(newControl(f2, 'CommandButton', { left: 0, top: 0 }, null));
  p.forms.push(f2);
  p.modules.push({ id: 'm1', name: 'Module1', code: 'Option Explicit\nPublic gCount As Long\nPublic Const APP_NAME = "Demo"\nPublic Function Twice(ByVal n As Long) As Long\n    Twice = n * 2\nEnd Function\n' });
  return p;
}
const inForm1 = (code: string) => { const p = project(); return validateCode(code, { moduleName: 'Form1', form: p.forms[0], project: p }); };
const sub = (body: string) => `Private Sub Command1_Click()\n${body}\nEnd Sub`;

test('unknown control member: suggestion from the mix-up table and from the registry', () => {
  expect(inForm1(sub('    Label1.Text = "x"'))).toEqual(['A Label has no Text property. Did you mean Caption?']);
  expect(inForm1(sub('    Me.Label1.Text = "x"'))).toEqual(['A Label has no Text property. Did you mean Caption?']);
  expect(inForm1(sub('    List1.Items.Add "x"'))).toEqual(['A ListBox has no Items property. Did you mean List or AddItem?']);
  expect(inForm1(sub('    Label1.Captoin = "x"'))).toEqual(['A Label has no Captoin property. Did you mean Caption?']);
  expect(inForm1(sub('    Me.Text = "x"'))).toEqual(['A Form has no Text property. Did you mean Caption?']);
  expect(inForm1(sub('    Command1.Flash'))).toEqual(['A CommandButton has no Flash method.']);
  // without a project the control check still runs
  const p = project();
  expect(validateCode(sub('    Label1.Text = "x"'), { moduleName: 'Form1', form: p.forms[0] })).toEqual(['A Label has no Text property. Did you mean Caption?']);
});

test('control arrays: Text1(0).Text is fine, a wrong member is still found', () => {
  expect(inForm1(sub('    Text1(0).Text = "x"\n    Text1(1).SelStart = Text1.UBound'))).toEqual([]);
  expect(inForm1(sub('    Text1(0).Caption = "x"'))).toEqual(['A TextBox has no Caption property. Did you mean Text?']);
});

test('unknown name before a dot', () => {
  expect(inForm1(sub('    Foo.Bar = 1'))).toEqual(['Foo is not a control, form, module or variable.']);
  // without a project, nothing is known about the other names: no report
  const p = project();
  expect(validateCode(sub('    Foo.Bar = 1'), { moduleName: 'Form1', form: p.forms[0] })).toEqual([]);
});

test('Option Explicit: undeclared variables', () => {
  const p = project();
  const mod = (code: string) => validateCode(code, { moduleName: 'Module2', form: null, project: p });
  expect(mod('Option Explicit\nSub Main()\n    x = 1\nEnd Sub')).toEqual(['Variable not defined: x']);
  expect(mod('Option Explicit\nSub Main()\n    Dim x\n    x = 1\nEnd Sub')).toEqual([]);
  expect(mod('Sub Main()\n    x = 1\nEnd Sub')).toEqual([]);
  // Form1's code already has Option Explicit: a proposed procedure without it is checked too
  expect(inForm1(sub('    total = 1'))).toEqual(['Variable not defined: total']);
});

test('unsupported functions and statements', () => {
  expect(inForm1(sub('    SaveSetting "App", "S", "K", Text1(0).Text'))).toEqual(['SaveSetting is not supported in VibeBasic. Use a module-level variable instead.']);
  expect(inForm1(sub('    Shell "notepad.exe"'))).toEqual(['Shell is not supported in VibeBasic. Programs cannot be started.']);
  expect(inForm1(sub('    Label1.Caption = StrConv("a b", vbProperCase) & Environ("HOME")\n    Beep'))).toEqual([]);
  expect(validateCode('Sub Main()\n    Dim o\n    Set o = CreateObject("Scripting.Dictionary")\nEnd Sub', { moduleName: 'Module2', form: null }))
    .toEqual(['CreateObject is not supported in VibeBasic.']);
  expect(validateCode('Sub Main()\n    Print #1, "x"\nEnd Sub', { moduleName: 'Module2', form: null }))
    .toEqual(['Line 2: Print # is not supported in VibeBasic. There is no file I/O; keep the data in variables instead.']);
});

test('a large valid program has no problems', () => {
  const code = `Option Explicit
Private Type Point2
    X As Long
    Y As Long
End Type
Private Enum Mode
    mdIdle
    mdBusy
End Enum

Private Sub Form_Load()
    Dim i As Integer, s As String, c As Control, p As Point2, m As Mode
    Me.Caption = APP_NAME & " " & Format(Now, "yyyy-mm-dd")
    Caption = "Main"
    Label1.Caption = UCase$("hi") & Chr(65) & CStr(Len("abc"))
    Text1(0).Text = Trim(Str(Val("42")))
    For i = 0 To Text1.UBound
        Text1(i).Enabled = True
    Next i
    gCount = gCount + Twice(3)
    Module1.gCount = 0
    mTotal = mTotal + 1
    List1.Clear
    List1.AddItem "One"
    s = List1.List(0) & List1.ListCount
    TreeView1.Nodes.Add , tvwChild, "k", "Key"
    Check1.Value = vbChecked
    Label1.ForeColor = vbRed
    p.X = 1
    m = mdBusy
    Form2.Command1.Caption = "Go"
    Form2.Show vbModal
    For Each c In Controls
        c.Tag = ""
    Next
    With Label1
        .Caption = "x"
        .Visible = True
    End With
    With Me
        .Width = 4800
    End With
    If MsgBox("Quit?", vbYesNo + vbQuestion, App.Title) = vbYes Then Unload Me
    Debug.Print Err.Number; Screen.Width
    s = Mid(s, 2) & vbCrLf & Left(s, 1)
    Timer1.Enabled = False
    Timer1.Interval = 500
    ReDim arr(3) As Long
    arr(0) = 1
    Select Case i
        Case 1 To 3: s = "a"
        Case Else: s = "b"
    End Select
    Do While i > 0
        i = i - 1
        DoEvents
    Loop
End Sub

Private Sub Command1_Click()
    Dim n As Long
    n = Helper(5)
    Label1.Caption = CStr(n)
    Command1.SetFocus
    MsgBox "Done", vbInformation
End Sub

Private Function Helper(ByVal x As Long) As Long
    Helper = x + mTotal
End Function

Private Sub Text1_Change(Index As Integer)
    Label1.Caption = Text1(Index).Text
End Sub

Private Sub Timer1_Timer()
    Label1.Caption = Time
End Sub

Private Sub Form_KeyPress(KeyAscii As Integer)
    If KeyAscii = 27 Then KeyAscii = 0
End Sub

Private Sub Text1_Click(Index As Integer)
    Label1.Caption = Greet("x") & Greet("y", True) & Greet("z", , "!")
    Label1.Tag = Choose(Index + 1, "a", "b", "c", "d") & UBound(Array(1, 2, 3, 4, 5))
End Sub

Private Function Greet(ByVal who As String, Optional ByVal loud As Boolean = False, Optional ByVal tail As String = ".") As String
    Greet = IIf(loud, UCase(who), who) & tail
End Function`;
  expect(inForm1(code)).toEqual([]);
});

test('run-time objects: Controls, Forms, Screen.ActiveControl and Clipboard are known in a form', () => {
  expect(inForm1(sub([
    '    Dim c As Control',
    '    For Each c In Controls: c.Tag = "": Next',
    '    Debug.Print Me.Controls.Count, Forms.Count, Me.ActiveControl.Name, Screen.ActiveForm.Caption, Screen.ActiveControl.Name',
    '    Clipboard.SetText Clipboard.GetText & "x"',
  ].join('\n')))).toEqual([]);
});

test('event signatures: count and declared types must match what the event passes', () => {
  expect(inForm1('Private Sub Form_KeyPress()\nEnd Sub')).toEqual(['Form_KeyPress needs (KeyAscii As Integer).']);
  expect(inForm1('Private Sub Text1_Change()\nEnd Sub')).toEqual(['Text1_Change needs (Index As Integer).']);
  expect(inForm1('Private Sub Command1_MouseDown(Button As Integer, Shift As Integer, X As Single)\nEnd Sub'))
    .toEqual(['Command1_MouseDown needs (Button As Integer, Shift As Integer, X As Single, Y As Single).']);
  expect(inForm1('Private Sub Form_QueryUnload(Cancel As Integer, UnloadMode As String)\nEnd Sub'))
    .toEqual(['Form_QueryUnload needs (Cancel As Integer, UnloadMode As Integer).']);
  // names may differ, undeclared types are not checked; without a project the rule still runs
  expect(inForm1('Private Sub Form_KeyDown(k As Integer, s As Integer)\nEnd Sub\nPrivate Sub Form_Unload(Cancel)\nEnd Sub')).toEqual([]);
  expect(validateCode('Private Sub Form_Load(x As Integer)\nEnd Sub', { moduleName: 'Form1', form: form() })).toEqual(['Form_Load needs ().']);
});

test('calls: procedures that exist nowhere and wrong argument counts', () => {
  expect(inForm1(sub('    DoWork 1\n    Label1.Caption = Missing(2)'))).toEqual(['Sub or Function not defined: DoWork', 'Sub or Function not defined: Missing']);
  expect(inForm1(sub('    Label1.Caption = Twice(1, 2)'))).toEqual(['Twice takes 1 argument, not 2.']);
  const opt = 'Private Sub Show2(ByVal a As Long, Optional ByVal b As Long)\nEnd Sub\n';
  expect(inForm1(opt + sub('    Show2 1\n    Show2 1, 2\n    Show2'))).toEqual(['Show2 takes 1 to 2 arguments, not 0.']);
  expect(inForm1(sub('    Label1.Caption = Left("abc") & Mid("abc", 1, 2, 3) & Choose(1)')))
    .toEqual(['Left takes 2 arguments, not 1.', 'Mid takes 2 to 3 arguments, not 4.', 'Choose takes at least 2 arguments, not 1.']);
  // without a project the other modules' names are unknown: no report
  const p = project();
  expect(validateCode(sub('    DoWork 1'), { moduleName: 'Form1', form: p.forms[0] })).toEqual([]);
});

test('a procedure defined twice in the proposal', () => {
  expect(validateCode('Sub Main()\nEnd Sub\nSub Helper()\nEnd Sub\nSub main()\nEnd Sub', { moduleName: 'Module2', form: null }))
    .toEqual(['main is defined more than once; keep one.']);
});
