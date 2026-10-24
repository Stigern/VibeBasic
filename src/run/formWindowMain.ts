// Entry of form.html: one Tauri window of the running program. form.html#<key> shows form <key>,
// form.html#dialog-<n> shows a MsgBox / InputBox / error dialog, form.html#print-<n> a print job. Protocol: see tauriFormHost.ts.

import { invoke } from '@tauri-apps/api/core';
import { LogicalPosition, LogicalSize } from '@tauri-apps/api/dpi';
import { emit } from '@tauri-apps/api/event';
import { getCurrentWebview } from '@tauri-apps/api/webview';
import { getCurrentWebviewWindow } from '@tauri-apps/api/webviewWindow';
import { runDialog, type DialogSpec } from './dialogSpec';
import { mountFormWindow } from './formWindow';
import { setMediaLoader } from './mediaSource';
import type { PropValue } from '../model/types';
import type { FormSnapshot, ToWindow } from './protocol';
import type { PrintJob } from './printing';
import { mountPrintPreview } from './printView';
import type { FromPayload } from './tauriFormHost';
import type { FileDrag } from './dragDrop';
import { ctrlLike, guessPlatform, isMac, setPlatform } from '../platform';
import { blockBrowserKeys } from '../browserKeys';

// A form window may call no app command (not even `platform`): its own webview's user agent names the OS. Its paths are the
// system's (DirListBox, FileListBox).
setPlatform(guessPlatform());
blockBrowserKeys(window);

// MMControl / MediaPlayer: this window reads a file the main window opened, by its token (media_read is the only app command a
// form window may call; capabilities/run-windows.json). The bytes come raw, never through an event.
setMediaLoader(token => invoke<ArrayBuffer>('media_read', { token }));

const key = decodeURIComponent(location.hash.slice(1));
const win = getCurrentWebviewWindow();
const root = document.getElementById('form')!;
const send = (p: FromPayload) => emit('vb:from', p).catch(() => {});
/** One paint, but never stuck: WKWebView may pause rAF in a hidden (visible:false) window. */
const frame = () => new Promise<void>(r => { requestAnimationFrame(() => r()); setTimeout(r, 50); });

/** Our own Win98 title bar moves the (undecorated) window (not those of the MDI children in an MDI form's workspace). */
function markDragRegions(): void {
  for (const el of root.querySelectorAll('.title-bar, .title-bar-text, .title-bar-icon')) if (!el.closest('.vb-mdi-workspace')) el.setAttribute('data-tauri-drag-region', '');
}

/** WindowState: vbNormal 0, vbMinimized 1, vbMaximized 2. */
async function applyWindowState(state: PropValue | undefined): Promise<void> {
  if (state === 1) await win.minimize();
  else if (state === 2) await win.maximize();
  else { await win.unminimize(); await win.unmaximize(); }
}

/** The form's own properties in a patch message (null when it has none). */
function formPatch(m: ToWindow): Record<string, PropValue> | null {
  if (m.t === 'patch') return m.id === 'form' ? m.props : null;
  if (m.t !== 'patches') return null;
  let r: Record<string, PropValue> | null = null;
  for (const p of m.items) if (p.id === 'form') r = { ...(r ?? {}), ...p.props };
  return r;
}

const twips = (v: PropValue | undefined): number | null => (typeof v === 'number' && Number.isFinite(v) ? v / 15 : null);

/** Cmd+W / Ctrl+W on a Mac when no menu item delivers it as a close request. Windows and Linux close a window with Alt+F4 (the
 *  system's own close request); Ctrl+W is the program's key there, as in VB6. */
const isCloseKey = (e: KeyboardEvent) => isMac() && (e.metaKey || e.ctrlKey) && !e.altKey && e.key.toLowerCase() === 'w';

