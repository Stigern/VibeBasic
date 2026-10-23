import { expect, test } from 'vitest';
import { formOpsToCommand, parseFormOps } from '../../src/ai/formMode';
import { applyComponentChoice } from '../../src/ide/projectDialogs';
import { LEGACY_COMPONENTS, availableComponents, controlsOf, toolboxTools } from '../../src/model/components';
import { newControl, newProject, TOOLBOX_ORDER } from '../../src/model/controls';
import { parseProject, serializeProject } from '../../src/model/serialize';

const INTRINSIC = ['Pointer', 'PictureBox', 'Label', 'TextBox', 'Frame', 'CommandButton', 'CheckBox', 'OptionButton', 'ComboBox', 'ListBox',
  'HScrollBar', 'VScrollBar', 'Timer', 'DriveListBox', 'DirListBox', 'FileListBox', 'Shape', 'Line', 'Image', 'Data'];

test('component data drives the Toolbox: intrinsic controls first, then the checked components in component order', () => {
  expect(newProject().components).toEqual([]);
  expect(toolboxTools([])).toEqual(INTRINSIC);
  // checked out of order: the Toolbox still follows the component table
  expect(toolboxTools(['TABCTL32.OCX', 'mscomctl.ocx']).slice(INTRINSIC.length))
    .toEqual(['ProgressBar', 'Slider', 'StatusBar', 'TabStrip', 'Toolbar', 'TreeView', 'ListView', 'ImageList', 'SSTab']);
  // every control type is reachable: intrinsic or in exactly one listed component
  const all = toolboxTools(availableComponents().map(c => c.file));
  expect([...all].sort()).toEqual([...TOOLBOX_ORDER].sort());
  // components without any control yet are not listed
  expect(availableComponents().map(c => c.file)).toEqual(['MSCOMCTL.OCX', 'MSCOMCT2.OCX', 'COMDLG32.OCX', 'RICHTX32.OCX', 'MSFLXGRD.OCX', 'TABCTL32.OCX', 'SHDOCVW.DLL', 'MSINET.OCX', 'MSWINSCK.OCX', 'MSCOMM32.OCX', 'SYSINFO.OCX', 'MSCHRT20.OCX', 'MSMASK32.OCX', 'MCI32.OCX', 'MSDXM.OCX', 'MSADODC.OCX', 'MSDATGRD.OCX', 'MSDATLST.OCX', 'THREED32.OCX', 'AGENTCTL.DLL']);
  expect(controlsOf('MSINET.OCX')).toEqual(['Inet']);
  expect(controlsOf('MCI32.OCX')).toEqual(['MMControl']);
  expect(controlsOf('AGENTCTL.DLL')).toEqual(['Agent']);
  expect(controlsOf('MSADODC.OCX')).toEqual(['Adodc']);
  expect(controlsOf('MSDATLST.OCX')).toEqual(['DataList', 'DataCombo']);
  expect(controlsOf('MSCOMM32.OCX')).toEqual(['MSComm']);
  expect(controlsOf('SYSINFO.OCX')).toEqual(['SysInfo']);
  expect(controlsOf('THREED32.OCX')).toEqual(['SSPanel', 'SSCommand', 'SSCheck', 'SSOption', 'SSFrame', 'SSRibbon']);
});

test('an old project (no components) keeps its controls visible; a used component is always checked on load', () => {
  const p = newProject();
  p.forms[0].controls.push(newControl(p.forms[0], 'ListView', { left: 0, top: 0 }, null));
  const old = JSON.parse(serializeProject(p));
  delete old.components;
  const loaded = parseProject(JSON.stringify(old));
  expect(loaded.components).toEqual([...LEGACY_COMPONENTS]);
  expect(toolboxTools(loaded.components)).toContain('ListView');
  // a file that lists too few components still gets the used ones
  p.forms[0].controls.push(newControl(p.forms[0], 'SSTab', { left: 0, top: 0 }, null));
  p.components = ['RICHTX32.OCX'];
  expect(parseProject(serializeProject(p)).components).toEqual(['MSCOMCTL.OCX', 'RICHTX32.OCX', 'TABCTL32.OCX']);
});

test('saving and loading keeps the components', () => {
  const p = newProject();
  p.components = ['COMDLG32.OCX', 'TABCTL32.OCX'];
  expect(JSON.parse(serializeProject(p)).components).toEqual(['COMDLG32.OCX', 'TABCTL32.OCX']);
  expect(parseProject(serializeProject(p)).components).toEqual(['COMDLG32.OCX', 'TABCTL32.OCX']);
  expect(parseProject(serializeProject(newProject())).components).toEqual([]);
});

test('unchecking a component a form uses is refused', () => {
  const p = newProject();
  p.components = ['MSCOMCTL.OCX', 'COMDLG32.OCX'];
  p.forms[0].controls.push(newControl(p.forms[0], 'TreeView', { left: 0, top: 0 }, null));
  expect(applyComponentChoice(p, [])).toEqual({ components: ['MSCOMCTL.OCX'], refused: ['MSCOMCTL.OCX'] });
  expect(applyComponentChoice(p, ['MSCOMCTL.OCX', 'TABCTL32.OCX'])).toEqual({ components: ['MSCOMCTL.OCX', 'TABCTL32.OCX'], refused: [] });
});

test('the AI may add any control: its component is checked in the same undo step', () => {
  const p = newProject();
  const parsed = parseFormOps('{"ops":[{"op":"add","type":"SSTab","name":"Tabs1"},{"op":"add","type":"Label","name":"L","container":"Tabs1","tab":2}]}', p.forms[0]);
  if (!parsed.ok) throw new Error('not parsed');
  const cmd = formOpsToCommand(p, p.forms[0].id, parsed, 'AI');
  cmd.do(p);
  expect(p.components).toEqual(['TABCTL32.OCX']);
  expect(p.forms[0].controls[1]).toMatchObject({ name: 'L', parentId: p.forms[0].controls[0].id, tab: 2 });
  cmd.undo(p);
  expect(p.components).toEqual([]);
  expect(p.forms[0].controls).toEqual([]);
});
