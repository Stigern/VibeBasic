// Internal control clipboard for the designer (cut/copy/paste). Holds deep copies; paste assigns new ids.
import type { ControlDef } from '../model/types';

let contents: ControlDef[] = [];

export function setClipboard(defs: ControlDef[]): void { contents = defs.map(d => structuredClone(d)); }
export function getClipboard(): ControlDef[] { return contents.map(d => structuredClone(d)); }
export function clipboardHasControls(): boolean { return contents.length > 0; }
