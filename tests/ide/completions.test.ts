import { expect, test } from 'vitest';
import { classMemberNames, classOfVariable, completionsFor } from '../../src/ide/completions';
import { newControl, newForm } from '../../src/model/controls';

const form = newForm('Form1');
const t = newControl(form, 'TextBox', { left: 0, top: 0 }, null);
form.controls.push(t);
const c0 = newControl(form, 'CommandButton', { left: 0, top: 0 }, null); c0.name = 'Cmd'; c0.index = 0;
const c1 = newControl(form, 'CommandButton', { left: 0, top: 0 }, null); c1.name = 'Cmd'; c1.index = 1;
form.controls.push(c0, c1);

test('textbox members', () => expect(completionsFor('  Text1.', form)!.options).toEqual(expect.arrayContaining(['Text', 'SelStart', 'SetFocus'])));
test('prefix filter', () => expect(completionsFor('Text1.Se', form)!.options).toEqual(['SelLength', 'SelStart', 'SelText', 'SetFocus']));
test('me lists controls', () => expect(completionsFor('Me.', form)!.options).toEqual(expect.arrayContaining(['Text1', 'Caption', 'Show'])));
test('not in strings', () => expect(completionsFor('x = "Text1.', form)).toBeNull());
test('unknown object', () => expect(completionsFor('Foo.', form)).toBeNull());
test('not in comments', () => { expect(completionsFor("x = 1 ' Text1.", form)).toBeNull(); expect(completionsFor('Rem Text1.', form)).toBeNull(); });
test('after a closed string', () => expect(completionsFor('x = "a" & Text1.Te', form)).toEqual({ from: 16, options: ['Text'] }));
test('control array and Me.Control', () => {
  expect(completionsFor('Cmd(0).Cap', form)!.options).toEqual(['Caption']);
  expect(completionsFor('Me.Text1.SetF', form)).toEqual({ from: 9, options: ['SetFocus'] });
  expect(completionsFor('Form1.', form)!.options.filter(o => o === 'Cmd')).toEqual(['Cmd']);
});
test('no form', () => {
  expect(completionsFor('Text1.', null)).toBeNull();
});

test('member already typed in full: no list (Enter inserts a newline)', () => {
  expect(completionsFor('Text1.Text', form)).toBeNull();
  expect(completionsFor('Text1.text', form)).toBeNull();
  expect(completionsFor('Text1.Tex', form)!.options).toEqual(['Text']);
});

test('global objects: Screen, Clipboard, Forms, App; Controls and ActiveControl in a form', () => {
  expect(completionsFor('Screen.Active', form)!.options).toEqual(['ActiveControl', 'ActiveForm']);
  expect(completionsFor('Clipboard.', null)!.options).toEqual(['Clear', 'GetFormat', 'GetText', 'SetText']);
  expect(completionsFor('n = Forms.C', null)!.options).toEqual(['Count']);
  expect(completionsFor('Controls.', form)!.options).toEqual(['Count', 'Item']);
  expect(completionsFor('Me.Contr', form)!.options).toEqual(['ControlBox', 'Controls']);
  expect(completionsFor('Controls.', null)).toBeNull();
});
test('members of a class variable (class modules)', () => {
  const classes = new Map([['worker', 'Public Name As String, Count As Long\nPublic Sub Go()\nEnd Sub\nPrivate Sub Hidden()\nEnd Sub\nPublic Property Get Total() As Long\nEnd Property']]);
  const code = 'Private w As Worker\nSub X()\n  w.\nEnd Sub';
  const members = (name: string) => { const k = name === 'me' ? 'worker' : classOfVariable(code, name, classes); return k ? classMemberNames(classes.get(k)!) : null; };
  expect(completionsFor('  w.', null, members)!.options).toEqual(['Count', 'Go', 'Name', 'Total']);
  expect(completionsFor('  Me.T', null, members)!.options).toEqual(['Total']);
  expect(completionsFor('  q.', null, members)).toBeNull();
});
