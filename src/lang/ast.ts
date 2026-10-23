// AST for the VibeBasic language core: expressions (Task 2), statements and
// modules (Task 3).

export type TypeSuffix = '%' | '&' | '!' | '#' | '$';

/** `isDouble`: written with a point or an exponent (`2.0`, `1E3`), a Double like `1.5`. */
export interface NumberLit { kind: 'number'; value: number; suffix?: TypeSuffix; isDouble?: boolean; line: number }
export interface StringLit { kind: 'string'; value: string; line: number }
/** `#1/2/2000#`: `text` is the raw text between the `#`s (parsed at run time). */
export interface DateLit { kind: 'date'; text: string; line: number }
export interface BoolLit { kind: 'bool'; value: boolean; line: number }
export interface NothingLit { kind: 'nothing'; line: number }
/**
 * A bare name. `Me`, `Empty`, `Null` and the keyword-named built-ins
 * (`Date`, `String`, `Error`, `Load`) are also NameExprs; the interpreter
 * resolves them. `name` is as written, without the type suffix.
 */
export interface NameExpr { kind: 'name'; name: string; suffix?: TypeSuffix; line: number; paren?: boolean }
export interface MemberExpr { kind: 'member'; object: Expr; name: string; line: number; paren?: boolean }
/** `a(1)`: whether this is a procedure call or an array/default-member index is decided at run time. */
export interface CallOrIndex { kind: 'call'; target: Expr; args: (Expr | MissingArg)[]; line: number; paren?: boolean }
/** An omitted argument, as in `MsgBox("x", , "t")`. */
export interface MissingArg { kind: 'missing'; line: number }
export type UnaryOp = 'neg' | 'not';
/**
 * On operator nodes, filled by the interpreter when first needed (interp/staticTypes.ts, eval.ts `binaryResult`): `st`
 * the static result type; `chk` what a result needs: 0 nothing, 1 a range check (`lo`..`hi`, Integer/Long/Byte),
 * 2 not known yet (the parser's value), 3 the slow path (a Single or Currency result; `&` with a Single operand).
 */
export interface OperatorTypeInfo { st?: VBTypeName | 'Decimal'; chk?: number; lo?: number; hi?: number }
export interface UnaryExpr extends OperatorTypeInfo { kind: 'unary'; op: UnaryOp; operand: Expr; line: number }
export type BinaryOp =
  | '^' | '*' | '/' | '\\' | 'mod' | '+' | '-' | '&'
  | '=' | '<>' | '<' | '>' | '<=' | '>=' | 'like' | 'is'
  | 'and' | 'or' | 'xor' | 'eqv' | 'imp';
/** `text`: a comparison or Like in a module with `Option Compare Text` (case-insensitive). */
export interface BinaryExpr extends OperatorTypeInfo { kind: 'binary'; op: BinaryOp; left: Expr; right: Expr; line: number; text?: boolean }
/** `.Text` inside a `With` block. */
export interface WithMemberExpr { kind: 'withMember'; name: string; line: number; paren?: boolean }
/** The object of the innermost `With` block: the `X` of `!Name` (`X("Name")`) inside it. */
export interface WithObjectExpr { kind: 'withObject'; line: number }
export interface NewExpr { kind: 'new'; typeName: string; line: number }
/** `TypeOf x Is T`: whether the object `x` is of type `T` (a control type, Form, a form or class name, Object ...). */
export interface TypeOfExpr { kind: 'typeOf'; object: Expr; typeName: string; line: number }
/**
 * Named arguments (`MsgBox Prompt:="x", Title:="t"`): the parser attaches the names to the argument array, by position
 * (undefined for a positional argument; positional ones come first). The callee puts them in place (eval.ts `positional`).
 */
export type ArgList = (Expr | MissingArg)[] & { names?: (string | undefined)[] };
/** The names of a call's named arguments, or undefined when it has none. */
export const argNames = (args: (Expr | MissingArg)[]): (string | undefined)[] | undefined => (args as ArgList).names;
/*
 * `paren` on a name, member, call/index or With member: the expression was written in its own parentheses (`Foo (x)`,
 * `Call Foo((x))`). It is then a value, never a variable: a ByRef parameter gets a copy.
 */

export type Expr =
  | NumberLit | StringLit | DateLit | BoolLit | NothingLit | NameExpr | MemberExpr
  | CallOrIndex | UnaryExpr | BinaryExpr | WithMemberExpr | WithObjectExpr | NewExpr | TypeOfExpr;

