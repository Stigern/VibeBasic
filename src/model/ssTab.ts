// SSTab (Microsoft Tabbed Dialog Control, TABCTL32.OCX): the pure parts shared by the registry, the renderer,
// the designer and the run-time object.
//
// Storage: `TabCaption` (list) holds every tab's caption, `Caption` is the current tab's caption (kept in step by
// syncSSTab), `Tab` is the current tab (0-based). `TabEnabled` / `TabVisible` are run-time lists where '0' means False
// (a missing entry is True). A child control's tab is `ControlDef.tab` (see types.ts).
import type { ControlDef, PropValue } from './types';

export interface TabRect { index: number; left: number; top: number; width: number; height: number }
export interface SSTabLayout { tabs: TabRect[]; bodyTop: number }

const num = (v: PropValue | undefined, d: number): number => (typeof v === 'number' && Number.isFinite(v) ? v : d);
const list = (v: PropValue | undefined): string[] => (Array.isArray(v) ? v.map(String) : []);

/** Whether entry `i` of a TabEnabled / TabVisible list is True. */
export const flagOn = (v: PropValue | undefined, i: number): boolean => list(v)[i] !== '0';

/** The number of tabs of an SSTab (at least 1). */
export const ssTabCount = (props: Record<string, PropValue>): number => Math.max(1, Math.floor(num(props.Tabs, 3)));

/** Keeps Tabs, TabCaption, Tab and Caption consistent after `name` was set (design time and run time). */
export function syncSSTab(props: Record<string, PropValue>, name: string): void {
  let caps = list(props.TabCaption);
  let n = Math.max(1, Math.floor(num(props.Tabs, 3)));
  if (name === 'TabCaption') n = Math.max(1, caps.length);
  caps = caps.slice(0, n);
  while (caps.length < n) caps.push(`Tab ${caps.length}`);
  const tab = Math.min(n - 1, Math.max(0, Math.floor(num(props.Tab, 0))));
  if (name === 'Caption') caps[tab] = typeof props.Caption === 'string' ? props.Caption : String(props.Caption ?? '');
  props.Tabs = n;
  props.TabCaption = caps;
  props.Tab = tab;
  props.Caption = caps[tab];
}

/** Approximate caption width for ssStylePropertyPage tabs (6 px per character plus 12 px padding), in twips. */
const textWidth = (s: string): number => (s.replace(/&(.)/g, '$1').length * 6 + 12) * 15;

/** The tab headers in twips, relative to the control's top-left. Rows run top to bottom; hidden tabs take no space.
 *  ssStyleTabbedDialog: TabsPerRow equal tabs per row; ssStylePropertyPage: tabs as wide as their captions. */
export function ssTabLayout(props: Record<string, PropValue>): SSTabLayout {
  const n = Math.max(1, Math.floor(num(props.Tabs, 3)));
  const per = Math.max(1, Math.floor(num(props.TabsPerRow, 3)));
  const width = num(props.Width, 0), th = Math.max(0, num(props.TabHeight, 520));
  const caps = list(props.TabCaption);
  const shown: number[] = [];
  for (let i = 0; i < n; i++) if (flagOn(props.TabVisible, i)) shown.push(i);
  const style = num(props.Style, 0);
  const tabs: TabRect[] = [];
  shown.forEach((index, k) => {
    const row = Math.floor(k / per), col = k % per;
    if (style === 1) {
      const prev = tabs[tabs.length - 1];
      const left = col === 0 || !prev ? 0 : prev.left + prev.width;
      tabs.push({ index, left, top: row * th, width: textWidth(caps[index] ?? ''), height: th });
    } else {
      const w = Math.floor(width / per);
      tabs.push({ index, left: col * w, top: row * th, width: w, height: th });
    }
  });
  const rows = Math.max(1, Math.ceil(shown.length / per));
  return { tabs, bodyTop: rows * th };
}

/** The tab whose header is at (x, y) (twips, relative to the control), or null. */
export function ssTabAt(props: Record<string, PropValue>, x: number, y: number): number | null {
  const t = ssTabLayout(props).tabs.find(r => x >= r.left && x < r.left + r.width && y >= r.top && y < r.top + r.height);
  return t ? t.index : null;
}

/** True when `c` is shown in its SSTab parent: always for a control whose parent is not an SSTab. */
export function onCurrentTab(c: ControlDef, parent: ControlDef | undefined): boolean {
  return parent?.type !== 'SSTab' || (c.tab ?? 0) === num(parent.props.Tab, 0);
}
