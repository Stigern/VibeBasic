// AST for the VibeBasic language core: expressions (Task 2), statements and
// modules (Task 3).

export type TypeSuffix = '%' | '&' | '!' | '#' | '$';

export interface NumberLit { kind: 'number'; value: number; suffix?: TypeSuffix; line: number }
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
export interface NameExpr { kind: 'name'; name: string; suffix?: TypeSuffix; line: number }
export interface MemberExpr { kind: 'member'; object: Expr; name: string; line: number }
/** `a(1)`: whether this is a procedure call or an array/default-member index is decided at run time. */
export interface CallOrIndex { kind: 'call'; target: Expr; args: (Expr | MissingArg)[]; line: number }
/** An omitted argument, as in `MsgBox("x", , "t")`. */
export interface MissingArg { kind: 'missing'; line: number }
export type UnaryOp = 'neg' | 'not';
export interface UnaryExpr { kind: 'unary'; op: UnaryOp; operand: Expr; line: number }
export type BinaryOp =
  | '^' | '*' | '/' | '\\' | 'mod' | '+' | '-' | '&'
  | '=' | '<>' | '<' | '>' | '<=' | '>=' | 'like' | 'is'
  | 'and' | 'or' | 'xor' | 'eqv' | 'imp';
export interface BinaryExpr { kind: 'binary'; op: BinaryOp; left: Expr; right: Expr; line: number }
/** `.Text` inside a `With` block. */
export interface WithMemberExpr { kind: 'withMember'; name: string; line: number }
export interface NewExpr { kind: 'new'; typeName: string; line: number }

export type Expr =
  | NumberLit | StringLit | DateLit | BoolLit | NothingLit | NameExpr | MemberExpr
  | CallOrIndex | UnaryExpr | BinaryExpr | WithMemberExpr | NewExpr;

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
    case 'new': return `(new ${e.typeName})`;
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
}

export interface TypeDecl { name: string; visibility: 'public' | 'private'; fields: VarDecl[]; line: number }
export interface EnumMember { name: string; value: number }
export interface EnumDecl { name: string; visibility: 'public' | 'private'; members: EnumMember[]; line: number }

export interface ProcDecl {
  kind: 'sub' | 'function';
  name: string;
  visibility: 'public' | 'private';
  /** `Static Sub`: all locals are static. */
  isStatic: boolean;
  params: Param[];
  /** Functions only: `As Type` or a type suffix on the name. */
  returnType?: VBTypeName;
  body: Stmt[];
  line: number;
  /** Line of `End Sub` / `End Function`. */
  endLine: number;
}

export interface ModuleAst {
  name: string;
  optionExplicit: boolean;
  variables: VarDecl[];
  consts: ConstDecl[];
  types: TypeDecl[];
  enums: EnumDecl[];
  procedures: ProcDecl[];
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
export interface ExitStmt { kind: 'exit'; what: 'for' | 'do' | 'sub' | 'function'; line: number }
export interface WithStmt { kind: 'with'; object: Expr; body: Stmt[]; line: number }
/** `label` is the label name or line number as text; `goto0` is `On Error GoTo 0`. */
export interface OnErrorStmt { kind: 'onError'; mode: 'resumeNext' | 'goto' | 'goto0'; label?: string; line: number }
/** `Resume` (mode 'resume'), `Resume Next` (mode 'next'), `Resume label`. */
export interface ResumeStmt { kind: 'resume'; mode: 'resume' | 'next' | 'label'; label?: string; line: number }
export interface GotoStmt { kind: 'goto'; label: string; line: number }
/** `Retry:` or a bare line number (`10`); `name` is the text. */
export interface LabelStmt { kind: 'label'; name: string; line: number }
export interface EndStmt { kind: 'end'; line: number }
export interface StopStmt { kind: 'stop'; line: number }
export interface UnloadStmt { kind: 'unload'; target: Expr; line: number }
export interface LoadStmt { kind: 'load'; target: Expr; line: number }
/** One item of `Debug.Print`: an expression and/or the separator written after it. */
export interface PrintItem { expr?: Expr; sep?: ';' | ',' }
/** `Debug.Print a; b, c;`: `items` in source order; a trailing separator is on the last item. */
export interface DebugPrintStmt { kind: 'debugPrint'; items: PrintItem[]; line: number }

export type Stmt =
  | DimStmt | ConstStmt | ReDimStmt | EraseStmt | AssignStmt | CallStmt | IfStmt | SelectStmt
  | ForStmt | ForEachStmt | DoStmt | WhileStmt | ExitStmt | WithStmt | OnErrorStmt | ResumeStmt
  | GotoStmt | LabelStmt | EndStmt | StopStmt | UnloadStmt | LoadStmt | DebugPrintStmt;
