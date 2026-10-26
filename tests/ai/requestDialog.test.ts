// @vitest-environment jsdom
import { afterEach, expect, test, vi } from 'vitest';
import { showRequestDialog, requestDialogImages } from '../../src/ai/requestDialog';
import { newProject } from '../../src/model/controls';

const form = () => newProject().forms[0];
const button = (text: string) => [...document.querySelectorAll<HTMLButtonElement>('.dlg98 button')].find(b => b.textContent === text)!;
const checkbox = (label: string) => {
  const el = [...document.querySelectorAll('label')].find(l => l.textContent === label)!;
  return document.getElementById(el.htmlFor) as HTMLInputElement;
};
const prompt = () => { (document.querySelector('.ai-prompt') as HTMLTextAreaElement).value = 'Improve this'; };
const options = () => ({ itemName: 'Form1', form: form(), codeMode: true, selection: 'x = 1', procName: 'Form_Load',
  vision: true as boolean | undefined, formPictureDefault: true, backend: {} as any, renderFormPicture: vi.fn(async () => 'data:image/png;base64,form') });
afterEach(() => { document.body.innerHTML = ''; vi.restoreAllMocks(); });

test('code defaults to the selection without a form picture and exposes the sent context', async () => {
  const o = options();
  const p = showRequestDialog(document, o);
  expect((document.querySelector('.ai-scope') as HTMLSelectElement).value).toBe('selection');
  expect(checkbox('Include form picture (schematic)').checked).toBe(false);
  expect(document.querySelector('.ai-context-summary')?.textContent).toContain('Selected code');
  expect(document.querySelector('.ai-context-detail-lines')?.textContent).toContain('Control names and properties');
  prompt(); button('Ask AI').click();
  expect(await p).toMatchObject({ prompt: 'Improve this', scope: 'selection', formPicture: null, references: [] });
  expect(o.renderFormPicture).not.toHaveBeenCalled();
});
test('compact context details are collapsed and keyboard accessible without submitting', async () => {
  const p = showRequestDialog(document, { ...options(), model: 'qwen-example' });
  const details = document.querySelector('.ai-context-details') as HTMLDetailsElement;
  expect(details?.open).toBe(false);
  const toggle = details.querySelector('summary')!;
  expect(toggle.tabIndex).toBe(0);
  toggle.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }));
  expect(details.open).toBe(true);
  expect(document.querySelector('.ai-model-status')?.textContent).toContain('qwen-example');
  expect(document.querySelector('.ai-shortcut-hint')?.textContent).toContain('Enter');
  button('Cancel').click(); await p;
});
test('image viewer closes back to the unchanged request draft', async () => {
  vi.spyOn(requestDialogImages, 'load').mockResolvedValue({ name: 'reference.png', url: 'data:image/png;base64,ref' });
  const p = showRequestDialog(document, options()); prompt();
  button('Add reference image...').click();
  await vi.waitFor(() => expect(document.querySelector('.ai-reference')).toBeTruthy());
  const open = document.querySelector<HTMLButtonElement>('.ai-reference .ai-image-open')!;
  expect(open.getAttribute('aria-label')).toContain('reference.png');
  open.click();
  await vi.waitFor(() => expect(document.querySelector('.ai-image-preview img')).toBeTruthy());
  button('Close').click();
  await vi.waitFor(() => expect(document.querySelector('.ai-image-preview')).toBeNull());
  expect((document.querySelector('.ai-prompt') as HTMLTextAreaElement).value).toBe('Improve this');
  expect(document.querySelectorAll('.ai-reference')).toHaveLength(1);
  expect(document.querySelector('.ai-reference button[aria-label="Remove reference.png"]')).toBeTruthy();
  button('Ask AI').click();
  expect((await p)?.references).toHaveLength(1);
});
test('module layout option is disabled and loading is explained', async () => {
  let resolve!: (v: any) => void;
  vi.spyOn(requestDialogImages, 'load').mockImplementationOnce(() => new Promise(r => { resolve = r; }));
  const p = showRequestDialog(document, { ...options(), form: null });
  expect(checkbox('Preserve the existing layout').disabled).toBe(true);
  button('Add reference image...').click();
  expect(button('Ask AI').disabled).toBe(true);
  expect(document.querySelector('.ai-attachment-status')?.textContent).toContain('Loading');
  resolve(null);
  await vi.waitFor(() => expect(button('Ask AI').disabled).toBe(false));
  button('Cancel').click(); await p;
});
test('form mode follows the saved image default and returns the displayed picture', async () => {
  const p = showRequestDialog(document, { ...options(), codeMode: false });
  await vi.waitFor(() => expect(document.querySelector<HTMLImageElement>('.ai-form-thumbnail')?.src).toContain('base64,form'));
  prompt(); button('Ask AI').click();
  expect(await p).toMatchObject({ scope: 'form', formPicture: 'data:image/png;base64,form' });
});
test('code mode can explicitly include a form picture and choose instructions', async () => {
  const p = showRequestDialog(document, options());
  checkbox('Include form picture (schematic)').click();
  checkbox('Make the smallest necessary change').click();
  checkbox('Preserve the existing layout').click();
  checkbox('Explain the changes').click();
  await vi.waitFor(() => expect(button('Ask AI').disabled).toBe(false));
  prompt(); button('Ask AI').click();
  expect(await p).toMatchObject({ formPicture: 'data:image/png;base64,form', minimal: true, preserveLayout: true, explain: true });
});
test('a standalone module offers file scope and explains the missing form', async () => {
  const p = showRequestDialog(document, { ...options(), form: null, selection: undefined, procName: undefined });
  expect((document.querySelector('.ai-scope') as HTMLSelectElement).value).toBe('file');
  expect(checkbox('Include form picture (schematic)').disabled).toBe(true);
  expect(document.querySelector('.ai-request')?.textContent).toContain('No form belongs to this code file');
  button('Cancel').click(); expect(await p).toBeNull();
});
test('reference attachments are labelled, removable and limited to two', async () => {
  vi.spyOn(requestDialogImages, 'load').mockResolvedValue({ name: 'target.png', url: 'data:image/png;base64,reference' });
  const p = showRequestDialog(document, options());
  for (let i = 0; i < 2; i++) {
    button('Add reference image...').click();
    await vi.waitFor(() => expect(document.querySelectorAll('.ai-reference')).toHaveLength(i + 1));
  }
  expect(button('Add reference image...').disabled).toBe(true);
  expect(document.querySelector('.ai-context-summary')?.textContent).toContain('2 images');
  button('Remove').click();
  expect(document.querySelectorAll('.ai-reference')).toHaveLength(1);
  expect(button('Add reference image...').disabled).toBe(false);
  prompt(); button('Ask AI').click();
  expect((await p)?.references).toHaveLength(1);
});
test('file failure preserves the prompt and existing attachment; Cancel discards pending loading', async () => {
  const loader = vi.spyOn(requestDialogImages, 'load').mockResolvedValueOnce({ name: 'first.png', url: 'data:image/png;base64,ref' })
    .mockRejectedValueOnce(new Error('Could not decode image'));
  const p = showRequestDialog(document, options()); prompt();
  button('Add reference image...').click();
  await vi.waitFor(() => expect(document.querySelectorAll('.ai-reference')).toHaveLength(1));
  button('Add reference image...').click();
  await vi.waitFor(() => expect(document.querySelector('.ai-attachment-status')?.textContent).toContain('Could not decode'));
  expect((document.querySelector('.ai-prompt') as HTMLTextAreaElement).value).toBe('Improve this');
  expect(document.querySelectorAll('.ai-reference')).toHaveLength(1);
  let resolve!: (v: any) => void;
  loader.mockImplementationOnce(() => new Promise(r => { resolve = r; }));
  button('Add reference image...').click();
  expect(button('Ask AI').disabled).toBe(true);
  button('Cancel').click(); expect(await p).toBeNull();
  resolve({ name: 'late.png', url: 'data:image/png;base64,late' });
  await Promise.resolve();
  expect(document.querySelector('.dlg98')).toBeNull();
});
test('late negative vision detection disables new images without silently submitting attached images', async () => {
  let resolve!: (s: { vision: boolean }) => void;
  vi.spyOn(requestDialogImages, 'load').mockResolvedValue({ name: 'ref.png', url: 'data:image/png;base64,ref' });
  const p = showRequestDialog(document, { ...options(), vision: undefined, detected: new Promise<{ vision: boolean }>(r => { resolve = r; }) });
  expect(document.querySelector('.ai-vision-status')?.textContent).toContain('not confirmed');
  button('Add reference image...').click();
  await vi.waitFor(() => expect(document.querySelectorAll('.ai-reference')).toHaveLength(1));
  resolve({ vision: false });
  await vi.waitFor(() => expect(button('Ask AI').disabled).toBe(true));
  expect(document.querySelector('.ai-vision-status')?.textContent).toContain('does not support images');
  button('Remove').click(); expect(button('Ask AI').disabled).toBe(false);
  button('Cancel').click(); await p;
});
test('empty request does not discard a reference attachment or scope choices', async () => {
  vi.spyOn(requestDialogImages, 'load').mockResolvedValue({ name: 'ref.png', url: 'data:image/png;base64,ref' });
  const p = showRequestDialog(document, options());
  const scope = document.querySelector('.ai-scope') as HTMLSelectElement;
  scope.value = 'file'; scope.dispatchEvent(new Event('change'));
  button('Add reference image...').click();
  await vi.waitFor(() => expect(document.querySelectorAll('.ai-reference')).toHaveLength(1));
  button('Ask AI').click();
  await vi.waitFor(() => expect(document.querySelector('.ai-request-status')?.textContent).toContain('Describe'));
  expect((document.querySelector('.ai-scope') as HTMLSelectElement).value).toBe('file');
  expect(document.querySelectorAll('.ai-reference')).toHaveLength(1);
  prompt(); button('Ask AI').click();
  expect(await p).toMatchObject({ prompt: 'Improve this', scope: 'file', references: [{ name: 'ref.png' }] });
});
test('Enter adds a new line while Ctrl+Enter submits the draft', async () => {
  const p = showRequestDialog(document, options());
  const box = document.querySelector('.ai-prompt') as HTMLTextAreaElement;
  box.value = 'First line'; box.selectionStart = box.selectionEnd = box.value.length;
  box.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }));
  expect(box.value).toBe('First line\n');
  expect(document.querySelector('.ai-request')).toBeTruthy();
  box.value += 'Second line';
  box.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', ctrlKey: true, bubbles: true, cancelable: true }));
  expect((await p)?.prompt).toBe('First line\nSecond line');
});
test('closing image preview restores focus after a pending attachment updates the cards', async () => {
  let finish!: (v: any) => void;
  vi.spyOn(requestDialogImages, 'load').mockResolvedValueOnce({ name: 'one.png', url: 'data:image/png;base64,one' })
    .mockImplementationOnce(() => new Promise(r => { finish = r; }));
  const p = showRequestDialog(document, options()); prompt();
  button('Add reference image...').click();
  await vi.waitFor(() => expect(document.querySelectorAll('.ai-reference')).toHaveLength(1));
  button('Add reference image...').click();
  const open = document.querySelector<HTMLButtonElement>('.ai-reference .ai-image-open')!;
  open.focus(); open.click();
  finish({ name: 'two.png', url: 'data:image/png;base64,two' });
  await vi.waitFor(() => expect(document.querySelectorAll('.ai-reference')).toHaveLength(2));
  button('Close').click();
  await vi.waitFor(() => expect(document.querySelector('.ai-image-preview')).toBeNull());
  expect(document.activeElement).toBe(document.querySelector('.ai-reference .ai-image-open'));
  button('Cancel').click(); await p;
});
