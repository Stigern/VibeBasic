// @vitest-environment jsdom
import { afterEach, expect, test, vi } from 'vitest';
import { IdeState } from '../../src/ide/ideState';
import { showComponents } from '../../src/ide/projectDialogs';
import { createToolbox } from '../../src/ide/toolbox';
import { addControlsCmd } from '../../src/model/commands';
import { newControl } from '../../src/model/controls';

afterEach(() => { document.body.innerHTML = ''; });

const overlays = () => [...document.querySelectorAll<HTMLElement>('.dlg98-overlay')];
const press = (label: string) => {
  const top = overlays()[overlays().length - 1];
  [...top.querySelectorAll<HTMLButtonElement>('button')].find(b => b.textContent === label)!.click();
};

test('the Toolbox follows Project > Components; unchecking a component in use is refused and stays checked', async () => {
  const ide = new IdeState();
  const host = document.createElement('div');
  document.body.appendChild(host);
  createToolbox(host, ide, () => {});
  const tools = () => [...host.querySelectorAll<HTMLElement>('.tbx98-btn')].map(b => b.dataset.tool);
  expect(tools()).toHaveLength(20);
  expect(tools()).not.toContain('SSTab');

  const done = showComponents(ide, document);
  const box = (file: string) => document.querySelector<HTMLInputElement>(`.cmp98-list input[data-file="${file}"]`)!;
  expect(document.querySelector('.cmp98-info')!.textContent).toContain('Location: C:\\PROGRAM FILES\\MICROSOFT OFFICE\\OFFICE\\MSCAL.OCX');   // the first one, by name
  box('TABCTL32.OCX').click();
  press('Apply');                                   // applies at once, the dialog stays open
  await vi.waitFor(() => expect(overlays()).toHaveLength(1));
  expect(ide.project.components).toEqual(['TABCTL32.OCX']);
  expect(tools()[tools().length - 1]).toBe('SSTab');

  const f = ide.project.forms[0];
  ide.stack.execute(addControlsCmd(f.id, [newControl(f, 'SSTab', { left: 0, top: 0 }, null)]));
  box('TABCTL32.OCX').click();
  expect(box('TABCTL32.OCX').checked).toBe(false);
  press('OK');
  await vi.waitFor(() => expect(document.body.textContent).toContain("Can't remove control or reference; in use"));
  press('OK');                                      // the message box; the Components dialog comes back
  await vi.waitFor(() => expect(box('TABCTL32.OCX')?.checked).toBe(true));
  expect(ide.project.components).toEqual(['TABCTL32.OCX']);
  press('Cancel');
  await done;
  expect(tools()).toContain('SSTab');
});
