// Variable values of the frame stopped in break mode, as short text (for the AI's error fix request).

import { EmptyT, NothingT, NullT, VBArray, VBRecord, isObject, maybeSingle, single7, toStr, vbTypeName, type VBValue } from '../values';
import type { Frame } from './scope';

/** Longest string value shown (longer ones are cut and end with `...`). */
export const MAX_STRING = 80;
/** Most variables listed. */
export const MAX_VARIABLES = 40;
/** Elements (or fields) shown of an array, a record or a collection. */
const FIRST = 3;

function short(v: VBValue, depth: number): string {
  if (typeof v === 'string') return `"${v.length > MAX_STRING ? `${v.slice(0, MAX_STRING)}...` : v}"`;
  if (v instanceof EmptyT || v instanceof NullT || v instanceof NothingT) return v.toString();
  if (v instanceof VBArray) {
    if (!v.allocated) return `${vbTypeName(v)} (not allocated)`;
    const head = `${vbTypeName(v).slice(0, -2)}(${v.bounds.map(([lo, hi]) => `${lo} To ${hi}`).join(', ')})`;
    if (depth > 0) return head;
    const vals = v.values();
    return `${head}: ${vals.slice(0, FIRST).map(x => short(x, depth + 1)).join(', ')}${vals.length > FIRST ? ', ...' : ''}`;
  }
  if (v instanceof VBRecord) {
    if (depth > 0) return v.typeName;
    const fields = [...v.fields];
    return `${v.typeName} {${fields.slice(0, FIRST).map(([k, x]) => `${k}: ${short(x, depth + 1)}`).join(', ')}${fields.length > FIRST ? ', ...' : ''}}`;
  }
  if (isObject(v)) {
    const items = depth === 0 && v.items ? v.items() : null;
    if (!items) return v.vbTypeName;
    const item = (x: VBValue) => (isObject(x) ? x.vbTypeName : short(x, depth + 1));   // a Collection holds any values
    return `${v.vbTypeName} (${items.length} items)${items.length ? `: ${items.slice(0, FIRST).map(item).join(', ')}${items.length > FIRST ? ', ...' : ''}` : ''}`;
  }
  try { return toStr(v); } catch { return vbTypeName(v); }
}

/**
 * The local variables of `frame` (the function result too), then its module's variables: at most
 * MAX_VARIABLES, strings cut to MAX_STRING characters, arrays, records and objects as their type with the first three values.
 */
export function snapshotVariables(frame: Frame | undefined): { name: string; value: string }[] {
  if (!frame) return [];
  const out: { name: string; value: string }[] = [];
  const seen = new Set<string>();
  for (const [key, v] of [...frame.locals, ...frame.vars]) {
    if (out.length >= MAX_VARIABLES) break;
    if (v.opts.isConst || seen.has(key)) continue;   // a local hides a module variable of the same name
    seen.add(key);
    let value: string;
    try {
      const x = v.value;
      value = short(v.type === 'Single' && maybeSingle(x) ? single7(x) : x, 0);   // a Single as VB6 shows it
    } catch { value = '?'; }
    out.push({ name: v.name, value });
  }
  return out;
}
