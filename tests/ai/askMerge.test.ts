// @vitest-environment jsdom
// A merge that would break the module is never previewed or applied: one retry, then "not understood" with the reason in Details.
import { afterEach, expect, test, vi } from 'vitest';
import { askAi } from '../../src/ai/askDialog';
import type { Backend } from '../../src/backend/backend';
import { IdeState } from '../../src/ide/ideState';
import { newProject } from '../../src/model/controls';

const btn = (label: string) => [...document.querySelectorAll<HTMLButtonElement>('.dlg98 button')].find(b => b.textContent === label);
const click = (label: string) => btn(label)!.click();
const text = () => [...document.querySelectorAll('.dlg98')].map(d => d.textContent).join('|');
afterEach(() => { document.body.innerHTML = ''; });

test('a merge that would declare a name twice: retried once, then not understood, with the reason under Details', async () => {
  const s = new IdeState(newProject());
  const f = s.project.forms[0];
  const src = 'Dim a, b\n\nPrivate Sub Form_Load()\nEnd Sub';
  f.code = src;
  s.setActiveView({ kind: 'code', itemId: f.id });
  const w = { src, getSource: () => w.src, getCursorLine: () => 3, applyChange: vi.fn() };
  const reply = '```vb\nDim a As Long\nPrivate Sub Form_Load()\n    a = 1\nEnd Sub\n```';
  const b = {
    loadSettings: async () => ({ baseUrl: 'http://x/v1', model: 'm', apiKey: '', serverKind: 'openai', vision: false }),
    saveSettings: async () => {}, aiListModels: async () => [],
    aiChat: vi.fn(async () => reply),
  } as unknown as Backend & { aiChat: ReturnType<typeof vi.fn> };
  const p = askAi(s, b, { codeWindowFor: () => w as never });
  await vi.waitFor(() => expect(btn('OK')).toBeTruthy());
  (document.querySelector('.ai-prompt') as HTMLTextAreaElement).value = 'x';
  click('OK');
  await vi.waitFor(() => expect(text()).toContain('could not be understood'));
  expect(b.aiChat).toHaveBeenCalledTimes(2);
  expect(b.aiChat.mock.calls[1][3].at(-1).content).toContain('would declare a twice');
  click('Details...');
  await vi.waitFor(() => expect(document.querySelector<HTMLTextAreaElement>('.ai-details')?.value).toContain('would declare a twice'));
  click('OK');
  await vi.waitFor(() => expect(btn('Details...')).toBeTruthy());
  click('OK');
  await p;
  expect(w.applyChange).not.toHaveBeenCalled();
  expect(text()).not.toContain('AI Suggestion');
});