/** S-expression rendering of an expression, used by tests. */
export function exprToString(e: Expr | MissingArg): string {
  switch (e.kind) {
    case 'number': return String(e.value);
    case 'string': return JSON.stringify(e.value);
    case 'date': return `#${e.text}#`;
    case 'bool': return e.value ? 'True' : 'False';
    case 'nothing': return 'Nothing';
    case 'name': return e.name + (e.suffix ?? '');
    case 'member': return `(. ${exprToString(e.object)} ${e.name})`;
    case 'call': return `(call ${[e.target, ...e.args].map(exprToString).join(' ')})`;
    case 'missing': return '<missing>';
    case 'unary': return `(${e.op} ${exprToString(e.operand)})`;
    case 'binary': return `(${e.op} ${exprToString(e.left)} ${exprToString(e.right)})`;
    case 'withMember': return `(with. ${e.name})`;
    case 'withObject': return '(with)';
    case 'new': return `(new ${e.typeName})`;
    case 'typeOf': return `(typeof ${exprToString(e.object)} ${e.typeName})`;
  }
}

// ---------------------------------------------------------------------------
// Types, declarations, statements and modules (Task 3)
// ---------------------------------------------------------------------------

export type VBTypeName =
  | 'Integer' | 'Long' | 'Single' | 'Double' | 'Currency' | 'String' | 'Boolean'
  | 'Variant' | 'Date' | 'Byte' | 'Object'
  | { userType: string }
  | { objectType: string };

/** One array dimension: `10` (lower omitted) or `1 To 5`. */
export interface ArrayBound { lower?: Expr; upper: Expr }

/**
 * A declared variable. A type suffix on the name (`s$`) is turned into `type`
 * and dropped from `name`. `bounds` is set for fixed arrays (`a(10)`,
 * `a(1 To 5, 3)`); a dynamic array (`a()`) has `isArray: true` and no bounds.
 * `fixedLength` is the `* n` of `As String * n`.
 */
export interface VarDecl {
  name: string;
  scope: 'dim' | 'private' | 'public' | 'static';
  type?: VBTypeName;
  isArray: boolean;
  bounds?: ArrayBound[];
  isNew: boolean;
  fixedLength?: number;
  /** `Private WithEvents x As Class1`: its events run the module's `x_EventName` procedures. */
  withEvents?: boolean;
  line: number;
}

export interface ConstDecl {
  name: string;
  scope: 'private' | 'public';
  type?: VBTypeName;
  value: Expr;
  line: number;
}

export interface Param {
  name: string;
  byRef: boolean;
  optional: boolean;
  defaultValue?: Expr;
  type?: VBTypeName;
  isArray: boolean;
  /** `ParamArray args()`: the last parameter, takes all remaining arguments as a 0-based Variant array. */
  paramArray?: boolean;
}

export interface TypeDecl { name: string; visibility: 'public' | 'private'; fields: VarDecl[]; line: number }
export interface EnumMember { name: string; value: number }
export interface EnumDecl { name: string; visibility: 'public' | 'private'; members: EnumMember[]; line: number }

/**
 * A Sub, Function or Property procedure. `Property Get` is a `function` (its name is the result variable) and
 * `Property Let` / `Property Set` are `sub`s, with `property` set; the last parameter of a Let/Set is the value.
 */
export interface ProcDecl {
  kind: 'sub' | 'function';
  property?: 'get' | 'let' | 'set';
  name: string;
  visibility: 'public' | 'private';
  /** `Static Sub`: all locals are static. */
  isStatic: boolean;
  params: Param[];
  /** Functions only: `As Type` or a type suffix on the name. */
  returnType?: VBTypeName;
  /** Functions only: `As Type()`, the function returns an array. */
  returnsArray?: boolean;
  body: Stmt[];
  line: number;
  /** Line of `End Sub` / `End Function` / `End Property`. */
  endLine: number;
}

/** `[Public] Event Name(params)` in a class module. */
export interface EventDecl { name: string; params: Param[]; line: number }

