import type { LanBackend, LanNetwork, LanServer } from './lanTypes';
import { h } from '../ui98/dom';
import { showDialog98 } from '../ui98/dialogs';
import { check, field } from '../ide/projectDialogs';
import './lanDialog.css';

const DEFAULT_PORTS = '11434, 1234, 8000, 8080';
interface LanPreferences { ports: string; recent: string[] }

export function parseLanPorts(value: string): number[] {
  const parts = value.trim().split(/[\s,;]+/).filter(Boolean);
  if (!parts.length) throw new Error('Enter at least one port (1–65535).');
  if (parts.some(p => !/^\d+$/.test(p) || Number(p) < 1 || Number(p) > 65535)) throw new Error('Ports must be whole numbers from 1–65535.');
  const ports = [...new Set(parts.map(Number))];
  if (ports.length > 16) throw new Error('Enter at most 16 ports.');
  return ports;
}

/** Opening only reads local interfaces/settings. Start is the sole entry point for network traffic. */
export async function searchLanDialog(doc: Document, backend: LanBackend, apiKey = ''): Promise<LanServer | null> {
  let alive = true, running = false, loading = true, preferencesReady = false, networkTurn = 0, scanTurn = 0;
  let saving = Promise.resolve();
  let controller: AbortController | undefined, selected: LanServer | undefined, chosen: LanServer | null = null;
  let preferences: LanPreferences = { ports: DEFAULT_PORTS, recent: [] };
  let networks: { network: LanNetwork; input: HTMLInputElement }[] = [];
  const servers = new Map<string, LanServer>();
  const ports = h('input', { type: 'text', value: DEFAULT_PORTS, class: 'lan98-ports', 'aria-label': 'Ports' });
  const link = check('Include link-local networks (169.254.x.x)', false);
  const tailscale = check('Include Tailscale peers', false);
  tailscale.el.classList.add('lan98-tailscale');
  const key = check('Use API key when searching', false);
  key.el.classList.add('lan98-key'); key.input.disabled = !apiKey.trim();
  const networkList = h('div', { class: 'lan98-networks', role: 'group', 'aria-label': 'Networks to scan' });
  const summary = h('div', { class: 'lan98-summary' });
  const status = h('div', { class: 'lan98-status', role: 'status' }, 'Loading local networks...');
  const progress = h('progress', { max: '1', value: '0', 'aria-label': 'Search progress' });
  const results = h('div', { class: 'lan98-results', role: 'listbox', 'aria-label': 'Servers found', tabindex: '0' });
  const details = h('div', { class: 'lan98-details' });
  const start = h('button', { type: 'button', disabled: true }, 'Start');
  const stop = h('button', { type: 'button', disabled: true }, 'Stop');
  const use = h('button', { type: 'button', disabled: true }, 'Use');
  const recent = h('select', { 'aria-label': 'Recent servers' });
  const useRecent = h('button', { type: 'button', disabled: true }, 'Use Recent');
  const clearRecent = h('button', { type: 'button', disabled: true }, 'Clear Recent');
  const recentRow = h('div', { class: 'lan98-recent', hidden: true }, field('Recent:', recent), useRecent, clearRecent);
  const content = h('div', { class: 'lan98' },
    h('div', {}, 'Find Ollama, LM Studio, vLLM and other OpenAI-compatible servers on this computer, your LAN or Tailscale. Review the networks and ports, then press Start.'),
    field('Ports:', ports), h('div', {}, 'Defaults: Ollama 11434, LM Studio 1234, vLLM 8000, llama.cpp 8080.'),
    tailscale.el, link.el, key.el, recentRow, h('div', {}, 'Networks and devices to scan:'), networkList, summary,
    h('div', {}, 'Localhost is always checked. LAN: selected private IPv4 networks, at most /24. Tailscale: selected known peers only. Up to 1,024 hosts; no IPv6.'),
    progress, status, results, details, h('div', { class: 'lan98-actions' }, start, stop, use));
  const updateButtons = () => {
    start.disabled = loading || !preferencesReady || running; stop.disabled = !running; use.disabled = running || !selected;
    ports.disabled = link.input.disabled = tailscale.input.disabled = running || !preferencesReady;
    key.input.disabled = running || !apiKey.trim();
    for (const n of networks) n.input.disabled = running;
    useRecent.disabled = clearRecent.disabled = running || !recent.value;
  };
  const updateSummary = () => {
    try {
      const count = 1 + networks.filter(n => n.input.checked).reduce((sum, n) => sum + n.network.hostCount, 0);
      const portCount = parseLanPorts(ports.value).length;
      summary.textContent = `${count} ${count === 1 ? 'host' : 'hosts'} × ${portCount} ${portCount === 1 ? 'port' : 'ports'}. Connections: ${tailscale.input.checked ? 'LAN 250 ms, Tailscale 2 s' : '250 ms'} timeout, at most 64 at once. Open ports are checked for an AI model API.`;
    } catch (e) { summary.textContent = String((e as Error).message); }
  };
  const render = () => {
    results.replaceChildren(...[...servers.values()].map(s => {
      const row = h('button', { type: 'button', role: 'option', 'aria-selected': s === selected ? 'true' : 'false', 'data-url': s.baseUrl, class: 'lan98-result' },
        h('span', {}, s.baseUrl), h('span', {}, `${s.kind}${s.requiresKey ? ' (requires API key)' : ''}`), h('span', {}, `${s.models.length} ${s.models.length === 1 ? 'model' : 'models'} · ${s.latencyMs} ms`));
      row.addEventListener('click', () => { selectServer(s); });
      row.addEventListener('dblclick', () => { selected = s; choose(s); });
      return row;
    }));
    selectServer(selected);
  };
  const selectServer = (server: LanServer | undefined) => {
    selected = server;
    for (const row of results.querySelectorAll<HTMLElement>('[data-url]')) row.setAttribute('aria-selected', row.dataset.url === selected?.baseUrl ? 'true' : 'false');
    details.textContent = selected ? (selected.models.join(', ') || (selected.requiresKey ? 'This server requires an API key. Enter it in AI settings, then use Test Connection.' : 'No models are loaded.')) : '';
    updateButtons();
  };
  const savePreferences = () => {
    const snapshot = { ports: preferences.ports, recent: [...preferences.recent] };
    saving = saving.then(() => backend.saveSettings('aiLan', snapshot)).catch(() => {});
    return saving;
  };
  const choose = (s: LanServer) => {
    if (running || !alive) return;
    chosen = s;
    preferences.recent = [s.baseUrl, ...preferences.recent.filter(url => url !== s.baseUrl)].slice(0, 5);
    void savePreferences();
    content.closest('.dlg98-overlay')?.dispatchEvent(new Event('dlg98-abort'));
  };
  use.addEventListener('click', () => { if (selected) choose(selected); });
  clearRecent.addEventListener('click', () => {
    preferences.recent = []; recent.replaceChildren(); recentRow.hidden = true;
    void savePreferences(); updateButtons();
  });
  useRecent.addEventListener('click', () => {
    if (recent.value) {
      const url = new URL(recent.value);
      choose({ host: url.hostname, port: Number(url.port) || 80, baseUrl: recent.value, kind: 'OpenAI-compatible', models: [], latencyMs: 0, requiresKey: false });
    }
  });
  results.addEventListener('keydown', e => {
    if (e.key !== 'ArrowDown' && e.key !== 'ArrowUp') return;
    e.preventDefault(); const list = [...servers.values()], index = selected ? list.indexOf(selected) : -1;
    selectServer(list[Math.max(0, Math.min(list.length - 1, index + (e.key === 'ArrowDown' ? 1 : -1)))]);
    results.querySelector<HTMLElement>('[aria-selected="true"]')?.focus();
  });
  const loadNetworks = async () => {
    const turn = ++networkTurn; loading = true; updateButtons();
    const unchecked = new Set(networks.filter(n => !n.input.checked).map(n => n.network.network));
    try {
      let found: LanNetwork[], warning = '';
      try { found = await backend.aiLanNetworks(link.input.checked, tailscale.input.checked); }
      catch (e) {
        if (!alive || turn !== networkTurn) return;
        if (!tailscale.input.checked) throw e;
        warning = `Tailscale unavailable: ${(e as Error).message} LAN discovery is still available.`;
        tailscale.input.checked = false;
        found = await backend.aiLanNetworks(link.input.checked, false);
      }
      if (!alive || turn !== networkTurn) return;
      networks = found.map(network => { const box = check(`${network.interface}: ${network.network} (${network.hostCount} hosts)${network.note ? ` — ${network.note}` : ''}`, !unchecked.has(network.network)); box.input.addEventListener('change', updateSummary); return { network, input: box.input, el: box.el }; });
      networkList.replaceChildren(...networks.map(n => n.input.parentElement!));
      status.textContent = warning || (found.length ? 'Ready.' : 'No private network found. Only this computer will be checked.');
    } catch (e) { if (alive && turn === networkTurn) { networks = []; networkList.replaceChildren(); status.textContent = `Could not list networks: ${(e as Error).message}`; } }
    finally { if (alive && turn === networkTurn) { loading = false; updateSummary(); updateButtons(); } }
  };
  link.input.addEventListener('change', () => { void loadNetworks(); });
  tailscale.input.addEventListener('change', () => { void loadNetworks(); });
  ports.addEventListener('input', updateSummary);
  stop.addEventListener('click', () => { controller?.abort(); status.textContent = 'Stopping...'; });
  start.addEventListener('click', () => { void (async () => {
    if (running || loading || !preferencesReady) return;
    let parsed: number[];
    try { parsed = parseLanPorts(ports.value); } catch (e) { status.textContent = (e as Error).message; return; }
    const turn = ++scanTurn; running = true; controller = new AbortController(); const signal = controller.signal;
    servers.clear(); selected = undefined; progress.value = 0; render(); status.textContent = 'Searching...';
    preferences.ports = parsed.join(', '); void savePreferences();
    try {
      const found = await backend.aiLanScan({ networks: networks.filter(n => n.input.checked).map(n => n.network.network), ports: parsed, linkLocal: link.input.checked, ...(tailscale.input.checked ? { tailscale: true } : {}), ...(key.input.checked && apiKey.trim() ? { apiKey } : {}) }, {
        signal, onProgress: p => {
          if (!alive || signal.aborted || turn !== scanTurn) return;
          progress.max = Math.max(1, p.total); progress.value = p.completed;
          if (p.server) { servers.set(p.server.baseUrl, p.server); selected ??= p.server; render(); }
          status.textContent = `${p.completed} / ${p.total} checked · ${p.found} ${p.found === 1 ? 'server' : 'servers'} found`;
        },
      });
      if (!alive || turn !== scanTurn) return;
      if (!signal.aborted) for (const s of found) servers.set(s.baseUrl, s);
      selected ??= servers.values().next().value;
      status.textContent = signal.aborted ? `Stopped. ${servers.size} ${servers.size === 1 ? 'server' : 'servers'} found.` : servers.size ? `Done. ${servers.size} ${servers.size === 1 ? 'server' : 'servers'} found.` : 'No AI servers found. Check that the server listens on the LAN and its port is allowed through its firewall.';
    } catch (e) { if (alive && turn === scanTurn) status.textContent = signal.aborted ? `Stopped. ${servers.size} ${servers.size === 1 ? 'server' : 'servers'} found.` : `Search failed: ${(e as Error).message}`; }
    finally { if (alive && turn === scanTurn) { running = false; render(); } }
  })(); });

  const dialog = showDialog98(doc, { title: 'Find AI Servers on LAN', content, buttons: [{ label: 'Close', value: 'close', cancel: true }], resizable: true, placeKey: 'ai-lan' });
  void backend.loadSettings<Partial<LanPreferences>>('aiLan').catch(() => null).then(p => {
    if (!alive) return;
    try { if (typeof p?.ports === 'string') ports.value = parseLanPorts(p.ports).join(', '); } catch { /* use defaults */ }
    preferences.ports = ports.value;
    preferences.recent = Array.isArray(p?.recent) ? p.recent.filter((url): url is string => {
      if (typeof url !== 'string' || !/^http:\/\/(?:127\.0\.0\.1|10\.\d+\.\d+\.\d+|192\.168\.\d+\.\d+|172\.(?:1[6-9]|2\d|3[01])\.\d+\.\d+|169\.254\.\d+\.\d+|100\.(?:6[4-9]|[7-9]\d|1[01]\d|12[0-7])\.\d+\.\d+):\d+\/v1$/.test(url)) return false;
      try { return Number(new URL(url).port || '80') > 0; } catch { return false; }
    }).slice(0, 5) : [];
    recent.replaceChildren(...preferences.recent.map(url => h('option', { value: url }, url)));
    recentRow.hidden = !preferences.recent.length; preferencesReady = true; updateSummary(); updateButtons();
  });
  void loadNetworks();
  try { await dialog; return chosen; }
  finally { alive = false; controller?.abort(); }
}
