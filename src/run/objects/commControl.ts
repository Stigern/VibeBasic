// Run-time behaviour of MSComm (MSCOMM32.OCX) and SysInfo (SYSINFO.OCX). A ControlObject of one of these types hands property
// reads and writes to the object here (see richControl.ts). MSComm's port calls go through the run's CommSession (the main
// window's backend); OnComm is raised with `raise`, which runs the VB handler and resolves when it has finished.
//
// MSComm: CommPort n is the n-th serial port of the backend's list (the sorted /dev/cu.* devices on a Mac, COMn on Windows). PortName (a VibeBasic extension) names the device itself
// ("/dev/cu.usbmodem1101") and wins over CommPort when it is not empty; setting CommPort clears it.

import type { SysInfoData, SystemApi } from '../../backend/backend';
import { VBRuntimeError } from '../../lang/errors';
import { coerce, toBool, toStr, type VBRef, type VBValue } from '../../lang/values';
import type { PropValue } from '../../model/types';
import { commError, type CommSession } from '../comm';
import type { CommEvent } from '../../backend/backend';
import { byteArray, bytesString, toBytes } from './netControls';
import type { RichControl } from './richControl';

export interface CommHost {
  readonly props: Record<string, PropValue>;
  readonly name: string;
  raise(event: string, args: VBRef[]): Promise<void>;
  /** The run's serial ports; throws 8002 when this host has none. */
  comm(): CommSession;
}

/** OnComm's CommEvent values (comEv*) and the error events (comEvent*) this control raises. */
export const COM_EV = { send: 1, receive: 2, cts: 3, dsr: 4, cd: 5, ring: 6, eof: 7, rxOver: 1008 } as const;

const COMM_TEXT: Record<number, string> = {
  380: 'Invalid property value',
  394: 'Property is write-only',
  8000: 'Operation not valid while the port is opened',
  8002: 'Invalid port number',
  8005: 'Port already open',
  8012: 'The device is not open',
  8018: 'Operation valid only when the port is open',
};
const commErr = (n: number): VBRuntimeError => new VBRuntimeError(n, COMM_TEXT[n]);
/** "9600,n,8,1": baud, parity (n e o m s), data bits 4-8, stop bits 1, 1.5 or 2. The port itself may refuse some (m, s, 4). */
const SETTINGS = /^\s*\d+\s*,\s*[neoms]\s*,\s*[4-8]\s*,\s*(1|1\.5|2)\s*$/i;
const num = (v: VBValue): number => coerce(v, 'Long') as number;
const EMPTY = new Uint8Array(0);

function concat(a: Uint8Array, b: Uint8Array): Uint8Array {
  const out = new Uint8Array(a.length + b.length);
  out.set(a); out.set(b, a.length);
  return out;
}

export class MSCommControl implements RichControl {
  /** The open port's id; -1 when closed. */
  private id = -1;
  private opening = false;
  /** Bumped when the port closes: results of calls made before it are dropped. */
  private gen = 0;
  private session: CommSession | null = null;
  /** The receive buffer (Input reads from it) and the bytes still being written (OutBufferCount). */
  private buf: Uint8Array = EMPTY;
  private pending = 0;
  private ring = false;
  private firing = false;
  private again = false;
  /** Writes and the close go to the backend in order. */
  private chain: Promise<unknown> = Promise.resolve();

  constructor(private h: CommHost) {
    Object.assign(h.props, { PortOpen: false, CommEvent: 0, CDHolding: false, CTSHolding: false, DSRHolding: false,
      InBufferCount: 0, OutBufferCount: 0, Break: false, CommID: 0 });
  }

  private get isOpen(): boolean { return this.id >= 0 && !this.opening; }
  private needOpen(): void { if (!this.isOpen) throw commErr(8018); }

  get(name: string, args: VBValue[]): VBValue | undefined {
    if (args.length) return undefined;
    switch (name) {
      case 'Input': this.needOpen(); return this.input();
      case 'Output': throw commErr(394);
      case 'InBufferCount': this.needOpen(); return this.buf.length;
      case 'OutBufferCount': this.needOpen(); return this.pending;
      case 'CDHolding': case 'CTSHolding': case 'DSRHolding': case 'Break': this.needOpen(); return undefined;
    }
    return undefined;
  }

