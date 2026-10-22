// @vitest-environment jsdom
import { afterEach, beforeEach, expect, test } from 'vitest';
import type { Backend, InetRequest, InetResponse, NetApi, SocketEvent, SocketInfo } from '../../src/backend/backend';
import { newControl, newForm, newProject } from '../../src/model/controls';
import type { ControlType, PropValue } from '../../src/model/types';
import { InlineFormHost } from '../../src/run/inlineFormHost';
import { stringBytes, webUrl } from '../../src/run/objects/netControls';
import { frameSandbox } from '../../src/controls/webBrowser';
import { RunSession } from '../../src/run/session';

/** The network as the run session sees it; the test plays the other side. */
class FakeNet implements NetApi {
  calls: string[] = [];
  sent: { id: number; text: string }[] = [];
  pages: Record<string, { body: string; headers?: [string, string][]; status?: number }> = {};
  private handler: ((e: SocketEvent) => void) | null = null;
  info = (o: Partial<SocketInfo> = {}): SocketInfo => ({ localIp: '192.168.1.5', localPort: 50000, remoteIp: '127.0.0.1', remotePort: 7000, ...o });

  async inetRequest(r: InetRequest): Promise<InetResponse> {
    this.calls.push(`inet ${r.method} ${r.url}`);
    const p = this.pages[r.url];
    if (!p) throw new Error('35754|Unable to connect to remote host');
    return { status: p.status ?? 200, statusText: 'OK', version: 'HTTP/1.1', headers: p.headers ?? [], body: new TextEncoder().encode(p.body) };
  }
  async inetCancel(id: string): Promise<void> { this.calls.push(`cancel ${id}`); }
  async sockConnect(id: number, host: string, port: number): Promise<SocketInfo> { this.calls.push(`connect ${id} ${host}:${port}`); return this.info({ remotePort: port }); }
  async sockListen(id: number, port: number): Promise<SocketInfo> { this.calls.push(`listen ${id} ${port}`); return this.info({ localPort: port || 51000, remoteIp: '', remotePort: 0 }); }
  async sockAccept(id: number, requestId: number): Promise<SocketInfo> { this.calls.push(`accept ${id} ${requestId}`); return this.info({ localPort: 8080, remotePort: 60000 + requestId }); }
  async sockBind(id: number, port: number): Promise<SocketInfo> { this.calls.push(`bind ${id} ${port}`); return this.info({ localPort: port }); }
  async sockSend(id: number, data: Uint8Array): Promise<void> { this.sent.push({ id, text: String.fromCharCode(...data) }); }
  async sockClose(id: number): Promise<void> { this.calls.push(`close ${id}`); }
  async netReset(): Promise<void> { this.calls.push('reset'); }
  async netLocalIp(): Promise<string> { return '192.168.1.5'; }
  async onSocketEvent(h: (e: SocketEvent) => void): Promise<() => void> { this.handler = h; return () => { this.handler = null; }; }

  /** The id of the last socket made by `verb` (connect, listen, accept). */
  idOf(verb: string): number { return Number([...this.calls].reverse().find(c => c.startsWith(verb + ' '))!.split(' ')[1]); }
  data(id: number, text: string): void { this.handler?.({ kind: 'data', id, data: stringBytes(text), remoteIp: '127.0.0.1', remotePort: 7000 }); }
  request(id: number, requestId: number): void { this.handler?.({ kind: 'connectionRequest', id, requestId, remoteIp: '10.0.0.9', remotePort: 60000 + requestId }); }
}

let container: HTMLElement;
let session: RunSession | undefined;
beforeEach(() => { container = document.createElement('div'); document.body.appendChild(container); });
afterEach(() => { if (session && session.state !== 'ended') session.end(); session = undefined; document.body.innerHTML = ''; });
const settle = async () => { for (let i = 0; i < 10; i++) await new Promise(r => setTimeout(r, 0)); await new Promise(r => setTimeout(r, 40)); };

async function run(code: string, controls: [Exclude<ControlType, 'Form'>, string, Record<string, PropValue>?, number?][], net = new FakeNet()) {
  const p = newProject();
  p.forms = [newForm('Form1', code)];
  p.startupForm = 'Form1';
  for (const [type, name, props, index] of controls) {
    const c = newControl(p.forms[0], type, { left: 120, top: 120 }, null);
    c.name = name; Object.assign(c.props, props ?? {});
    if (index !== undefined) c.index = index;
    p.forms[0].controls.push(c);
  }
  const out: string[] = [];
  session = new RunSession(p, new InlineFormHost(container, net as unknown as Backend), {
    debugPrint: t => { out.push(t); }, onBreak: async () => 'end', onEnded: () => {},
    readFile: async () => { throw new Error('ENOENT'); }, appPath: '/tmp',
  }, 'ide');
  await session.start();
  await settle();
  return { out, net, p };
}

