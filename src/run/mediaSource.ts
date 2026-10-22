// How an MMControl / MediaPlayer file reaches the media element that plays it, without sending the bytes through an event.
//
// - Tauri (TauriFormHost.openMedia): the main window opens the file by path and gets a token; `MediaSrc` is `vbmedia:<token>`, and
//   the form window reads the bytes itself by that token (the `media_read` command, raw bytes) into a Blob URL of its own.
// - One document (InlineFormHost: browser, tests): a Blob URL made here is used as it is (a data URL where Blob URLs are missing,
//   for small files only).
// Whoever made a Blob URL revokes it: the run session (`release`) for its own, the renderer (media.ts) for the ones it made.

/** `MediaSrc` of a file the window reads by token: `vbmedia:<token>:<mime>` (see mediaRef). */
export const MEDIA_TOKEN = 'vbmedia:';
export const mediaRef = (token: string, mime: string): string => `${MEDIA_TOKEN}${token}:${mime}`;
/** Without Blob URLs (jsdom) the file goes as a data URL: only up to this size. */
export const MAX_DATA_URL_BYTES = 16 * 1024 * 1024;

/** An open media file: `src` for the window, `bytes` for this window's length probe, `release` when it is closed. */
export interface OpenedMedia {
  src: string;
  bytes(): Promise<Uint8Array>;
  release(): void;
}

function dataUrl(bytes: Uint8Array, mime: string): string {
  let s = '';
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return `data:${mime};base64,${btoa(s)}`;
}

const canBlob = (): boolean => typeof URL.createObjectURL === 'function';

/** A file the window shares this document with (the inline host). Throws for a file too big for a data URL. */
export function localMedia(bytes: Uint8Array, mime: string): OpenedMedia {
  if (canBlob()) {
    const url = URL.createObjectURL(new Blob([bytes as BlobPart], { type: mime }));
    let open = true;
    return { src: url, bytes: async () => bytes, release: () => { if (open) { open = false; URL.revokeObjectURL(url); } } };
  }
  if (bytes.length > MAX_DATA_URL_BYTES) throw new Error('The file is too big to play');
  return { src: dataUrl(bytes, mime), bytes: async () => bytes, release: () => {} };
}

// -- the window's side ------------------------------------------------------------------------------------------------

let loader: ((token: string) => Promise<ArrayBuffer | Uint8Array | number[]>) | null = null;

/** The form window (formWindowMain.ts) sets how a `vbmedia:` token is read. */
export function setMediaLoader(fn: typeof loader): void { loader = fn; }

/**
 * The URL a media element plays `src` from. `own`: a Blob URL made here, which the caller revokes. Null when it cannot be loaded
 * (no loader, or the read failed).
 */
export async function mediaElementUrl(src: string, mime = 'application/octet-stream'): Promise<{ url: string; own: boolean } | null> {
  if (!src.startsWith(MEDIA_TOKEN)) {
    const m = /^data:([^;,]*)(;base64)?,(.*)$/s.exec(src);
    if (!m || !m[2] || !canBlob()) return { url: src, own: false };   // a Blob URL of this document, or a plain URL
    const bin = atob(m[3]);
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    return { url: URL.createObjectURL(new Blob([bytes], { type: m[1] || mime })), own: true };
  }
  if (!loader || !canBlob()) return null;
  const rest = src.slice(MEDIA_TOKEN.length), at = rest.indexOf(':');
  const token = at < 0 ? rest : rest.slice(0, at), type = at < 0 ? mime : rest.slice(at + 1) || mime;
  try {
    const r = await loader(token);
    const bytes = r instanceof Uint8Array ? r : Array.isArray(r) ? new Uint8Array(r) : new Uint8Array(r);
    return { url: URL.createObjectURL(new Blob([bytes as BlobPart], { type })), own: true };
  } catch {
    return null;
  }
}
