// The operating system the app runs on, for the few things that differ: the Ctrl key (Cmd on a Mac), paths (C:\ on Windows),
// the made app's file type and some texts. No imports: the language, the controls and the IDE all read it.
//
// The main window sets it at start from the backend (Backend.platform(): the Rust side knows); the form windows, which may call
// no app command, keep the guess from their own webview's user agent (WKWebView, WebView2 and WebKitGTK name their OS).

export type Platform = 'mac' | 'windows' | 'linux';

/** The platform a user agent names: "Windows" -> windows, Linux / X11 (not Android) -> linux, anything else -> mac. */
export function guessPlatform(userAgent = typeof navigator === 'undefined' ? '' : navigator.userAgent ?? ''): Platform {
  if (/windows/i.test(userAgent)) return 'windows';
  if (/linux|x11/i.test(userAgent) && !/android/i.test(userAgent)) return 'linux';
  return 'mac';
}

let current: Platform = guessPlatform();
let winFs = false;

/** The platform the app runs on (the guess until setPlatform). */
export const platform = (): Platform => current;
export const isMac = (): boolean => current === 'mac';

/**
 * Sets the platform. `nativeFs`: the program's files are the system's own (the desktop app), so on Windows its paths are Windows
 * paths ("C:\a\b"); the browser version's files live in a POSIX-style store whatever the system is.
 */
export function setPlatform(p: Platform, nativeFs = true): void {
  current = p;
  winFs = p === 'windows' && nativeFs;
}

/** The program's paths are Windows paths (backslashes, drive letters): the desktop app on Windows. */
export const winPaths = (): boolean => winFs;

/** The system's name in texts: macOS, Windows, Linux. */
export const osName = (p: Platform = current): string => (p === 'windows' ? 'Windows' : p === 'linux' ? 'Linux' : 'macOS');
/** What the user drags files from: Finder, Explorer, the file manager. */
export const fileManagerName = (p: Platform = current): string => (p === 'windows' ? 'Explorer' : p === 'linux' ? 'the file manager' : 'Finder');

/**
 * A character typed with AltGr: Windows reports AltGr as Ctrl+Alt (Norwegian @ £ $ { [ ] } € are AltGr keys). AltGraph when the
 * webview names it, else a Ctrl+Alt key that gave a character other than a plain letter or digit (Ctrl+Alt+A is a shortcut).
 */
export const isAltGr = (e: { key: string; ctrlKey: boolean; altKey: boolean; getModifierState?: (k: string) => boolean }): boolean =>
  e.ctrlKey && e.altKey && e.key.length === 1 && (e.getModifierState?.('AltGraph') === true || !/^[a-z0-9]$/i.test(e.key));

/** Whether a key event holds the key menus call "Ctrl": Ctrl, and on a Mac also Cmd (the Mac's own command key). */
export const ctrlLike = (e: { ctrlKey: boolean; metaKey: boolean }): boolean => e.ctrlKey || (current === 'mac' && e.metaKey);