  set(name: string, value: VBValue): boolean | Promise<void> {
    const p = this.h.props;
    switch (name) {
      case 'PortOpen':
        if (toBool(value)) return this.openPort();
        this.closePort(true);
        return true;
      case 'CommPort': {
        if (this.isOpen || this.opening) throw commErr(8000);
        const n = num(value);
        if (n < 1 || n > 255) throw commErr(8002);
        p.CommPort = n;
        p.PortName = '';
        return true;
      }
      case 'PortName':
        if (this.isOpen || this.opening) throw commErr(8000);
        p.PortName = toStr(value).trim();
        return true;
      case 'Settings': {
        const s = toStr(value);
        if (!SETTINGS.test(s)) throw commErr(380);
        p.Settings = s.replace(/\s+/g, '');
        return this.isOpen ? this.configure() : true;
      }
      case 'Handshaking': {
        const n = num(value);
        if (n < 0 || n > 3) throw commErr(380);
        p.Handshaking = n;
        return this.isOpen ? this.configure() : true;
      }
      case 'InputMode': {
        const n = num(value);
        if (n !== 0 && n !== 1) throw commErr(380);
        p.InputMode = n;
        return true;
      }
      case 'DTREnable': case 'RTSEnable': {
        const v = toBool(value);
        p[name] = v;
        return this.isOpen ? this.lines(name === 'DTREnable' ? v : null, name === 'RTSEnable' ? v : null, null) : true;
      }
      case 'Break': {
        this.needOpen();
        const v = toBool(value);
        p.Break = v;
        return this.lines(null, null, v);
      }
      case 'Output': this.needOpen(); this.output(toBytes(value)); return true;
      case 'InBufferCount':
        this.needOpen();
        if (num(value) !== 0) throw commErr(380);
        this.buf = EMPTY;
        p.InBufferCount = 0;
        return true;
      case 'OutBufferCount':
        this.needOpen();
        if (num(value) !== 0) throw commErr(380);
        return true;   // what was handed to the port is sent anyway
    }
    return false;
  }

  /** PortOpen = True: the port named by PortName, else the CommPort-th port of the backend's list. Errors: 8005 open, 8002 no such port. */
  private async openPort(): Promise<void> {
    if (this.isOpen || this.opening) throw commErr(8005);
    const comm = this.h.comm();
    const p = this.h.props, gen = this.gen;
    this.opening = true;
    try {
      await comm.ready;
      await this.chain.catch(() => {});   // PortOpen = False just before: the device is free only once that close has finished
      let path = String(p.PortName ?? '').trim();
      if (path === '') {
        const ports = await comm.api.commList();
        path = ports[Number(p.CommPort) - 1] ?? '';
        if (path === '') throw commErr(8002);
      }
      if (gen !== this.gen) return;
      const id = comm.port(e => this.onEvent(id, e));
      this.id = id;
      this.buf = EMPTY;   // bytes that arrive while the port opens are kept (OnComm follows once it is open)
      let lines;
      try {
        lines = await comm.api.commOpen(id, path, String(p.Settings ?? '9600,n,8,1'), Number(p.Handshaking) || 0, p.DTREnable === true, p.RTSEnable === true);
      } catch (e) {
        comm.release(id);
        if (this.id === id) { this.id = -1; this.buf = EMPTY; p.InBufferCount = 0; }
        throw commError(e, 8002);
      }
      if (gen !== this.gen) {   // the form unloaded (or the program ended) while it opened
        comm.release(id);
        void comm.api.commClose(id).catch(() => {});
        return;
      }
      this.session = comm;
      this.pending = 0;
      this.ring = lines.ring;
      Object.assign(p, { PortOpen: true, CommID: id, CommEvent: 0, InBufferCount: this.buf.length, OutBufferCount: 0,
        CTSHolding: lines.cts, DSRHolding: lines.dsr, CDHolding: lines.cd });
    } finally {
      this.opening = false;
    }
    if (this.isOpen && this.buf.length) void this.received();
  }

  /** PortOpen = False (8012 when it is not open), or the form unloads (`explicit` false). Like VB6 it clears the transmit
   *  buffer: the close goes out at once and stops a write still waiting on the device (Output not yet started fails with 8018). */
  private closePort(explicit: boolean): void {
    if (!this.isOpen && explicit) throw commErr(8012);
    const id = this.id, comm = this.session;
    this.gen++;
    if (id >= 0 && comm) {
      comm.release(id);
      // a re-open waits for both: the device is free once the close has finished and no write holds it
      this.chain = Promise.all([this.chain.catch(() => {}), comm.api.commClose(id).catch(() => {})]).then(() => {});
    }
    this.closed();
  }

  /** The port is gone: closed by code, unloaded, or unplugged (an `error` event). */
  private closed(): void {
    this.id = -1;
    this.session = null;
    this.buf = EMPTY;
    this.pending = 0;
    this.ring = false;
    Object.assign(this.h.props, { PortOpen: false, CommID: 0, InBufferCount: 0, OutBufferCount: 0,
      CTSHolding: false, DSRHolding: false, CDHolding: false, Break: false });
  }

