// Run-time behaviour of Winsock (MSWINSCK.OCX), Inet (MSINET.OCX) and WebBrowser (SHDOCVW.DLL). A ControlObject of
// one of these types hands its methods (and a few property writes) to the object here. The network calls go through
// the run's NetSession (the main window's backend); events are raised with `raise`, which runs the VB handler (nested
// when code is waiting, like a Timer event) and resolves when it has finished.

import type { SocketEvent, SocketInfo } from '../../backend/backend';
import { VBRuntimeError } from '../../lang/errors';
import { Empty, VBArray, VBRef, coerce, toBool, toStr, type VBValue } from '../../lang/values';
import type { OutSlot, VBObject } from '../../lang/host';
import type { PropValue } from '../../model/types';
import { frameSandbox } from '../../controls/webBrowser';
import { netError, type NetSession } from '../net';

export interface NetHost {
  readonly props: Record<string, PropValue>;
  readonly name: string;
  /** The control itself (the pDisp argument of the WebBrowser events). */
  readonly self: VBObject;
  raise(event: string, args: VBRef[]): Promise<void>;
  /** The run's network; throws when this host has none. */
  net(): NetSession;
  /** WebBrowser: a patch for its view. */
  send(props: Record<string, PropValue>): void;
}

export interface NetControl {
  /** Undefined: not a method of this object (the ControlObject handles it). */
  call(name: string, args: VBValue[], refs?: (OutSlot | undefined)[]): VBValue | Promise<VBValue> | undefined;
  /** A property write by code; false lets the ControlObject store it as usual (after a check that may throw). */
  set?(name: string, value: PropValue): boolean;
  /** State the window reported (WebBrowser: a page loaded). */
  applyState?(props: Record<string, PropValue>): void;
  readonly byRef?: Readonly<Record<string, readonly number[]>>;
  /** The form unloads or the program ends. */
  dispose(): void;
}

const arg = (args: VBValue[], i: number): VBValue | undefined => (args[i] === undefined || args[i] === Empty ? undefined : args[i]);
const num = (v: VBValue): number => coerce(v, 'Long') as number;

// -- bytes and strings ---------------------------------------------------------------------------------------------

/** A VB string as bytes, one per character (VB6's ANSI conversion; characters above 255 become "?"). */
export function stringBytes(s: string): Uint8Array {
  const out = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i++) { const c = s.charCodeAt(i); out[i] = c < 256 ? c : 63; }
  return out;
}
export function bytesString(b: Uint8Array): string {
  let s = '';
  for (let i = 0; i < b.length; i += 0x8000) s += String.fromCharCode(...b.subarray(i, i + 0x8000));
  return s;
}
function byteArray(b: Uint8Array): VBArray {
  const a = new VBArray('Byte', [[0, b.length - 1]]);
  b.forEach((x, i) => a.set([i], x));
  return a;
}
/** SendData / Execute data: a Byte array as it is, anything else as its string. */
function toBytes(v: VBValue): Uint8Array {
  if (v instanceof VBArray) return Uint8Array.from(v.values(), x => Number(x) & 255);
  return stringBytes(toStr(v));
}
function concat(a: Uint8Array, b: Uint8Array): Uint8Array {
  const out = new Uint8Array(a.length + b.length);
  out.set(a); out.set(b, a.length);
  return out;
}

// -- Winsock -------------------------------------------------------------------------------------------------------

export const SCK = { closed: 0, open: 1, listening: 2, pending: 3, resolving: 4, resolved: 5, connecting: 6, connected: 7, closing: 8, error: 9 } as const;
const TCP = 0;
const VB_ARRAY = 8192, VB_BYTE = 17;
const invalidOp = (): VBRuntimeError => new VBRuntimeError(40020, 'Invalid operation at current state');
const badState = (): VBRuntimeError => new VBRuntimeError(40006, 'Wrong protocol or connection state for the requested transaction or request');

