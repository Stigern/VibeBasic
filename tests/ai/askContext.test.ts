// @vitest-environment jsdom
import { afterEach, expect, test, vi } from 'vitest';
import { askAi, formPictures } from '../../src/ai/askDialog';
import { requestDialogImages } from '../../src/ai/requestDialog';
import { IdeState } from '../../src/ide/ideState';
import { newProject } from '../../src/model/controls';
import type { Backend } from '../../src/backend/backend';
import type { ChatMessage } from '../../src/ai/types';

const FORM = 'data:image/png;base64,form', REF = 'data:image/png;base64,ref';
const GOOD = 'Changed the message.\n```vb\nPrivate Sub Form_Load()\n    MsgBox "New"\nEnd Sub\n```';
let id = 0;
const button = (label: string) => [...document.querySelectorAll<HTMLButtonElement>('.dlg98 button')].find(b => b.textContent === label)!;
const checkbox = (label: string) => document.getElementById([...document.querySelectorAll('label')].find(l => l.textContent === label)!.htmlFor) as HTMLInputElement;
const images = (msgs: ChatMessage[]) => msgs.flatMap(m => typeof m.content === 'string' ? [] : m.content.filter(p => p.type === 'image_url').map(p => p.type === 'image_url' ? p.image_url.url : ''));
function setup(mode: 'code' | 'designer', replies: (string | Error)[], off = false) {
  const ide = new IdeState(newProject());
  const f = ide.project.forms[0];
  f.code = 'Private Sub Form_Load()\n    MsgBox "Old"\nEnd Sub';
  ide.setActiveView(mode === 'code' ? { kind: 'code', itemId: f.id } : { kind: 'designer', formId: f.id });
  const win = { src: f.code, getSource: () => win.src, getCursorLine: () => 2,
    getSelection: () => ({ from: f.code.indexOf('MsgBox'), to: f.code.indexOf('MsgBox') + 12, text: 'MsgBox "Old"' }),
    applyChange: (_a: number, _b: number, source: string) => { win.src = source; } };
  const settings = { baseUrl: 'http://x/v1', model: `context-${++id}`, serverKind: 'openai', vision: true, ...(off ? { formPicture: 'off' } : {}) };
  const backend = { loadSettings: async () => settings, saveSettings: vi.fn(), aiListModels: vi.fn(async () => []),
    aiChat: vi.fn(async () => { const reply = replies.shift()!; if (reply instanceof Error) throw reply; return reply; }) } as unknown as Backend & { aiChat: ReturnType<typeof vi.fn>; saveSettings: ReturnType<typeof vi.fn> };
  vi.spyOn(formPictures, 'render').mockResolvedValue(FORM);
  vi.spyOn(requestDialogImages, 'load').mockResolvedValue({ name: 'desired.png', url: REF });
  return { ide, backend, win, start: () => askAi(ide, backend, { codeWindowFor: () => win as any }) };
}
async function draft() {
  await vi.waitFor(() => expect(document.querySelector('.ai-prompt')).toBeTruthy());
  (document.querySelector('.ai-prompt') as HTMLTextAreaElement).value = 'Update this';
}
async function attach() { await vi.waitFor(() => expect(button('Add reference image...').disabled).toBe(false)); button('Add reference image...').click(); await vi.waitFor(() => expect(document.querySelector('.ai-reference')).toBeTruthy()); }
async function preview() { await vi.waitFor(() => expect(button('Change...')).toBeTruthy()); }
afterEach(() => { document.body.innerHTML = ''; vi.restoreAllMocks(); });

