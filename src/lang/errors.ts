// Errors for the VibeBasic language core. Later tasks extend this file
// (VBRuntimeError, vbErrorText).

/** A compile-time (lexer/parser) error. `line` and `col` are 1-based. */
export class VBSyntaxError extends Error {
  line: number;
  col: number;
  constructor(message: string, line: number, col: number) {
    super(message);
    this.name = 'VBSyntaxError';
    this.line = line;
    this.col = col;
  }
}

/** Standard VB6 run-time error descriptions, keyed by error number. */
const ERROR_TEXTS: Record<number, string> = {
  3: 'Return without GoSub',
  5: 'Invalid procedure call or argument',
  6: 'Overflow',
  7: 'Out of memory',
  9: 'Subscript out of range',
  10: 'This array is fixed or temporarily locked',
  11: 'Division by zero',
  13: 'Type mismatch',
  20: 'Resume without error',
  28: 'Out of stack space',
  35: 'Sub or Function not defined',
  53: 'File not found',
  91: 'Object variable or With block variable not set',
  92: 'For loop not initialized',
  94: 'Invalid use of Null',
  340: "Control array element 'n' doesn't exist",
  380: 'Invalid property value',
  383: 'Property is read-only',
  424: 'Object required',
  438: "Object doesn't support this property or method",
  450: 'Wrong number of arguments or invalid property assignment',
};

/** The VB6 description of run-time error `n`. */
export function vbErrorText(n: number): string {
  return ERROR_TEXTS[n] ?? 'Application-defined or object-defined error';
}

/**
 * A run-time error (`Err.Number` / `Err.Description`). `compile` marks errors
 * that VB6 reports at compile time (`Variable not defined`,
 * `Sub or Function not defined`) but that this interpreter raises while
 * running; the host shows those as "Compile error:". Use
 * `VBRuntimeError.compile(message)` to make one.
 */
export class VBRuntimeError extends Error {
  readonly description: string;
  compile = false;
  constructor(public number: number, description?: string) {
    const d = description ?? vbErrorText(number);
    super(d);
    this.name = 'VBRuntimeError';
    this.description = d;
  }

  /** A compile error raised at run time; number 0. */
  static compile(message: string): VBRuntimeError {
    const e = new VBRuntimeError(0, message);
    e.compile = true;
    return e;
  }
}
