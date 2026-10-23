// @vitest-environment jsdom
// review08 #8: New, Open, Exit and closing the window commit a value typed in the Properties window (not yet entered) first,
// so "Save changes?" asks about it instead of the value being lost silently.
import { afterEach, beforeEach, expect, test } from 'vitest';
import { BrowserBackend } from '../../src/backend/browserBackend';
import { startIde, type Ide } from '../../src/ide/main';

class TestBackend extends BrowserBackend {
  closeHandler: (() => Promise<boolean>) | null = null;
  override onCloseRequested(h: () => Promise<boolean>): void { this.closeHandler = h; }
  override async closeMainWindow(): Promise<void> {}
  override async openProjectDialog(): Promise<string | null> { return null; }
}

let ide: Ide, be: TestBackend, root: HTMLElement;
const form = () => ide.state.project.forms[0];
function typeCaption(text: string): void {
  const row = () => root.querySelector('.pw98-row[data-prop="Caption"]') as HTMLElement;
  row().click();
  (row().querySelector('.pw98-editor') as HTMLInputElement).value = text;   // typed, not entered
}

beforeEach(() => {
  document.body.innerHTML = '';
  root = document.createElement('div');
  document.body.appendChild(root);
  be = new TestBackend();
  ide = startIde(be, root);
  ide.state.stack.markSaved();
});
afterEach(() => { document.body.innerHTML = ''; });

test.each(['newProject', 'openProject', 'exit'] as const)('%s commits the typed value and so asks to save', action => {
  typeCaption('Typed');
  ide.actions[action]!();
  expect(form().props.Caption).toBe('Typed');
  expect(ide.state.stack.isDirty).toBe(true);
});

test('closing the window commits the typed value before asking', async () => {
  typeCaption('Typed');
  void be.closeHandler!();
  expect(form().props.Caption).toBe('Typed');
  expect(ide.state.stack.isDirty).toBe(true);
});
