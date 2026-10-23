// Host globals of a running program: App, Screen and the Picture objects LoadPicture returns (Forms and Clipboard: globalObjects.ts).

import type { VBObject } from '../../lang/host';
import { VBRuntimeError } from '../../lang/errors';
import { Nothing, coerce, toStr, type VBValue } from '../../lang/values';
import { MOUSE_POINTERS } from '../../controls/cursor';
import type { PictureRef } from '../../model/types';

/** Any picture value carries its asset reference; `null` is an empty picture (`LoadPicture("")`). */
export interface HasPictureRef { pictureRef: PictureRef | null }

/**
 * A Picture: what `Picture1.Picture` reads and LoadPicture returns. `pictureRef.asset` is a project asset key,
 * or a data URL for a picture loaded at run time (the form window shows that URL directly).
 */
export class PictureObject implements VBObject, HasPictureRef {
  readonly vbTypeName = 'Picture';
  constructor(readonly pictureRef: PictureRef | null) {}
  hasMember(name: string): boolean { return name.toLowerCase() === 'handle'; }
  getMember(name: string): VBValue {
    if (name.toLowerCase() === 'handle') return this.pictureRef ? 1 : 0;
    throw new VBRuntimeError(438);
  }
  setMember(): void { throw new VBRuntimeError(438); }
  callMethod(): VBValue { throw new VBRuntimeError(438); }
}

/** A tiny read/write property bag; names are case-insensitive, `readOnly` ones give 383. */
abstract class PropObject implements VBObject {
  abstract readonly vbTypeName: string;
  protected abstract props(): Record<string, () => VBValue>;
  protected setters: Record<string, (v: VBValue) => void> = {};
  hasMember(name: string): boolean { return name.toLowerCase() in this.props(); }
  getMember(name: string, args: VBValue[]): VBValue {
    const g = this.props()[name.toLowerCase()];
    if (!g) throw new VBRuntimeError(438);
    if (args.length) throw new VBRuntimeError(450);
    return g();
  }
  setMember(name: string, _args: VBValue[], value: VBValue): void {
    const l = name.toLowerCase();
    if (!(l in this.props())) throw new VBRuntimeError(438);
    const s = this.setters[l];
    if (!s) throw new VBRuntimeError(383);
    s(value);
  }
  callMethod(): VBValue { throw new VBRuntimeError(438); }
}

export class AppObject extends PropObject {
  readonly vbTypeName = 'App';
  constructor(public title: string, private path: string, private exeName: string) {
    super();
    this.setters = { title: v => { this.title = toStr(v); } };
  }
  protected props(): Record<string, () => VBValue> {
    return { title: () => this.title, path: () => this.path, exename: () => this.exeName, previnstance: () => false };
  }
}

export class ScreenObject extends PropObject {
  readonly vbTypeName = 'Screen';
  private mousePointer = 0;
  private mouseIcon: PictureObject | null = null;
  /** `active` gives the form that was activated last and its control with the focus (Nothing when there is none); `pointer` hears
   *  MousePointer / MouseIcon (the cursor over every form window; 99 shows the icon). */
  constructor(private active: { form(): VBValue; control(): VBValue } = { form: () => Nothing, control: () => Nothing },
    private pointer: (pointer: number, icon: PictureRef | null) => void = () => {}) {
    super();
    this.setters = {
      mousepointer: v => {
        const n = Math.trunc(Number(coerce(v, 'Long')));
        if (!MOUSE_POINTERS.some(([k]) => k === n)) throw new VBRuntimeError(380);
        this.mousePointer = n;
        this.pointer(n, this.mouseIcon?.pictureRef ?? null);
      },
      mouseicon: v => {
        if (v !== Nothing && !(v instanceof PictureObject)) throw new VBRuntimeError(13);
        this.mouseIcon = v === Nothing ? null : v as PictureObject;
        this.pointer(this.mousePointer, this.mouseIcon?.pictureRef ?? null);
      },
    };
  }
  protected props(): Record<string, () => VBValue> {
    const scr = typeof screen !== 'undefined' ? screen : { width: 1024, height: 768 };
    return {
      width: () => (scr.width || 1024) * 15, height: () => (scr.height || 768) * 15, mousepointer: () => this.mousePointer,
      mouseicon: () => this.mouseIcon ?? Nothing,
      activeform: () => this.active.form(), activecontrol: () => this.active.control(),
    };
  }
}
