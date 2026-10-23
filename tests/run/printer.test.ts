// @vitest-environment jsdom
// 0.9 B2: the Printer object (pages of GfxOps, NewPage, EndDoc, KillDoc), Printers, PrintForm and CommonDialog.ShowPrinter.
import { afterEach, beforeEach, expect, test } from 'vitest';
import { newControl, newForm, newProject } from '../../src/model/controls';
import type { ControlType, PropValue } from '../../src/model/types';
import { InlineFormHost } from '../../src/run/inlineFormHost';
import type { PrintJob, PrinterDialogRequest, PrinterDialogResult, PrinterInfo } from '../../src/run/printing';
import { RunSession } from '../../src/run/session';
import { mountPrintPreview } from '../../src/run/printView';

/** Printing through fakes: the jobs EndDoc and PrintForm hand over, a fixed printer list, a scripted Print dialog. */
class PrintHost extends InlineFormHost {
  jobs: PrintJob[] = [];
  printers: PrinterInfo[] = [];
  dialogAnswer: PrinterDialogResult | null = null;
  dialogAsked: PrinterDialogRequest[] = [];
  override async printPages(job: PrintJob): Promise<void> { this.jobs.push(job); }
  override async listPrinters(): Promise<PrinterInfo[]> { return this.printers; }
  override async printerDialog(o: PrinterDialogRequest): Promise<PrinterDialogResult | null> { this.dialogAsked.push(o); return this.dialogAnswer; }
}

let container: HTMLElement;
let session: RunSession | undefined;
let host: PrintHost;
let out: string[];
beforeEach(() => { container = document.createElement('div'); document.body.appendChild(container); out = []; host = new PrintHost(container); });
afterEach(() => { if (session && session.state !== 'ended') session.end(); session = undefined; document.body.innerHTML = ''; });

async function run(body: string, controls: [Exclude<ControlType, 'Form'>, string, Record<string, PropValue>?][] = []): Promise<void> {
  const p = newProject();
  const fd = newForm('Form1', `Private Sub Form_Load()\n${body}\nEnd Sub\n`);
  for (const [type, name, props] of controls) {
    const c = newControl(fd, type, { left: 120, top: 120 }, null);
    c.name = name; Object.assign(c.props, props ?? {});
    fd.controls.push(c);
  }
  p.forms = [fd];
  p.startupForm = 'Form1';
  session = new RunSession(p, host, {
    debugPrint: t => { out.push(t); }, onBreak: async () => 'end', onEnded: () => {},
    readFile: async () => { throw new Error('ENOENT'); }, appPath: '/app',
  }, 'ide');
  await session.start();
  for (let i = 0; i < 30; i++) await new Promise(r => setTimeout(r, 0));
}
const ops = (job: PrintJob, page: number) => job.pages[page].ops!.map(s => JSON.parse(s) as { o: string; t?: string });

test('Printer.Print and Line record their ops on the page', async () => {
  await run('Printer.Print "Hello"\nPrinter.Line (0, 0)-(1440, 1440)\nDebug.Print Printer.CurrentX; Printer.Page\nPrinter.EndDoc');
  expect(host.jobs).toHaveLength(1);
  const kinds = ops(host.jobs[0], 0).filter(o => o.o !== 'size' && o.o !== 'back');
  expect(kinds.map(o => o.o)).toEqual(['text', 'line']);
  expect(kinds[0].t).toBe('Hello');
  expect(out[0]).toBe(' 1440  1 ');
});

test('NewPage makes a second page; EndDoc hands both to the print backend and starts over at page 1', async () => {
  await run('Printer.Print "one"\nPrinter.NewPage\nDebug.Print Printer.Page; Printer.CurrentY\nPrinter.Print "two"\nPrinter.EndDoc\nDebug.Print Printer.Page');
  expect(out).toEqual([' 2  0 ', ' 1 ']);
  expect(host.jobs).toHaveLength(1);
  const job = host.jobs[0];
  expect(job.pages).toHaveLength(2);
  expect(ops(job, 1).find(o => o.o === 'text')?.t).toBe('two');
  expect(job).toMatchObject({ copies: 1, paperSize: 9, title: 'Project1' });
});

