// AST for the VibeBasic language core. Task 2 defines the expression nodes;
// later tasks add statements and modules to this file.

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
