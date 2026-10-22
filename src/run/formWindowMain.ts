// Entry of form.html: one Tauri window of the running program. form.html#<key> shows form <key>,
// form.html#dialog-<n> shows a MsgBox / InputBox / error dialog. Protocol: see tauriFormHost.ts.

import { LogicalSize } from '@tauri-apps/api/dpi';
import { emit } from '@tauri-apps/api/event';
import { getCurrentWebviewWindow } from '@tauri-apps/api/webviewWindow';
import { runDialog, type DialogSpec } from './dialogSpec';
import { mountFormWindow } from './formWindow';
import type { FormSnapshot, ToWindow } from './protocol';
import type { FromPayload } from './tauriFormHost';

const key = decodeURIComponent(location.hash.slice(1));
const win = getCurrentWebviewWindow();
const root = document.getElementById('form')!;
const send = (p: FromPayload) => emit('vb:from', p).catch(() => {});
/** One paint, but never stuck: WKWebView may pause rAF in a hidden (visible:false) window. */
const frame = () => new Promise<void>(r => { requestAnimationFrame(() => r()); setTimeout(r, 50); });

/** Our own Win98 title bars move the (undecorated) window. */
function markDragRegions(): void {
  for (const el of root.querySelectorAll('.title-bar, .title-bar-text, .title-bar-icon')) el.setAttribute('data-tauri-drag-region', '');
}

async function startForm(): Promise<void> {
  let mounted: ReturnType<typeof mountFormWindow> | null = null;
  const early: ToWindow[] = [];
  let wantVisible = true, firstShown = false, blocked = false;

  const show = async () => { await win.show(); await win.setFocus(); };
  const handle = (m: ToWindow) => {
    mounted!.receive(m);
    if (m.t === 'patch' && m.id === 'form') markDragRegions();   // title bar is rebuilt on chrome changes
    else if (m.t === 'show') { wantVisible = true; if (firstShown) void show(); }
    else if (m.t === 'hide') { wantVisible = false; void win.hide(); }
    else if (m.t === 'blocked') blocked = m.blocked;
  };

  root.addEventListener('click', e => {
    const b = (e.target as Element).closest?.('.title-bar-controls button');
    const label = b?.getAttribute('aria-label');
    if (label === 'Minimize') void win.minimize();
    else if (label === 'Maximize') void win.toggleMaximize();
  });

  // Cmd+W / OS close: the program decides (QueryUnload), the window never closes itself.
  await win.onCloseRequested(e => { e.preventDefault(); if (mounted && !blocked) void send({ key, m: { t: 'closeRequest' } }); });
  await win.listen<FormSnapshot>('vb:snapshot', async e => {
    if (mounted) return;
    root.dataset.vbWindow = '';
    mounted = mountFormWindow(root, e.payload, m => void send({ key, m }));
    markDragRegions();
    for (const m of early.splice(0)) handle(m);
    await frame();                       // first paint before the window appears
    firstShown = true;
    if (wantVisible) await show();
  });
  await win.listen<ToWindow>('vb:to', e => { if (mounted) handle(e.payload); else early.push(e.payload); });
  await emit('vb:hello', key);
}

async function startDialog(): Promise<void> {
  document.body.classList.add('vb-dialog-window');
  let started = false;
  await win.onCloseRequested(e => { e.preventDefault(); void send({ key, cancelled: true }); });
  await win.listen<DialogSpec>('vb:dialog', async e => {
    if (started) return;
    started = true;
    const result = runDialog(document, e.payload);
    await frame();
    const dlg = document.querySelector<HTMLElement>('.dlg98');
    if (dlg) {
      for (const el of dlg.querySelectorAll('.title-bar, .title-bar-text')) el.setAttribute('data-tauri-drag-region', '');
      const r = dlg.getBoundingClientRect();
      await win.setSize(new LogicalSize(Math.ceil(r.width), Math.ceil(r.height)));
      await win.center();
    }
    await win.show();
    await win.setFocus();
    await send({ key, result: await result });
  });
  await emit('vb:hello', key);
}

void (key.startsWith('dialog-') ? startDialog() : startForm());