test('KillDoc throws the pages away: the next EndDoc prints nothing', async () => {
  await run('Printer.Print "gone"\nPrinter.NewPage\nPrinter.KillDoc\nPrinter.EndDoc\nDebug.Print Printer.Page');
  expect(host.jobs).toHaveLength(0);
  expect(out).toEqual([' 1 ']);
});

test('Printers: Count and DeviceName from the system list; Printer is the default; Set Printer = Printers(i) selects one', async () => {
  host.printers = [{ name: 'Office', port: 'ipp://office', isDefault: false }, { name: 'Home_Laser', port: 'usb://home', isDefault: true }];
  await run([
    'Dim p As Printer',
    'Debug.Print Printers.Count; Printers(0).DeviceName; " "; Printer.DeviceName',
    'For Each p In Printers: Debug.Print p.Port: Next',
    'Set Printer = Printers(0)',
    'Debug.Print Printer.DeviceName',
  ].join('\n'));
  expect(out).toEqual([' 2 Office Home_Laser', 'ipp://office', 'usb://home', 'Office']);
});

test('ShowPrinter: Cancel with CancelError gives 32755; OK fills Copies and Orientation, and the Printer gets them (PrinterDefault)', async () => {
  host.printers = [{ name: 'A', port: 'a', isDefault: true }, { name: 'B', port: 'b', isDefault: false }];
  await run([
    'On Error Resume Next',
    'CommonDialog1.CancelError = True',
    'CommonDialog1.ShowPrinter',
    'Debug.Print Err.Number',
    'Err.Clear',
    'CommonDialog1.Tag = "x"',
  ].join('\n') + '\nEnd Sub\nSub Form_Click()\nCommonDialog1.ShowPrinter\nDebug.Print CommonDialog1.Copies; CommonDialog1.Orientation; Printer.DeviceName; Printer.Copies; Printer.Orientation',
  [['CommonDialog', 'CommonDialog1']]);
  expect(out).toEqual([' 32755 ']);
  expect(host.dialogAsked[0]).toMatchObject({ device: 'A', copies: 1, orientation: 1, printers: host.printers });
  host.dialogAnswer = { device: 'B', copies: 3, orientation: 2, pageNums: false, fromPage: 0, toPage: 0 };
  await session!.fire('Form1', 'Form_Click', []);
  expect(out[1]).toBe(' 3  2 B 3  2 ');
});

test('Orientation turns the paper: Width and Height swap, ScaleWidth and ScaleHeight follow (A4 less the margins)', async () => {
  await run([
    'Debug.Print Printer.Width; Printer.Height; Printer.ScaleWidth; Printer.ScaleHeight',
    'Printer.Orientation = vbPRORLandscape',
    'Debug.Print Printer.Width; Printer.Height; Printer.ScaleWidth; Printer.ScaleHeight',
  ].join('\n'));
  expect(out).toEqual([' 11906  16838  11186  16118 ', ' 16838  11906  16118  11186 ']);
});

test('PrintForm prints one page holding the form', async () => {
  await run('Me.PrintForm', [['CommandButton', 'Command1']]);
  expect(host.jobs).toHaveLength(1);
  expect(host.jobs[0].pages).toHaveLength(1);
  expect(host.jobs[0].pages[0].form?.form.controls.map(c => c.name)).toEqual(['Command1']);
});

test('print preview: one sheet per page and copy (further copies print only), a landscape page marked to be turned', async () => {
  let printed = 0;
  const page = { paperW: 1123, paperH: 794, left: 24, top: 24, w: 1075, h: 746, ops: ['{"o":"cls"}'] };
  await mountPrintPreview(container, { title: 'T', device: '', copies: 2, paperSize: 9, pages: [page] }, { onPrint: () => { printed++; }, onClose: () => {} });
  const sheets = [...container.querySelectorAll('.vb-print-sheet')];
  expect(sheets.map(s => s.className)).toEqual(['vb-print-sheet landscape', 'vb-print-sheet landscape vb-print-copy vb-print-last']);
  expect(container.querySelector('.vb-print-count')?.textContent).toBe('1 page');
  container.querySelector<HTMLButtonElement>('.vb-print-bar button')!.click();
  expect(printed).toBe(1);
});
