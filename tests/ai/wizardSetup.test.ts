// @vitest-environment jsdom
import { afterEach, expect, test, vi } from 'vitest';
import { askAi } from '../../src/ai/askDialog';
import { registerAiOptionsTab } from '../../src/ai/optionsTab';
import { wizardDialog } from '../../src/ai/wizardDialog';
import { optionsTabs } from '../../src/ide/optionsDialog';
import { IdeState } from '../../src/ide/ideState';
import { BrowserBackend } from '../../src/backend/browserBackend';

const press = (label: string) => [...document.querySelectorAll<HTMLButtonElement>('.dlg98 button')].find(b => b.textContent === label)!.click();
afterEach(() => { optionsTabs.length = 0; document.body.replaceChildren(); });

test('the wizard continues after AI setup has finished saving the model', async () => {
  const backend = new BrowserBackend();
  const store = new Map<string, unknown>();
  vi.spyOn(backend, 'loadSettings').mockImplementation(async key => store.get(key) as never ?? null);
  vi.spyOn(backend, 'saveSettings').mockImplementation(async (key, value) => {
    // The desktop backend writes asynchronously; Options must wait before continuing.
    await new Promise(r => setTimeout(r, 20));
    store.set(key, value);
  });
  vi.spyOn(backend, 'aiListModels').mockResolvedValue([]);
  const chat = vi.spyOn(backend, 'aiChat').mockImplementation(() => new Promise(() => {}));
  registerAiOptionsTab(backend);
  const ide = new IdeState();
  ide.setActiveView({ kind: 'designer', formId: ide.project.forms[0].id });
  const request = askAi(ide, backend, { codeWindowFor: () => null }, document, { prompt: () => wizardDialog(document) });
  const box = document.querySelector<HTMLTextAreaElement>('.aiw-desc')!;
  box.value = 'A calculator';
  press('Create');
  await vi.waitFor(() => expect(document.querySelector('.dlg98')!.textContent).toContain('Set up the AI server'));
  press('OK');
  await vi.waitFor(() => expect(document.querySelector('.cb98-input')).not.toBeNull());
  const model = document.querySelector<HTMLInputElement>('.cb98-input')!;
  model.value = 'local-model';
  model.dispatchEvent(new Event('change', { bubbles: true }));
  press('OK');
  await vi.waitFor(() => expect(document.querySelector('.ai-wait-label')).not.toBeNull());
  expect(store.get('ai')).toMatchObject({ model: 'local-model' });
  expect(ide.busy).toBe(true);
  expect(chat).toHaveBeenCalledOnce();
  press('Cancel');
  await request;
  expect(ide.busy).toBe(false);
});
