import { afterEach, expect, test } from 'vitest';
import { showAbout, renderChangelog } from '../../src/ide/aboutDialog';

afterEach(() => { document.body.innerHTML = ''; });

test('About shows the version and the rendered changelog', async () => {
  const done = showAbout(document);
  const dlg = document.querySelector('.dlg98')!;
  expect(dlg.textContent).toContain('VibeBasic');
  expect(dlg.textContent).toContain(`Version ${__APP_VERSION__}`);
  expect(dlg.textContent).toContain('Changelog');
  const log = dlg.querySelector('.about98-log')!;
  expect(log.textContent).toContain('• Movable and resizable toolbox.');
  expect(log.textContent).toContain('[0.5.0]');
  expect(log.textContent).not.toContain('- Movable');
  expect(dlg.textContent).toContain('CC BY-SA 3.0');
  (Array.from(dlg.querySelectorAll('button')).find(b => b.textContent === 'OK') as HTMLButtonElement).click();
  await done;
  expect(document.querySelector('.dlg98')).toBeNull();
});

test('renderChangelog: headings bold, bullets with a dot', () => {
  const box = renderChangelog('## [1.0]\n- one\n\n### Added\n- two');
  const lines = Array.from(box.children).map(c => [c.className, c.textContent]);
  expect(lines).toEqual([['l b', '[1.0]'], ['l', '• one'], ['l b', 'Added'], ['l', '• two']]);
});
