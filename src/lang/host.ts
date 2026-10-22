// Host interface for the VibeBasic language core. Task 5 adds the rest of
// this file (Host, BreakInfo); for now only the object protocol that
// `VBValue` needs.

import type { VBValue } from './values';

export interface VBObject {
  readonly vbTypeName: string;
  readonly defaultMember?: string;
  hasMember(name: string): boolean;
  getMember(name: string, args: VBValue[]): VBValue;
  setMember(name: string, args: VBValue[], value: VBValue): void;
  callMethod(name: string, args: VBValue[]): VBValue | Promise<VBValue>;
  item?(index: number): VBObject;
}
