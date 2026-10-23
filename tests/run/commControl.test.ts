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
