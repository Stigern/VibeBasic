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