test('code requests carry chosen form and reference images with roles and show requested explanation', async () => {
  const s = setup('code', [GOOD]); const p = s.start(); await draft();
  checkbox('Include form picture (schematic)').click();
  checkbox('Explain the changes').click();
  await attach(); button('Ask AI').click(); await preview();
  const sent = s.backend.aiChat.mock.calls[0][3] as ChatMessage[];
  expect(images(sent)).toEqual([FORM, REF]);
  expect(JSON.stringify(sent)).toContain('Current form');
  expect(JSON.stringify(sent)).toContain('Desired appearance reference 1');
  expect(document.querySelector('.ai-explanation')?.textContent).toContain('Changed the message.');
  button('Cancel').click(); await p;
  expect(s.backend.saveSettings).not.toHaveBeenCalled();
});
test('unfenced VB is not repeated as an explanation', async () => {
  const s = setup('code', ['Private Sub Form_Load()\n    MsgBox "New"\nEnd Sub']);
  const p = s.start(); await draft(); checkbox('Explain the changes').click();
  button('Ask AI').click(); await preview();
  expect(document.querySelector('.ai-after')?.textContent).toContain('MsgBox "New"');
  expect(document.querySelector('.ai-explanation')).toBeNull();
  button('Cancel').click(); await p;
});
test('reference images work when the saved form-picture preference is off', async () => {
  const s = setup('code', [GOOD], true); const p = s.start(); await draft(); await attach();
  button('Ask AI').click(); await preview();
  expect(images(s.backend.aiChat.mock.calls[0][3])).toEqual([REF]);
  button('Cancel').click(); await p;
  expect(s.backend.saveSettings).not.toHaveBeenCalled();
});
test('a lower server image limit names every omitted attachment', async () => {
  const s = setup('code', [new Error('The AI server answered 400: at most 1 image is supported'), GOOD]);
  const p = s.start(); await draft(); checkbox('Include form picture (schematic)').click(); await attach();
  button('Ask AI').click(); await preview();
  expect(images(s.backend.aiChat.mock.calls[0][3])).toEqual([FORM, REF]);
  expect(images(s.backend.aiChat.mock.calls[1][3])).toEqual([REF]);
  expect(document.querySelector('.ai-image-warning')?.textContent).toContain('form picture');
  button('Cancel').click(); await p;
});
test('identical current and reference image bytes still identify which role was omitted', async () => {
  const s = setup('code', [new Error('The AI server answered 400: at most 1 image is supported'), GOOD]);
  vi.mocked(requestDialogImages.load).mockResolvedValueOnce({ name: 'same-as-form.png', url: FORM });
  const p = s.start(); await draft(); checkbox('Include form picture (schematic)').click(); await attach();
  button('Ask AI').click(); await preview();
  const warnings = [...document.querySelectorAll('.ai-image-warning')].map(el => el.textContent).join(' ');
  expect(warnings).toContain('form picture');
  expect(warnings).not.toContain('same-as-form.png');
  button('Cancel').click(); await p;
});
test('unchecking the form image also keeps layout-repair requests reference-only', async () => {
  const bad = JSON.stringify({ ops: [{ op: 'add', type: 'CommandButton', name: 'cmdTest', props: { Left: 240, Top: 240, Width: 10, Height: 10 } }] });
  const fixed = JSON.stringify({ ops: [{ op: 'add', type: 'CommandButton', name: 'cmdTest', props: { Left: 240, Top: 240, Width: 1200, Height: 400 } }] });
  const s = setup('designer', [bad, fixed], true); const p = s.start(); await draft(); await attach();
  button('Ask AI').click(); await preview();
  expect(s.backend.aiChat).toHaveBeenCalledTimes(2);
  for (const call of s.backend.aiChat.mock.calls) expect(images(call[3])).toEqual([REF]);
  button('Cancel').click(); await p;
});
test('form references survive repair and Change; explanation is shown separately from code', async () => {
  const reply = (invalid: boolean) => JSON.stringify({ ops: [{ op: 'form', props: { Caption: 'Updated', ...(invalid ? { BadProperty: 1 } : {}) } }], explanation: 'Updated the caption.' });
  const s = setup('designer', [reply(true), reply(false), reply(false)]); const p = s.start(); await draft();
  checkbox('Explain the changes').click(); await attach(); button('Ask AI').click(); await preview();
  expect(document.querySelector('.ai-explanation')?.textContent).toContain('Updated the caption.');
  button('Change...').click();
  await vi.waitFor(() => expect(document.querySelector('.ai-change')).toBeTruthy());
  (document.querySelector('.ai-change') as HTMLInputElement).value = 'Keep the caption'; button('OK').click();
  await preview();
  expect(s.backend.aiChat).toHaveBeenCalledTimes(3);
  for (const call of s.backend.aiChat.mock.calls) expect(images(call[3])).toContain(REF);
  expect(s.backend.aiChat.mock.calls[0][5].responseFormat.json_schema.schema.properties.explanation).toEqual({ type: 'string' });
  button('Cancel').click(); await p;
});
test('image rejection is disclosed with the omitted reference name before acceptance', async () => {
  const s = setup('code', [new Error('The AI server answered 400: image input is not supported'), GOOD]);
  const p = s.start(); await draft(); await attach(); button('Ask AI').click(); await preview();
  expect(images(s.backend.aiChat.mock.calls[1][3])).toEqual([]);
  expect(document.querySelector('.ai-image-warning')?.textContent).toContain('desired.png');
  button('Cancel').click(); await p;
});
test('procedure scope drops selection targeting and replaces a bare reply into the whole procedure', async () => {
  const s = setup('code', ['```vb\n    MsgBox "New"\n```']); const p = s.start(); await draft();
  const scope = document.querySelector('.ai-scope') as HTMLSelectElement; scope.value = 'procedure'; scope.dispatchEvent(new Event('change'));
  button('Ask AI').click(); await preview(); button('OK').click(); await p;
  expect(s.win.src).toContain('Private Sub Form_Load()\n    MsgBox "New"\nEnd Sub');
  expect(s.win.src).not.toContain('Old');
  expect(JSON.stringify(s.backend.aiChat.mock.calls[0][3])).not.toContain('Selected code (the request is about this)');
});
test('file scope never inserts bare body code into the cursor procedure', async () => {
  const s = setup('code', ['```vb\n    MsgBox "New"\n```', '```vb\n    MsgBox "New"\n```']); const p = s.start(); await draft();
  (document.querySelector('.ai-scope') as HTMLSelectElement).value = 'file';
  button('Ask AI').click();
  await vi.waitFor(() => expect(document.querySelector('.dlg98')?.textContent).toContain('could not be understood'));
  button('OK').click(); await p;
  expect(s.win.src).toContain('Old');
});
