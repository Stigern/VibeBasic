// @vitest-environment jsdom
import { beforeEach, expect, test, vi } from 'vitest';
import { defaultChoices, EXAMPLES, WIZARD_OPTIONS, wizardDialog, wizardPrompt } from '../../src/ai/wizardDialog';

const flush = () => new Promise(r => setTimeout(r, 0));
const press = (label: string) => [...document.querySelectorAll<HTMLButtonElement>('.dlg98 button')].find(b => b.textContent === label)!.click();
const $ = <T extends Element>(sel: string) => document.querySelector<T>(sel)!;
const preview = () => $('.aiw-preview').textContent!;
const set = (el: HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement, value: string, ev = 'change') => { el.value = value; el.dispatchEvent(new Event(ev, { bubbles: true })); };
const sliders = () => [...document.querySelectorAll<HTMLInputElement>('.aiw-slider input')];

beforeEach(() => { document.body.replaceChildren(); });

test('the request: the description, then the look, the scope, the checked options, help and comments', () => {
  const c = { ...defaultChoices(), description: '  A tip calculator ' };
  expect(wizardPrompt(c)).toBe([
    'Build this program on the form, with its controls and all of its code: A tip calculator', '', 'Also:',
    '- A medium-sized form (about 7200 x 5400 twips) in the classic Windows 98 grey (the default colours), all texts in English.',
    '- A complete program with the usual extras, not more.',
    ...WIZARD_OPTIONS.filter(o => o.on).map(o => `- ${o.instruction}`),
    '- Give the controls short ToolTipText.',
    '- Comment the code briefly.',
  ].join('\n'));
  const p = wizardPrompt({ ...c, colours: 'dark', language: 'nb', size: 'large', checked: new Set(['menu']), features: 1, help: 0, comments: 0 });
  expect(p).toContain('A large form');
  expect(p).toContain('a dark BackColor and light ForeColor');
  expect(p).toContain('Norwegian (bokmål)');
  expect(p).toContain('Only the core of the program');
  expect(p).toContain(WIZARD_OPTIONS.find(o => o.id === 'menu')!.instruction);
  expect(p).not.toContain('ToolTipText');
  expect(p).not.toContain('Comment the code');
  expect(wizardPrompt({ ...c, help: 2, comments: 2, features: 5 })).toMatch(/Help menu with How to use[\s\S]*every step[\s\S]*|Everything a polished/);
});

test('the dialog: an example fills the description, the request shows as it changes, Create needs a description, Copy', async () => {
  const copy = vi.fn(async (_t: string) => {});
  let r = wizardDialog(document, { copy });
  expect(preview()).toContain('Describe the program above');
  press('Create'); await flush();
  expect($('.dlg98').textContent).toContain('Describe the program first');   // the wizard closed; it comes back after OK
  press('OK'); await flush(); await flush();

  set($<HTMLSelectElement>('.aiw-row select'), '1');   // Stopwatch
  expect($<HTMLTextAreaElement>('.aiw-desc').value).toBe(EXAMPLES[1].text);
  expect(preview()).toContain('A stopwatch with Start, Stop');
  set(sliders()[0], '5', 'input');
  expect(preview()).toContain('Everything a polished program');
  const radio = [...document.querySelectorAll<HTMLInputElement>('.aiw-radios input')].find(i => i.value === 'small')!;
  radio.checked = true; radio.dispatchEvent(new Event('change', { bubbles: true }));
  expect(preview()).toContain('A small form');
  press('Copy'); await flush();
  expect(copy).toHaveBeenCalledWith(preview());
  const shown = preview();
  press('Create');
  expect(await r).toBe(shown);   // what the dialog showed is what is sent

  r = wizardDialog(document);   // the choices are kept for next time
  expect($<HTMLTextAreaElement>('.aiw-desc').value).toBe(EXAMPLES[1].text);
  expect(sliders()[0].value).toBe('5');
  press('Cancel');
  expect(await r).toBeNull();
});

test('choosing no example keeps the description the user typed', async () => {
  const result = wizardDialog(document);
  set($<HTMLTextAreaElement>('.aiw-desc'), 'My own program', 'input');
  set($<HTMLSelectElement>('.aiw-row select'), '');
  expect($<HTMLTextAreaElement>('.aiw-desc').value).toBe('My own program');
  expect(preview()).toContain('My own program');
  press('Cancel');
  await result;
});
