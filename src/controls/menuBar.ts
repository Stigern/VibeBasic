// The Win98 menu bar of a form (design and run mode) and its dropdowns, submenus and pop-up menus (PopupMenu). It shows the Menu
// controls handed to it (a whole form's, or what an MDI parent window merges) and knows nothing about the run session: the owner
// gets `beforeOpen` (VB6 raises a menu's Click before its items show, so code can change Checked / Enabled first) and `choose`.
//
// Mouse: a press on a title opens its menu, moving to another title while one is open switches, a click on an item chooses it.
// Keyboard: Alt (pressed and released) or F10 selects the bar, Alt+letter opens a menu, arrows move, Enter chooses, Esc goes back
// one level, a letter chooses the item it underlines. The Shortcut keys (Ctrl+O ...) choose their item from anywhere in the form.
// The dropdowns live in a layer under <body> (position: fixed), so the form's own box does not clip them.
import { menuTree, shortcutMatches, shortcutText, type MenuNode } from '../model/menus';
import { keyLetter } from '../model/menuShortcuts';
import type { ControlDef, PropValue } from '../model/types';
import { h, mnemonicNodes, parseMnemonic } from '../ui98/dom';

export interface MenuBarHost {
  /** A menu with items (on the bar, a submenu or a pop-up menu's own) is about to show them; it shows them when the promise settles. */
  beforeOpen?(id: string): Promise<void> | void;
  /** An item without items of its own was chosen (also a top-level menu without items, and a Shortcut key). */
  choose(id: string): void;
}

/** PopupMenu flags: vbPopupMenuRightButton 2 (the right button chooses too), CenterAlign 4, RightAlign 8 (x is the centre / right edge). */
export interface PopupOptions { flags?: number; bold?: string | null }

export interface MenuBar {
  /** The bar (display: none without a visible top-level menu). */
  readonly el: HTMLElement;
  /** Whether the bar shows (a top-level menu is visible): the form's client area is MENU_BAR_HEIGHT lower then. */
  readonly visible: boolean;
  /** Whether a menu is open or the bar has the keyboard (keys belong to the menus then). */
  readonly active: boolean;
  /** Replaces all menus (in their order). */
  set(defs: ControlDef[]): void;
  add(def: ControlDef): void;
  update(id: string, changed: Record<string, PropValue>): void;
  rename(id: string, name: string): void;
  /** Removes the menu and the menus under it. */
  remove(id: string): void;
  has(id: string): boolean;
  /** A key pressed in the form: Alt / F10 / Alt+letter / a Shortcut. True when the menus took it (the controls do not get it). */
  keyDown(e: KeyboardEvent): boolean;
  keyUp(e: KeyboardEvent): boolean;
  /** Shows the items of menu `id` at (x, y) (viewport pixels). Resolves with the chosen item, or null when cancelled. */
  popup(id: string, x: number, y: number, o?: PopupOptions): Promise<string | null>;
  /** Closes every open menu (a pop-up menu resolves with null). */
  close(): void;
  dispose(): void;
}

interface Level { node: MenuNode | null; items: MenuNode[]; panel: HTMLElement; els: HTMLElement[]; hot: number }

const isSep = (d: ControlDef): boolean => d.props.Caption === '-';
const enabled = (d: ControlDef): boolean => d.props.Enabled !== false;
const visibleDef = (d: ControlDef): boolean => d.props.Visible !== false;
const visibleKids = (n: MenuNode): MenuNode[] => n.children.filter(c => visibleDef(c.def));
const opens = (n: MenuNode): boolean => visibleKids(n).length > 0;
const caption = (d: ControlDef): string => (typeof d.props.Caption === 'string' ? d.props.Caption : '');
/** The letter `&` marks in a caption, lower case ('' for none). */
const mnemonic = (d: ControlDef): string => {
  const m = parseMnemonic(caption(d));
  return m.index >= 0 ? m.text[m.index].toLowerCase() : '';
};

