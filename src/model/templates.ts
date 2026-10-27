// The project types of File > New Project (the New Project dialog, ide/newProjectDialog.ts), as VB6's New tab offers them.
import { newControl, newId, newProject } from './controls';
import { newMdiForm } from './mdi';
import type { Project } from './types';
import { populatePreset } from './projectPresets';

export type ProjectTemplate = 'standard' | 'mdi' | 'subMain' | 'data' | 'aiWizard' | 'textEditor' | 'drawing' | 'serial';

export interface TemplateInfo { id: ProjectTemplate; label: string; description: string }

export const TEMPLATES: readonly TemplateInfo[] = [
  { id: 'standard', label: 'Standard EXE', description: 'Creates a project with one form.' },
  { id: 'mdi', label: 'MDI Application', description: 'Creates an MDI form with a child form that opens inside it.' },
  { id: 'subMain', label: 'Sub Main', description: 'Creates a project that starts in Sub Main in a standard module.' },
  { id: 'data', label: 'Data Project', description: 'Creates a form with a Data control and a DataGrid bound to it.' },
  { id: 'aiWizard', label: 'AI Wizard', description: 'Describe the program you want; the AI lays out the form and writes the code.' },
  { id: 'textEditor', label: 'Text Editor', description: 'A plain-text editor with Open, Save, File/Edit menus and a status line.' },
  { id: 'drawing', label: 'Drawing App', description: 'A drawing canvas with colours, brush sizes and a Clear button.' },
  { id: 'serial', label: 'Serial Terminal', description: 'Connect to a serial device, choose the baud rate, and send and receive text.' },
];

/** A new project of the type (`code`: what each new form and module starts with, e.g. Option Explicit). The AI Wizard starts as a
 *  Standard EXE; the IDE then asks the AI. */
export function projectFromTemplate(t: ProjectTemplate, code = ''): Project {
  const p = newProject();
  const form1 = p.forms[0];
  form1.code = code;
  switch (t) {
    case 'textEditor': case 'drawing': case 'serial':
      populatePreset(p, t, code);
      break;
    case 'mdi': {
      const mdi = newMdiForm('MDIForm1', code + 'Private Sub MDIForm_Load()\n    Form1.Show\nEnd Sub\n');
      form1.props.MDIChild = true;
      p.forms = [mdi, form1];
      p.startupForm = mdi.name;
      break;
    }
    case 'subMain':
      p.modules.push({ id: newId(), name: 'Module1', code: code + 'Sub Main()\n    Form1.Show\nEnd Sub\n' });
      p.subMain = true;
      break;
    case 'data': {
      Object.assign(form1.props, { Width: 7200, Height: 5400 });
      const grid = newControl(form1, 'DataGrid', { left: 120, top: 120, width: 6735, height: 3855 }, null);
      form1.controls.push(grid);
      const data = newControl(form1, 'Data', { left: 120, top: 4140, width: 6735, height: 375 }, null);
      form1.controls.push(data);
      grid.props.DataSource = data.name;
      p.components = ['MSDATGRD.OCX'];
      form1.code = code + `' Set ${data.name}.DatabaseName to a SQLite database (.db) and RecordSource to a table name,\n`
        + `' in the Properties window or here in Form_Load.\n`;
      break;
    }
  }
  return p;
}
