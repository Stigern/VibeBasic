export type TokenKind =
  | 'keyword' | 'ident' | 'number' | 'string' | 'date'
  | 'op' | 'newline' | 'colon' | 'comment' | 'eof';

export interface Token {
  kind: TokenKind;
  /** The original source text of the token. */
  text: string;
  /**
   * number: numeric value. string: unescaped contents. date: the text between the `#`s.
   * comment: the comment text after `'` / `Rem`.
   */
  value?: number | string;
  /** 1-based. */
  line: number;
  /** 1-based. */
  col: number;
  /** Type-declaration character on an identifier or number literal, if written. */
  suffix?: '%' | '&' | '!' | '#' | '$';
}

/**
 * Lowercase keyword set. Includes the VB type names, operator words, and the
 * words of VB6 that VibeBasic does not support (Declare, Open, Property, ...)
 * so the parser can recognise and name them in an "unsupported" error.
 * Built-in function / object names (Debug, MsgBox, Print, Len, ...) are NOT keywords.
 */
export const KEYWORDS: ReadonlySet<string> = new Set([
  // declarations
  'dim', 'private', 'public', 'static', 'const', 'redim', 'preserve', 'erase',
  'as', 'new', 'type', 'enum', 'option', 'explicit',
  // control flow
  'if', 'then', 'else', 'elseif', 'end', 'select', 'case',
  'for', 'to', 'step', 'next', 'each', 'in',
  'do', 'loop', 'while', 'until', 'wend', 'exit',
  // procedures
  'sub', 'function', 'byval', 'byref', 'optional', 'call', 'set', 'let',
  // other statements
  'with', 'on', 'error', 'resume', 'goto', 'unload', 'load', 'stop',
  // literals and values
  'nothing', 'true', 'false', 'empty', 'null', 'me',
  // operator words
  'and', 'or', 'not', 'xor', 'eqv', 'imp', 'mod', 'like', 'is', 'typeof',
  // type names
  'integer', 'long', 'single', 'double', 'string', 'boolean', 'variant', 'date',
  'byte', 'currency', 'object',
  // unsupported VB6 words (parser rejects these by name)
  'declare', 'open', 'close', 'property', 'implements', 'event', 'raiseevent',
  'withevents', 'friend', 'global', 'lib', 'alias', 'paramarray', 'gosub', 'return',
]);
