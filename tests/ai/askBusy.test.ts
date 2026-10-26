// @vitest-environment jsdom
// Review finding 11: from OK in the prompt to the first waiting dialog a modal dialog is up, and the IDE is busy
// (no program start, no second Ask AI) for the whole conversation.
import { afterEach, expect, test, vi } from 'vitest';
import { askAi } from '../../src/ai/askDialog';
import type { Backend } from '../../src/backend/backend';
import { IdeState } from '../../src/ide/ideState';
import { newProject } from '../../src/model/controls';

const btn = (label: string) => [...document.querySelectorAll<HTMLButtonElement>('.dlg98 button')].find(b => b.textContent === label);
const click = (label: string) => btn(label)!.click();
const text = () => [...document.querySelectorAll('.dlg98')].map(d => d.textContent).join('|');
afterEach(() => { document.body.innerHTML = ''; });

let server = 0;
function setup() {
  const url = `http://x${server++}/v1`;   // detection runs once per server and session
  const s = new IdeState(newProject());
  const f = s.project.forms[0];
  f.code = 'Private Sub Form_Load()\nEnd Sub';
  s.setActiveView({ kind: 'code', itemId: f.id });
  const w = { src: f.code, getSource: () => w.src, getCursorLine: () => 1, applyChange: vi.fn() };
  let listed!: (v: unknown[]) => void;
  const b = {
    // a fresh setup: the server kind and vision are not known yet, and the server is slow to list its models
    loadSettings: async () => ({ baseUrl: url, model: 'm', apiKey: '' }),
    saveSettings: async () => {},
    aiListModels: vi.fn(() => new Promise<unknown[]>(r => { listed = r; })),
    aiChat: vi.fn(() => new Promise<string>(() => {})),
  } as unknown as Backend & { aiChat: ReturnType<typeof vi.fn> };
  return { s, w, b, list: (v: unknown[] = []) => listed(v) };
}
async function enterPrompt() {
  await vi.waitFor(() => expect(document.querySelector('.ai-prompt')).toBeTruthy());
  (document.querySelector('.ai-prompt') as HTMLTextAreaElement).value = 'x';
  click('Ask AI');
}

test('a modal dialog covers the server detection, and the IDE is busy: no second Ask AI', async () => {
  const { s, w, b, list } = setup();
  const p = askAi(s, b, { codeWindowFor: () => w as never });
  expect(s.busy).toBe(true);
  await enterPrompt();
  await vi.waitFor(() => expect(text()).toContain('Connecting to m...'));
  // a second Ask AI (Ctrl+I) does nothing
  await askAi(s, b, { codeWindowFor: () => w as never });
  expect(document.querySelectorAll('.ai-prompt')).toHaveLength(0);
  list();
  await vi.waitFor(() => expect(b.aiChat).toHaveBeenCalledTimes(1));
  expect(text()).not.toContain('Connecting');   // the waiting dialog took over
  expect(s.busy).toBe(true);
  click('Cancel');
  await p;
  expect(s.busy).toBe(false);
});

test('Cancel during the detection sends nothing; a change of mode meanwhile stops the request too', async () => {
  const a = setup();
  const p = askAi(a.s, a.b, { codeWindowFor: () => a.w as never });
  await enterPrompt();
  await vi.waitFor(() => expect(text()).toContain('Connecting'));
  click('Cancel');
  await p;
  expect(a.b.aiChat).not.toHaveBeenCalled();
  expect(a.s.busy).toBe(false);

  const c = setup();
  const q = askAi(c.s, c.b, { codeWindowFor: () => c.w as never });
  await enterPrompt();
  await vi.waitFor(() => expect(text()).toContain('Connecting'));
  c.s.setMode('run');   // e.g. from the app's native menu
  c.list();
  await q;
  expect(c.b.aiChat).not.toHaveBeenCalled();
  expect(document.querySelector('.dlg98')).toBeNull();
});
