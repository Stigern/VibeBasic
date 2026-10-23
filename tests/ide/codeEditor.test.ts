// @vitest-environment jsdom
// Code window readability: block scanner (folding), Edit > Outlining, palettes, matching keywords, Enter, pretty listing.
import { beforeEach, expect, test } from 'vitest';
import type { EditorView } from '@codemirror/view';
import { foldedRanges } from '@codemirror/language';
import { openCodeWindow, registerCodeActions, type CodeWindow } from '../../src/ide/codeWindow';
import { IdeState } from '../../src/ide/ideState';
import type { IdeActions } from '../../src/ide/menus';
import { scanBlocks } from '../../src/ide/vbBlocks';
import { matchingKeywords, vbEnter } from '../../src/ide/vbEditing';
import { vbSpans } from '../../src/ide/vbLanguage';

const rect = { x: 0, y: 0, top: 0, left: 0, right: 0, bottom: 0, width: 0, height: 0, toJSON() {} };
Range.prototype.getClientRects = () => [] as unknown as DOMRectList;
Range.prototype.getBoundingClientRect = () => rect as DOMRect;

const scan = (src: string) => { const ls = src.split('\n'); return scanBlocks(n => ls[n - 1], ls.length); };
const ranges = (src: string) => scan(src).blocks.map(b => `${b.kind} ${b.start}-${b.end}`);

test('fold ranges for each block kind; nested blocks; single-line If is not foldable', () => {
  const src = [
    "' one",                                  // 1  comment run 1-3
    "' two",
    "' three",
    'Private Type Pt',                        // 4  type 4-6
    '  X As Long',
    'End Type',
    'Enum Colour',                            // 7  enum 7-9
    '  Red',
    'End Enum',
    'Private Sub Form_Load()',                // 10 proc 10-34
    '  If a Then b = 1',                      // single-line: no block
    '  If a Then',                            // 12 if 12-16
    '    For i = 1 To 3',                     // 13 for 13-15
    '      x = x + i',
    '    Next i',
    '  End If',
    '  For Each c In Controls',               // 17 for 17-18
    '  Next',
    '  Do While x < 3',                       // 19 do 19-20
    '  Loop',
    '  While x',                              // 21 while 21-22
    '  Wend',
    '  Select Case x',                        // 23 select 23-29
    '    Case 1',                             // 24 case 24-25
    '      y = 1',
    '    Case Else',                          // 26 case 26-28
    '      y = 2',
    '      y = 3',
    '  End Select',
    '  With Text1',                           // 30 with 30-31
    '  End With',
    '  Do: x = 1: Loop',                      // one line: no block
    '  x = 0',
    'End Sub',
  ].join('\n');
  expect(ranges(src)).toEqual([
    'comment 1-3', 'type 4-6', 'enum 7-9', 'proc 10-34', 'if 12-16', 'for 13-15', 'for 17-18', 'do 19-20',
    'while 21-22', 'select 23-29', 'case 24-25', 'case 26-28', 'with 30-31',
  ]);
  const s = scan(src);
  expect(s.unclosed.size).toBe(0);
  // two comment lines are no block; a missing End If leaves the If unclosed (not foldable)
  expect(ranges("' a\n' b\nSub X()\n  If a Then\nEnd Sub")).toEqual(['proc 3-5']);
  expect(scan("Sub X()\n  If a Then\nEnd Sub").unclosed.get(2)).toBe('End If');
  // `Next j, i` closes two loops; a continued header folds from its last line
  expect(ranges('For i = 1 To 2\nFor j = 1 To 2\nNext j, i')).toEqual(['for 1-3', 'for 2-3']);
  const c = scan('Sub X(a, _\n  b)\n  y = 1\nEnd Sub').blocks[0];
  expect([c.start, c.headEnd, c.end]).toEqual([1, 2, 4]);
  // strings and comments do not count
  expect(ranges('x = "If a Then"\n\' End If\nIf a Then \' note\n  y\nEnd If')).toEqual(['if 3-5']);
});

let ide: IdeState, host: HTMLElement, cw: CodeWindow, view: EditorView, actions: IdeActions;
const form = () => ide.project.forms[0];
const set = (text: string, cursor = 0) => view.dispatch({ changes: { from: 0, to: view.state.doc.length, insert: text }, selection: { anchor: cursor } });
const folds = () => { const out: string[] = []; foldedRanges(view.state).between(0, view.state.doc.length, (a, b) => { out.push(`${view.state.doc.lineAt(a).number}-${view.state.doc.lineAt(b).number}`); }); return out.sort(); };

beforeEach(() => {
  document.body.innerHTML = '';
  host = document.body.appendChild(document.createElement('div'));
  ide = new IdeState();
  cw = openCodeWindow(ide, form().id, { mdiHost: host });
  view = (cw as unknown as { view: EditorView }).view;
  actions = {};
  registerCodeActions(ide, actions, { mdiHost: host });
});

