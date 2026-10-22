// Native window geometry for a running form (Tauri). Pure: px from the Form's twips properties.

import { CONTROL_TYPES } from '../model/controls';
import type { FormDef, PropValue } from '../model/types';

export interface FormWindowOptions {
  width: number; height: number; resizable: boolean; center: boolean;
  x?: number; y?: number; minimizable: boolean; maximizable: boolean;
}

function prop(props: Record<string, PropValue>, name: string): PropValue {
  return props[name] !== undefined ? props[name] : CONTROL_TYPES.Form.props.find(p => p.name === name)?.default ?? null;
}

/** Outer window size = Width/15 × Height/15 (title bar and border are drawn by the page). */
export function windowOptionsFor(form: FormDef, cascadeIndex: number): FormWindowOptions {
  const p = form.props;
  const num = (n: string): number => Number(prop(p, n)) || 0;
  const on = (n: string): boolean => { const v = prop(p, n); return v === true || (typeof v === 'number' && v !== 0); };
  const bs = num('BorderStyle');
  const sizable = bs === 2 || bs === 5;
  const buttons = (bs === 1 || bs === 2) && on('ControlBox');
  const o: FormWindowOptions = {
    width: Math.max(1, Math.round(num('Width') / 15)),
    height: Math.max(1, Math.round(num('Height') / 15)),
    resizable: sizable, center: false,
    minimizable: buttons && on('MinButton'),
    maximizable: buttons && sizable && on('MaxButton'),
  };
  const pos = num('StartUpPosition');
  if (pos === 0) { o.x = Math.round(num('Left') / 15); o.y = Math.round(num('Top') / 15); }
  else if (pos === 1 || pos === 2) o.center = true;
  else { o.x = o.y = 60 + 30 * cascadeIndex; }
  return o;
}
