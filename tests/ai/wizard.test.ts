// @vitest-environment jsdom
import { beforeEach, expect, test } from 'vitest';
import { WIZARD_OPTIONS, wizardDialog, wizardPrompt } from '../../src/ai/wizardDialog';

const flush = () => new Promise(r => setTimeout(r, 0));
const press = (label: string) => [...document.querySelectorAll<HTMLButtonElement>('.dlg98 button')].find(b => b.textContent === label)!.click();
const boxes = () => [...document.querySelectorAll<HTMLInputElement>('.ai-wizard input[type=checkbox]')];

beforeEach(() => { document.body.replaceChildren(); });

test('the request: the description, then the checked improvements in their order', () => {
  expect(wizardPrompt('  A tip calculator ', new Set())).toBe('Build this program on the form, with its controls and all of its code: A tip calculator');
  const p = wizardPrompt('A tip calculator', new Set(['menu', 'names']));
  const names = WIZARD_OPTIONS.find(o => o.id === 'names')!.instruction, menu = WIZARD_OPTIONS.find(o => o.id === 'menu')!.instruction;
  expect(p).toBe(`Build this program on the form, with its controls and all of its code: A tip calculator\n\nAlso:\n- ${names}\n- ${menu}`);
});

test('the dialog: the defaults are checked, Create needs a description, the choices are kept for next time', async () => {
  let r = wizardDialog(document);
  expect(boxes().map(b => b.checked)).toEqual(WIZARD_OPTIONS.map(o => o.on));
  press('Create'); await flush();
  expect(document.querySelector('.dlg98:last-of-type')!.textContent).toContain('Describe the program first');
  press('OK'); await flush(); await flush();
  document.querySelector<HTMLTextAreaElement>('.ai-wizard textarea')!.value = 'A stopwatch';
  const menu = boxes()[WIZARD_OPTIONS.findIndex(o => o.id === 'menu')];
  menu.checked = true;
  press('Create');
  const text = await r;
  expect(text).toContain('A stopwatch');
  expect(text).toContain(WIZARD_OPTIONS.find(o => o.id === 'menu')!.instruction);

  r = wizardDialog(document);
  expect(boxes()[WIZARD_OPTIONS.findIndex(o => o.id === 'menu')].checked).toBe(true);   // kept
  press('Cancel');
  expect(await r).toBeNull();
});
