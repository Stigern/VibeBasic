// The New Project dialog (VB6's): when VibeBasic starts (Options > General, Prompt for project) with the New, Existing and Recent
// tabs, and from File > New Project with the New tab only. Opening a project is the caller's (FileController); this only chooses.
import { TEMPLATES, type ProjectTemplate } from '../model/templates';
import { messageBox98, showDialog98 } from '../ui98/dialogs';
import { h } from '../ui98/dom';
import { createTabs } from '../ui98/tabs';
import { check } from './projectDialogs';
import { projectFolder, projectLabel } from './recentProjects';
import './newProjectDialog.css';

export type NewProjectChoice = { kind: 'new'; template: ProjectTemplate } | { kind: 'existing' } | { kind: 'recent'; path: string };

export interface NewProjectOptions {
  /** At start: the Existing and Recent tabs and "Don't show this dialog in the future". */
  startup: boolean;
  /** The Recent tab's projects, newest first. */
  recent: readonly string[];
}

export interface NewProjectResult { choice: NewProjectChoice | null; dontShow: boolean }

/** 32x32 icons, original artwork in the Win98 manner. */
const ICONS: Record<ProjectTemplate, string> = {
  textEditor: '<path d="M6 2.5h14l6 6V29H6z" fill="#fff" stroke="#404040"/><path d="M20 3v6h6" fill="#dfdfdf" stroke="#808080"/><path d="M10 13h12M10 17h12M10 21h12M10 25h8" stroke="#000080" stroke-width="1.5"/>',
  drawing: '<rect x="3" y="5" width="26" height="23" fill="#fff" stroke="#404040"/><path d="M6 24l7-9 5 5 5-7 4 11" fill="#80c080"/><circle cx="10" cy="11" r="3" fill="#ffd36a"/><path d="M17 18L28 2l3 2-12 15z" fill="#e9a514" stroke="#805000"/><path d="M17 18l-2 6 5-4" fill="#000080"/>',
  serial: '<rect x="2.5" y="3.5" width="27" height="20" fill="#c0c0c0" stroke="#404040"/><rect x="5" y="6" width="22" height="14" fill="#101010"/><path d="M8 9l3 3-3 3M14 16h7" fill="none" stroke="#00ff80" stroke-width="1.5"/><path d="M12 24v4h-5m13-4v4h5" fill="none" stroke="#404040" stroke-width="2"/>',
  standard: '<rect x="3.5" y="5.5" width="25" height="21" fill="#d4d0c8" stroke="#404040"/><rect x="4" y="6" width="24" height="5" fill="#000080"/><rect x="7" y="14" width="10" height="4" fill="#fff" stroke="#808080" stroke-width="0.6"/><rect x="7" y="20" width="8" height="4" fill="#e6e2da" stroke="#404040" stroke-width="0.6"/>',
  mdi: '<rect x="1.5" y="3.5" width="29" height="25" fill="#808080" stroke="#404040"/><rect x="2" y="4" width="28" height="4" fill="#000080"/><rect x="5.5" y="11.5" width="14" height="11" fill="#d4d0c8" stroke="#404040"/><rect x="6" y="12" width="13" height="3" fill="#1084d0"/><rect x="12.5" y="15.5" width="14" height="11" fill="#d4d0c8" stroke="#404040"/><rect x="13" y="16" width="13" height="3" fill="#000080"/>',
  subMain: '<path d="M7.5 3.5h13l5 5v20h-18z" fill="#fff" stroke="#404040"/><path d="M20.5 3.5v5h5" fill="#dfdfdf" stroke="#404040"/><rect x="10" y="12" width="12" height="1.6" fill="#000080"/><rect x="12" y="16" width="10" height="1.6" fill="#2a8a2a"/><rect x="12" y="20" width="8" height="1.6" fill="#404040"/><rect x="10" y="24" width="9" height="1.6" fill="#000080"/>',
  data: '<ellipse cx="11" cy="7" rx="8" ry="3" fill="#ffd36a" stroke="#8a6300"/><path d="M3 7v16c0 1.7 3.6 3 8 3s8-1.3 8-3V7" fill="#f5c43a" stroke="#8a6300"/><ellipse cx="11" cy="13" rx="8" ry="3" fill="none" stroke="#8a6300" stroke-width="0.6"/><rect x="14.5" y="15.5" width="15" height="12" fill="#fff" stroke="#404040"/><path d="M14.5 19.5h15M14.5 23.5h15M19.5 15.5v12M24.5 15.5v12" stroke="#808080" stroke-width="0.6"/><rect x="15" y="16" width="14" height="3" fill="#c0c0c0"/>',
  aiWizard: '<rect x="2.5" y="8.5" width="22" height="19" fill="#d4d0c8" stroke="#404040"/><rect x="3" y="9" width="21" height="4" fill="#000080"/><rect x="6" y="16" width="9" height="3" fill="#fff" stroke="#808080" stroke-width="0.6"/><rect x="6" y="21" width="12" height="3" fill="#e6e2da" stroke="#404040" stroke-width="0.6"/><path d="M14 30 L27 9" stroke="#5a3a1a" stroke-width="2.2" stroke-linecap="round"/><path d="M26 2 Q27 7 31 8 Q27 9 26 14 Q25 9 21 8 Q25 7 26 2 Z" fill="#fff4b0" stroke="#e9b818" stroke-width="0.8"/>',
};
const FOLDER_ICON = '<path d="M2.5 9.5h10l2 2h15v16h-27z" fill="#f5d36a" stroke="#8a6300"/><path d="M2.5 13.5h27v14h-27z" fill="#ffe28a" stroke="#8a6300"/>';
const PROJECT_ICON = '<rect x="5.5" y="4.5" width="21" height="24" fill="#fff" stroke="#404040"/><rect x="9" y="9" width="14" height="10" fill="#d4d0c8" stroke="#404040" stroke-width="0.6"/><rect x="9" y="9" width="14" height="3" fill="#000080"/><rect x="9" y="22" width="10" height="1.6" fill="#000080"/>';

