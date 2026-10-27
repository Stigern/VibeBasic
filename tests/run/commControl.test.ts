// @vitest-environment jsdom
import { afterEach, beforeEach, expect, test } from 'vitest';
import type { Backend, CommEvent, CommLines, SerialApi, SysInfoData, SystemApi } from '../../src/backend/backend';
import { newControl, newForm, newProject } from '../../src/model/controls';
import type { ControlType, PropValue } from '../../src/model/types';
import { InlineFormHost } from '../../src/run/inlineFormHost';
import { stringBytes } from '../../src/run/objects/netControls';
import { RunSession } from '../../src/run/session';

/** The serial ports and the system as the run session sees them; the test plays the device. */
class FakeSystem implements SerialApi, SystemApi {
  calls: string[] = [];
  written: string[] = [];
  ports = ['/dev/cu.Bluetooth-Incoming-Port', '/dev/cu.usbmodem1101'];
  info: SysInfoData = {
    osVersion: '15.4.1', osBuild: '24E263', workLeft: 0, workTop: 25, workWidth: 1440, workHeight: 875,
    acStatus: 0, batteryLifePercent: 76, batteryLifeTime: 15120, batteryFullTime: -1, batteryStatus: 1,
  };
  private handler: ((e: CommEvent) => void) | null = null;

  async commList(): Promise<string[]> { return this.ports; }
  async commOpen(id: number, path: string, settings: string): Promise<CommLines> {
    if (!this.ports.includes(path)) throw new Error('8002|Invalid port number');
    this.calls.push(`open ${id} ${path} ${settings}`);
    return { cts: true, dsr: false, cd: false, ring: false };
  }
  async commConfigure(id: number, settings: string): Promise<void> { this.calls.push(`configure ${id} ${settings}`); }
  async commWrite(_id: number, data: Uint8Array): Promise<void> { this.written.push(String.fromCharCode(...data)); }
  async commSetLines(id: number, dtr: boolean | null): Promise<void> { this.calls.push(`lines ${id} ${dtr}`); }
  async commClose(id: number): Promise<void> { this.calls.push(`close ${id}`); }
  async commReset(): Promise<void> { this.calls.push('reset'); }
  async onCommEvent(h: (e: CommEvent) => void): Promise<() => void> { this.handler = h; return () => { this.handler = null; }; }
  async sysInfo(): Promise<SysInfoData> { return this.info; }

  idOf(): number { return Number([...this.calls].reverse().find(c => c.startsWith('open '))!.split(' ')[1]); }
  data(text: string): void { this.handler?.({ kind: 'data', id: this.idOf(), data: stringBytes(text) }); }
}

let container: HTMLElement;
let session: RunSession | undefined;
beforeEach(() => { container = document.createElement('div'); document.body.appendChild(container); });
afterEach(() => { if (session && session.state !== 'ended') session.end(); session = undefined; document.body.innerHTML = ''; });
const settle = async () => { for (let i = 0; i < 10; i++) await new Promise(r => setTimeout(r, 0)); await new Promise(r => setTimeout(r, 40)); };

async function run(code: string, controls: [Exclude<ControlType, 'Form'>, string, Record<string, PropValue>?][], sys = new FakeSystem()) {
  const p = newProject();
  p.forms = [newForm('Form1', code)];
  p.startupForm = 'Form1';
  for (const [type, name, props] of controls) {
    const c = newControl(p.forms[0], type, { left: 120, top: 120 }, null);
    c.name = name; Object.assign(c.props, props ?? {});
    p.forms[0].controls.push(c);
  }
  const out: string[] = [];
  session = new RunSession(p, new InlineFormHost(container, sys as unknown as Backend), {
    debugPrint: t => { out.push(t); }, onBreak: async () => 'end', onEnded: () => {},
    readFile: async () => { throw new Error('ENOENT'); }, appPath: '/tmp',
  }, 'ide');
  await session.start();
  await settle();
  return { out, sys };
}

