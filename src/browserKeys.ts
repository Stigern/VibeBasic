// The webview's own browser shortcuts, off in every window on Windows (WebView2) and Linux. F5 or Ctrl+R would reload the
// page (a running form goes blank, the IDE loses an unsaved project), Ctrl+P prints it and Ctrl+F, Ctrl+G, F3 open Find.
// The page gets the key first (a form's KeyDown, the IDE's F5 = Run); the listener runs last and only
// cancels what the browser would do with it. WebView2's own setting for this (AreBrowserAcceleratorKeysEnabled) only takes
// effect from the next navigation, too late for a window that loads its page once.
import { isMac } from './platform';

/** A key the browser itself acts on: reload, Find, print, caret browsing, back / forward. AltGr (Ctrl+Alt) keys type characters. */
export function isBrowserKey(e: { key: string; ctrlKey: boolean; altKey: boolean; shiftKey: boolean; metaKey: boolean }): boolean {
  if (e.metaKey) return false;
  const k = e.key.toLowerCase();
  if (k === 'f5' || k === 'browserrefresh' || k === 'browserback' || k === 'browserforward') return !e.altKey;
  if (k === 'f3') return !e.ctrlKey && !e.altKey;
  if (k === 'f7') return !e.ctrlKey && !e.altKey && !e.shiftKey;
  if (e.ctrlKey && !e.altKey) return k === 'r' || k === 'f' || k === 'g' || k === 'p';
  return e.altKey && !e.ctrlKey && (k === 'arrowleft' || k === 'arrowright');
}

export function blockBrowserKeys(win: Window): void {
  // Handlers that skip a defaultPrevented key (menubar.ts) must see it first: the cancelling listener is added while the key is
  // on its way down, so it runs after every bubbling listener the window already has.
  win.addEventListener('keydown', e => {
    if (isMac() || !isBrowserKey(e)) return;
    win.addEventListener('keydown', ev => { if (ev === e) e.preventDefault(); }, { once: true });
  }, true);
}
