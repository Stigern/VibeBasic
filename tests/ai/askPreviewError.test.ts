// @vitest-environment jsdom
import { expect, test, vi } from 'vitest';
import { askAi } from '../../src/ai/askDialog';
import type { Backend } from '../../src/backend/backend';
import { IdeState } from '../../src/ide/ideState';
import { newControl, newProject } from '../../src/model/controls';

vi.mock('../../src/ai/formMode', async orig => ({
  ...(await orig<typeof import('../../src/ai/formMode')>()),
  applyFormOpsToClone: () => { throw new Error('preview boom'); },
}));

const btn = (label: string) => [...document.querySelectorAll<HTMLButtonElement>('.dlg98 button')].find(b => b.textContent === label);

test('a failing preview shows the not-understood dialog with the error in Details', async () => {
  const s = new IdeState(newProject());
  const f = s.project.forms[0];
  f.controls.push(newControl(f, 'CommandButton', { left: 100, top: 100 }, null));
  s.setActiveView({ kind: 'designer', formId: f.id });
  const backend = {
    loadSettings: async () => ({ baseUrl: 'http://x/v1', model: 'm', apiKey: '' }),
    aiChat: async () => '{"ops":[{"op":"delete","name":"Command1"}]}',
  } as unknown as Backend;
  const p = askAi(s, backend, { codeWindowFor: () => null });
  await vi.waitFor(() => expect(btn('OK')).toBeTruthy());
  (document.querySelector('.ai-prompt') as HTMLTextAreaElement).value = 'x';
  btn('OK')!.click();
  await vi.waitFor(() => expect(btn('Details...')).toBeTruthy());
  btn('Details...')!.click();
  await vi.waitFor(() => expect((document.querySelector('.ai-details') as HTMLTextAreaElement)?.value).toContain('preview boom'));
  btn('OK')!.click();
  await vi.waitFor(() => expect(btn('Details...')).toBeTruthy());
  btn('OK')!.click();
  await p;
  expect(s.project.forms[0].controls).toHaveLength(1);
});