test('MSComm: PortOpen opens the CommPort-th port; RThreshold 1 raises OnComm comEvReceive, Input drains the buffer', async () => {
  const { out, sys } = await run(`
Private Sub Form_Load()
  MSComm1.CommPort = 2
  MSComm1.Settings = "115200,n,8,1"
  MSComm1.RThreshold = 1
  MSComm1.PortOpen = True
  Debug.Print "open " & MSComm1.PortOpen & " " & MSComm1.CTSHolding
  MSComm1.Output = "PING" & vbCr
End Sub
Private Sub MSComm1_OnComm()
  Dim s As String
  If MSComm1.CommEvent = comEvReceive Then
    Debug.Print "count " & MSComm1.InBufferCount
    MSComm1.InputLen = 3
    s = MSComm1.Input
    Debug.Print "got " & s & " left " & MSComm1.InBufferCount
    MSComm1.InputLen = 0
    s = MSComm1.Input
    Debug.Print "rest " & s & " left " & MSComm1.InBufferCount
  End If
End Sub`, [['MSComm', 'MSComm1']]);
  const id = sys.idOf();
  expect(sys.calls).toContain(`open ${id} /dev/cu.usbmodem1101 115200,n,8,1`);
  expect(out).toEqual(['open True True']);
  expect(sys.written).toEqual(['PING\r']);
  sys.data('hello');
  await settle();
  expect(out.slice(1)).toEqual(['count 5', 'got hel left 2', 'rest lo left 0']);
  session!.end();
  await settle();
  expect(sys.calls).toContain('reset');
});

test('MSComm: an unknown port is error 8002; PortName names the device; closing a closed port is 8012', async () => {
  const { out } = await run(`
Private Sub Form_Load()
  On Error Resume Next
  MSComm1.CommPort = 9
  MSComm1.PortOpen = True
  Debug.Print Err.Number & " " & Err.Description & " " & MSComm1.PortOpen
  Err.Clear
  MSComm1.PortName = "/dev/cu.nothing"
  MSComm1.PortOpen = True
  Debug.Print Err.Number
  Err.Clear
  MSComm1.PortOpen = False
  Debug.Print Err.Number
  Err.Clear
  MSComm1.Output = "x"
  Debug.Print Err.Number
  Err.Clear
  MSComm1.PortName = "/dev/cu.usbmodem1101"
  MSComm1.PortOpen = True
  MSComm1.PortOpen = True
  Debug.Print Err.Number & " " & MSComm1.PortOpen
End Sub`, [['MSComm', 'MSComm1']]);
  expect(out).toEqual(['8002 Invalid port number False', ' 8002 ', ' 8012 ', ' 8018 ', '8005 True']);   // Debug.Print pads a number
});

test('SysInfo: BatteryLifePercent and the other values come from the backend', async () => {
  const { out } = await run(`
Private Sub Form_Load()
  Debug.Print SysInfo1.BatteryLifePercent & " " & SysInfo1.ACStatus & " " & SysInfo1.BatteryStatus & " " & SysInfo1.BatteryLifeTime
  Debug.Print SysInfo1.OSPlatform & " " & SysInfo1.OSVersion & " " & SysInfo1.OSBuild & " " & SysInfo1.WorkAreaTop & " " & SysInfo1.WorkAreaWidth
End Sub`, [['SysInfo', 'SysInfo1']]);
  expect(out).toEqual(['76 0 1 15120', '2 15.4 24E263 375 21600']);
});

test('MSComm: Input with InputLen above what has arrived gives "" and keeps the bytes (review 08 runtime 15)', async () => {
  const { out, sys } = await run(`
Private Sub Form_Load()
  MSComm1.PortName = "/dev/cu.usbmodem1101"
  MSComm1.PortOpen = True
End Sub
Private Sub Command1_Click()
  MSComm1.InputLen = 10
  Debug.Print "[" & MSComm1.Input & "] " & MSComm1.InBufferCount
  MSComm1.InputLen = 3
  Debug.Print "[" & MSComm1.Input & "] " & MSComm1.InBufferCount
End Sub`, [['MSComm', 'MSComm1'], ['CommandButton', 'Command1']]);
  sys.data('abcd');
  await settle();
  container.querySelector<HTMLElement>('[data-control-id] button')!.click();
  await settle();
  expect(out).toEqual(['[] 4', '[abc] 1']);
});