async function startForm(): Promise<void> {
  let mounted: ReturnType<typeof mountFormWindow> | null = null;
  const early: ToWindow[] = [];
  let wantVisible = true, firstShown = false, blocked = false;

  const show = async () => { await win.show(); await win.setFocus(); };
  const handle = (m: ToWindow) => {
    mounted!.receive(m);
    const fp = formPatch(m);
    if (fp) {
      markDragRegions();   // title bar is rebuilt on chrome changes
      // size / position set by code move the native window (the ResizeObserver ignores the echo: same pixel size)
      if ('Width' in fp || 'Height' in fp) {
        const w = twips(fp.Width) ?? window.innerWidth, h = twips(fp.Height) ?? window.innerHeight;
        void win.setSize(new LogicalSize(Math.max(1, Math.round(w)), Math.max(1, Math.round(h)))).catch(() => {});
      }
      if ('WindowState' in fp) void applyWindowState(fp.WindowState).catch(() => {});
      if ('Left' in fp || 'Top' in fp) {
        void (async () => {
          const pos = (await win.outerPosition()).toLogical(await win.scaleFactor());
          await win.setPosition(new LogicalPosition(Math.round(twips(fp.Left) ?? pos.x), Math.round(twips(fp.Top) ?? pos.y)));
        })().catch(() => {});
      }
    } else if (m.t === 'show') { wantVisible = true; if (firstShown) void show(); }
    else if (m.t === 'hide') { wantVisible = false; void win.hide(); }
    else if (m.t === 'blocked') blocked = m.blocked;
  };

  root.addEventListener('click', e => {
    const b = (e.target as Element).closest?.('.title-bar-controls button');
    if (b?.closest('.vb-mdi-workspace, .vb-mdi-maxbox')) return;   // an MDI child's buttons: its workspace handles them
    const label = b?.getAttribute('aria-label');
    if (label === 'Minimize') void win.minimize();
    else if (label === 'Maximize') void win.toggleMaximize();
  });

  // Cmd+W / OS close: the program decides (QueryUnload), the window never closes itself.
  const closeRequest = () => { if (mounted && !blocked) void send({ key, m: { t: 'closeRequest' } }); };
  await win.onCloseRequested(e => { e.preventDefault(); closeRequest(); });
  window.addEventListener('keydown', e => { if (isCloseKey(e)) { e.preventDefault(); closeRequest(); } }, true);
  // the user moved the window: Left / Top (one report once the move has stopped, not one per step)
  let moved: ReturnType<typeof setTimeout> | null = null;
  await win.onMoved(() => {
    if (moved) clearTimeout(moved);
    moved = setTimeout(() => {
      moved = null;
      void (async () => {
        const pos = (await win.outerPosition()).toLogical(await win.scaleFactor());
        if (mounted) void send({ key, m: { t: 'moved', left: Math.round(pos.x * 15), top: Math.round(pos.y * 15) } });
      })().catch(() => {});
    }, 150);
  });
  await win.listen<FormSnapshot>('vb:snapshot', async e => {
    if (mounted) return;
    root.dataset.vbWindow = '';
    mounted = mountFormWindow(root, e.payload, m => void send({ key, m }));
    markDragRegions();
    for (const m of early.splice(0)) handle(m);
    await frame();                       // first paint before the window appears
    firstShown = true;
    if (wantVisible) await show();
    const ws = e.payload.form.props.WindowState;   // a form set to Maximized (or Minimized) opens so
    if (ws === 1 || ws === 2) await applyWindowState(ws).catch(() => {});
  });
  await win.listen<ToWindow>('vb:to', e => { if (mounted) handle(e.payload); else early.push(e.payload); });
  // files dragged from Finder / Explorer: Tauri's drag-drop events of this window (core:event:default lets it listen) go to the form, which
  // tells the run session (OLEDragOver / OLEDragDrop). On macOS the position is in points of the webview, i.e. CSS pixels.
  await getCurrentWebview().onDragDropEvent(e => {
    const p = e.payload;
    const detail: FileDrag = p.type === 'leave' ? { type: 'leave' }
      : { type: p.type, x: p.position.x, y: p.position.y, ...('paths' in p ? { paths: p.paths } : {}) };
    if (mounted) root.dispatchEvent(new CustomEvent('vbfiledrag', { detail }));
  }).catch(() => {});
  await emit('vb:hello', key);
}

async function startDialog(): Promise<void> {
  document.body.classList.add('vb-dialog-window');
  let started = false;
  await win.onCloseRequested(e => { e.preventDefault(); void send({ key, cancelled: true }); });
  window.addEventListener('keydown', e => { if (isCloseKey(e)) { e.preventDefault(); void send({ key, cancelled: true }); } }, true);
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

/** A print window: the pages in a Print Preview frame; the main window opens the print dialog on it when they are drawn. */
async function startPrint(): Promise<void> {
  document.body.classList.add('vb-print-window');
  let started = false;
  const close = () => void send({ key, result: 'close' });
  const print = () => void send({ key, result: 'print' });
  await win.onCloseRequested(e => { e.preventDefault(); close(); });
  window.addEventListener('keydown', e => {
    if (isCloseKey(e)) { e.preventDefault(); close(); } else if (ctrlLike(e) && e.key.toLowerCase() === 'p') { e.preventDefault(); print(); }
  }, true);
  await win.listen('vb:print-self', () => window.print());
  await win.listen<PrintJob>('vb:print', async e => {
    if (started) return;
    started = true;
    await mountPrintPreview(root, e.payload, { onPrint: print, onClose: close });
    markDragRegions();
    await frame();
    await win.show();
    await win.setFocus();
    await frame();   // the canvases of a PrintForm page are drawn
    await send({ key, result: 'ready' });
  });
  await emit('vb:hello', key);
}

void (key.startsWith('dialog-') ? startDialog() : key.startsWith('print-') ? startPrint() : startForm());