export class WinsockControl implements NetControl {
  readonly byRef = { getdata: [0], peekdata: [0] };
  private id = -1;
  /** Bumped by Close: results of calls made before it are dropped. */
  private gen = 0;
  /** TCP: the receive buffer. UDP: the datagrams not read yet. */
  private buf: Uint8Array = new Uint8Array(0);
  private grams: { data: Uint8Array; ip: string; port: number }[] = [];
  /** Data that arrived before Connect / Accept had finished. */
  private early: SocketEvent[] | null = null;
  private firing = false;
  private again = false;
  /** Sends and closes go to the backend in order. */
  private chain: Promise<unknown> = Promise.resolve();

  constructor(private h: NetHost) {
    const p = h.props;
    Object.assign(p, { State: SCK.closed, BytesReceived: 0, SocketHandle: -1, RemoteHostIP: '' });
    try { void h.net().localIp().then(ip => { p.LocalIP = ip; }); } catch { /* no network here: 127.0.0.1 */ }
  }

  private get state(): number { return Number(this.h.props.State); }
  private set state(v: number) { this.h.props.State = v; }
  private get udp(): boolean { return Number(this.h.props.Protocol) !== TCP; }

  set(name: string): boolean {
    if ((name === 'Protocol' || name === 'LocalPort') && this.state !== SCK.closed) throw invalidOp();
    return false;
  }

  call(name: string, args: VBValue[], refs?: (OutSlot | undefined)[]): VBValue | Promise<VBValue> | undefined {
    switch (name) {
      case 'connect': return this.connect(args);
      case 'listen': return this.listen();
      case 'accept': return this.accept(args);
      case 'bind': return this.bind(args);
      case 'senddata': return this.sendData(args);
      case 'getdata': case 'peekdata': return this.getData(args, refs?.[0], name === 'peekdata');
      case 'close': this.close(); return Empty;
    }
    return undefined;
  }

  private open(): { net: NetSession; id: number; gen: number } {
    const net = this.h.net();
    this.id = net.socket(e => this.onEvent(e));
    this.h.props.SocketHandle = this.id;
    this.buf = new Uint8Array(0);
    this.grams = [];
    this.updateCount();
    return { net, id: this.id, gen: this.gen };
  }

  private took(info: SocketInfo): void {
    const p = this.h.props;
    if (info.localPort) p.LocalPort = info.localPort;
    if (info.remoteIp) p.RemoteHostIP = info.remoteIp;
  }

  /** Connect [RemoteHost], [RemotePort]: returns at once; Connect or Error follows. */
  private connect(args: VBValue[]): VBValue {
    if (this.state !== SCK.closed) throw invalidOp();
    if (this.udp) throw badState();
    const p = this.h.props;
    if (arg(args, 0) !== undefined) p.RemoteHost = toStr(args[0]);
    if (arg(args, 1) !== undefined) p.RemotePort = num(args[1]);
    const host = String(p.RemoteHost ?? ''), port = Number(p.RemotePort);
    const { net, id, gen } = this.open();
    this.state = SCK.connecting;
    this.early = [];
    void net.ready.then(() => net.api.sockConnect(id, host, port)).then(info => {
      if (gen !== this.gen) { this.dropStale(net, id); return; }   // Close (or End) came while connecting: the late connection goes too
      this.took(info);
      p.RemotePort = info.remotePort;
      this.state = SCK.connected;
      void this.h.raise('Connect', []).then(() => this.flushEarly());
    }, e => {
      if (gen !== this.gen) return;
      this.early = null;
      this.state = SCK.error;
      const err = netError(e);
      void this.raiseError(err.number, err.description);
    });
    return Empty;
  }

  /** Listen: TCP, on LocalPort (0: a free port, which LocalPort then holds). An error (10048 Address in use) is raised here. */
  private async listen(): Promise<VBValue> {
    if (this.state !== SCK.closed) throw invalidOp();
    if (this.udp) throw badState();
    const { net, id, gen } = this.open();
    this.state = SCK.listening;
    try {
      await net.ready;
      const info = await net.api.sockListen(id, Number(this.h.props.LocalPort), '');
      if (gen === this.gen) this.took(info); else this.dropStale(net, id);
    } catch (e) {
      if (gen === this.gen) this.reset();
      throw netError(e);
    }
    return Empty;
  }