  private configure(): Promise<void> {
    const comm = this.session!, id = this.id, p = this.h.props;
    return comm.api.commConfigure(id, String(p.Settings), Number(p.Handshaking) || 0).catch(e => { throw commError(e); });
  }

  private lines(dtr: boolean | null, rts: boolean | null, brk: boolean | null): Promise<void> {
    return this.session!.api.commSetLines(this.id, dtr, rts, brk).catch(e => { throw commError(e); });
  }

  /** Output = data: returns at once; with SThreshold > 0, OnComm comEvSend follows once fewer bytes than that wait to be sent. */
  private output(bytes: Uint8Array): void {
    if (bytes.length === 0) return;
    const comm = this.session!, id = this.id, gen = this.gen;
    this.pending += bytes.length;
    this.h.props.OutBufferCount = this.pending;
    const done = (): Promise<void> | undefined => {
      if (gen !== this.gen) return;
      this.pending = Math.max(0, this.pending - bytes.length);
      this.h.props.OutBufferCount = this.pending;
      const st = Number(this.h.props.SThreshold) || 0;
      return st > 0 && this.pending < st ? this.fire(COM_EV.send) : undefined;
    };
    // a failed write (the device went away) is reported by the reader, which closes the port
    this.chain = this.chain.then(() => comm.api.commWrite(id, bytes)).then(done, done);
  }

  /** Input: InputLen bytes (0: all) from the receive buffer, as a String (comInputModeText) or a Byte array (comInputModeBinary).
   *  Fewer than InputLen bytes there: "" and they stay (VB6). */
  private input(): VBValue {
    const len = Number(this.h.props.InputLen) || 0;
    if (len > 0 && this.buf.length < len) return Number(this.h.props.InputMode) === 1 ? byteArray(EMPTY) : '';
    const n = len > 0 ? Math.min(len, this.buf.length) : this.buf.length;
    const out = this.buf.slice(0, n);
    this.buf = this.buf.slice(n);
    this.h.props.InBufferCount = this.buf.length;
    return Number(this.h.props.InputMode) === 1 ? byteArray(out) : bytesString(out);
  }

  private fire(ev: number): Promise<void> {
    this.h.props.CommEvent = ev;
    return this.h.raise('OnComm', []);
  }

  private onEvent(id: number, e: CommEvent): void {
    if (id !== this.id) return;
    const p = this.h.props;
    switch (e.kind) {
      case 'data': {
        let d = e.data;
        if (p.NullDiscard === true) d = d.filter(b => b !== 0);
        if (d.length === 0) return;
        const eof = p.EOFEnable === true && d.includes(26);
        const room = Math.max(0, (Number(p.InBufferSize) || 1024) - this.buf.length);
        const over = d.length > room;
        if (over) d = d.subarray(0, room);
        this.buf = concat(this.buf, d);
        p.InBufferCount = this.buf.length;
        if (over) void this.fire(COM_EV.rxOver);
        if (eof) void this.fire(COM_EV.eof);
        void this.received();
        break;
      }
      case 'lines': {
        const changes: number[] = [];
        if (e.cts !== p.CTSHolding) { p.CTSHolding = e.cts; changes.push(COM_EV.cts); }
        if (e.dsr !== p.DSRHolding) { p.DSRHolding = e.dsr; changes.push(COM_EV.dsr); }
        if (e.cd !== p.CDHolding) { p.CDHolding = e.cd; changes.push(COM_EV.cd); }
        if (e.ring && !this.ring) changes.push(COM_EV.ring);
        this.ring = e.ring;
        void changes.reduce<Promise<void>>((prev, ev) => prev.then(() => this.fire(ev)), Promise.resolve());
        break;
      }
      case 'error':   // reading failed (the device was unplugged): the backend closed the port, PortOpen reads False
        this.session?.release(id);
        this.gen++;
        this.closed();
        break;
    }
  }

  /** OnComm comEvReceive once InBufferCount reaches RThreshold (0: never); data that arrives while the handler runs raises it again. */
  private async received(): Promise<void> {
    if (this.firing) { this.again = true; return; }
    this.firing = true;
    try {
      do {
        this.again = false;
        const rt = Number(this.h.props.RThreshold) || 0;
        if (rt <= 0 || this.buf.length < rt || !this.isOpen) break;
        await this.fire(COM_EV.receive);
      } while (this.again);
    } finally {
      this.firing = false;
    }
  }

