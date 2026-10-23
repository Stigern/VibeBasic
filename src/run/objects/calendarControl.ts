// Run-time behaviour of Calendar (MSCAL.OCX): Value, Day, Month, Year, the Next / Previous methods and Today. Every change of Value, by the user or
// by code, goes BeforeUpdate(Cancel) -> the change -> AfterUpdate -> NewYear / NewMonth (when the year / month changed).

import { VBRuntimeError } from '../../lang/errors';
import { Empty, NullT, VBRef, coerce, dateParts, toBool, type VBDate, type VBValue } from '../../lang/values';
import { dayOf, nowSerial } from '../../model/dateControls';
import { inRange, setDatePart, stepDate, type CalUnit } from '../../model/mscal';
import type { PropValue } from '../../model/types';
import { userAction, type RichControl, type RichHost } from './richControl';

const METHOD = /^(next|previous)(day|week|month|year)$/;
const UNIT: Record<string, CalUnit> = { day: 'Day', week: 'Week', month: 'Month', year: 'Year' };

export class CalendarControl implements RichControl {
  constructor(private h: RichHost) {
    const v = h.props.Value;
    h.props.Value = typeof v === 'number' ? dayOf(v) : nowSerial(true);
  }

  private get value(): number { return Number(this.h.props.Value); }

  get(name: string): VBValue | undefined {
    if (name !== 'Day' && name !== 'Month' && name !== 'Year') return undefined;
    const p = dateParts(this.value);
    return name === 'Day' ? p.d : name === 'Month' ? p.m : p.y;
  }

  set(name: string, v: VBValue): boolean | Promise<void> {
    if (name === 'Value') {
      if (v instanceof NullT) throw new VBRuntimeError(94);
      return this.update(dayOf((coerce(v, 'Date') as VBDate).serial));
    }
    if (name === 'Day' || name === 'Month' || name === 'Year') {
      const s = setDatePart(this.value, name, coerce(v, 'Long') as number);
      if (s === null) throw new VBRuntimeError(380);
      return this.update(s);
    }
    return false;
  }

  call(name: string): VBValue | Promise<VBValue> | undefined {
    if (name === 'today') return this.update(nowSerial(true)).then(() => Empty);
    const m = METHOD.exec(name);
    if (!m) return undefined;
    return this.update(stepDate(this.value, UNIT[m[2]], m[1] === 'next' ? 1 : -1)).then(() => Empty);
  }

  /** The user picked a day, moved with the keys or chose a month or year. */
  applyState(props: Record<string, PropValue>): void {
    const a = userAction(props);
    if (!a) return;
    const go = async (): Promise<void> => {
      if (a.verb === 'select' && typeof a.serial === 'number' && inRange(a.serial)) await this.update(dayOf(a.serial));
      if (a.click || a.verb === 'click') await this.h.raise('Click', []);
    };
    void go();
  }

  private async update(serial: number): Promise<void> {
    if (!inRange(serial)) throw new VBRuntimeError(380);
    const old = this.value;
    if (serial === old) return;
    const cancel = new VBRef(0);
    await this.h.raise('BeforeUpdate', [cancel]);
    if (toBool(cancel.value)) { this.h.send({ Value: old }); return; }   // the window shows the old date again
    this.h.props.Value = serial;
    this.h.send({ Value: serial });
    await this.h.raise('AfterUpdate', []);
    const a = dateParts(old), b = dateParts(serial);
    if (a.y !== b.y) await this.h.raise('NewYear', []);
    if (a.y !== b.y || a.m !== b.m) await this.h.raise('NewMonth', []);
  }

  dispose(): void { /* nothing is held */ }
}
