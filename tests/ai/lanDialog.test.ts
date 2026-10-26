import { afterEach, expect, test, vi } from 'vitest';
import { parseLanPorts, searchLanDialog } from '../../src/ai/lanDialog';
import type { LanBackend, LanProgress, LanServer } from '../../src/ai/lanTypes';

const server: LanServer = { host: '192.168.1.7', port: 11434, baseUrl: 'http://192.168.1.7:11434/v1', kind: 'Ollama', models: ['qwen'], latencyMs: 3, requiresKey: false };
const button = (name: string) => [...document.querySelectorAll<HTMLButtonElement>('.dlg98 button')].find(b => b.textContent === name)!;
const waitReady = () => vi.waitFor(() => expect(button('Start')?.disabled).toBe(false));
function setup() {
  const settings = new Map<string, unknown>();
  let progress: (p: LanProgress) => void = () => {};
  let signal: AbortSignal | undefined;
  let finish: (s: LanServer[]) => void = () => {};
  const requests: unknown[] = [];
  const backend: LanBackend = {
    aiLanNetworks: async () => [{ interface: 'Wi-Fi', address: '192.168.1.5', network: '192.168.1.0/24', prefix: 24, hostCount: 254, note: '' }],
    aiLanScan: async (request, options) => { requests.push(request); signal = options?.signal; progress = options?.onProgress ?? (() => {}); return new Promise(r => { finish = r; }); },
    loadSettings: async <T>(key: string) => settings.get(key) as T ?? null,
    saveSettings: async (key, value) => { settings.set(key, value); },
  };
  return { backend, requests, settings, progress: (p: LanProgress) => progress(p), finish: (s: LanServer[] = [server]) => finish(s), signal: () => signal };
}
afterEach(() => document.body.replaceChildren());

test('ports accept separators and duplicates, reject empty, invalid and excessive lists', () => {
  expect(parseLanPorts('11434, 1234;8000 8080,1234')).toEqual([11434, 1234, 8000, 8080]);
  for (const value of ['', '0', '-1', '65536', 'abc', '80.5', Array.from({ length: 17 }, (_, i) => i + 1).join(',')]) expect(() => parseLanPorts(value), value).toThrow();
});

test('opening does not scan; Start reports results and Use returns the selected server', async () => {
  const s = setup();
  const result = searchLanDialog(document, s.backend, 'private-key');
  await waitReady();
  expect(s.requests).toEqual([]);
  expect(document.body.textContent).toContain('192.168.1.0/24');
  button('Start').click();
  await vi.waitFor(() => expect(button('Stop').disabled).toBe(false));
  s.progress({ completed: 3, total: 1020, found: 1, server });
  expect(document.body.textContent).toContain('Ollama');
  expect(button('Use').disabled).toBe(true);
  s.finish();
  await vi.waitFor(() => expect(button('Use').disabled).toBe(false));
  button('Use').click();
  expect(await result).toEqual(server);
  expect(s.requests).toEqual([{ networks: ['192.168.1.0/24'], ports: [11434, 1234, 8000, 8080], linkLocal: false }]);
  expect(s.settings.get('aiLan')).toMatchObject({ recent: ['http://192.168.1.7:11434/v1'] });
});

test('Stop and Close abort work; a late result cannot alter a closed dialog', async () => {
  const s = setup();
  const result = searchLanDialog(document, s.backend);
  await waitReady(); button('Start').click();
  await vi.waitFor(() => expect(s.signal()).toBeDefined());
  button('Stop').click();
  expect(s.signal()!.aborted).toBe(true);
  button('Close').click();
  expect(await result).toBeNull();
  s.progress({ completed: 1, total: 1, found: 1, server }); s.finish();
  await Promise.resolve();
  expect(document.querySelector('.dlg98')).toBeNull();
});

test('sending a key requires opting in and invalid ports never start a request', async () => {
  const s = setup(); const result = searchLanDialog(document, s.backend, 'key');
  await waitReady();
  const ports = document.querySelector<HTMLInputElement>('.lan98-ports')!;
  ports.value = '0'; button('Start').click();
  expect(s.requests).toEqual([]);
  expect(document.body.textContent).toContain('1–65535');
  ports.value = '8000';
  document.querySelector<HTMLInputElement>('.lan98-key input')!.click();
  button('Start').click();
  await vi.waitFor(() => expect(s.requests).toHaveLength(1));
  expect(s.requests[0]).toMatchObject({ apiKey: 'key', ports: [8000] });
  button('Close').click(); await result; s.finish();
});

