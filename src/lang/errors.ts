// Errors for the VibeBasic language core. Later tasks extend this file
// (VBRuntimeError, vbErrorText).

/**
 * A compile-time (lexer/parser) error. `line` and `col` are 1-based;
 * `moduleName` is set by `parseModule` / `findSyntaxErrors` (and so for the
 * error `new Program(...)` throws), so the IDE can open that module's code.
 */
export class VBSyntaxError extends Error {
  line: number;
  col: number;
  moduleName?: string;
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
  51: 'Internal error',
  52: 'Bad file name or number',
  53: 'File not found',
  54: 'Bad file mode',
  55: 'File already open',
  57: 'Device I/O error',
  58: 'File already exists',
  59: 'Bad record length',
  61: 'Disk full',
  62: 'Input past end of file',
  63: 'Bad record number',
  67: 'Too many files',
  68: 'Device unavailable',
  70: 'Permission denied',
  71: 'Disk not ready',
  75: 'Path/File access error',
  76: 'Path not found',
  91: 'Object variable or With block variable not set',
  92: 'For loop not initialized',
  94: 'Invalid use of Null',
  340: "Control array element 'n' doesn't exist",
  343: 'Object not an array',
  380: 'Invalid property value',
  381: 'Invalid property array index',
  383: 'Property is read-only',
  424: 'Object required',
  438: "Object doesn't support this property or method",
  450: 'Wrong number of arguments or invalid property assignment',
  // DAO / ADO (Data control, Adodc, Recordset)
  3001: 'Invalid argument.',
  3020: 'Update or CancelUpdate without AddNew or Edit.',
  3021: 'No current record.',
  3022: 'The changes you requested to the table were not successful because they would create duplicate values in the index, primary key, or relationship.',
  3024: "Couldn't find file.",
  3027: "Can't update. Database or object is read-only.",
  3044: 'Not a valid path.',
  3061: 'Too few parameters.',
  3065: 'Cannot execute a select query.',
  3070: 'The database engine does not recognize the field name or expression.',
  3075: 'Syntax error in query expression.',
  3077: 'Syntax error in expression.',
  3078: 'The database engine cannot find the input table or query.',
  3159: 'Not a valid bookmark.',
  3164: 'Field cannot be updated.',
  3167: 'Record is deleted.',
  3265: 'Item not found in this collection.',
  3314: 'The field cannot contain a Null value.',
  3420: 'Object invalid or no longer set.',
  3421: 'Data type conversion error.',
  3426: 'This action was cancelled by an associated object.',
  3704: 'Operation is not allowed when the object is closed.',
  3709: 'The connection cannot be used to perform this operation. It is either closed or invalid in this context.',
  32755: 'Cancel was selected',
  35600: 'Index out of bounds',
  35602: 'Key is not unique in collection',
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
  /** `Err.Source`: set by `Err.Raise`; otherwise the app title is used. */
  source?: string;
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

/**
 * A plain JS error (a bug in host code or in the interpreter) turned into
 * VB run-time error 51, `Internal error: <message>`, so it goes through the
 * normal error path (On Error, onRuntimeError). The original is logged with
 * console.error.
 */
export function internalError(e: unknown): VBRuntimeError {
  console.error('VibeBasic: internal error', e);
  const message = e instanceof Error ? e.message : String(e);
  return new VBRuntimeError(51, `Internal error: ${message}`);
}