  dispose(): void {
    if (this.isOpen || this.opening) this.closePort(false);
  }
}

// -- SysInfo -------------------------------------------------------------------------------------------------------

export interface SysInfoHost {
  readonly props: Record<string, PropValue>;
  raise(event: string, args: VBRef[]): Promise<void>;
  /** Null: the host cannot tell (the values are VB6's "unknown" ones). */
  system(): SystemApi | null;
}

const UNKNOWN: SysInfoData = {
  osVersion: '', osBuild: '', workLeft: 0, workTop: 0, workWidth: 0, workHeight: 0,
  acStatus: 255, batteryLifePercent: 255, batteryLifeTime: -1, batteryFullTime: -1, batteryStatus: 255,
};
/** How long one reading of the system is used (the power state comes from `pmset`). */
const FRESH_MS = 1000;
const DISPLAY_POLL_MS = 2000;
const TWIPS = 15;

type Screenish = { width: number; height: number; availWidth: number; availHeight: number; availLeft?: number; availTop?: number };
const theScreen = (): Screenish | null => (typeof screen !== 'undefined' ? screen as Screenish : null);

/** "15.4.1" -> 15.4 (VB6's OSVersion is major.minor). */
function osVersion(v: string): number {
  const [major, minor] = v.split('.');
  const n = Number(`${Number(major) || 0}.${Number(minor) || 0}`);
  return Number.isFinite(n) ? n : 0;
}

/** The work area in twips: the backend's visible frame of the main screen, else this window's screen. */
function workArea(d: SysInfoData): { left: number; top: number; width: number; height: number } {
  if (d.workWidth > 0 && d.workHeight > 0) return { left: d.workLeft, top: d.workTop, width: d.workWidth, height: d.workHeight };
  const s = theScreen();
  return { left: s?.availLeft ?? 0, top: s?.availTop ?? 0, width: s?.availWidth || s?.width || 1024, height: s?.availHeight || s?.height || 768 };
}

const SYS_FIELDS: Record<string, (d: SysInfoData) => VBValue> = {
  OSVersion: d => osVersion(d.osVersion),
  OSBuild: d => d.osBuild,
  WorkAreaLeft: d => Math.round(workArea(d).left * TWIPS),
  WorkAreaTop: d => Math.round(workArea(d).top * TWIPS),
  WorkAreaWidth: d => Math.round(workArea(d).width * TWIPS),
  WorkAreaHeight: d => Math.round(workArea(d).height * TWIPS),
  ACStatus: d => d.acStatus,
  BatteryFullTime: d => d.batteryFullTime,
  BatteryLifePercent: d => d.batteryLifePercent,
  BatteryLifeTime: d => d.batteryLifeTime,
  BatteryStatus: d => d.batteryStatus,
};

export class SysInfoControl implements RichControl {
  private snap: SysInfoData | null = null;
  private at = 0;
  private loading: Promise<SysInfoData> | null = null;
  private poll: ReturnType<typeof setInterval> | null = null;
  private screenKey = '';

  constructor(private h: SysInfoHost) {
    Object.assign(h.props, { OSPlatform: 2, ScrollBarSize: 16 * TWIPS });   // 2: the NT family
    const s = theScreen();
    if (s) {
      this.screenKey = this.key(s);
      this.poll = setInterval(() => this.checkDisplay(), DISPLAY_POLL_MS);
    }
  }

  private key(s: Screenish): string { return [s.width, s.height, s.availWidth, s.availHeight, s.availLeft ?? 0, s.availTop ?? 0].join('x'); }

  /** DisplayChanged: the screen's size (or its visible frame) changed. */
  private checkDisplay(): void {
    const s = theScreen();
    if (!s) return;
    const k = this.key(s);
    if (k === this.screenKey) return;
    this.screenKey = k;
    this.snap = null;
    void this.h.raise('DisplayChanged', []);
  }

  private data(): Promise<SysInfoData> {
    if (this.snap && performance.now() - this.at < FRESH_MS) return Promise.resolve(this.snap);
    const api = this.h.system();
    if (!api) return Promise.resolve(UNKNOWN);
    return this.loading ??= api.sysInfo().then(d => {
      this.snap = d;
      this.at = performance.now();
      return d;
    }, () => UNKNOWN).finally(() => { this.loading = null; });
  }

  get(name: string, args: VBValue[]): VBValue | undefined {
    const f = SYS_FIELDS[name];
    if (!f || args.length) return undefined;
    return this.data().then(f) as unknown as VBValue;   // the interpreter waits for a Promise
  }

  dispose(): void {
    if (this.poll !== null) clearInterval(this.poll);
    this.poll = null;
  }
}
