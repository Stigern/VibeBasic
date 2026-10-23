// The DataSource / RowSource row of a bound control (TextBox, DataGrid, DataCombo ...): a drop-down of the form's Data and
// ADO Data controls; renaming one of those takes the references along.
import { setPropertyCmd, type Command } from '../model/commands';
import type { FormDef } from '../model/types';
import { createCombo } from '../ui98/combo';
import type { CustomEditor, CustomEditorEnv } from './imageListEditor';

const DATA_REF_PROPS = new Set(['DataSource', 'RowSource']);
const isDataControl = (t: string): boolean => t === 'Data' || t === 'Adodc';

/** The drop-down editor of a DataSource / RowSource row; null for any other row. */
export function dataSourceEditor(env: CustomEditorEnv): CustomEditor | null {
  if (!DATA_REF_PROPS.has(env.def.name) || env.def.kind !== 'string') return null;
  const names = env.form.controls.filter(c => isDataControl(c.type)).map(c => c.name);
  const cur = typeof env.value === 'string' ? env.value : '';
  const combo = createCombo({ items: ['', ...names], value: cur, openOnClick: false, onChange: v => env.apply(v) });
  env.cell.replaceChildren(combo.el);
  return { focus: combo.el.querySelector('input'), open: () => combo.open(), close: () => combo.close() };
}

/** Renaming a Data control / Adodc: the controls whose DataSource or RowSource names it follow (one undo step). */
export function dataSourceRenameCmds(form: FormDef, oldName: string, newName: string): Command[] {
  const old = oldName.toLowerCase();
  const out: Command[] = [];
  for (const c of form.controls) {
    for (const p of DATA_REF_PROPS) {
      const v = c.props[p];
      if (typeof v === 'string' && v.toLowerCase() === old) out.push(setPropertyCmd(form.id, c.id, p, newName));
    }
  }
  return out;
}