  /** Accept requestID (in ConnectionRequest): this control takes the connection; it must be closed first. */
  private async accept(args: VBValue[]): Promise<VBValue> {
    if (arg(args, 0) === undefined) throw new VBRuntimeError(450);
    if (this.state !== SCK.closed) throw invalidOp();
    const requestId = num(args[0]);
    const { net, id, gen } = this.open();
    this.state = SCK.connecting;
    this.early = [];
    try {
      await net.ready;
      const info = await net.api.sockAccept(id, requestId);
      if (gen !== this.gen) { this.dropStale(net, id); return Empty; }
      this.took(info);
      this.h.props.RemotePort = info.remotePort;
      this.state = SCK.connected;
      this.flushEarly();
    } catch (e) {
      if (gen === this.gen) this.reset();
      throw netError(e, 40006);
    }
    return Empty;
  }

  /** Bind [LocalPort], [LocalIP]: UDP opens the port (State sckOpen); TCP just keeps LocalPort. */
  private async bind(args: VBValue[]): Promise<VBValue> {
    if (this.state !== SCK.closed) throw invalidOp();
    if (arg(args, 0) !== undefined) this.h.props.LocalPort = num(args[0]);
    if (!this.udp) return Empty;
    await this.openUdp(arg(args, 1) !== undefined ? toStr(args[1]) : '');
    return Empty;
  }

  private async openUdp(ip: string): Promise<void> {
    const { net, id, gen } = this.open();
    this.state = SCK.open;
    try {
      await net.ready;
      const info = await net.api.sockBind(id, Number(this.h.props.LocalPort), ip);
      if (gen === this.gen) this.took(info); else this.dropStale(net, id);
    } catch (e) {
      if (gen === this.gen) this.reset();
      throw netError(e);
    }
  }

  /** SendData data: returns at once; SendProgress and SendComplete follow (Error when it fails). */
  private async sendData(args: VBValue[]): Promise<VBValue> {
    if (arg(args, 0) === undefined) throw new VBRuntimeError(450);
    const bytes = toBytes(args[0]);
    const p = this.h.props;
    if (this.udp) {
      if (String(p.RemoteHost ?? '') === '') throw badState();
      if (this.state === SCK.closed) await this.openUdp('');   // VB6 binds a UDP socket on its first SendData
      if (this.state !== SCK.open) throw badState();
    } else if (this.state !== SCK.connected) throw badState();
    const net = this.h.net(), id = this.id, gen = this.gen;
    const host = String(p.RemoteHost ?? ''), port = Number(p.RemotePort);
    this.chain = this.chain.then(() => net.api.sockSend(id, bytes, this.udp ? host : '', this.udp ? port : 0)).then(async () => {
      if (gen !== this.gen) return;
      await this.h.raise('SendProgress', [new VBRef(bytes.length), new VBRef(0)]);
      await this.h.raise('SendComplete', []);
    }, e => {
      if (gen !== this.gen) return;
      const err = netError(e);
      return this.raiseError(err.number, err.description);
    });
    return Empty;
  }

