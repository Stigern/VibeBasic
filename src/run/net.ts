// The network of one run: Winsock sockets and Inet requests, made by the main window through the backend (NetApi).
// The session creates it when a form first has an Inet, Winsock or WebBrowser control. It routes the socket events to
// the socket that owns them, and at the end of the program (End, or the last form closed) closes every socket and
// aborts every request.

import type { NetApi, SocketEvent } from '../backend/backend';
import { VBRuntimeError } from '../lang/errors';

/** Socket and request ids are unique for the whole page, so a late event of an earlier run never reaches a new socket. */
let socketSeq = 0;
let requestSeq = 0;

/** "10061|Connection is forcefully rejected" (a rejection of the backend) -> VB error number and text. */
export function netError(e: unknown, fallback = 10050): VBRuntimeError {
  const msg = e instanceof Error ? e.message : String(e);
  const m = /^(-?\d+)\|([\s\S]*)$/.exec(msg);
  return m ? new VBRuntimeError(Number(m[1]), m[2]) : new VBRuntimeError(fallback, msg || 'Network error');
}

export class NetSession {
  private handlers = new Map<number, (e: SocketEvent) => void>();
  private unlisten: Promise<() => void>;
  private ip: Promise<string> | null = null;
  private closed = false;
  /** Resolves once sockets left over from an earlier run are gone and the events are heard: every socket call waits for it. */
  readonly ready: Promise<void>;

  constructor(readonly api: NetApi) {
    this.unlisten = api.netReset().catch(() => {}).then(() => api.onSocketEvent(e => this.handlers.get(e.id)?.(e)));
    this.ready = this.unlisten.then(() => {}, () => {});
  }

  get ended(): boolean { return this.closed; }

  /** A new socket id whose events go to `handler` (until `release`). */
  socket(handler: (e: SocketEvent) => void): number {
    const id = ++socketSeq;
    this.handlers.set(id, handler);
    return id;
  }

  release(id: number): void {
    this.handlers.delete(id);
  }

  requestId(): string { return `inet-${++requestSeq}`; }

  /** The Mac's network address (Winsock.LocalIP). */
  localIp(): Promise<string> {
    return this.ip ??= this.api.netLocalIp().catch(() => '127.0.0.1');
  }

  /** The end of the program: every socket closed, every request aborted, no more events. */
  shutdown(): void {
    if (this.closed) return;
    this.closed = true;
    this.handlers.clear();
    void this.unlisten.then(stop => stop(), () => {});
    void this.api.netReset().catch(() => {});
  }
}
