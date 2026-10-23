// The run-time side of MMControl, MediaPlayer and Agent: a ControlObject of one of these types hands property reads and writes,
// methods and the window's reports (`UserAction`) to the object here. Like the net controls (netControls.ts), events are raised with
// `raise`, which runs the VB handler and resolves when it has finished.

import type { OutSlot } from '../../lang/host';
import type { VBRef, VBValue } from '../../lang/values';
import type { PropValue } from '../../model/types';
import type { OpenedMedia } from '../mediaSource';
import type { DataControl } from '../data/dataControl';
import type { ControlArrayObject, ControlObject } from './controlObject';

export interface RichHost {
  readonly props: Record<string, PropValue>;
  readonly name: string;
  raise(event: string, args: VBRef[]): Promise<void>;
  /** Sends `props` (already stored in `props`) to the window. */
  send(props: Record<string, PropValue>): void;
  /** Opens a file of the program (relative to App.Path) for the window to play: never the bytes in a patch (see mediaSource.ts).
   *  Rejects with error 53 when it is missing, or an Error when it cannot be played (too big). */
  openMedia(path: string, mime: string): Promise<OpenedMedia>;
  /** A control of the form by name (CoolBar bands host them); undefined before the form's controls are all made. */
  controlByName?(name: string): ControlObject | ControlArrayObject | undefined;
}

export interface RichControl {
  /** A property read; undefined: an ordinary property (the ControlObject reads it). */
  get?(name: string, args: VBValue[]): VBValue | undefined;
  /** A property write (the plain value, before any conversion); false: an ordinary property. A Promise: the statement waits for it. */
  set?(name: string, value: VBValue): boolean | Promise<void>;
  /** A method; undefined: not one of this object's (the ControlObject handles it). */
  call?(name: string, args: VBValue[], refs?: (OutSlot | undefined)[]): VBValue | Promise<VBValue> | undefined;
  /** State the window reported (the user clicked a button, dragged a character ...). */
  applyState?(props: Record<string, PropValue>): void;
  /** The form's Form_Load has finished (the Data control opens its recordset). */
  formLoaded?(): Promise<void>;
  /** The form is about to unload (the Data control saves the bound controls' changes). */
  formUnloading?(): Promise<void>;
  /** Data binding of a DataList / DataCombo (BoundText); see DataConsumer. */
  showBound?(v: VBValue | null): void;
  boundValue?(): VBValue;
  dataNotify?(src: DataControl, kind: 'reposition' | 'rows'): void;
  /** The form unloads or the program ends. */
  dispose(): void;
}

/** The window's `UserAction` report, parsed; null when there is none. */
export function userAction(props: Record<string, PropValue>): Record<string, string | number> | null {
  if (typeof props.UserAction !== 'string') return null;
  try { return JSON.parse(props.UserAction) as Record<string, string | number>; } catch { return null; }
}

/** setTimeout that can be cleared all at once (dispose). */
export class Timers {
  private set = new Set<ReturnType<typeof setTimeout>>();
  after(ms: number, fn: () => void): ReturnType<typeof setTimeout> {
    const t = setTimeout(() => { this.set.delete(t); fn(); }, Math.max(0, ms));
    this.set.add(t);
    return t;
  }
  clear(t: ReturnType<typeof setTimeout> | null): void { if (t !== null) { clearTimeout(t); this.set.delete(t); } }
  clearAll(): void { for (const t of this.set) clearTimeout(t); this.set.clear(); }
}