export interface ModuleAst {
  name: string;
  optionExplicit: boolean;
  /** `Option Base 1`: the default lower bound of arrays (`Dim a(5)`, `Array()`); absent: 0. */
  optionBase?: number;
  /** `Option Compare Text`: =, <, Like, InStr and StrComp (without a compare argument) ignore case. */
  optionCompareText?: boolean;
  variables: VarDecl[];
  consts: ConstDecl[];
  types: TypeDecl[];
  enums: EnumDecl[];
  procedures: ProcDecl[];
  /** `Event` declarations (class modules). Optional: older code builds a ModuleAst without them. */
  events?: EventDecl[];
  /** `Implements IFoo`: the interface classes (by name, as written). */
  implements?: string[];
}

export interface DimStmt { kind: 'dim'; decls: VarDecl[]; line: number }
export interface ConstStmt { kind: 'const'; decls: ConstDecl[]; line: number }
export interface ReDimDecl { name: string; type?: VBTypeName; bounds: ArrayBound[]; line: number }
export interface ReDimStmt { kind: 'redim'; preserve: boolean; decls: ReDimDecl[]; line: number }
export interface EraseStmt { kind: 'erase'; targets: NameExpr[]; line: number }
/** `x = 1`, `Let x = 1` (isSet false) and `Set x = obj` (isSet true). `target` is a name, member, call/index or withMember. */
export interface AssignStmt { kind: 'assign'; target: Expr; value: Expr; isSet: boolean; line: number }
/**
 * `Foo`, `Foo 1, 2`, `Foo(1)`, `Call Foo(1)`, `Form2.Show vbModal`.
 * `target` is the procedure/method expression (name, member, withMember); `args` may hold MissingArg.
 */
export interface CallStmt { kind: 'call'; target: Expr; args: (Expr | MissingArg)[]; explicitCall: boolean; line: number }
export interface IfBranch { cond: Expr; body: Stmt[]; line: number }
/** Block and single-line If. `branches[0]` is the If, the rest are ElseIf. */
export interface IfStmt { kind: 'if'; branches: IfBranch[]; elseBody?: Stmt[]; singleLine: boolean; line: number }
export type CompareOp = '=' | '<>' | '<' | '>' | '<=' | '>=';
export type CaseTest =
  | { kind: 'value'; value: Expr }
  | { kind: 'range'; from: Expr; to: Expr }
  | { kind: 'is'; op: CompareOp; value: Expr };
export interface CaseClause { tests: CaseTest[]; body: Stmt[]; line: number }
export interface SelectStmt { kind: 'select'; subject: Expr; cases: CaseClause[]; elseBody?: Stmt[]; line: number }
/** `nextLine`: the line of the loop's `Next` (the back-edge: increment and test stop there, as in VB6); `line` when on one line. */
export interface ForStmt { kind: 'for'; variable: NameExpr; from: Expr; to: Expr; step?: Expr; body: Stmt[]; line: number; nextLine: number }
export interface ForEachStmt { kind: 'forEach'; variable: NameExpr; collection: Expr; body: Stmt[]; line: number; nextLine: number }
/** `test.atEnd` is true for `Loop While/Until`. No `test` means `Do ... Loop` forever. */
export interface DoStmt {
  kind: 'do';
  test?: { mode: 'while' | 'until'; expr: Expr; atEnd: boolean };
  body: Stmt[];
  line: number;
}
export interface WhileStmt { kind: 'while'; cond: Expr; body: Stmt[]; line: number }
export interface ExitStmt { kind: 'exit'; what: 'for' | 'do' | 'sub' | 'function' | 'property'; line: number }
/** `RaiseEvent Name[(args)]` in a class module. */
export interface RaiseEventStmt { kind: 'raiseEvent'; name: string; args: (Expr | MissingArg)[]; line: number }
export interface WithStmt { kind: 'with'; object: Expr; body: Stmt[]; line: number }
/** `label` is the label name or line number as text; `goto0` is `On Error GoTo 0`. */
export interface OnErrorStmt { kind: 'onError'; mode: 'resumeNext' | 'goto' | 'goto0'; label?: string; line: number }
/** `Resume` (mode 'resume'), `Resume Next` (mode 'next'), `Resume label`. */
export interface ResumeStmt { kind: 'resume'; mode: 'resume' | 'next' | 'label'; label?: string; line: number }
/** `GoTo label`; with `gosub`, `GoSub label` (a `Return` comes back after it). */
export interface GotoStmt { kind: 'goto'; label: string; line: number; gosub?: boolean }
/** `Return` (from a GoSub). */
export interface ReturnStmt { kind: 'return'; line: number }
/** `On n GoTo l1, l2, ...` / `On n GoSub ...`: the n-th label; n = 0 or more than the labels goes on with the next statement. */
export interface OnGotoStmt { kind: 'onGoto'; index: Expr; labels: string[]; gosub: boolean; line: number }
/** `Debug.Assert cond`: break mode when cond is False (in the IDE; a made app skips it). */
export interface DebugAssertStmt { kind: 'debugAssert'; cond: Expr; line: number }
/** `Retry:` or a bare line number (`10`); `name` is the text. */
export interface LabelStmt { kind: 'label'; name: string; line: number }
export interface EndStmt { kind: 'end'; line: number }
/** `Error n`: raises run-time error n (like `Err.Raise n`). */
export interface ErrorStmt { kind: 'error'; number: Expr; line: number }
/** `Mid(s, start[, length]) = value` (also `Mid$`, `MidB`): replaces characters of the variable `target` in place. */
export interface MidStmt { kind: 'mid'; target: Expr; start: Expr; length?: Expr; value: Expr; line: number }
/** `LSet s = value` / `RSet s = value`: `value` left/right aligned in the current length of the string variable. */
export interface AlignStmt { kind: 'lset' | 'rset'; target: Expr; value: Expr; line: number }
export interface StopStmt { kind: 'stop'; line: number }
export interface UnloadStmt { kind: 'unload'; target: Expr; line: number }
export interface LoadStmt { kind: 'load'; target: Expr; line: number }
/**
 * One item of `Debug.Print` / `Print #`: an expression, or `Spc(n)` / `Tab(n)` / `Tab` (`fn`), and/or the separator
 * written after it.
 */
