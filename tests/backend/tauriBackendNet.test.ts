import { afterEach, expect, test, vi } from 'vitest';
const { handlers, invoke } = vi.hoisted(() => ({ handlers: new Map<string, (e: any) => void>(), invoke: vi.fn() }));
vi.mock('@tauri-apps/api/core', () => ({ invoke }));
vi.mock('@tauri-apps/api/event', () => ({ listen: async (name: string, callback: (e: any) => void) => { handlers.set(name, callback); return () => handlers.delete(name); } }));
import { TauriBackend } from '../../src/backend/tauriBackend';
afterEach(() => { handlers.clear(); invoke.mockReset(); });

// winsock.rs / comm.rs send only a few Data events ahead of the window: each one handled is acked, other events are not
test('socket and comm data events are acked once handled', async () => {
  invoke.mockResolvedValue(undefined);
  const b = new TauriBackend();
  const got: unknown[] = [];
  await b.onSocketEvent(e => got.push(e));
  await b.onCommEvent(e => got.push(e));
  handlers.get('vb:socket')?.({ payload: { kind: 'data', id: 4, data: 'aGk=', remoteIp: '1.2.3.4', remotePort: 5 } });
  handlers.get('vb:socket')?.({ payload: { kind: 'close', id: 4 } });
  handlers.get('vb:comm')?.({ payload: { kind: 'data', id: 7, data: 'aGk=' } });
  handlers.get('vb:comm')?.({ payload: { kind: 'lines', id: 7, cts: true, dsr: false, cd: false, ring: false } });
  expect(got).toHaveLength(4);
  expect(got[0]).toMatchObject({ kind: 'data', id: 4, data: new Uint8Array([104, 105]) });
  expect(invoke.mock.calls).toEqual([['sock_ack', { id: 4 }], ['comm_ack', { id: 7 }]]);
});

// inet.rs answers with raw bytes: a 4-byte big-endian head length, the JSON head, then the body as is
test('an Inet answer is decoded from its raw head and body', async () => {
  const head = new TextEncoder().encode(JSON.stringify({ status: 404, statusText: 'Not Found', version: 'HTTP/1.1', headers: [['x-a', '1']] }));
  const raw = new Uint8Array(4 + head.length + 3);
  new DataView(raw.buffer).setUint32(0, head.length);
  raw.set(head, 4);
  raw.set([0, 255, 120], 4 + head.length);
  invoke.mockResolvedValue(raw.buffer);
  const res = await new TauriBackend().inetRequest({ id: 'inet-1', url: 'http://h/', method: 'GET', headers: '', body: new Uint8Array([1]), timeoutSecs: 5, userName: '', password: '' });
  expect(res).toEqual({ status: 404, statusText: 'Not Found', version: 'HTTP/1.1', headers: [['x-a', '1']], body: new Uint8Array([0, 255, 120]) });
  expect(invoke.mock.calls[0][0]).toBe('inet_request');
  expect(invoke.mock.calls[0][1]).toMatchObject({ id: 'inet-1', body: 'AQ==', timeoutSecs: 5 });
});

test('a handler that throws still acks', async () => {
  invoke.mockResolvedValue(undefined);
  await new TauriBackend().onSocketEvent(() => { throw new Error('boom'); });
  expect(() => handlers.get('vb:socket')?.({ payload: { kind: 'data', id: 2, data: '', remoteIp: '', remotePort: 0 } })).toThrow('boom');
  expect(invoke.mock.calls).toEqual([['sock_ack', { id: 2 }]]);
});
