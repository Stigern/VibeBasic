// The serial ports of one run (MSComm), opened by the main window through the backend (SerialApi). The session creates it when
// a form first opens a port. It routes the port events to the control that owns the port, and at the end of the program
// (End, or the last form closed) closes every port.

import type { CommEvent, SerialApi } from '../backend/backend';
import { VBRuntimeError } from '../lang/errors';

/** Port ids are unique for the whole page, so a late event of an earlier run never reaches a new port. */
let portSeq = 0;

/** "8002|Invalid port number" (a rejection of the backend) -> VB error number and text. */
export function commError(e: unknown, fallback = 8015): VBRuntimeError {
  if (e instanceof VBRuntimeError) return e;
  const msg = e instanceof Error ? e.message : String(e);
  const m = /^(-?\d+)\|([\s\S]*)$/.exec(msg);
  return m ? new VBRuntimeError(Number(m[1]), m[2]) : new VBRuntimeError(fallback, msg || 'Could not set comm state');
}

export class CommSession {
  private handlers = new Map<number, (e: CommEvent) => void>();
  private unlisten: Promise<() => void>;
  private closed = false;
  /** Resolves once ports left over from an earlier run are closed and the events are heard: every port call waits for it. */
  readonly ready: Promise<void>;

  constructor(readonly api: SerialApi) {
    this.unlisten = api.commReset().catch(() => {}).then(() => api.onCommEvent(e => this.handlers.get(e.id)?.(e)));
    this.ready = this.unlisten.then(() => {}, () => {});
  }

  get ended(): boolean { return this.closed; }

  /** A new port id whose events go to `handler` (until `release`). */
  port(handler: (e: CommEvent) => void): number {
    const id = ++portSeq;
    this.handlers.set(id, handler);
    return id;
  }

  release(id: number): void { this.handlers.delete(id); }

  /** The end of the program: every port closed, no more events. */
  shutdown(): void {
    if (this.closed) return;
    this.closed = true;
    this.handlers.clear();
    void this.unlisten.then(stop => stop(), () => {});
    void this.api.commReset().catch(() => {});
  }
}
