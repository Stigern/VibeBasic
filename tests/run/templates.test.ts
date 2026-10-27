// @vitest-environment jsdom
import { afterEach, expect, test } from 'vitest';
import type { Backend, CommEvent } from '../../src/backend/backend';
import { MemoryFs } from '../../src/lang/fileio/memoryFs';
import { VBRef, type VBValue } from '../../src/lang/values';
import { projectFromTemplate, TEMPLATES, type ProjectTemplate } from '../../src/model/templates';
import { parseProject, serializeProject } from '../../src/model/serialize';
import { InlineFormHost } from '../../src/run/inlineFormHost';
import { RunSession } from '../../src/run/session';

let session: RunSession | undefined;
afterEach(() => { session?.end(); session = undefined; document.body.replaceChildren(); });

async function run(id: string, backend: Partial<Backend> = {}) {
  expect(TEMPLATES.some(t => t.id === id), `${id} available in New`).toBe(true);
  const project = parseProject(serializeProject(projectFromTemplate(id as ProjectTemplate, 'Option Explicit\n')));
  const container = document.body.appendChild(document.createElement('div'));
  const host = new InlineFormHost(container, backend as Backend);
  const messages: string[] = [];
  let answer = 2; // Cancel
  host.messageBox = async o => { messages.push(o.prompt); return answer; };
  host.runtimeErrorBox = async o => { throw new Error(`${o.number}: ${o.description}`); };
  session = new RunSession(project, host, {
    debugPrint: () => {}, onBreak: async () => 'end', onEnded: () => {},
    readFile: async () => { throw new Error('ENOENT'); }, appPath: '/app',
  }, 'ide');
  await session.start();
  const fire = async (name: string, ...args: VBValue[]) => {
    const refs = args.map(a => new VBRef(a));
    await session!.fire('Form1', name, refs);
    return refs.map(r => r.value);
  };
  const immediate = (code: string) => session!.immediate(code);
  const value = (expr: string) => immediate(`? Form1.${expr}`);
  return { project, container, fire, immediate, value, messages, answer: (n: number) => { answer = n; } };
}

test('Text Editor opens and saves plain text, preserves text on cancel, and edits through the clipboard', async () => {
  const fs = new MemoryFs();
  fs.writeFile('/app/in.txt', 'hello\r\nworld');
  let open: string | null = '/app/in.txt', save: string | null = '/app/out.txt', clip = '';
  const r = await run('textEditor', Object.assign(fs, {
    showOpenDialog: async () => open, showSaveDialog: async () => save,
    clipboardGetText: async () => clip, clipboardSetText: async (s: string) => { clip = s; },
  }));
  await r.fire('mnuOpen_Click');
  expect(await r.value('txtEditor.Text')).toContain('hello');
  await r.fire('mnuSelectAll_Click');
  await r.fire('mnuCopy_Click');
  expect(clip).toContain('hello');
  await r.fire('mnuCut_Click');
  expect(await r.value('txtEditor.Text')).toBe('');
  await r.fire('mnuPaste_Click');
  await r.fire('mnuSaveAs_Click');
  expect(fs.readFile('/app/out.txt')).toBe('hello\r\nworld');
  await r.immediate('Form1.txtEditor.Text = "changed"');
  await r.fire('txtEditor_Change');
  save = null;
  await r.fire('mnuSaveAs_Click');
  expect(fs.readFile('/app/out.txt')).toBe('hello\r\nworld');
  await r.fire('mnuNew_Click'); // Cancel the discard confirmation
  expect(await r.value('txtEditor.Text')).toBe('changed');
  r.answer(7); // No: discard
  open = null;
  await r.fire('mnuOpen_Click');
  expect(await r.value('txtEditor.Text')).toBe('changed');
  await r.fire('mnuNew_Click');
  expect(await r.value('txtEditor.Text')).toBe('');
  expect(r.project.components).toEqual(expect.arrayContaining(['RICHTX32.OCX', 'COMDLG32.OCX']));
});

test('Drawing App draws connected strokes in the selected colour and width, and Clear erases them', async () => {
  const r = await run('drawing');
  await r.immediate('Form1.cboColor.ListIndex = 1');
  await r.fire('cboColor_Click');
  await r.immediate('Form1.cboBrush.ListIndex = 2');
  await r.fire('cboBrush_Click');
  await r.fire('picCanvas_MouseDown', 1, 0, 10, 10);
  await r.fire('picCanvas_MouseMove', 1, 0, 40, 10);
  expect((await r.value('picCanvas.Point(25, 10)')).trim()).toBe('255');
  expect((await r.value('picCanvas.DrawWidth')).trim()).toBe('5');
  expect((await r.value('picCanvas.Point(25, 12)')).trim()).toBe('255');
  await r.fire('picCanvas_MouseMove', 0, 0, 40, 40);
  expect((await r.value('picCanvas.Point(40, 30)')).trim()).toBe('16777215');
  await r.fire('cmdClear_Click');
  expect((await r.value('picCanvas.Point(25, 10)')).trim()).toBe('16777215');
});

