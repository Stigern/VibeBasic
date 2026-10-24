// The AI Wizard (New Project dialog): the program described in your own words (or started from an example), its look, what to
// add (check boxes) and how much (sliders). Each choice adds a clear instruction to the request, which the dialog shows as it is
// built. The request then goes the usual Ask AI way, in form mode, to the new project's Form1.
import { messageBox98, showDialog98 } from '../ui98/dialogs';
import { h } from '../ui98/dom';
import { check } from '../ide/projectDialogs';
import './wizardDialog.css';

export interface WizardOption { id: string; label: string; instruction: string; on: boolean }

/** What form mode can build (controls, menus, form properties and code); the ones on by default cost the model little. */
export const WIZARD_OPTIONS: readonly WizardOption[] = [
  { id: 'names', label: 'Clear names', on: true,
    instruction: 'Name every control with its VB6 prefix and purpose (txtName, cmdSave, lblTotal).' },
  { id: 'keys', label: 'Enter / Esc keys', on: true,
    instruction: 'Give the captions access keys (&), set a sensible TabIndex order, and make the main button the Default (Enter) and a Close or Cancel button the Cancel (Esc) button.' },
  { id: 'validate', label: 'Check the input', on: true,
    instruction: 'Check what the user types and explain mistakes in a MsgBox; never fail on empty or wrong input.' },
  { id: 'menu', label: 'Menu bar', on: false,
    instruction: 'Add a menu bar: File with Exit, and Edit where it makes sense.' },
  { id: 'status', label: 'Status line', on: false,
    instruction: 'Add a status line (a Label along the bottom of the form) that tells the user what just happened.' },
  { id: 'errors', label: 'Error handling', on: false,
    instruction: 'Use On Error in the event procedures and show a friendly MsgBox when something fails.' },
  { id: 'settings', label: 'Remember settings', on: false,
    instruction: 'Remember the window position and the last values between runs with SaveSetting and GetSetting.' },
  { id: 'resize', label: 'Resizable', on: false,
    instruction: 'Let the form be resized and move or stretch the controls in Form_Resize.' },
  { id: 'confirm', label: 'Ask before closing', on: false,
    instruction: 'Ask before closing when there is unsaved work (Form_QueryUnload).' },
];

export const EXAMPLES: readonly { label: string; text: string }[] = [
  { label: 'Tip calculator', text: 'A tip calculator: the bill, a tip percent and the number of people; it shows the tip and what each person pays.' },
  { label: 'Stopwatch', text: 'A stopwatch with Start, Stop, Lap and Reset; it shows the time in minutes, seconds and hundredths, and a list of laps.' },
  { label: 'To-do list', text: 'A to-do list: type a task and add it, tick tasks off as done, remove the done ones, and keep the list in a file between runs.' },
  { label: 'Guess the number', text: 'Guess the number: the program picks a number from 1 to 100, the player guesses and gets "too high" or "too low", and it counts the guesses.' },
  { label: 'Address book', text: 'An address book: name, phone, e-mail and address, with buttons to add, change, delete and move between the people, kept in a SQLite database.' },
  { label: 'Unit converter', text: 'A unit converter for length, weight and temperature: pick the kind, the from and to units, type a value and see the result at once.' },
];

export const COLOURS = [
  { id: 'classic', label: 'Classic Windows 98', phrase: 'in the classic Windows 98 grey (the default colours)' },
  { id: 'colourful', label: 'Colourful', phrase: 'with a colourful, friendly look (BackColor and ForeColor on the form and its controls)' },
  { id: 'dark', label: 'Dark', phrase: 'with a dark look: a dark BackColor and light ForeColor on the form and its controls' },
  { id: 'pastel', label: 'Pastel', phrase: 'in soft pastel colours (BackColor on the form and its controls)' },
] as const;
export const LANGUAGES = [
  { id: 'en', label: 'English', phrase: 'all texts in English' },
  { id: 'nb', label: 'Norsk', phrase: 'all texts in Norwegian (bokmål)' },
  { id: 'same', label: 'Same as my description', phrase: 'all texts in the language of my description' },
] as const;
export const SIZES = [
  { id: 'small', label: 'Small', phrase: 'A small form (about 4800 x 3600 twips)' },
  { id: 'medium', label: 'Medium', phrase: 'A medium-sized form (about 7200 x 5400 twips)' },
  { id: 'large', label: 'Large', phrase: 'A large form (about 9600 x 7200 twips)' },
] as const;
const FEATURES = [
  'Only the core of the program, as simple as possible.',
  'A small program: the core and nothing extra.',
  'A complete program with the usual extras, not more.',
  'A rich program: add the useful extras a user would expect.',
  'Everything a polished program of this kind would have.',
];
const HELP = [
  '',
  'Give the controls short ToolTipText.',
  'Give the controls short ToolTipText, and add a Help menu with How to use (short instructions in a MsgBox) and About.',
];
const COMMENTS = ['', 'Comment the code briefly.', 'Comment the code so a beginner can follow every step.'];