/** The banner: the splash window's wordmark and blocks, small. */
const BANNER = `<svg width="100%" height="54" viewBox="0 0 400 54" preserveAspectRatio="xMinYMid slice" aria-hidden="true">
<defs><linearGradient id="np-bg" x1="0" y1="0" x2="1" y2="0"><stop offset="0" stop-color="#fff"/><stop offset="1" stop-color="#dbe5f7"/></linearGradient>
<linearGradient id="np-w" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#2f56d8"/><stop offset="1" stop-color="#0a1d7a"/></linearGradient>
<linearGradient id="np-b" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#9cc4ff"/><stop offset="1" stop-color="#4f86f0"/></linearGradient>
<linearGradient id="np-p" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#d5b8ff"/><stop offset="1" stop-color="#9a6af0"/></linearGradient>
<linearGradient id="np-g" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#fff0a8"/><stop offset="1" stop-color="#f5c43a"/></linearGradient></defs>
<rect width="400" height="54" fill="url(#np-bg)"/>
<text x="16" y="24" font-family="Arial, Helvetica, sans-serif" font-size="17" fill="#3b3b3b">Vibe</text>
<text x="14" y="46" font-family="'Arial Black', Arial, sans-serif" font-weight="900" font-size="25" fill="url(#np-w)" letter-spacing="-1">Basic</text>
<g transform="translate(282 -7) scale(0.3)">
<polygon points="190,36 231.6,60 190,84 148.4,60" fill="url(#np-b)"/><polygon points="148.4,60 190,84 190,132 148.4,108" fill="#2a5fd6"/><polygon points="190,84 231.6,60 231.6,108 190,132" fill="#c9d3e3"/>
<polygon points="146,92 187.6,116 146,140 104.4,116" fill="url(#np-p)"/><polygon points="104.4,116 146,140 146,188 104.4,164" fill="#7a45d8"/><polygon points="146,140 187.6,116 187.6,164 146,188" fill="#9563ea"/>
<circle cx="146" cy="104" r="16" fill="#ff8a2a"/>
<polygon points="234,92 275.6,116 234,140 192.4,116" fill="url(#np-g)"/><polygon points="192.4,116 234,140 234,188 192.4,164" fill="#e9a514"/><polygon points="234,140 275.6,116 275.6,164 234,188" fill="#f5bb2a"/></g>
<path d="M376 7 Q378 15 385 17 Q378 19 376 27 Q374 19 367 17 Q374 15 376 7 Z" fill="#fff4b0" stroke="#e9b818" stroke-width="0.8"/></svg>`;

/** Markup this module writes itself (no user text) as a DOM node. */
function fromMarkup(doc: Document, markup: string): Element {
  const t = doc.createElement('template');
  t.innerHTML = markup;
  return t.content.firstElementChild!;
}
const icon = (doc: Document, body: string): Element => fromMarkup(doc, `<svg class="np-icon" width="32" height="32" viewBox="0 0 32 32" aria-hidden="true">${body}</svg>`);

const HELP = 'New: pick the kind of project and click Open.\n\nExisting: open a project from a file, a VibeBasic project (.vbb) or a Visual Basic 6 project (.vbp).\n\n'
  + 'Recent: the projects you opened or saved last.\n\nThe dialog shows when VibeBasic starts; turn that off and on again under Tools > Options > General.';