test('MSComm: bytes that arrive while the port opens are kept and raise OnComm (review 08 runtime, below the cut)', async () => {
  class Early extends FakeSystem {
    private h: ((e: CommEvent) => void) | null = null;
    override async onCommEvent(h: (e: CommEvent) => void): Promise<() => void> { this.h = h; return super.onCommEvent(h); }
    override async commOpen(id: number, path: string, settings: string): Promise<CommLines> {
      const r = await super.commOpen(id, path, settings);
      this.h?.({ kind: 'data', id, data: stringBytes('hi') });
      return r;
    }
  }
  const { out } = await run(`
Private Sub Form_Load()
  MSComm1.PortName = "/dev/cu.usbmodem1101"
  MSComm1.RThreshold = 1
  MSComm1.PortOpen = True
End Sub
Private Sub MSComm1_OnComm()
  If MSComm1.CommEvent = comEvReceive Then Debug.Print "got " & MSComm1.Input
End Sub`, [['MSComm', 'MSComm1']], new Early());
  expect(out).toEqual(['got hi']);
});

test('MSComm: PortOpen = False does not wait for Output stuck on the device (the close stops it; True opens after both)', async () => {
  class StuckWrite extends FakeSystem {
    private release: (() => void) | null = null;
    private closedIds = new Set<number>();
    override async commWrite(id: number): Promise<void> {
      this.calls.push(`write ${id}`);
      if (this.closedIds.has(id)) throw new Error('8018|Operation valid only when the port is open');
      await new Promise<void>(r => { this.release = r; });   // the device takes nothing: only a close ends it
      throw new Error('8015|Could not write to the comm device: the port was closed');
    }
    override async commClose(id: number): Promise<void> { this.calls.push(`close ${id}`); this.closedIds.add(id); this.release?.(); }
  }
  const sys = new StuckWrite();
  const { out } = await run(`
Private Sub Form_Load()
  MSComm1.PortName = "/dev/cu.usbmodem1101"
  MSComm1.PortOpen = True
  MSComm1.Output = "stuck"
  DoEvents
  MSComm1.PortOpen = False
  MSComm1.PortOpen = True
  Debug.Print MSComm1.PortOpen & " " & MSComm1.OutBufferCount
End Sub`, [['MSComm', 'MSComm1']], sys);
  expect(out).toEqual(['True 0']);
  expect(sys.calls.filter(c => /^(open|close|write)/.test(c)).map(c => c.split(' ')[0])).toEqual(['open', 'write', 'close', 'open']);
});

test('MSComm: PortOpen = False then True opens once the close has finished (review 08 runtime 14)', async () => {
  class SlowClose extends FakeSystem {
    override async commClose(id: number): Promise<void> { await new Promise(r => setTimeout(r, 20)); this.calls.push(`close ${id}`); }
  }
  const sys = new SlowClose();
  const { out } = await run(`
Private Sub Form_Load()
  MSComm1.PortName = "/dev/cu.usbmodem1101"
  MSComm1.PortOpen = True
  MSComm1.PortOpen = False
  MSComm1.PortOpen = True
  Debug.Print MSComm1.PortOpen
End Sub`, [['MSComm', 'MSComm1']], sys);
  expect(out).toEqual(['True']);
  const seq = sys.calls.filter(c => /^(open|close)/.test(c)).map(c => c.split(' ').slice(0, 2));
  expect(seq.map(c => c[0])).toEqual(['open', 'close', 'open']);
  expect(seq[1][1]).toBe(seq[0][1]);
});