export interface WizardChoices {
  description: string;
  colours: (typeof COLOURS)[number]['id'];
  language: (typeof LANGUAGES)[number]['id'];
  size: (typeof SIZES)[number]['id'];
  checked: ReadonlySet<string>;
  /** 1 (just the basics) .. 5 (everything). */
  features: number;
  /** 0 none, 1 tooltips, 2 tooltips and a Help menu. */
  help: number;
  /** 0 none, 1 brief, 2 explain all. */
  comments: number;
}

export const defaultChoices = (): WizardChoices => ({
  description: '', colours: 'classic', language: 'en', size: 'medium',
  checked: new Set(WIZARD_OPTIONS.filter(o => o.on).map(o => o.id)), features: 3, help: 1, comments: 1,
});

/** The request: the description, then one instruction per choice (look, scope, the checked options, help, comments). */
export function wizardPrompt(c: WizardChoices): string {
  const pick = <T extends { id: string }>(list: readonly T[], id: string): T => list.find(x => x.id === id) ?? list[0];
  const clamp = (n: number, max: number) => Math.min(max, Math.max(0, Math.round(n)));
  const lines = [
    `${pick(SIZES, c.size).phrase} ${pick(COLOURS, c.colours).phrase}, ${pick(LANGUAGES, c.language).phrase}.`,
    FEATURES[clamp(c.features - 1, FEATURES.length - 1)],
    ...WIZARD_OPTIONS.filter(o => c.checked.has(o.id)).map(o => o.instruction),
    HELP[clamp(c.help, HELP.length - 1)],
    COMMENTS[clamp(c.comments, COMMENTS.length - 1)],
  ].filter(Boolean);
  return `Build this program on the form, with its controls and all of its code: ${c.description.trim()}\n\nAlso:\n${lines.map(l => `- ${l}`).join('\n')}`;
}

/** The choices made last time (this session); the defaults at first. */
let last: WizardChoices | null = null;
let radioSeq = 0;

