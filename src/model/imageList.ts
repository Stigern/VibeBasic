// ImageList (MSCOMCTL.OCX): the pure parts shared by the registry, the renderer, the run-time object and the editor.
//
// Storage: the design-time `ListImages` list holds one image per line, 'Key|asset|Tag' (see fieldLines.ts). `asset` is a key in
// Project.assets, or at run time a data URL (LoadPicture). An image is addressed by its 1-based index or its key; a control that
// uses an ImageList (Toolbar, TreeView, ListView, TabStrip) names it in its ImageList / Icons / SmallIcons property.
import { joinFields, splitFields } from './fieldLines';

export interface ListImageData { key: string; asset: string; tag: string }

export const parseListImage = (line: string): ListImageData => { const [key = '', asset = '', tag = ''] = splitFields(line); return { key, asset, tag }; };
export const listImageLine = (i: ListImageData): string => joinFields([i.key, i.asset, i.tag]);

/** The image an Image / Icon / SmallIcon value names: a number is a 1-based index, anything else a key (case-insensitive). Null when none. */
export function findListImage(lines: readonly string[], ref: string | number | undefined | null): ListImageData | null {
  if (ref === undefined || ref === null) return null;
  const s = String(ref).trim();
  if (s === '') return null;
  if (/^-?\d+$/.test(s)) { const n = Number(s); return n >= 1 && n <= lines.length ? parseListImage(lines[n - 1]) : null; }
  const k = s.toLowerCase();
  for (const l of lines) { const i = parseListImage(l); if (i.key.toLowerCase() === k) return i; }
  return null;
}

/** What a renderer needs to draw one image of an ImageList by name. */
export interface ImageSource { url: string; width: number; height: number }
export type ImageLookup = (imageList: string, ref: string) => ImageSource | null;
