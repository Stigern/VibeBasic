// The run-time side of DataList and DataCombo (MSDATLST.OCX): the list is the ListField of every record of the RowSource data
// control; BoundText is the BoundColumn value of the chosen record (BoundColumn empty: the ListField itself). With DataSource and
// DataField the control is bound like a TextBox: the current record of the DataSource sets BoundText (the item with that bound
// value is selected), and a new choice is saved to the DataField. The window gets List, ListIndex and Text, as for a ListBox /
// ComboBox.

import { VBRuntimeError } from '../../lang/errors';
import { Empty, Null, NullT, VBRef, toStr, type VBValue } from '../../lang/values';
import type { PropValue } from '../../model/types';
import type { RichControl } from '../objects/richControl';
import { cellText } from './dataGrid';
import type { DataControl } from './dataControl';

export interface ListHost {
  readonly props: Record<string, PropValue>;
  readonly name: string;
  readonly type: 'DataList' | 'DataCombo';
  raise(event: string, args: VBRef[]): Promise<void>;
  send(props: Record<string, PropValue>): void;
  /** The data control the RowSource names (null when there is none). */
  rowSource(): DataControl | null;
  /** Runs `fn` with the program's locale current (list texts of dates). */
  inScope?<T>(fn: () => T): T;
}

const str = (v: PropValue | undefined): string => (typeof v === 'string' ? v : '');

export class DataListControl implements RichControl {
  /** The list texts and the bound values, one per record of the RowSource. */
  private texts: string[] = [];
  private bound: string[] = [];

  constructor(private h: ListHost) {}

  /** Fills the list from the RowSource's records (ReFill, and whenever they change). */
  private refill(src: DataControl | null): void {
    if (this.h.inScope) this.h.inScope(() => this.fill(src)); else this.fill(src);
  }

  private fill(src: DataControl | null): void {
    const rs = src?.recordset();
    this.texts = []; this.bound = [];
    if (rs) {
      const find = (f: string) => rs.columns.findIndex(c => c.name.toLowerCase() === f.toLowerCase());
      const li = find(str(this.h.props.ListField));
      const bf = str(this.h.props.BoundColumn);
      const bi = bf === '' ? li : find(bf);
      for (const r of rs.rowValues()) {
        this.texts.push(li < 0 ? '' : cellText(r[li]));
        this.bound.push(bi < 0 ? '' : cellText(r[bi]));
      }
    }
    this.h.props.List = [...this.texts];
    this.select(this.bound.indexOf(str(this.h.props.BoundText)), false);
  }

  /** Item i is chosen (-1: none): ListIndex, Text and (unless `keepText`) BoundText follow. */
  private select(i: number, fromUser: boolean, keepText = false): void {
    const p = this.h.props;
    p.ListIndex = i;
    p.MatchedWithList = i >= 0;
    if (i >= 0) { p.Text = this.texts[i]; p.BoundText = this.bound[i]; }
    else if (!keepText && this.h.type === 'DataList') p.Text = '';
    p.SelectedItem = i >= 0 ? String(i) : '';
    this.h.send({ List: [...this.texts], ListIndex: i, Text: str(p.Text) });
    if (fromUser) p.DataChanged = true;
  }

  dataNotify(src: DataControl, kind: 'reposition' | 'rows'): void {
    if (kind === 'rows' && src.name.toLowerCase() === str(this.h.props.RowSource).toLowerCase()) this.refill(src);
  }

  showBound(v: VBValue | null): void {
    const t = v === null || v instanceof NullT ? '' : toStr(v);
    this.h.props.BoundText = t;
    const i = this.bound.indexOf(t);
    if (i < 0 && this.h.type === 'DataCombo') this.h.props.Text = t;
    this.select(i, false, true);
  }

  boundValue(): VBValue {
    const t = str(this.h.props.BoundText);
    return t === '' && this.h.props.MatchedWithList !== true && this.h.type === 'DataList' ? Null : t;
  }

  get(name: string, args: VBValue[]): VBValue | undefined {
    if (args.length && (name === 'BoundText' || name === 'Text')) throw new VBRuntimeError(450);
    switch (name) {
      case 'BoundText': return str(this.h.props.BoundText);
      case 'Text': return str(this.h.props.Text);
      case 'SelectedItem': { const i = Number(this.h.props.ListIndex); return i >= 0 ? i : Null; }
      case 'VisibleCount': return this.texts.length;
    }
    return undefined;
  }

  set(name: string, value: VBValue): boolean {
    switch (name) {
      case 'BoundText': {
        const t = toStr(value);
        this.h.props.BoundText = t;
        this.select(this.bound.indexOf(t), true, true);
        return true;
      }
      case 'Text': {
        const t = toStr(value);
        const i = this.texts.findIndex(x => x.toLowerCase() === t.toLowerCase());
        this.h.props.Text = t;
        if (i >= 0) this.select(i, true);
        else { this.select(-1, true, true); if (this.h.type === 'DataCombo') void this.h.raise('Change', []); }
        return true;
      }
    }
    return false;
  }

  call(name: string): VBValue | undefined {
    if (name === 'refill') { this.refill(this.h.rowSource()); return Empty; }
    return undefined;
  }

  /** The user picked an item (ListIndex) or typed in a DataCombo (Text). */
  applyState(props: Record<string, PropValue>): void {
    if (typeof props.ListIndex === 'number' && props.ListIndex >= 0 && props.ListIndex < this.texts.length) this.select(props.ListIndex, true);
    else if (typeof props.Text === 'string' && this.h.type === 'DataCombo') {
      const i = this.texts.findIndex(x => x.toLowerCase() === String(props.Text).toLowerCase());
      this.h.props.MatchedWithList = i >= 0;
      if (i >= 0) { this.h.props.ListIndex = i; this.h.props.BoundText = this.bound[i]; }
      this.h.props.DataChanged = true;
    }
  }

  dispose(): void { /* nothing held */ }
}