test('Inet: OpenURL returns the body; Execute raises StateChanged and GetChunk reads the answer', async () => {
  const net = new FakeNet();
  net.pages['http://example.test/hello'] = { body: 'hei æøå', headers: [['content-type', 'text/plain; charset=utf-8']] };
  const { out } = await run(`
Private Sub Form_Load()
  Dim s As String
  s = Inet1.OpenURL("http://example.test/hello")
  Debug.Print s & "|" & Inet1.GetHeader("Content-Type") & "|" & Inet1.RemoteHost & "|" & Inet1.Protocol
  Inet1.Execute "http://example.test/hello", "GET"
  Debug.Print "busy " & Inet1.StillExecuting
End Sub
Private Sub Inet1_StateChanged(ByVal State As Integer)
  Dim part As String, all As String
  If State = icResponseCompleted Then
    Do
      part = Inet1.GetChunk(3, icString)
      If Len(part) = 0 Then Exit Do
      all = all & "[" & part & "]"
    Loop
    Debug.Print "done " & all & " " & Inet1.StillExecuting
    Inet1.Execute "http://nowhere.test/"
  ElseIf State = icError Then
    Debug.Print "error " & Inet1.ResponseCode & " " & Inet1.ResponseInfo
  End If
End Sub`, [['Inet', 'Inet1']], net);
  expect(out).toEqual([
    'hei æøå|text/plain; charset=utf-8|example.test|4',
    'busy True',
    'done [hei][ æø][å] False',
    'error 35754 Unable to connect to remote host',
  ]);
});

test('Winsock client: Connect, SendData, DataArrival + GetData into a String', async () => {
  const { out, net } = await run(`
Private Sub Form_Load()
  Winsock1.RemoteHost = "127.0.0.1"
  Winsock1.RemotePort = 7000
  Winsock1.Connect
  Debug.Print "state " & Winsock1.State
End Sub
Private Sub Winsock1_Connect()
  Debug.Print "connected " & Winsock1.State & " " & Winsock1.RemoteHostIP & " " & Winsock1.LocalIP
  Winsock1.SendData "HELLO" & vbCrLf
End Sub
Private Sub Winsock1_SendComplete()
  Debug.Print "sent"
End Sub
Private Sub Winsock1_DataArrival(ByVal bytesTotal As Long)
  Dim s As String, p As String
  Winsock1.PeekData p, vbString, 2
  Winsock1.GetData s
  Debug.Print "got " & bytesTotal & " " & p & " " & s & " left " & Winsock1.BytesReceived
End Sub
Private Sub Winsock1_Close()
  Debug.Print "closed " & Winsock1.State
  Winsock1.Close
End Sub`, [['Winsock', 'Winsock1']]);
  const id = net.idOf('connect');
  expect(net.calls).toContain(`connect ${id} 127.0.0.1:7000`);
  expect(out).toEqual(['state 6', 'connected 7 127.0.0.1 192.168.1.5', 'sent']);
  expect(net.sent).toEqual([{ id, text: 'HELLO\r\n' }]);
  net.data(id, 'hi there');
  await settle();
  expect(out.slice(3)).toEqual(['got 8 hi hi there left 0']);
  (net as unknown as { handler: (e: SocketEvent) => void }).handler({ kind: 'close', id });
  await settle();
  expect(out.slice(4)).toEqual(['closed 8']);
  expect(net.calls).toContain(`close ${id}`);
});

test('Winsock: Close while Connect is still under way closes the connection that opens later (no ghost client)', async () => {
  const net = new FakeNet();
  let opened: (i: SocketInfo) => void = () => {};
  net.sockConnect = async (id, host, port) => { net.calls.push(`connect ${id} ${host}:${port}`); return new Promise<SocketInfo>(r => { opened = r; }); };
  const { out } = await run(`
Private Sub Form_Load()
  Winsock1.Connect "slow.test", 7000
  Winsock1.Close
  Debug.Print "state " & Winsock1.State
End Sub
Private Sub Winsock1_Connect()
  Debug.Print "connected"
End Sub`, [['Winsock', 'Winsock1']], net);
  const id = net.idOf('connect');
  const closes = () => net.calls.filter(c => c === `close ${id}`).length;
  const before = closes();
  opened(net.info({ remotePort: 7000 }));   // the slow connect completes after Close
  await settle();
  expect(out).toEqual(['state 0']);
  expect(closes()).toBe(before + 1);
});