test('slow saved preferences cannot overwrite ports after a scan has started', async () => {
  const s = setup();
  let loaded!: (value: unknown) => void;
  const pending = new Promise(r => { loaded = r; });
  s.backend.loadSettings = async <T>() => await pending as T;
  const result = searchLanDialog(document, s.backend);
  await Promise.resolve(); await Promise.resolve();
  expect(button('Start').disabled).toBe(true);
  loaded({ ports: '8000', recent: [] });
  await waitReady();
  expect(document.querySelector<HTMLInputElement>('.lan98-ports')!.value).toBe('8000');
  button('Close').click(); await result;
});

test('recent servers can be cleared without starting a scan', async () => {
  const s = setup(); s.settings.set('aiLan', { ports: '8000', recent: [server.baseUrl] });
  const result = searchLanDialog(document, s.backend); await waitReady();
  expect(document.querySelector<HTMLElement>('.lan98-recent')!.hidden).toBe(false);
  expect(button('Clear Recent')).toBeDefined(); button('Clear Recent').click();
  await vi.waitFor(() => expect(s.settings.get('aiLan')).toEqual({ ports: '8000', recent: [] }));
  expect(document.querySelector<HTMLElement>('.lan98-recent')!.hidden).toBe(true);
  expect(s.requests).toEqual([]);
  button('Close').click(); await result;
});

test('Tailscale peers are individually listed and included only when selected', async () => {
  const s = setup(); const local = s.backend.aiLanNetworks;
  s.backend.aiLanNetworks = async (linkLocal, tailscale) => [
    ...await local(linkLocal),
    ...(tailscale ? [{ interface: 'Tailscale: ai-box', address: '100.100.2.3', network: '100.100.2.3/32', prefix: 32, hostCount: 1, note: 'known peer' }] : []),
  ];
  const result = searchLanDialog(document, s.backend); await waitReady();
  const toggle = document.querySelector<HTMLInputElement>('.lan98-tailscale input');
  expect(toggle).not.toBeNull(); expect(toggle!.checked).toBe(false); toggle!.click();
  await vi.waitFor(() => expect(document.body.textContent).toContain('100.100.2.3/32'));
  button('Start').click();
  await vi.waitFor(() => expect(s.requests).toHaveLength(1));
  expect(s.requests[0]).toMatchObject({ networks: ['192.168.1.0/24', '100.100.2.3/32'], tailscale: true });
  button('Close').click(); await result; s.finish();
});

test('unavailable Tailscale leaves LAN discovery usable and reports how to reconnect', async () => {
  const s = setup(); const local = s.backend.aiLanNetworks;
  s.backend.aiLanNetworks = async (linkLocal, tailscale) => {
    if (tailscale) throw new Error('Open Tailscale and connect, then try again.');
    return local(linkLocal);
  };
  const result = searchLanDialog(document, s.backend); await waitReady();
  const toggle = document.querySelector<HTMLInputElement>('.lan98-tailscale input');
  expect(toggle).not.toBeNull(); toggle!.click();
  await vi.waitFor(() => expect(document.body.textContent).toContain('Tailscale unavailable'));
  expect(toggle!.checked).toBe(false); expect(button('Start').disabled).toBe(false);
  expect(document.body.textContent).toContain('192.168.1.0/24');
  button('Close').click(); await result;
});

test('a previously chosen Tailscale server remains available in Recent without scanning', async () => {
  const s = setup(); s.settings.set('aiLan', { ports: '8000', recent: ['http://100.100.2.3:8000/v1'] });
  const result = searchLanDialog(document, s.backend); await waitReady();
  expect(document.querySelector<HTMLElement>('.lan98-recent')!.hidden).toBe(false);
  button('Use Recent').click();
  expect(await result).toMatchObject({ baseUrl: 'http://100.100.2.3:8000/v1' });
  expect(s.requests).toEqual([]);
});