const MODULE = 'Option Explicit\nPrivate Sub A()\n  If x Then\n    y = 1\n  End If\nEnd Sub\n\nFunction B()\n  B = 1\nEnd Function\n';

test('Collapse to Definitions folds every procedure; Toggle All unfolds; folds are not undone', () => {
  set(MODULE); cw.gotoLine(4);   // the cursor inside A
  actions.collapseToDefinitions();
  expect(folds()).toEqual(['2-6', '8-10']);
  expect(cw.getCursorLine()).toBe(2);         // moved out of the hidden lines
  expect(view.dom.querySelectorAll('.cm-vb-foldph').length).toBe(2);
  expect(view.dom.querySelector('.cm-vb-ol-plus')).not.toBeNull();
  expect(form().code).toBe(MODULE);           // view state only
  actions.toggleAllOutlining();
  expect(folds()).toEqual([]);
  actions.toggleAllOutlining();
  expect(folds()).toEqual(['2-6', '3-5', '8-10']);
});

test('Toggle Outlining Expansion folds the innermost block; jumping to a line inside a fold unfolds it', () => {
  set(MODULE); cw.gotoLine(4);
  actions.toggleOutlining();
  expect(folds()).toEqual(['3-5']);
  actions.toggleOutlining();                  // the cursor is on the folded line: unfolds
  expect(folds()).toEqual([]);
  actions.collapseToDefinitions();
  cw.gotoLine(4);
  expect(folds()).toEqual(['8-10']);
  cw.setBreakLine(9);
  expect(folds()).toEqual([]);
});

test('palette option switches the editor class; font size applies', () => {
  set('Dim s As String');
  expect(view.dom.classList.contains('cm-vb-pal-vs')).toBe(true);
  ide.setOptions({ codePalette: 'vb6', codeFontSize: 15 });
  expect(view.dom.classList.contains('cm-vb-pal-vb6')).toBe(true);
  expect(view.dom.classList.contains('cm-vb-pal-vs')).toBe(false);
  expect(getComputedStyle(view.dom).fontSize).toBe('15px');
  // token classes the palettes colour
  const cls = (line: string) => vbSpans(line, new Set(['text1'])).map(s => `${line.slice(s.from, s.to)}:${s.cls.slice(6)}`);
  expect(cls('Private Sub Go(n As Long) \' c')).toEqual(['Private:kw', 'Sub:kwb', 'Go:proc', 'As:kw', 'Long:type', "' c:comment"]);
  expect(cls('Text1.Text = "a" & vbCrLf & 1.5')).toEqual(['Text1:ctl', '"a":str', 'vbCrLf:const', '1.5:num']);
  // 0.8 component constants and file I/O statement words come from the same tables
  expect(cls('If x = comEvReceive Or y = adOpenStatic Then')).toEqual(['If:kw', 'comEvReceive:const', 'Or:kw', 'adOpenStatic:const', 'Then:kw']);
  expect(cls('Open f For Output As #1')).toEqual(['Open:kw', 'For:kw', 'Output:kw', 'As:kw', '1:num']);
});

test('matching keyword highlight: If finds ElseIf, Else and End If', () => {
  set('If a Then\n  x = 1\nElseIf b Then\n  x = 2\nElse\n  x = 3\nEnd If', 1);
  const words = () => matchingKeywords(view.state).map(r => view.state.sliceDoc(r.from, r.to));
  expect(words()).toEqual(['If', 'ElseIf', 'Else', 'End If']);
  view.dispatch({ selection: { anchor: view.state.doc.length } });   // on End If
  expect(words()).toEqual(['If', 'ElseIf', 'Else', 'End If']);
  expect(view.dom.querySelectorAll('.cm-vb-kwmatch').length).toBe(4);
  view.dispatch({ selection: { anchor: view.state.doc.line(2).from + 3 } });
  expect(words()).toEqual([]);
});

test('Enter after Sub inserts End Sub; after If indents and adds End If; an existing End is not doubled', () => {
  set('Private Sub Go()', 16);
  vbEnter(view);
  expect(cw.getSource()).toBe('Private Sub Go()\n    \nEnd Sub');
  expect(cw.getCursorLine()).toBe(2);
  view.dispatch(view.state.replaceSelection('if a then'));
  vbEnter(view);
  expect(cw.getSource()).toBe('Private Sub Go()\n    If a Then\n        \n    End If\nEnd Sub');   // the left line was prettified
  set('Sub X()\nEnd Sub', 7);
  vbEnter(view);
  expect(cw.getSource()).toBe('Sub X()\n    \nEnd Sub');
});

test('pretty listing capitalises keywords and types on leaving a line', () => {
  set('dim x as integer\n', 3);
  cw.gotoLine(2);
  expect(cw.getSource()).toBe('Dim x As Integer\n');
});
