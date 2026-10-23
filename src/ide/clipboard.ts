// Internal control clipboard for the designer (cut/copy/paste). Holds deep copies; paste assigns new ids.
// The pictures the controls name go along, so a paste into another project (or after the cut dropped them) still has them.
import type { Asset, ControlDef } from '../model/types';

let contents: ControlDef[] = [];
let assets: Record<string, Asset> = {};

export function setClipboard(defs: ControlDef[], withAssets: Record<string, Asset> = {}): void {
  contents = defs.map(d => structuredClone(d));
  assets = structuredClone(withAssets);
}
export function getClipboard(): ControlDef[] { return contents.map(d => structuredClone(d)); }
export function getClipboardAssets(): Record<string, Asset> { return structuredClone(assets); }
export function clipboardHasControls(): boolean { return contents.length > 0; }
