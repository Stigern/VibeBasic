// The AI Wizard (New Project dialog): the program described in your own words, plus checked improvements that each add a clear
// instruction to the request. The request then goes the usual Ask AI way, in form mode, to the new project's Form1.
import { messageBox98, showDialog98 } from '../ui98/dialogs';
import { h } from '../ui98/dom';
import { check } from '../ide/projectDialogs';

export interface WizardOption { id: string; label: string; instruction: string; on: boolean }

/** What form mode can build (controls, menus, form properties and code); the ones on by default cost the model little. */
export const WIZARD_OPTIONS: readonly WizardOption[] = [
  { id: 'names', label: 'Clear control names', on: true,
    instruction: 'Name every control with its VB6 prefix and purpose (txtName, cmdSave, lblTotal).' },
  { id: 'keys', label: 'Access keys, Enter and Esc', on: true,
    instruction: 'Give the captions access keys (&), set a sensible TabIndex order, and make the main button the Default (Enter) and a Close or Cancel button the Cancel (Esc) button.' },
  { id: 'tips', label: 'Tooltips', on: true, instruction: 'Give the controls short ToolTipText.' },
  { id: 'validate', label: 'Check the input', on: true,
    instruction: 'Check what the user types and explain mistakes in a MsgBox; never fail on empty or wrong input.' },
  { id: 'menu', label: 'Menu bar (File, Help)', on: false,
    instruction: 'Add a menu bar: File with Exit, Edit where it makes sense, and Help with an About box (a MsgBox).' },
  { id: 'status', label: 'Status line at the bottom', on: false,
    instruction: 'Add a status line (a Label along the bottom of the form) that tells the user what just happened.' },
  { id: 'errors', label: 'Error handling', on: false,
    instruction: 'Use On Error in the event procedures and show a friendly MsgBox when something fails.' },
  { id: 'settings', label: 'Remember settings', on: false,
    instruction: 'Remember the window position and the last values between runs with SaveSetting and GetSetting.' },
  { id: 'resize', label: 'Resizable layout', on: false,
    instruction: 'Let the form be resized and move or stretch the controls in Form_Resize.' },
  { id: 'confirm', label: 'Ask before closing', on: false,
    instruction: 'Ask before closing when there is unsaved work (Form_QueryUnload).' },
  { id: 'comments', label: 'Comments in the code', on: false, instruction: 'Comment the code briefly so a beginner can follow it.' },
];

/** The request: the description, then the instructions of the checked options in WIZARD_OPTIONS order. */
export function wizardPrompt(description: string, checked: ReadonlySet<string>): string {
  const extra = WIZARD_OPTIONS.filter(o => checked.has(o.id)).map(o => `- ${o.instruction}`);
  const what = `Build this program on the form, with its controls and all of its code: ${description.trim()}`;
  return extra.length ? `${what}\n\nAlso:\n${extra.join('\n')}` : what;
}

/** The options checked last time (this session); the defaults at first. */
let lastChecked: Set<string> | null = null;

export async function wizardDialog(doc: Document): Promise<string | null> {
  const box = h('textarea', { class: 'ai-prompt', rows: '5', cols: '60', 'data-autofocus': '',
    placeholder: 'A tip calculator: the bill, a tip percent and the number of people; it shows the tip and what each person pays.' });
  // Enter inserts a line break (the dialog would otherwise press Create); Ctrl+Enter presses Create
  box.addEventListener('keydown', e => {
    if (e.key !== 'Enter' || e.ctrlKey || e.metaKey) return;
    e.preventDefault();
    const a = box.selectionStart ?? box.value.length, b = box.selectionEnd ?? a;
    box.value = `${box.value.slice(0, a)}\n${box.value.slice(b)}`;
    box.selectionStart = box.selectionEnd = a + 1;
  });
  const checked = lastChecked ?? new Set(WIZARD_OPTIONS.filter(o => o.on).map(o => o.id));
  const checks = WIZARD_OPTIONS.map(o => ({ o, c: check(o.label, checked.has(o.id)) }));
  for (const { o, c } of checks) c.el.title = o.instruction;
  const content = h('div', { class: 'ai-wizard' },
    h('div', { style: 'margin-bottom:4px' }, 'Describe the program you want:'), box,
    h('fieldset', { class: 'ai-wizard-opts', style: 'margin-top:10px' }, h('legend', {}, 'Make it better'),
      h('div', { style: 'display:grid;grid-template-columns:1fr 1fr;gap:2px 16px' }, ...checks.map(x => x.c.el))));
  for (;;) {
    const v = await showDialog98(doc, {
      title: 'AI Wizard', content,
      buttons: [{ label: 'Create', value: 'ok', default: true }, { label: 'Cancel', value: 'cancel', cancel: true }],
    });
    const now = new Set(checks.filter(x => x.c.input.checked).map(x => x.o.id));
    lastChecked = now;
    if (v !== 'ok') return null;
    if (box.value.trim()) return wizardPrompt(box.value, now);
    await messageBox98(doc, { prompt: 'Describe the program first: what it is for and what the user does with it.', title: 'AI Wizard', buttons: 48 });
  }
}