  /** GetData / PeekData data, [type], [maxLen]: a String (vbString, or a String variable) or a Byte array (vbByte + vbArray, or an array variable). */
  private getData(args: VBValue[], out: OutSlot | undefined, peek: boolean): VBValue {
    if (args.length === 0) throw new VBRuntimeError(450);
    const type = arg(args, 1) !== undefined ? num(args[1]) : undefined;
    const max = arg(args, 2) !== undefined ? num(args[2]) : Infinity;
    let bytes: Uint8Array;
    if (this.udp) {
      const g = this.grams[0];
      bytes = g ? g.data.slice(0, Math.min(g.data.length, max)) : new Uint8Array(0);
      if (g && !peek) this.grams.shift();
    } else {
      const n = Math.min(this.buf.length, max);
      bytes = this.buf.slice(0, n);
      if (!peek) this.buf = this.buf.slice(n);
    }
    this.updateCount();
    const asBytes = type !== undefined ? type === VB_ARRAY + VB_BYTE || type === VB_BYTE : out?.value instanceof VBArray;
    if (out) out.value = asBytes ? byteArray(bytes) : bytesString(bytes);
    return Empty;
  }

  /** Close: the socket (connection, listener or UDP port) is closed; State is sckClosed again. */
  close(): void {
    const id = this.id;
    this.gen++;
    if (id >= 0) {
      let net: NetSession | null = null;
      try { net = this.h.net(); } catch { /* none */ }
      if (net) {
        const n = net;
        n.release(id);
        this.chain = this.chain.then(() => n.api.sockClose(id)).catch(() => {});
      }
    }
    this.reset();
  }

  /** A socket that opened after this control was closed (Close or End during Connect, Accept, Listen or Bind): nobody owns it. */
  private dropStale(net: NetSession, id: number): void {
    net.release(id);
    void net.api.sockClose(id).catch(() => {});
  }

  private reset(): void {
    this.id = -1;
    this.early = null;
    this.buf = new Uint8Array(0);
    this.grams = [];
    Object.assign(this.h.props, { State: SCK.closed, SocketHandle: -1, BytesReceived: 0 });
  }

  dispose(): void { this.close(); }

  private updateCount(): void {
    this.h.props.BytesReceived = this.udp ? this.grams[0]?.data.length ?? 0 : this.buf.length;
  }

  private flushEarly(): void {
    const early = this.early ?? [];
    this.early = null;
    for (const e of early) this.onEvent(e);
  }

  private onEvent(e: SocketEvent): void {
    if (this.early && e.kind !== 'connectionRequest') { this.early.push(e); return; }
    const p = this.h.props;
    switch (e.kind) {
      case 'data':
        if (this.udp) {
          this.grams.push({ data: e.data, ip: e.remoteIp, port: e.remotePort });
          p.RemoteHostIP = e.remoteIp;
          p.RemotePort = e.remotePort;
        } else this.buf = concat(this.buf, e.data);
        this.updateCount();
        void this.arrived();
        break;
      case 'connectionRequest':
        p.RemoteHostIP = e.remoteIp;
        p.RemotePort = e.remotePort;
        void this.h.raise('ConnectionRequest', [new VBRef(e.requestId)]);
        break;
      case 'close':
        if (this.state === SCK.connected) this.state = SCK.closing;
        void this.h.raise('Close', []);
        break;
      case 'error':
        this.state = SCK.error;
        void this.raiseError(e.number, e.description);
        break;
    }
  }

  /** DataArrival(bytesTotal); data that arrives while the handler runs raises it once more afterwards. */
  private async arrived(): Promise<void> {
    if (this.firing) { this.again = true; return; }
    this.firing = true;
    try {
      do {
        this.again = false;
        const total = Number(this.h.props.BytesReceived);
        if (total === 0) break;
        await this.h.raise('DataArrival', [new VBRef(total)]);
      } while (this.again);
    } finally {
      this.firing = false;
    }
  }

  private raiseError(number: number, description: string): Promise<void> {
    const scode = (0x800a0000 | number) | 0;
    return this.h.raise('Error', [number, description, scode, this.h.name, '', 0, false].map(v => new VBRef(v)));
  }
}

// -- Inet ----------------------------------------------------------------------------------------------------------

const IC_ERROR = 11, IC_COMPLETED = 12;
const PROTOCOLS: Record<string, number> = { 'ftp:': 2, 'http:': 4, 'https:': 5 };

