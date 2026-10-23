// Which parts of a project refer to an asset (a key in Project.assets): Picture-type properties ({ asset } values) and the
// ListImages lines of ImageLists ('Key|asset|Tag'). An asset may be deleted only when nothing refers to it any more.
import { parseListImage } from './imageList';
import type { Project, PropValue } from './types';

const isRef = (v: PropValue | undefined): v is { asset: string } =>
  typeof v === 'object' && v !== null && !Array.isArray(v) && typeof (v as { asset?: unknown }).asset === 'string';

/** How many times the forms of `p` name asset `id` (each picture property and each ListImages line counts once). The project
 *  icon is not counted. */
export function assetRefCount(p: Project, id: string): number {
  let n = 0;
  for (const f of p.forms) {
    for (const props of [f.props, ...f.controls.map(c => c.props)]) {
      for (const v of Object.values(props)) if (isRef(v) && v.asset === id) n++;
    }
    for (const c of f.controls) {
      const lines = c.type === 'ImageList' ? c.props.ListImages : undefined;
      if (Array.isArray(lines)) for (const l of lines) if (parseListImage(String(l)).asset === id) n++;
    }
  }
  return n;
}

/** True when the forms of `p` name asset `id` more often than the `own` references the caller is about to drop (0: any use). */
export function assetUsedElsewhere(p: Project, id: string, own = 0): boolean {
  return assetRefCount(p, id) > own;
}
