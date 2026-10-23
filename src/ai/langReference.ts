// The language reference card in the code and form system prompts. Built once at module load from the language's own
// tables (built-in functions and constants, the parser's type and unsupported-word tables), so a new built-in shows up
// by itself. Everything is sorted: the card, and with it the system prompt, is byte-identical on every build (prefix caching).
import { BUILTINS, CANONICAL_NAMES, CONSTANTS } from '../lang/builtins';
import { HASH_STATEMENTS, TYPE_KEYWORDS, UNSUPPORTED_IDENTS, UNSUPPORTED_KEYWORDS } from '../lang/parseStatements';
import { BUILTIN_OBJECTS } from './knownNames';

const byName = (a: string, b: string): number => a.toLowerCase() < b.toLowerCase() ? -1 : a.toLowerCase() > b.toLowerCase() ? 1 : 0;
const canonical = (key: string): string => CANONICAL_NAMES.get(key) ?? key;
const cap = (s: string): string => s[0].toUpperCase() + s.slice(1);

/** "(1): Abs, Asc, …" per argument count; `2-3` optional arguments, `2+` any number from 2. */
function functionLines(): string[] {
  const groups = new Map<string, { min: number; max: number; names: string[] }>();
  for (const [key, b] of BUILTINS) {
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
    const shown = names.length <= 10 ? names.length : Math.max(4, Math.min(12, Math.ceil(names.length / 10)));
    const examples = [...names].sort((a, b) => a.length - b.length || byName(a, b)).slice(0, shown);
    return `${p}* (${names.length}): ${examples.join(', ')}${shown < names.length ? ', ...' : ''}`;
  });
}

const STATEMENTS = 'Option Explicit; Dim / Private / Public / Static x As Type, arrays a(0 To 9), ReDim [Preserve], Erase; Const; Type ... End Type; Enum ... End Enum;'
  + ' [Public|Private] Sub / Function (ByVal, ByRef, Optional p = default) ... End Sub / End Function; Call; Set obj = ...;'
  + ' If ... Then ... ElseIf ... Else ... End If (and one-line If); Select Case (Case 1, 2 To 5, Is > 3, Case Else); For ... To ... Step ... Next; For Each x In ... Next;'
  + ' Do [While|Until] ... Loop [While|Until]; While ... Wend; With ... End With; Exit Sub / Function / For / Do;'
  + ' On Error GoTo label / Resume Next / GoTo 0; Resume [Next]; GoTo label; Load / Unload; End; Stop; Debug.Print; : joins statements, _ continues a line.';

/** Builds the card from the language's tables (exported for the stability test). */
export function buildLanguageReference(): string {
  const types = Object.values(TYPE_KEYWORDS).map(String).sort(byName);
  const objects = [...BUILTIN_OBJECTS].map(cap).sort(byName);
  const words = Object.values(UNSUPPORTED_KEYWORDS).sort(byName);
  const fileIo = Object.values(HASH_STATEMENTS).sort(byName).map(w => `${w} #`);
  const drawing = Object.values(UNSUPPORTED_IDENTS).sort(byName);
  return [
    'Language reference (VibeBasic dialect of VB6):',
    `Statements: ${STATEMENTS}`,
    `Types: ${types.join(', ')} (suffixes % & ! # $). Operators: + - * / \\ Mod ^ &, = <> < > <= >=, Like, Is, Not, And, Or, Xor, Eqv, Imp.`,
    `Objects: ${objects.join(', ')}.`,
    'Built-in functions by argument count (String functions also have a $ form, e.g. Left$):',
    ...functionLines(),
    'Constant groups (prefix, count, examples):',
    ...constantGroups(),
    `Not available: ${words.join(', ')}; file I/O (${fileIo.join(', ')}); ${drawing.join(' / ')} on forms; class modules;`
      + ' CreateObject / GetObject (no COM automation); named arguments (x:=1). Keep data in variables.',
  ].join('\n');
}

/** The card, built once. */
export const LANGUAGE_REFERENCE = buildLanguageReference();