export async function showNewProjectDialog(doc: Document, o: NewProjectOptions): Promise<NewProjectResult> {
  let tab = 0, template: ProjectTemplate = 'standard', recentIndex = o.recent.length ? 0 : -1, dontShow = false;
  for (;;) {   // Help shows its text and comes back to the dialog as it was
    const r = await once();
    if (r !== 'help') return r;
    await messageBox98(doc, { prompt: HELP, title: 'New Project', buttons: 64 });
  }

  function once(): Promise<NewProjectResult | 'help'> {
    // (from the content, which stays in the dialog: a tab's own elements are taken out while another tab shows)
    const pressOpen = () => content.closest('.dlg98')?.querySelector<HTMLButtonElement>('.dlg98-buttons button.default')?.click();
    const desc = h('div', { class: 'np-desc' });

    // New: the project types
    const list = h('div', { class: 'np-list', role: 'listbox', tabindex: '0', 'aria-label': 'Project types', 'data-autofocus': '' });
    const items = TEMPLATES.map(t => {
      const el = h('div', { class: 'np-item', role: 'option' }, icon(doc, ICONS[t.id]), h('span', {}, t.label));
      el.addEventListener('mousedown', () => pick(t.id));
      el.addEventListener('dblclick', pressOpen);
      list.appendChild(el);
      return el;
    });
    const pick = (id: ProjectTemplate) => {
      template = id;
      items.forEach((el, i) => el.classList.toggle('sel', TEMPLATES[i].id === id));
      desc.textContent = TEMPLATES.find(t => t.id === id)?.description ?? '';
    };
    list.addEventListener('keydown', e => {   // arrows move in the grid of 4 columns
      const i = TEMPLATES.findIndex(t => t.id === template);
      const step: Record<string, number> = { ArrowLeft: -1, ArrowRight: 1, ArrowUp: -4, ArrowDown: 4 };
      if (step[e.key] === undefined) return;
      e.preventDefault();
      const j = i + step[e.key];
      if (j >= 0 && j < TEMPLATES.length) pick(TEMPLATES[j].id);
    });
    pick(template);
    const newTab = h('div', { class: 'np-pane' }, list, desc);

    // Existing: the file dialog (Open or Browse)
    const browse = h('button', { type: 'button' }, 'Browse...');
    browse.addEventListener('click', pressOpen);
    const existingTab = h('div', { class: 'np-pane np-existing' },
      icon(doc, FOLDER_ICON),
      h('div', { class: 'np-text' }, 'Open a VibeBasic project (.vbb) or a Visual Basic 6 project (.vbp) from a file. Click Open or Browse to choose it.'),
      browse);

    // Recent
    const rows = o.recent.map((path, i) => {
      const row = h('div', { class: 'np-row', role: 'option', title: path },
        icon(doc, PROJECT_ICON), h('span', { class: 'np-name' }, projectLabel(path)), h('span', { class: 'np-folder' }, projectFolder(path)));
      row.addEventListener('mousedown', () => pickRecent(i));
      row.addEventListener('dblclick', pressOpen);
      return row;
    });
    const pickRecent = (i: number) => { recentIndex = i; rows.forEach((r, k) => r.classList.toggle('sel', k === i)); };
    if (recentIndex >= 0) pickRecent(recentIndex);
    const recentList = h('div', { class: 'np-list np-recent', role: 'listbox', tabindex: '0', 'aria-label': 'Recent projects' },
      ...(rows.length ? rows : [h('div', { class: 'np-empty' }, 'No recent projects yet. The projects you open or save show here.')]));
    recentList.addEventListener('keydown', e => {
      if (!rows.length || (e.key !== 'ArrowUp' && e.key !== 'ArrowDown')) return;
      e.preventDefault();
      pickRecent(Math.min(rows.length - 1, Math.max(0, recentIndex + (e.key === 'ArrowDown' ? 1 : -1))));
    });
    const recentTab = h('div', { class: 'np-pane' }, recentList);

    const tabs = createTabs(o.startup
      ? [{ label: 'New', content: newTab }, { label: 'Existing', content: existingTab }, { label: 'Recent', content: recentTab }]
      : [{ label: 'New', content: newTab }], { selected: tab, onSelect: i => { tab = i; } });

    const dont = check("Don't show this dialog in the future", dontShow);
    dont.input.addEventListener('change', () => { dontShow = dont.input.checked; });
    dont.el.classList.add('np-dont');
    const content = h('div', { class: 'np' }, tabs.el, ...(o.startup ? [dont.el] : []));

    return showDialog98(doc, {
      title: 'New Project', content, buttonsSide: true, header: h('div', { class: 'np-banner' }, fromMarkup(doc, BANNER)),
      buttons: [{ label: 'Open', value: 'open', default: true }, { label: 'Cancel', value: 'cancel', cancel: true }, { label: 'Help', value: 'help' }],
    }).then((v): NewProjectResult | 'help' => {
      if (v === 'help') return 'help';
      if (v !== 'open') return { choice: null, dontShow };
      if (tab === 1) return { choice: { kind: 'existing' }, dontShow };
      if (tab === 2) return { choice: recentIndex >= 0 ? { kind: 'recent', path: o.recent[recentIndex] } : null, dontShow };
      return { choice: { kind: 'new', template }, dontShow };
    });
  }
}