test('Text Editor cancels closing when saving is cancelled or fails, and reports failed opens without losing text', async () => {
  const fs = new MemoryFs();
  fs.mkdirs('/app');
  let save: string | null = null;
  const r = await run('textEditor', Object.assign(fs, {
    showOpenDialog: async () => '/app/missing.txt', showSaveDialog: async () => save,
  }));
  await r.immediate('Form1.txtEditor.Text = "unsaved"');
  r.answer(6); // Yes: save before closing
  expect((await r.fire('Form_QueryUnload', 0, 0))[0]).toBe(1);
  expect(await r.value('txtEditor.Text')).toBe('unsaved');
  save = '/missing-folder/out.txt';
  expect((await r.fire('Form_QueryUnload', 0, 0))[0]).toBe(1);
  expect(r.messages.length).toBeGreaterThan(2);
  r.answer(7); // No: discard, but the file cannot be opened
  await r.fire('mnuOpen_Click');
  expect(await r.value('txtEditor.Text')).toBe('unsaved');
  expect((await r.fire('Form_QueryUnload', 0, 0))[0]).toBe(0);
});

test('Serial Terminal connects only on request, sends CRLF, receives data and disconnects', async () => {
  const opened: string[] = [], written: number[][] = [], closed: number[] = [];
  let handler: ((e: CommEvent) => void) | undefined, portId = 0;
  const r = await run('serial', {
    commList: async () => ['/dev/cu.test'],
    commOpen: async (id, path, settings) => { portId = id; opened.push(`${path} ${settings}`); return { cts: false, dsr: false, cd: false, ring: false }; },
    commWrite: async (_id, data) => { written.push([...data]); },
    commClose: async id => { closed.push(id); }, commReset: async () => {},
    onCommEvent: async h => { handler = h; return () => {}; },
  });
  expect(opened).toEqual([]);
  await r.fire('cmdConnect_Click');
  expect(opened).toEqual(['/dev/cu.test 9600,n,8,1']);
  expect(await r.value('cmdSend.Enabled')).toBe('True');
  await r.immediate('Form1.txtSend.Text = "PING"');
  await r.fire('cmdSend_Click');
  expect(written).toEqual([[80, 73, 78, 71, 13, 10]]);
  handler!({ kind: 'data', id: portId, data: new Uint8Array([79, 75]) });
  await expect.poll(() => r.value('txtReceive.Text')).toBe('OK');
  await r.fire('cmdConnect_Click');
  expect(closed).toEqual([portId]);
  expect(await r.value('cmdSend.Enabled')).toBe('False');
  expect(r.project.components).toContain('MSCOMM32.OCX');
});

test('Serial Terminal accepts a device name and leaves its controls usable after an open failure', async () => {
  const paths: string[] = [];
  const r = await run('serial', {
    commList: async () => [], commReset: async () => {},
    onCommEvent: async () => () => {},
    commOpen: async (_id, path) => { paths.push(path); throw new Error('8002|Invalid port number'); },
  });
  await r.immediate('Form1.txtPort.Text = "COM7"');
  await r.fire('cmdConnect_Click');
  expect(paths).toEqual(['COM7']);
  expect(await r.value('lblStatus.Caption')).toContain('Invalid port number');
  expect(await r.value('txtPort.Enabled')).toBe('True');
  expect(await r.value('cmdSend.Enabled')).toBe('False');
});

test('Serial Terminal restores its connection controls when the device disappears', async () => {
  let handler: ((e: CommEvent) => void) | undefined, portId = 0;
  const r = await run('serial', {
    commList: async () => ['/dev/cu.test'],
    commOpen: async id => { portId = id; return { cts: false, dsr: false, cd: false, ring: false }; },
    commClose: async () => {}, commReset: async () => {},
    onCommEvent: async h => { handler = h; return () => {}; },
  });
  await r.fire('cmdConnect_Click');
  handler!({ kind: 'error', id: portId, number: 8018, description: 'Device removed' });
  await expect.poll(() => r.value('cmdSend.Enabled')).toBe('False');
  expect(await r.value('txtPort.Enabled')).toBe('True');
  expect(await r.value('cboBaud.Enabled')).toBe('True');
  expect(await r.value('cmdConnect.Caption')).toBe('&Connect');
  expect(await r.value('lblStatus.Caption')).toContain('Disconnected');
});