/** `copy`: puts the request on the clipboard (Copy). */
export async function wizardDialog(doc: Document, o: { copy?: (text: string) => Promise<void> } = {}): Promise<string | null> {
  const c: WizardChoices = { ...(last ?? defaultChoices()) };
  const checked = new Set(c.checked);

  const select = (items: readonly { id: string; label: string }[], value: string) => {
    const s = h('select', {}, ...items.map(i => h('option', { value: i.id }, i.label)));
    s.value = value;
    return s;
  };
  const row = (label: string, ...kids: (Node | string)[]) => h('div', { class: 'aiw-row' }, h('label', { class: 'aiw-key' }, label), ...kids);

  // the description, or an example to start from
  const example = h('select', {}, h('option', { value: '' }, '(none)'), ...EXAMPLES.map((e, i) => h('option', { value: String(i) }, e.label)));
  const box = h('textarea', { class: 'ai-prompt aiw-desc', rows: '4', 'data-autofocus': '', placeholder: EXAMPLES[0].text });
  box.value = c.description;
  example.addEventListener('change', () => { const e = EXAMPLES[Number(example.value)]; if (e) { box.value = e.text; update(); box.focus(); } });
  // Enter inserts a line break (the dialog would otherwise press Create); Ctrl+Enter presses Create
  box.addEventListener('keydown', e => {
    if (e.key !== 'Enter' || e.ctrlKey || e.metaKey) return;
    e.preventDefault();
    const a = box.selectionStart ?? box.value.length, b = box.selectionEnd ?? a;
    box.value = `${box.value.slice(0, a)}\n${box.value.slice(b)}`;
    box.selectionStart = box.selectionEnd = a + 1;
    update();
  });

  // look
  const colours = select(COLOURS, c.colours), language = select(LANGUAGES, c.language);
  const group = `aiw-size-${++radioSeq}`;
  const sizes = SIZES.map(s => {
    const id = `${group}-${s.id}`;
    const input = h('input', { type: 'radio', id, name: group, value: s.id, checked: s.id === c.size });
    return { s, input, el: h('span', {}, input, h('label', { for: id }, s.label)) };
  });

  // what to add
  const checks = WIZARD_OPTIONS.map(w => ({ w, c: check(w.label, checked.has(w.id)) }));
  for (const { w, c: ch } of checks) ch.el.title = w.instruction;

  // how much
  const slider = (label: string, lo: string, hi: string, min: number, max: number, value: number) => {
    const input = h('input', { type: 'range', min: String(min), max: String(max), step: '1', value: String(value), 'aria-label': label });
    return { input, el: h('div', { class: 'aiw-slider' }, h('label', {}, label), h('span', { class: 'aiw-lo' }, lo), input, h('span', { class: 'aiw-hi' }, hi)) };
  };
  const features = slider('Features:', 'Just the basics', 'Everything', 1, 5, c.features);
  const help = slider('Help for the user:', 'None', 'Tooltips + Help', 0, 2, c.help);
  const comments = slider('Code comments:', 'None', 'Explain all', 0, 2, c.comments);

  // the request as it will be sent
  const preview = h('div', { class: 'aiw-preview', 'aria-live': 'polite' });
  const copy = h('button', { type: 'button' }, 'Copy');
  copy.addEventListener('click', () => { void o.copy?.(wizardPrompt(read())).catch(() => {}); });

  const read = (): WizardChoices => ({
    description: box.value,
    colours: colours.value as WizardChoices['colours'], language: language.value as WizardChoices['language'],
    size: (sizes.find(x => x.input.checked)?.s.id ?? 'medium') as WizardChoices['size'],
    checked: new Set(checks.filter(x => x.c.input.checked).map(x => x.w.id)),
    features: Number(features.input.value), help: Number(help.input.value), comments: Number(comments.input.value),
  });
  const update = () => {
    const r = read();
    preview.textContent = r.description.trim() ? wizardPrompt(r) : 'Describe the program above; the request shows here.';
  };

  const content = h('div', { class: 'aiw' },
    h('div', { class: 'aiw-row' }, h('label', {}, 'Start from an example:'), example),
    h('div', { class: 'aiw-label' }, 'Describe the program you want:'), box,
    h('div', { class: 'aiw-cols' },
      h('fieldset', {}, h('legend', {}, 'Look'),
        row('Colours:', colours), row('Texts in:', language), row('Form size:', h('span', { class: 'aiw-radios' }, ...sizes.map(x => x.el)))),
      h('fieldset', {}, h('legend', {}, 'Make it better'), h('div', { class: 'aiw-checks' }, ...checks.map(x => x.c.el)))),
    h('fieldset', {}, h('legend', {}, 'How much'), features.el, help.el, comments.el),
    h('fieldset', {}, h('legend', {}, 'The request the AI gets'), preview, h('div', { class: 'aiw-copy' }, copy)));
  content.addEventListener('input', update);
  content.addEventListener('change', update);
  update();

  for (;;) {
    const v = await showDialog98(doc, {
      title: 'AI Wizard', content,
      buttons: [{ label: 'Create', value: 'ok', default: true }, { label: 'Cancel', value: 'cancel', cancel: true }],
    });
    last = read();
    if (v !== 'ok') return null;
    if (last.description.trim()) return wizardPrompt(last);
    await messageBox98(doc, { prompt: 'Describe the program first: what it is for and what the user does with it.', title: 'AI Wizard', buttons: 48 });
  }
}
