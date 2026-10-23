// @vitest-environment jsdom
// Review 08 (M2): a file over the backend's size cap (LoadPicture, MMControl) is error 7, any other failure 53.
import { expect, test } from 'vitest';
import { newForm, newProject } from '../../src/model/controls';
import { InlineFormHost } from '../../src/run/inlineFormHost';
import { RunSession } from '../../src/run/session';

test('readFile: a too-big file is 7 (Out of memory), a missing one 53', async () => {
  const p = newProject();
  p.forms = [newForm('Form1', '')];
  p.startupForm = 'Form1';
  let fail: unknown = null;
  const s = new RunSession(p, new InlineFormHost(document.createElement('div')), {
    debugPrint: () => {}, onBreak: async () => 'end', onEnded: () => {},
    readFile: async () => { throw fail; }, appPath: '/app',
  }, 'ide');
  fail = Object.assign(new Error('/app/big.png: the file is too big (more than 256 MB)'), { vbNumber: 7 });
  await expect(s.readFile('big.png')).rejects.toEqual(expect.objectContaining({ number: 7 }));
  fail = new Error('/app/x.png: No such file or directory');
  await expect(s.readFile('x.png')).rejects.toEqual(expect.objectContaining({ number: 53 }));
});
