// The language reference card in the code and form system prompts. Built once at module load from the language's own
// tables (built-in functions and constants, the parser's type and unsupported-word tables), so a new built-in shows up
// by itself. Everything is sorted: the card, and with it the system prompt, is byte-identical on every build (prefix caching).
import { BUILTINS, CANONICAL_NAMES, CONSTANTS, PROG_IDS } from '../lang/builtins';
import { FINANCIAL } from '../lang/builtins/financial';
import { GFX_STATEMENTS, TYPE_KEYWORDS, UNSUPPORTED_KEYWORDS } from '../lang/parseStatements';
import { BUILTIN_OBJECTS } from './knownNames';

const byName = (a: string, b: string): number => a.toLowerCase() < b.toLowerCase() ? -1 : a.toLowerCase() > b.toLowerCase() ? 1 : 0;
const canonical = (key: string): string => CANONICAL_NAMES.get(key) ?? key;
const cap = (s: string): string => s[0].toUpperCase() + s.slice(1);

/** "(1): Abs, Asc, …" per argument count; `2-3` optional arguments, `2+` any number from 2. */
function functionLines(): string[] {
  const groups = new Map<string, { min: number; max: number; names: string[] }>();
  const financial = new Set(FINANCIAL.map(n => n.toLowerCase()));   // on a line of their own
  for (const [key, b] of BUILTINS) {
    if (key === 'shell' || financial.has(key)) continue;   // Shell exists only to raise a clear error; the card lists it as not available
    const sig = b.maxArgs >= 100 ? `${b.minArgs}+` : b.minArgs === b.maxArgs ? `${b.minArgs}` : `${b.minArgs}-${b.maxArgs}`;
    const g = groups.get(sig) ?? { min: b.minArgs, max: b.maxArgs, names: [] };
    g.names.push(canonical(key));
    groups.set(sig, g);
  }
  return [...groups.entries()]
    .sort(([, a], [, b]) => a.min - b.min || a.max - b.max)
    .map(([sig, g]) => `(${sig}): ${g.names.sort(byName).join(', ')}`);
}

/** The prefix of a constant group: the leading lower-case letters (vb, tvw, sck), or a capitalised word (Vt for VtCh...). */
const prefixOf = (name: string): string => /^[a-z]+|^[A-Z][a-z]+/.exec(name)?.[0] ?? name;

/** "vb* (190): vbCr, vbLf, …": the count and the names of each prefix (the shortest few when there are more than 10). */
function constantGroups(): string[] {
  const groups = new Map<string, string[]>();
  for (const key of CONSTANTS.keys()) {
    const name = canonical(key);
    const p = prefixOf(name);
    groups.set(p, [...groups.get(p) ?? [], name]);
  }
  return [...groups.entries()].sort(([a], [b]) => byName(a, b)).map(([p, names]) => {
    const shown = names.length <= 8 ? names.length : Math.max(4, Math.min(12, Math.ceil(names.length / 10)));
    const examples = [...names].sort((a, b) => a.length - b.length || byName(a, b)).slice(0, shown);
    return `${p}* (${names.length}): ${examples.join(', ')}${shown < names.length ? ', ...' : ''}`;
  });
}