export function createMenuBar(doc: Document, mode: 'design' | 'run', host: MenuBarHost, onVisibility: () => void = () => {}): MenuBar {
  const el = h('div', { class: `vb-menubar vb-${mode}` });
  el.addEventListener('mousedown', e => e.preventDefault());   // the control with the focus keeps it
  const defs = new Map<string, ControlDef>();
  let order: string[] = [];
  let tree: MenuNode[] = [];
  let tops: MenuNode[] = [];
  let topEls: HTMLElement[] = [];
  let layer: HTMLElement | null = null;
  let levels: Level[] = [];
  /** The bar's menu that is open or has the keyboard (-1: none). */
  let barIndex = -1;
  /** The bar has the keyboard without an open menu (Alt, F10). */
  let barFocus = false;
  let popupDone: ((id: string | null) => void) | null = null;
  let popupOpts: PopupOptions = {};
  let seq = 0;            // stops a menu whose Click is still running from opening after the user moved on
  let altArmed = false;
  let wasVisible = false;
  let disposed = false;

  const nodeOf = (id: string, nodes: MenuNode[] = tree): MenuNode | null => {
    for (const n of nodes) { if (n.def.id === id) return n; const f = nodeOf(id, n.children); if (f) return f; }
    return null;
  };

  // ---- the bar ------------------------------------------------------------------------------------------------
  function renderBar(): void {
    tree = menuTree(order.map(id => defs.get(id)!));
    tops = tree.filter(n => visibleDef(n.def));
    topEls = tops.map((n, i) => {
      const t = h('span', { class: 'vb-menubar-top', dataset: { menuId: n.def.id } }, ...mnemonicNodes(caption(n.def)));
      t.classList.toggle('disabled', !enabled(n.def));
      t.classList.toggle('open', i === barIndex && levels.length > 0);
      t.classList.toggle('hot', i === barIndex && barFocus);
      t.addEventListener('mousedown', e => { if (e.button === 0) pressTop(i); });
      t.addEventListener('mouseenter', () => { if (levels.length && popupDone === null && barIndex !== i) openTop(i, false); });
      return t;
    });
    el.replaceChildren(...topEls);
    const vis = tops.length > 0;
    el.style.display = vis ? '' : 'none';
    if (vis !== wasVisible) { wasVisible = vis; onVisibility(); }
  }

  function pressTop(i: number): void {
    if (disposed) return;
    if (popupDone) close();
    const n = tops[i];
    if (!n) return;
    if (barIndex === i && levels.length) { close(); return; }
    if (!enabled(n.def)) { close(); return; }
    if (!opens(n)) { close(); host.choose(n.def.id); return; }   // a menu without items is a command on the bar
    openTop(i, false);
  }

  // ---- dropdowns ----------------------------------------------------------------------------------------------
  function layerEl(): HTMLElement {
    if (!layer) { layer = h('div', { class: 'vb-menu-layer' }); doc.body.appendChild(layer); }
    return layer;
  }

  function buildPanel(items: MenuNode[], depth: number): Level {
    const panel = h('div', { class: 'menu98 vb-menudrop' });
    panel.addEventListener('mousedown', e => e.preventDefault());
    const els = items.map((n, idx) => {
      const d = n.def;
      if (isSep(d)) return h('div', { class: 'menu98-item sep' }, h('hr'));
      const label = h('span', { class: 'menu98-label' }, ...mnemonicNodes(caption(d)));
      if (popupOpts.bold && popupOpts.bold === d.id && popupDone) label.style.fontWeight = 'bold';
      const item = h('div', { class: `menu98-item${opens(n) ? ' has-sub' : ''}${enabled(d) ? '' : ' disabled'}`, dataset: { menuId: d.id } },
        h('span', { class: 'menu98-check' }, d.props.Checked === true ? '✓' : ''), label,
        h('span', { class: 'menu98-shortcut' }, opens(n) ? '' : shortcutText(d.props.Shortcut)),
        h('span', { class: 'menu98-arrow' }, opens(n) ? '▶' : ''));
      item.addEventListener('mouseenter', () => hover(depth, idx));
      item.addEventListener('click', e => { e.stopPropagation(); activate(depth, idx, false); });
      item.addEventListener('mouseup', e => { if (e.button === 2 && popupDone && ((popupOpts.flags ?? 0) & 2)) activate(depth, idx, false); });
      return item;
    });
    panel.append(...els);
    panel.addEventListener('contextmenu', e => e.preventDefault());
    return { node: null, items, panel, els, hot: -1 };
  }

  function place(panel: HTMLElement, x: number, y: number, flip?: { left: number }): void {
    const win = doc.defaultView;
    const vw = win?.innerWidth || doc.documentElement.clientWidth, vh = win?.innerHeight || doc.documentElement.clientHeight;
    panel.style.position = 'fixed';
    panel.style.left = `${x}px`; panel.style.top = `${y}px`;
    const w = panel.offsetWidth, ht = panel.offsetHeight;
    if (vw && x + w > vw) panel.style.left = `${Math.max(0, flip ? flip.left - w : vw - w)}px`;
    if (vh && y + ht > vh) panel.style.top = `${Math.max(0, vh - ht)}px`;
  }

  /** Shows the items of `node` as level `depth` (levels below it close). */
  function showLevel(node: MenuNode, depth: number, at: () => { x: number; y: number; flipLeft?: number }, hotFirst: boolean): void {
    closeFrom(depth);
    const lv = buildPanel(visibleKids(node), depth);
    lv.node = node;
    layerEl().appendChild(lv.panel);
    const p = at();
    place(lv.panel, p.x, p.y, p.flipLeft !== undefined ? { left: p.flipLeft } : undefined);
    levels[depth] = lv;
    if (hotFirst) setHot(depth, nextItem(lv, -1, 1));
    markTops();
  }

  /** Runs the menu's Click (beforeOpen) and then `then`, unless the user has moved on meanwhile. */
  function afterClick(id: string, then: () => void): void {
    const token = ++seq;
    const r = host.beforeOpen?.(id);
    if (!r) { then(); return; }
    void Promise.resolve(r).catch(() => {}).then(() => {
      if (token !== seq || disposed) return;
      const n = nodeOf(id);
      if (!n || !opens(n) || !enabled(n.def)) { if (levels.length === 0 && !barFocus) markTops(); return; }
      then();
    });
  }

  function openTop(i: number, hotFirst: boolean): void {
    closeFrom(0);
    barIndex = i;
    barFocus = false;
    attach();
    markTops();
    const n = tops[i];
    if (!n || !enabled(n.def)) return;   // a disabled menu: selected, but its items do not show
    if (!opens(n)) return;
    afterClick(n.def.id, () => {
      const cur = nodeOf(n.def.id);
      const t = topEls[tops.findIndex(x => x.def.id === n.def.id)];
      if (!cur || !t) return;
      showLevel(cur, 0, () => { const r = t.getBoundingClientRect(); return { x: r.left, y: r.bottom }; }, hotFirst);
    });
  }

  function openSub(depth: number, idx: number, hotFirst: boolean): void {
    const lv = levels[depth];
    const n = lv?.items[idx];
    if (!n || !opens(n) || !enabled(n.def)) return;
    if (levels[depth + 1]?.node?.def.id === n.def.id) { if (hotFirst) setHot(depth + 1, nextItem(levels[depth + 1], -1, 1)); return; }
    closeFrom(depth + 1);
    afterClick(n.def.id, () => {
      const cur = nodeOf(n.def.id), itemEl = levels[depth]?.els[idx];
      if (!cur || !itemEl || levels[depth]?.items[idx]?.def.id !== n.def.id) return;
      showLevel(cur, depth + 1, () => {
        const r = itemEl.getBoundingClientRect(), pr = levels[depth].panel.getBoundingClientRect();
        return { x: r.right - 3, y: r.top - 3, flipLeft: pr.left + 3 };
      }, hotFirst);
    });
  }

  function closeFrom(depth: number): void {
    for (const lv of levels.splice(depth)) lv.panel.remove();
  }

  function markTops(): void {
    topEls.forEach((t, i) => {
      t.classList.toggle('open', i === barIndex && !barFocus && popupDone === null);
      t.classList.toggle('hot', i === barIndex && barFocus);
    });
  }

  // ---- items --------------------------------------------------------------------------------------------------
  const selectable = (n: MenuNode | undefined): boolean => !!n && !isSep(n.def);
  function nextItem(lv: Level, from: number, dir: 1 | -1): number {
    const n = lv.items.length;
    for (let k = 1; k <= n; k++) {
      const i = (((from + dir * k) % n) + n) % n;
      if (selectable(lv.items[i])) return i;
    }
    return -1;
  }
  function setHot(depth: number, idx: number): void {
    const lv = levels[depth];
    if (!lv) return;
    lv.hot = idx;
    lv.els.forEach((e, i) => e.classList.toggle('hot', i === idx));
  }
  function hover(depth: number, idx: number): void {
    if (!levels[depth]) return;
    setHot(depth, selectable(levels[depth].items[idx]) ? idx : -1);
    const n = levels[depth].items[idx];
    if (n && opens(n) && enabled(n.def)) openSub(depth, idx, false);
    else { seq++; closeFrom(depth + 1); }
  }
  /** An item clicked, or Enter / its letter on it: a submenu opens, a command is chosen. */
  function activate(depth: number, idx: number, keyboard: boolean): void {
    const n = levels[depth]?.items[idx];
    if (!n || isSep(n.def) || !enabled(n.def)) return;
    if (opens(n)) { openSub(depth, idx, keyboard); return; }
    const done = popupDone;
    close(false);
    if (done) done(n.def.id); else host.choose(n.def.id);
  }

  // ---- open / close -------------------------------------------------------------------------------------------
  let attached = false;
  function attach(): void {
    if (attached) return;
    attached = true;
    doc.addEventListener('mousedown', onOutside, true);
    doc.addEventListener('keydown', onKey, true);
  }
  function detach(): void {
    if (!attached) return;
    attached = false;
    doc.removeEventListener('mousedown', onOutside, true);
    doc.removeEventListener('keydown', onKey, true);
  }
  function close(cancelPopup = true): void {
    seq++;
    closeFrom(0);
    barIndex = -1;
    barFocus = false;
    detach();
    markTops();
    const done = popupDone;
    popupDone = null;
    popupOpts = {};
    if (done && cancelPopup) done(null);
  }
  function onOutside(e: Event): void {
    const t = e.target as Node | null;
    if (t && (el.contains(t) || levels.some(l => l.panel.contains(t)))) return;
    close();
  }
  function focusBar(i: number): void {
    closeFrom(0);
    barIndex = i;
    barFocus = true;
    attach();
    markTops();
  }
  const firstTop = (): number => tops.findIndex(() => true);

  function onKey(e: KeyboardEvent): void {
    if (disposed) return;
    const swallow = (): void => { e.preventDefault(); e.stopPropagation(); };
    const depth = levels.length - 1;
    const lv = levels[depth];
    swallow();
    if (e.key === 'Alt' || e.key === 'F10') { if (!popupDone) close(); return; }
    if (e.key === 'Escape') {
      if (depth > 0) { closeFrom(depth); seq++; return; }
      if (popupDone) { close(); return; }
      if (depth === 0) { const i = barIndex; closeFrom(0); seq++; focusBar(i); return; }
      close();
      return;
    }
    const moveTop = (dir: 1 | -1): void => {
      if (!tops.length) return;
      const i = ((barIndex + dir) % tops.length + tops.length) % tops.length;
      if (barFocus) focusBar(i); else openTop(i, true);
    };
    if (!lv) {   // the bar has the keyboard
      if (popupDone) return;
      if (e.key === 'ArrowLeft') moveTop(-1);
      else if (e.key === 'ArrowRight') moveTop(1);
      else if (e.key === 'ArrowDown' || e.key === 'Enter' || e.key === 'ArrowUp') {
        const n = tops[barIndex];
        if (n && enabled(n.def) && !opens(n) && e.key === 'Enter') { close(); host.choose(n.def.id); }
        else openTop(barIndex, true);
      } else {
        const l = keyLetter(e);
        const i = l ? tops.findIndex(n => mnemonic(n.def) === l) : -1;
        if (i >= 0) { const n = tops[i]; if (enabled(n.def) && !opens(n)) { close(); host.choose(n.def.id); } else openTop(i, true); }
      }
      return;
    }
    switch (e.key) {
      case 'ArrowDown': case 'ArrowUp': setHot(depth, nextItem(lv, lv.hot, e.key === 'ArrowDown' ? 1 : -1)); return;
      case 'ArrowRight': {
        const n = lv.items[lv.hot];
        if (n && opens(n) && enabled(n.def)) openSub(depth, lv.hot, true);
        else if (!popupDone) moveTop(1);
        return;
      }
      case 'ArrowLeft':
        if (depth > 0) { closeFrom(depth); seq++; }
        else if (!popupDone) moveTop(-1);
        return;
      case 'Enter': case ' ':
        if (lv.hot >= 0) activate(depth, lv.hot, true);
        return;
    }
    const l = keyLetter(e);
    if (!l) return;
    const hits = lv.items.map((n, i) => (selectable(n) && mnemonic(n.def) === l ? i : -1)).filter(i => i >= 0);
    if (hits.length === 1) { setHot(depth, hits[0]); activate(depth, hits[0], true); }
    else if (hits.length > 1) setHot(depth, hits.find(i => i > lv.hot) ?? hits[0]);
  }

  /** The item a Shortcut key stands for: enabled and visible, in a menu whose parents are enabled. */
  function shortcutItem(e: KeyboardEvent): MenuNode | null {
    const walk = (nodes: MenuNode[], ok: boolean): MenuNode | null => {
      for (const n of nodes) {
        const on = ok && enabled(n.def);
        if (on && visibleDef(n.def) && !isSep(n.def) && !n.children.length && shortcutMatches(Number(n.def.props.Shortcut) || 0, e)) return n;
        const f = walk(n.children, on);
        if (f) return f;
      }
      return null;
    };
    return walk(tree, true);
  }
  const parentOf = (id: string): string | null => defs.get(id)?.parentId ?? null;

  renderBar();

  const bar: MenuBar = {
    el,
    get visible() { return tops.length > 0; },
    get active() { return levels.length > 0 || barFocus; },
    set(list) {
      defs.clear();
      for (const d of list) defs.set(d.id, d);
      order = list.map(d => d.id);
      refresh();
    },
    add(def) {
      if (defs.has(def.id)) return;
      defs.set(def.id, def);
      order.push(def.id);
      refresh();
    },
    update(id, changed) {
      const d = defs.get(id);
      if (!d) return;
      defs.set(id, { ...d, props: { ...d.props, ...changed } });
      refresh();
    },
    rename(id, name) {
      const d = defs.get(id);
      if (d) { defs.set(id, { ...d, name }); refresh(); }
    },
    remove(id) {
      const doomed = new Set([id]);
      for (let grew = true; grew;) {
        grew = false;
        for (const d of defs.values()) if (d.parentId !== null && doomed.has(d.parentId) && !doomed.has(d.id)) { doomed.add(d.id); grew = true; }
      }
      for (const d of doomed) defs.delete(d);
      order = order.filter(o => !doomed.has(o));
      refresh();
    },
    has: id => defs.has(id),
    keyDown(e) {
      if (disposed || mode !== 'run') return false;
      const bareAlt = e.key === 'Alt' || e.key === 'AltGraph';
      if (!bareAlt) altArmed = false;
      const item = shortcutItem(e);
      if (item) {
        e.preventDefault();
        const id = item.def.id, parent = parentOf(id);
        const run = (): void => {
          const cur = nodeOf(id);
          let ok = !!cur && enabled(cur.def) && visibleDef(cur.def);
          for (let p = parentOf(id); ok && p; p = parentOf(p)) ok = enabled(defs.get(p)!);
          if (ok) host.choose(id);
        };
        const r = parent ? host.beforeOpen?.(parent) : undefined;   // VB6 initialises the item's menu first (its Click)
        if (r) void Promise.resolve(r).catch(() => {}).then(() => { if (!disposed) run(); }); else run();
        return true;
      }
      if (!tops.length) return false;
      if (bareAlt) { altArmed = !e.repeat && !e.ctrlKey && !e.metaKey && !e.shiftKey; return false; }
      if (e.key === 'F10' && !e.ctrlKey && !e.altKey && !e.metaKey && !e.shiftKey) { e.preventDefault(); focusBar(firstTop()); return true; }
      if (e.altKey && !e.ctrlKey && !e.metaKey) {
        const l = keyLetter(e);
        const i = l ? tops.findIndex(n => mnemonic(n.def) === l) : -1;
        if (i < 0) return false;
        e.preventDefault();
        const n = tops[i];
        if (enabled(n.def) && !opens(n)) host.choose(n.def.id); else openTop(i, true);
        return true;
      }
      return false;
    },
    keyUp(e) {
      if (disposed || mode !== 'run') return false;
      if ((e.key === 'Alt' || e.key === 'AltGraph') && altArmed && tops.length && !levels.length) {
        altArmed = false;
        focusBar(firstTop());
        return true;
      }
      altArmed = false;
      return false;
    },
    popup(id, x, y, o = {}) {
      close();
      const n = nodeOf(id);
      if (!n || !opens(n)) return Promise.resolve(null);
      return new Promise<string | null>(resolve => {
        popupDone = resolve;
        popupOpts = o;
        attach();
        const flags = o.flags ?? 0;
        showLevel(n, 0, () => ({ x, y }), false);
        const p = levels[0]?.panel;
        if (p) {
          const w = p.offsetWidth;
          const left = flags & 8 ? x - w : flags & 4 ? x - w / 2 : x;
          place(p, Math.max(0, left), y);
        }
      });
    },
    close: () => close(),
    dispose() {
      if (disposed) return;
      close();
      disposed = true;
      layer?.remove();
      layer = null;
    },
  };

  /** Re-renders the bar and the open menus after a change (a menu that is gone or hidden closes, with those below it). */
  function refresh(): void {
    const openIds = levels.map(l => l.node?.def.id ?? '');
    const hots = levels.map(l => l.hot);
    const topId = barIndex >= 0 ? tops[barIndex]?.def.id : undefined;
    renderBar();
    if (topId !== undefined) {
      const i = tops.findIndex(n => n.def.id === topId);
      if (i < 0 || (!barFocus && !popupDone && !enabled(tops[i].def))) { close(); return; }
      barIndex = i;
    }
    markTops();
    if (!openIds.length) return;
    const rects = levels.map(l => ({ left: l.panel.style.left, top: l.panel.style.top }));
    closeFrom(0);
    for (let depth = 0; depth < openIds.length; depth++) {
      const n = nodeOf(openIds[depth]);
      if (!n || !opens(n) || !visibleDef(n.def) || !enabled(n.def)) break;
      const lv = buildPanel(visibleKids(n), depth);
      lv.node = n;
      layerEl().appendChild(lv.panel);
      lv.panel.style.position = 'fixed';
      lv.panel.style.left = rects[depth].left; lv.panel.style.top = rects[depth].top;
      levels[depth] = lv;
      setHot(depth, Math.min(hots[depth], lv.items.length - 1));
    }
    if (!levels.length && !barFocus && !popupDone) close();
    else if (!levels.length && popupDone) close();
  }

  return bar;
}