test('Winsock server: Close and Accept requestID in ConnectionRequest; a control array takes several clients; End closes them', async () => {
  const one = await run(`
Private Sub Form_Load()
  tcpServer.LocalPort = 1001
  tcpServer.Listen
  Debug.Print "listening " & tcpServer.State & " " & tcpServer.LocalPort
End Sub
Private Sub tcpServer_ConnectionRequest(ByVal requestID As Long)
  If tcpServer.State <> sckClosed Then tcpServer.Close
  tcpServer.Accept requestID
  Debug.Print "accepted " & requestID & " " & tcpServer.State & " " & tcpServer.RemoteHostIP
End Sub`, [['Winsock', 'tcpServer']]);
  one.net.request(one.net.idOf('listen'), 5);
  await settle();
  expect(one.out).toEqual(['listening 2 1001', 'accepted 5 7 127.0.0.1']);
  const listenId = one.net.idOf('listen'), acceptId = one.net.idOf('accept');
  expect(one.net.calls).toContain(`close ${listenId}`);
  expect(one.net.calls).toContain(`accept ${acceptId} 5`);
  session!.end();

  const arr = await run(`
Dim n As Integer
Private Sub Form_Load()
  sck(0).LocalPort = 8080
  sck(0).Listen
End Sub
Private Sub sck_ConnectionRequest(Index As Integer, ByVal requestID As Long)
  n = n + 1
  Load sck(n)
  sck(n).Accept requestID
  Debug.Print "client " & n & " " & sck(n).State & " " & sck.Count
End Sub
Private Sub sck_DataArrival(Index As Integer, ByVal bytesTotal As Long)
  Dim b() As Byte
  sck(Index).GetData b, vbByte + vbArray
  Debug.Print "from " & Index & " " & (UBound(b) + 1)
  sck(Index).SendData b
End Sub`, [['Winsock', 'sck', {}, 0]]);
  const listen = arr.net.idOf('listen');
  arr.net.request(listen, 1);
  await settle();
  const first = arr.net.idOf('accept');
  arr.net.request(listen, 2);
  await settle();
  const second = arr.net.idOf('accept');
  expect(arr.out).toEqual(['client 1 7 2', 'client 2 7 3']);
  arr.net.data(second, 'abc');
  arr.net.data(first, 'hello');
  await settle();
  expect(arr.out.slice(2)).toEqual(['from 2 3', 'from 1 5']);
  expect(arr.net.sent).toEqual([{ id: second, text: 'abc' }, { id: first, text: 'hello' }]);
  session!.end();
  await settle();
  for (const id of [listen, first, second]) expect(arr.net.calls).toContain(`close ${id}`);
  expect(arr.net.calls.filter(c => c === 'reset')).toHaveLength(2);   // at the start and at the end
});

test('WebBrowser: Navigate raises BeforeNavigate2 (Cancel honoured), sets LocationURL and raises NavigateComplete2 and TitleChange', async () => {
  const net = new FakeNet();
  const { out, p } = await run(`
Private Sub Form_Load()
  WebBrowser1.Navigate "http://blocked.test/"
  Debug.Print "after cancel [" & WebBrowser1.LocationURL & "]"
  WebBrowser1.Navigate "example.test/page"
  Debug.Print "url " & WebBrowser1.LocationURL & " busy " & WebBrowser1.Busy
End Sub
Private Sub WebBrowser1_BeforeNavigate2(ByVal pDisp As Object, URL As Variant, Flags As Variant, TargetFrameName As Variant, PostData As Variant, Headers As Variant, Cancel As Boolean)
  Debug.Print "before " & URL
  If InStr(URL, "blocked") > 0 Then Cancel = True
End Sub
Private Sub WebBrowser1_NavigateComplete2(ByVal pDisp As Object, URL As Variant)
  Debug.Print "complete " & URL & " " & (pDisp Is WebBrowser1) & " busy " & WebBrowser1.Busy
End Sub
Private Sub WebBrowser1_TitleChange(ByVal Text As String)
  Debug.Print "title " & Text & " = " & WebBrowser1.LocationName
End Sub`, [['WebBrowser', 'WebBrowser1']], net);
  const frame = container.querySelector<HTMLIFrameElement>(`[data-control-id="${p.forms[0].controls[0].id}"] iframe`)!;
  expect(frame.getAttribute('src')).toBe('http://example.test/page');
  expect(frame.getAttribute('sandbox')).toBe('allow-scripts allow-forms allow-same-origin');
  frame.dispatchEvent(new Event('load'));   // jsdom does not load http pages
  await settle();
  expect(out).toEqual([
    'before http://blocked.test/', 'after cancel []',
    'before http://example.test/page', 'url http://example.test/page busy True',
    'complete http://example.test/page True busy False',
    'title http://example.test/page = http://example.test/page',   // another site's title cannot be read: the URL
  ]);
  expect(net.calls.some(c => c.includes('example.test'))).toBe(false);   // the page is not fetched a second time for its title
});

test('WebBrowser URLs: http, https and about:blank only, never the app itself', () => {
  expect(webUrl('www.vg.no')).toBe('http://www.vg.no');
  expect(frameSandbox('about:blank', 'tauri://localhost')).toBe('');
  expect(frameSandbox('https://example.com/', 'tauri://localhost')).toContain('allow-scripts');
  for (const bad of ['javascript:alert(1)', 'tauri://localhost/index.html', 'file:///etc/passwd', 'data:text/html,x', 'http://localhost:1420/x']) {
    expect(frameSandbox(bad, 'http://localhost:1420')).toBeNull();
  }
});
