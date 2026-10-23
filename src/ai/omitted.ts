// The marker codeForPrompt (context.ts) puts in place of a procedure body the model is not shown, and the check that keeps such a
// stub, echoed back by the model, from replacing the real procedure (codeMode.ts applyCodeProposal).

/** The line that stands for an omitted procedure body in the code the model sees. */
export const BODY_OMITTED = "' ... (body omitted)";

const COMMENT_OR_BLANK = /^\s*(?:$|'|Rem(?:\s|$))/i;
const OMITTED_TEXT = /\(body omitted\)/i;

/** The lines inside a procedure (without its heading and End line) have no code: only blank lines and comments. */
export function hasNoCode(inner: readonly string[]): boolean {
  return inner.every(l => COMMENT_OR_BLANK.test(l));
}

/** The inner lines are the omitted-body stub (the marker, perhaps with other comments and blank lines). */
export function isOmittedStub(inner: readonly string[]): boolean {
  return hasNoCode(inner) && inner.some(l => OMITTED_TEXT.test(l));
}