const STATEMENTS = 'Option Explicit; Dim / Private / Public / Static x As Type, arrays a(0 To 9), ReDim [Preserve], Erase; Const; Type ... End Type; Enum ... End Enum;'
  + ' [Public|Private] Sub / Function (ByVal, ByRef, Optional p = default) ... End Sub / End Function; Call; Set obj = ...;'
  + ' If ... Then ... ElseIf ... Else ... End If (and one-line If); Select Case (Case 1, 2 To 5, Is > 3, Case Else); For ... To ... Step ... Next; For Each x In ... Next;'
  + ' Do [While|Until] ... Loop [While|Until]; While ... Wend; With ... End With; Exit Sub / Function / For / Do;'
  + ' On Error GoTo label / Resume Next / GoTo 0; Resume [Next]; GoTo label; Load / Unload; End; Stop; Debug.Print; : joins statements, _ continues a line.'
  + ' Files: Open path For Input|Output|Append|Binary|Random As #n [Len = n]; Close [#n]; Print #n, a; b; Write #n, a, b; Input #n, a, b;'
  + ' Line Input #n, s; Get / Put #n, [pos], var; Seek #n, pos; Name old As new (paths may use \\ or /, relative to CurDir = App.Path at start).'
  + ' Also: Mid(s, i, n) = x; LSet / RSet s = x; Error n (Erl gives the last line number); Dim c As New Collection / Set c = New Collection (Add, Item, Count, Remove);'
  + ' Function F() As Long() returns an array; IsMissing(v) for an Optional Variant; !Name also works inside With rs.'
  + ' Classes: Set x = New Class1 / Dim x As New Class1; Class_Initialize, Class_Terminate; Public vars, Sub, Function,'
  + ' Property Get/Let/Set, Exit Property, Me; Event E(a) + RaiseEvent E(a) -> Private WithEvents x As Class1, Sub x_E(a); Implements IFoo, Sub IFoo_M();'
  + ' default member: Attribute Item.VB_UserMemId = 0 inside its Property Get (x(2), Debug.Print x); For Each over a class:'
  + ' Property Get NewEnum() As IUnknown with Attribute NewEnum.VB_UserMemId = -4 and Set NewEnum = mCol.[_NewEnum].'
  + ' If TypeOf x Is TextBox (or Form, a class, Collection); named arguments MsgBox Prompt:="x", Title:="t" (skip Optionals);'
  + ' Option Base 1, Option Compare Text; Global = Public; GoSub label ... Return; On n GoTo|GoSub a, b; Debug.Assert cond;'
  + ' #Const X = 1, #If X Then ... #ElseIf ... #Else ... #End If. App.Major, Minor, Revision, PrevInstance, LogEvent s.';

/** What the live evaluation showed the model gets wrong about the controls' objects (kept short: the card's budget). */
const IDIOMS = 'Set it = ListView1.ListItems.Add(, , "Ann"): it.SubItems(1) = "x" (ListItems(1) is the first; no ListSubItems);'
  + ' TabStrip1.SelectedItem is a Tab: Select Case TabStrip1.SelectedItem.Index (1-based);'
  + ' WindowList only on a top-level menu, set at design time (not in code); a Data control set up in code needs Data1.Refresh.';

/** Builds the card from the language's tables (exported for the stability test). */
export function buildLanguageReference(): string {
  const types = Object.values(TYPE_KEYWORDS).map(String).sort(byName);
  const objects = [...BUILTIN_OBJECTS].map(cap).sort(byName);
  const words = Object.values(UNSUPPORTED_KEYWORDS).sort(byName);
  const drawing = Object.values(GFX_STATEMENTS).sort(byName);
  return [
    'Language reference (VibeBasic dialect of VB6):',
    `Statements: ${STATEMENTS}`,
    `Types: ${types.join(', ')} (suffixes % & ! # $). Operators: + - * / \\ Mod ^ &, = <> < > <= >=, Like, Is, Not, And, Or, Xor, Eqv, Imp; rs!Name is rs("Name") (a Recordset field).`,
    `Objects: ${objects.join(', ')}.`,
    `CreateObject(ProgID) or New: ${[...new Set([...PROG_IDS.values()].map(c => c.name))].sort(byName).join(', ')}. ADO on SQLite files:`
      + ' cn.Open "Data Source=x.db", cn.Execute sql[, n], BeginTrans / CommitTrans / RollbackTrans; rs.Open sql, cn, adOpenStatic, adLockOptimistic;'
      + ' rs.Filter = "A > 1 And B Like \'x*\'", rs.Sort = "B DESC". FSO: OpenTextFile / CreateTextFile -> ReadLine, WriteLine, AtEndOfStream, Close.',
    `Drawing on a Form, PictureBox or Printer (NewPage, EndDoc prints, KillDoc): ${drawing.join(', ')} (Line (x1, y1)-(x2, y2)[, c][, B[F]]; Scale (x1, y1)-(x2, y2), two corners), Cls, Point, PaintPicture; AutoRedraw or Paint.`,
    `Idioms: ${IDIOMS}`,
    'Built-in functions by argument count (String functions also have a $ form, e.g. Left$):',
    ...functionLines(),
    `Financial: ${FINANCIAL.join(', ')} (VB6 argument order).`,
    'Constant groups (prefix, count, examples):',
    ...constantGroups(),
    `Not available: ${words.join(', ')};`
      + ' GetObject, other ProgIDs (no COM automation); Shell (programs cannot be started).',
  ].join('\n');
}

/** The card, built once. */
export const LANGUAGE_REFERENCE = buildLanguageReference();