/** The text of a response body: its charset (Content-Type), else UTF-8. */
function bodyText(body: Uint8Array, headers: [string, string][]): string {
  const ct = headers.find(([k]) => k.toLowerCase() === 'content-type')?.[1] ?? '';
  const cs = /charset=["']?([\w-]+)/i.exec(ct)?.[1] ?? 'utf-8';
  try { return new TextDecoder(cs).decode(body); } catch { return new TextDecoder().decode(body); }
}

export class InetControl implements NetControl {
  private request: string | null = null;
  private body: Uint8Array = new Uint8Array(0);
  private text: string | null = null;
  private bytePos = 0;
  private textPos = 0;
  private headers: [string, string][] = [];
  private statusLine = '';

  constructor(private h: NetHost) {
    Object.assign(h.props, { StillExecuting: false, ResponseCode: 0, ResponseInfo: '' });
    this.parseUrl(String(h.props.URL ?? ''));
  }

  /** URL = "...": Protocol, RemoteHost, RemotePort and Document follow it. */
  set(name: string, value: PropValue): boolean {
    if (name === 'URL') this.parseUrl(String(value ?? ''));
    return false;
  }

  private parseUrl(url: string): void {
    let u: URL;
    try { u = new URL(url); } catch { return; }
    const p = this.h.props;
    p.Protocol = PROTOCOLS[u.protocol] ?? 0;
    p.RemoteHost = u.hostname;
    p.RemotePort = u.port ? Number(u.port) : u.protocol === 'https:' ? 443 : u.protocol === 'ftp:' ? 21 : 80;
    p.Document = u.pathname + u.search;
  }

  call(name: string, args: VBValue[]): VBValue | Promise<VBValue> | undefined {
    switch (name) {
      case 'openurl': return this.openUrl(args);
      case 'execute': return this.execute(args);
      case 'getchunk': return this.getChunk(args);
      case 'getheader': return this.getHeader(args);
      case 'cancel': this.cancel(); return Empty;
    }
    return undefined;
  }

  private target(args: VBValue[]): string {
    if (arg(args, 0) !== undefined) {
      const url = toStr(args[0]);
      this.h.props.URL = url;
      this.parseUrl(url);
    }
    const url = String(this.h.props.URL ?? '');
    if (url === '') throw new VBRuntimeError(35752, 'URL is malformed');
    return url;
  }

  private send(url: string, method: string, data: Uint8Array, headers: string) {
    const net = this.h.net(), p = this.h.props, id = net.requestId();
    this.request = id;
    const req = net.ready.then(() => net.api.inetRequest({
      id, url, method, headers, body: data, timeoutSecs: Number(p.RequestTimeout) || 0,
      userName: String(p.UserName ?? ''), password: String(p.Password ?? ''),
    }));
    return { id, req };
  }

  private keep(r: { status: number; statusText: string; version: string; headers: [string, string][]; body: Uint8Array }): void {
    this.body = r.body;
    this.text = null;
    this.bytePos = this.textPos = 0;
    this.headers = r.headers;
    const v = r.version.replace(/^HTTP_/, 'HTTP/').replace('_', '.');
    this.statusLine = `${v} ${r.status} ${r.statusText}`.trim();
  }

  /** OpenURL [URL], [icString | icByteArray]: waits for the whole document (GET) and returns it. */
  private async openUrl(args: VBValue[]): Promise<VBValue> {
    if (this.h.props.StillExecuting === true) throw new VBRuntimeError(35764, 'Still executing last request');
    const url = this.target(args);
    const asBytes = arg(args, 1) !== undefined && num(args[1]) === 1;
    const { id, req } = this.send(url, 'GET', new Uint8Array(0), '');
    try {
      const r = await req;
      this.keep(r);
      return asBytes ? byteArray(r.body) : bodyText(r.body, r.headers);
    } catch (e) {
      throw netError(e, 35756);
    } finally {
      if (this.request === id) this.request = null;
    }
  }

  /** Execute [URL], [Operation], [InputData], [InputHdrs]: returns at once; StateChanged follows with icResponseCompleted or icError. */
  private execute(args: VBValue[]): VBValue {
    const p = this.h.props;
    if (p.StillExecuting === true) throw new VBRuntimeError(35764, 'Still executing last request');
    const url = this.target(args);
    const method = arg(args, 1) !== undefined ? toStr(args[1]).trim().toUpperCase() || 'GET' : 'GET';
    if (!['GET', 'HEAD', 'POST', 'PUT', 'DELETE'].includes(method)) throw new VBRuntimeError(35753, 'Protocol not supported for this method');
    const data = arg(args, 2) !== undefined ? (args[2] instanceof VBArray ? toBytes(args[2]) : new TextEncoder().encode(toStr(args[2]))) : new Uint8Array(0);
    const headers = arg(args, 3) !== undefined ? toStr(args[3]) : '';
    Object.assign(p, { StillExecuting: true, ResponseCode: 0, ResponseInfo: '' });
    this.keep({ status: 0, statusText: '', version: '', headers: [], body: new Uint8Array(0) });
    this.statusLine = '';
    const { id, req } = this.send(url, method, data, headers);
    void req.then(r => {
      if (this.request !== id) return;
      this.request = null;
      this.keep(r);
      p.StillExecuting = false;
      return this.h.raise('StateChanged', [new VBRef(IC_COMPLETED)]);
    }, e => {
      if (this.request !== id) return;   // cancelled
      this.request = null;
      const err = netError(e, 35756);
      Object.assign(p, { StillExecuting: false, ResponseCode: err.number, ResponseInfo: err.description });
      return this.h.raise('StateChanged', [new VBRef(IC_ERROR)]);
    });
    return Empty;
  }

  /** GetChunk(Size, [icString | icByteArray]): the next part of the answer of Execute; "" (or an empty array) at the end. */
  private getChunk(args: VBValue[]): VBValue {
    if (arg(args, 0) === undefined) throw new VBRuntimeError(450);
    const size = Math.max(0, num(args[0]));
    if (arg(args, 1) !== undefined && num(args[1]) === 1) {
      const b = this.body.slice(this.bytePos, this.bytePos + size);
      this.bytePos += b.length;
      return byteArray(b);
    }
    this.text ??= bodyText(this.body, this.headers);
    const s = this.text.slice(this.textPos, this.textPos + size);
    this.textPos += s.length;
    return s;
  }

  /** GetHeader([HdrName]): one header's value, or all of them with the status line, CR LF separated. */
  private getHeader(args: VBValue[]): VBValue {
    if (arg(args, 0) !== undefined) {
      const n = toStr(args[0]).toLowerCase();
      return this.headers.filter(([k]) => k.toLowerCase() === n).map(([, v]) => v).join(', ');
    }
    if (!this.statusLine) return '';
    return [this.statusLine, ...this.headers.map(([k, v]) => `${k}: ${v}`)].join('\r\n') + '\r\n\r\n';
  }

  cancel(): void {
    const id = this.request;
    this.request = null;
    this.h.props.StillExecuting = false;
    if (id === null) return;
    try { void this.h.net().api.inetCancel(id).catch(() => {}); } catch { /* none */ }
  }

  dispose(): void { this.cancel(); }
}

// -- WebBrowser ----------------------------------------------------------------------------------------------------

/** "www.x.no" -> "http://www.x.no" (as IE did); about:blank as it is. */
export function webUrl(url: string): string {
  const u = url.trim();
  if (/^about:/i.test(u) || /^[a-z][a-z0-9+.-]*:/i.test(u)) return u;
  return `http://${u}`;
}

const failed = (method: string): VBRuntimeError => new VBRuntimeError(-2147467259, `Method '${method}' of object 'IWebBrowser2' failed`);

export class WebBrowserControl implements NetControl {
  private history: string[] = [];
  private at = -1;
  private seq = 0;
  /** The NavSeq whose load is still to be reported, and whether it is a Refresh (DocumentComplete only). */
  private waiting = 0;
  private refreshing = false;

  constructor(private h: NetHost) {
    Object.assign(h.props, { LocationURL: '', LocationName: '', Busy: false });
  }

  call(name: string, args: VBValue[]): VBValue | Promise<VBValue> | undefined {
    switch (name) {
      case 'navigate': case 'navigate2': {
        if (arg(args, 0) === undefined) throw new VBRuntimeError(450);
        return this.navigate(webUrl(toStr(args[0])), true, args);
      }
      case 'goback': case 'goforward': {
        const to = this.at + (name === 'goback' ? -1 : 1);
        if (to < 0 || to >= this.history.length) throw failed(name === 'goback' ? 'GoBack' : 'GoForward');
        return this.navigate(this.history[to], false, [], to);
      }
      case 'gohome': return this.navigate('about:blank', true, []);
      case 'refresh': {
        const url = String(this.h.props.LocationURL ?? '');
        if (url) this.show(url, true);
        return Empty;
      }
      case 'stop':
        this.waiting = 0;
        this.h.props.Busy = false;
        return Empty;
    }
    return undefined;
  }

  /** BeforeNavigate2 (Cancel = True stops it), then the page is loaded in the window. */
  private async navigate(url: string, push: boolean, args: VBValue[], historyAt = -1): Promise<VBValue> {
    if (frameSandbox(url, globalThis.location?.origin ?? '') === null) throw new VBRuntimeError(5, 'Invalid procedure call or argument');   // http, https and about:blank only
    const cancel = new VBRef(false);
    const opt = (i: number): VBValue => arg(args, i) ?? Empty;
    await this.h.raise('BeforeNavigate2', [this.h.self, url, opt(1), opt(2), opt(3), opt(4)].map(v => new VBRef(v)).concat(cancel));
    if (toBool(cancel.value)) return Empty;
    if (push) {
      this.history.splice(this.at + 1);
      this.history.push(url);
      this.at = this.history.length - 1;
    } else this.at = historyAt;
    this.show(url, false);
    void this.h.raise('StatusTextChange', [new VBRef(`Opening page ${url}...`)]);
    return Empty;
  }

  private show(url: string, refresh: boolean): void {
    const p = this.h.props;
    this.seq++;
    this.waiting = this.seq;
    this.refreshing = refresh;
    Object.assign(p, { LocationURL: url, Busy: true, Src: url, NavSeq: this.seq });   // Src / NavSeq also go into a window opened later
    if (!refresh) p.LocationName = url;
    this.h.send({ Src: url, NavSeq: this.seq });
  }

  /** The window: the page of NavSeq `Loaded` is there (`LoadedTitle`: its title, when the window could read it). */
  applyState(props: Record<string, PropValue>): void {
    if (!('Loaded' in props) || Number(props.Loaded) !== this.waiting || this.waiting === 0) return;
    this.waiting = 0;
    void this.completed(String(this.h.props.LocationURL ?? ''), this.refreshing, typeof props.LoadedTitle === 'string' ? props.LoadedTitle : '');
  }

  /** LocationName is the page's title only when the window could read it (never for another site's page): else the URL. The page is
   *  never fetched a second time to find its title (that would repeat a GET with side effects, without the frame's cookies). */
  private async completed(url: string, refresh: boolean, title: string): Promise<void> {
    const p = this.h.props, seq = this.seq;
    p.Busy = false;
    if (!refresh) await this.h.raise('NavigateComplete2', [new VBRef(this.h.self), new VBRef(url)]);
    await this.h.raise('DocumentComplete', [new VBRef(this.h.self), new VBRef(url)]);
    await this.h.raise('StatusTextChange', [new VBRef('Done')]);
    if (refresh || seq !== this.seq) return;
    p.LocationName = title.trim() || url;
    await this.h.raise('TitleChange', [new VBRef(p.LocationName)]);
  }

  dispose(): void { this.waiting = 0; }
}