export interface PrintItem { expr?: Expr; fn?: { kind: 'spc' | 'tab'; arg?: Expr }; sep?: ';' | ',' }
/** `Debug.Print a; b, c;`: `items` in source order; a trailing separator is on the last item. */
export interface DebugPrintStmt { kind: 'debugPrint'; items: PrintItem[]; line: number }


// File I/O. `file` is the file number expression (the `#` before it is optional in VB6 and not kept).
export type OpenMode = 'input' | 'output' | 'append' | 'binary' | 'random';
/** `Open path For mode [Access ...] [Shared | Lock ...] As #n [Len = reclen]`; no `For` is Random. The lock is accepted and ignored. */
export interface OpenStmt { kind: 'open'; path: Expr; mode: OpenMode; access: '' | 'read' | 'write' | 'readwrite'; file: Expr; recLen?: Expr; line: number }
/** `Close` (every file) or `Close #1, #2`. */
export interface CloseStmt { kind: 'close'; files: Expr[]; line: number }
/** `Print #n, items` (Debug.Print rules, in the file's own columns) and `Write #n, items`. */
export interface FilePrintStmt { kind: 'printFile' | 'writeFile'; file: Expr; items: PrintItem[]; line: number }
/** `Input #n, a, b` and `Line Input #n, s`. */
export interface FileInputStmt { kind: 'inputFile' | 'lineInput'; file: Expr; targets: Expr[]; line: number }
/** `Get #n, [rec], var` / `Put #n, [rec], var`. */
export interface GetPutStmt { kind: 'getFile' | 'putFile'; file: Expr; rec?: Expr; target: Expr; line: number }
/** `Seek #n, pos`. */
export interface SeekStmt { kind: 'seekFile'; file: Expr; pos: Expr; line: number }
/** `Name old As new`. */
export interface NameStmt { kind: 'name'; from: Expr; to: Expr; line: number }

export type Stmt =
  | DimStmt | ConstStmt | ReDimStmt | EraseStmt | AssignStmt | CallStmt | IfStmt | SelectStmt
  | ForStmt | ForEachStmt | DoStmt | WhileStmt | ExitStmt | WithStmt | OnErrorStmt | ResumeStmt
  | GotoStmt | LabelStmt | EndStmt | StopStmt | UnloadStmt | LoadStmt | DebugPrintStmt | ErrorStmt | MidStmt | AlignStmt
  | OpenStmt | CloseStmt | FilePrintStmt | FileInputStmt | GetPutStmt | SeekStmt | NameStmt | RaiseEventStmt
  | ReturnStmt | OnGotoStmt | DebugAssertStmt;
