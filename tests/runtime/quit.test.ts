// @vitest-environment jsdom
// Review 08 runtime 9 and 10: a made app writes the files left open before it quits, and Cmd+Q asks every form (QueryUnload).
import { expect, test } from 'vitest';
import type { Backend } from '../../src/backend/backend';
import { MemoryFs } from '../../src/lang/fileio/memoryFs';
import { newControl, newForm, newProject } from '../../src/model/controls';
import { InlineFormHost } from '../../src/run/inlineFormHost';
import type { TauriFormHost } from '../../src/run/tauriFormHost';
import { requestQuit, startRuntime } from '../../src/runtime/runtimeMain';

const wait = (ms: number) => new Promise(r => setTimeout(r, ms));

function app(code: string, fs = new MemoryFs(), answers: number[] = [], slowFirst = false) {
  let calls = 0;
  const p = newProject();
  const f = newForm('Form1', code);
  const t = newControl(f, 'TextBox', { left: 120, top: 120 }, null);
  t.name = 'Text1';
  f.controls.push(t);
  p.forms = [f];
  p.startupForm = 'Form1';
  const log: string[] = [];
  const backend = {
    quitApp: async () => { log.push('quit'); }, getAppDir: async () => '/app', getAppName: async () => 'App',
    readBinaryFile: async () => new Uint8Array(),
  } as unknown as Backend;
  const container = document.body.appendChild(document.createElement('div'));
  const host = new InlineFormHost(container, fs as unknown as Backend) as unknown as TauriFormHost;
  Object.assign(host, {
    dispose: async () => { log.push('dispose'); },
    messageBox: async (o: { prompt: string }) => { log.push(o.prompt); await wait(slowFirst && calls++ === 0 ? 1700 : 0); return answers.shift() ?? 1; },
  });
  return { p, backend, host, log };
}

test('9: text written with Print # is on disk before the app quits at End', async () => {
  class SlowFs extends MemoryFs {
    override async fioWrite(id: number, pos: number, data: Uint8Array): Promise<void> { await wait(30); return super.fioWrite(id, pos, data); }
  }
  const fs = new SlowFs();
  fs.mkdirs('/data');
  const { p, backend, host, log } = app(`Private Sub Form_Load()
  Open "/data/log.txt" For Output As #1
  Print #1, "important"
  End
End Sub`, fs);
  (backend as unknown as { quitApp(): Promise<void> }).quitApp = async () => { log.push(`quit ${JSON.stringify(fs.readFile('/data/log.txt'))}`); };
  await startRuntime(p, backend, host);
  await wait(100);
  expect(log).toEqual(['dispose', 'quit "important\\r\\n"']);
});

test('10: Cmd+Q raises QueryUnload (vbAppWindows) and Unload; Cancel keeps the app; a MsgBox longer than the fallback is waited for', async () => {
  const { p, backend, host, log } = app(`Private Sub Form_QueryUnload(Cancel As Integer, UnloadMode As Integer)
  If MsgBox("Save changes? " & UnloadMode, vbYesNo) = vbNo Then Cancel = True
End Sub
Private Sub Form_Unload(Cancel As Integer)
  MsgBox "unload"
End Sub`, new MemoryFs(), [7, 6, 1], true);
  // the first answer (No) takes 1.7 s: longer than the fallback, which must not quit while the dialog is open
  await startRuntime(p, backend, host);
  requestQuit();
  await wait(1900);
  expect(log).toEqual(['Save changes? 2']);
  requestQuit();
  await wait(100);
  expect(log).toEqual(['Save changes? 2', 'Save changes? 2', 'unload', 'dispose', 'quit']);
}, 5000);
