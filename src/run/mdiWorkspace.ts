// The workspace of an MDI form's window: its MDI children as Win98 child windows inside the client area that the docked controls
// leave (Tauri windows cannot nest, so a child is a form surface in this document, mounted like any form window; only the host of
// its messages differs, see protocol.ts mdi* and the form hosts). Each child has its own title bar with Minimize / Maximize / Close,
// moves and resizes within the workspace, minimizes to a small title bar at the bottom and maximizes to fill the workspace (its
// caption then joins the MDI form's: "Parent - [Child]", and its buttons move to the right end of the menu bar).
// The menu bar shows the active child's menus when it has visible ones (else the MDI form's own), and the Window list (a menu
// with WindowList = True) under them. The session decides which child is active (mdiActive); a click here asks it (`activated`).
import { formMetrics, type FormSurface } from '../controls/render';
import type { MenuBarHost } from '../controls/menuBar';
import { hasMenuBar, isMenu } from '../model/menus';
import { MINIMIZED_HEIGHT, WINDOW_ITEM, cascadeRects, iconSlot, tileRects, withWindowList } from '../model/mdi';
import type { ControlDef, PropValue } from '../model/types';
import { h } from '../ui98/dom';
import type { FormSnapshot, FromWindow, ToWindow } from './protocol';

type Props = Record<string, PropValue>;

/** What the workspace needs of a mounted child form (formWindow.ts mountFormWindow). */
export interface ChildMount {
  receive(m: ToWindow): void;
  dispose(): void;
  readonly surface: FormSurface;
  /** The child's own menu events (a menu's Click before it opens, an item chosen). */
  readonly menuHost: MenuBarHost;
  /** Sets the form's outer size (twips); `report`: tells the session (resized, then Form_Resize). */
  resize(width: number, height: number, report: boolean): void;
}

/** What the workspace needs of the MDI form's own window. */
export interface MdiParent {
  surface: FormSurface;
  mount(root: HTMLElement, s: FormSnapshot, post: (m: FromWindow) => void): ChildMount;
  /** A message of child `key` for the session. */
  post(key: string, m: FromWindow): void;
  /** The MDI form's own menus (current properties) and their events. */
  ownMenus(): ControlDef[];
  readonly ownMenuHost: MenuBarHost;
  /** Shows these menus in the menu bar with this host; null: the form's own menus again. */
  setBar(defs: ControlDef[] | null, host: MenuBarHost | null): void;
  /** " - [Child]" after the MDI form's caption (null: none). */
  setCaptionSuffix(suffix: string | null): void;
  formProps(): Props;
}

export interface MdiWorkspace {
  readonly el: HTMLElement;
  /** Handles an mdi* message; false for any other. */
  receive(m: ToWindow): boolean;
  /** The client area or the docked controls changed. */
  relayout(): void;
  dispose(): void;
}

interface Child {
  key: string; wrap: HTMLElement; mount: ChildMount; props: Props;
  visible: boolean; state: number;                 // WindowState: 0 normal, 1 minimized, 2 maximized
  x: number; y: number;                            // px in the workspace (where it is when normal)
  normal: { width: number; height: number } | null;   // twips, while maximized
  menus: ControlDef[]; seq: number;
}

const num = (v: PropValue | undefined, d = 0): number => (typeof v === 'number' && Number.isFinite(v) ? v : d);
const on = (v: PropValue | undefined): boolean => v === true || (typeof v === 'number' && v !== 0);

export function createMdiWorkspace(p: MdiParent): MdiWorkspace {
  const doc = p.surface.el.ownerDocument;
  const el = h('div', { class: 'vb-mdi-workspace' });
  p.surface.clientEl.appendChild(el);
  const children = new Map<string, Child>();
  let activeKey: string | null = null;
  let z = 1, seq = 0, cascade = 0;
  let maxBox: HTMLElement | null = null;
  let disposed = false;
  const ws = () => ({ width: el.clientWidth || parseFloat(el.style.width) || 0, height: el.clientHeight || parseFloat(el.style.height) || 0 });
  const metrics = (c: Child) => formMetrics(c.props);
  const twips = (px: number): number => Math.round(px * 15);

  // ---- placement --------------------------------------------------------------------------------------------
  function place(c: Child): void {
    if (c.state === 2) { c.wrap.style.left = '0px'; c.wrap.style.top = '0px'; return; }
    if (c.state === 1) {
      const minimized = [...children.values()].filter(o => o.state === 1 && o.visible).sort((a, b) => a.seq - b.seq);
      const s = iconSlot(Math.max(0, minimized.indexOf(c)), ws());
      c.wrap.style.left = `${s.left}px`; c.wrap.style.top = `${s.top}px`;
      return;
    }
    const m = metrics(c), w = ws();
    c.x = Math.max(0, Math.min(c.x, w.width - m.outerWidth));
    c.y = Math.max(0, Math.min(c.y, w.height - m.outerHeight));
    c.wrap.style.left = `${c.x}px`; c.wrap.style.top = `${c.y}px`;
  }
  const reportPos = (c: Child) => p.post(c.key, { t: 'moved', left: twips(c.x), top: twips(c.y) });

  /** The outer size (twips) that gives a maximized child the whole workspace as its client area. */
  function maxSize(c: Child): { width: number; height: number } {
    const m = metrics(c), w = ws();
    return { width: twips(w.width + 2 * m.border), height: twips(w.height + 2 * m.border + m.titleHeight) };
  }

  function setState(c: Child, state: number, report: boolean): void {
    state = state === 1 || state === 2 ? state : 0;
    if (c.state === state) return;
    const was = c.state;
    c.state = state;
    c.wrap.classList.toggle('vb-mdi-max', state === 2);
    c.wrap.classList.toggle('vb-mdi-min', state === 1);
    if (was === 2 && c.normal) { c.mount.resize(c.normal.width, c.normal.height, report); c.props.Width = c.normal.width; c.props.Height = c.normal.height; c.normal = null; }
    if (state === 2) {
      c.normal = { width: num(c.props.Width), height: num(c.props.Height) };
      const s = maxSize(c);
      c.props.Width = s.width; c.props.Height = s.height;
      c.mount.resize(s.width, s.height, report);
    }
    c.props.WindowState = state;
    for (const o of children.values()) if (o.state === 1 || o === c) place(o);
    if (report) p.post(c.key, { t: 'state', id: 'form', props: { WindowState: state } });
    chrome();
  }

  // ---- activation and chrome ----------------------------------------------------------------------------------
  function activate(key: string | null): void {
    const c = key ? children.get(key) : undefined;
    const prev = activeKey ? children.get(activeKey) : undefined;
    activeKey = c ? key : null;
    if (c) {
      c.wrap.style.zIndex = String(++z);
      if (prev && prev !== c && prev.state === 2 && c.state !== 2) { setState(prev, 0, true); setState(c, 2, true); }   // Windows: the maximized look moves along
    }
    for (const o of children.values()) o.mount.surface.setActive(o.key === activeKey);
    chrome();
    refreshBar();
  }
  /** The user picked a child (a click, the Window list): it comes to the front at once; the session makes it the active form. */
  function pick(c: Child): void {
    if (c.key !== activeKey) { activate(c.key); p.post(c.key, { t: 'activated' }); }
  }

  /** The buttons say what they do in the window's state (Restore instead of Minimize / Maximize); the caption, the max box. */
  function chrome(): void {
    for (const c of children.values()) {
      const bs = c.wrap.querySelectorAll<HTMLButtonElement>(':scope > .vb-form > .title-bar .title-bar-controls button');
      if (bs.length === 3) {
        bs[0].setAttribute('aria-label', c.state === 1 ? 'Restore' : 'Minimize');
        bs[1].setAttribute('aria-label', c.state === 2 ? 'Restore' : 'Maximize');
      }
    }
    const a = activeKey ? children.get(activeKey) : undefined;
    const max = a && a.visible && a.state === 2 ? a : undefined;
    p.setCaptionSuffix(max ? ` - [${String(max.props.Caption ?? '')}]` : null);
    maxBox?.remove();
    maxBox = null;
    if (!max) return;
    const btn = (label: string, disabled = false) => h('button', { type: 'button', 'aria-label': label, disabled });
    const minOk = on(max.props.MinButton ?? true), bs = num(max.props.BorderStyle, 2);
    maxBox = h('div', { class: 'vb-mdi-maxbox title-bar-controls' },
      ...(bs === 1 || bs === 2 ? [btn('Minimize', !minOk), btn('Restore')] : []), btn('Close'));
    maxBox.addEventListener('mousedown', e => e.preventDefault());
    maxBox.addEventListener('click', e => {
      const l = (e.target as Element).closest?.('button')?.getAttribute('aria-label');
      if (l) button(max, l);
    });
    const bar = p.surface.menuBar;
    if (bar.visible && bar.el.parentElement) {
      p.surface.el.appendChild(maxBox);
      maxBox.style.top = `${bar.el.offsetTop}px`;
    } else el.appendChild(maxBox);
  }

  function button(c: Child, label: string): void {
    if (label === 'Close') { p.post(c.key, { t: 'closeRequest' }); return; }
    pick(c);
    if (label === 'Minimize') setState(c, 1, true);
    else if (label === 'Maximize') setState(c, 2, true);
    else if (label === 'Restore') setState(c, 0, true);
  }

  // ---- menus --------------------------------------------------------------------------------------------------
  function refreshBar(): void {
    if (disposed) return;
    const a = activeKey ? children.get(activeKey) : undefined;
    const own = a && a.visible && hasMenuBar(a.menus) ? a : undefined;
    const base = own ? a!.menus : p.ownMenus();
    const wins = [...children.values()].filter(c => c.visible).sort((x, y) => x.seq - y.seq).map(c => ({ key: c.key, caption: String(c.props.Caption ?? '') }));
    const defs = withWindowList(base, wins, activeKey);
    if (!own && defs === base) { p.setBar(null, null); return; }
    const owner = (id: string): MenuBarHost => (own && own.menus.some(m => m.id === id) ? own.mount.menuHost : p.ownMenuHost);
    p.setBar(defs, {
      beforeOpen: id => owner(id).beforeOpen?.(id),
      choose: id => {
        if (!id.startsWith(WINDOW_ITEM)) { owner(id).choose(id); return; }
        const c = children.get(id.slice(WINDOW_ITEM.length));
        if (!c) return;
        pick(c);
        if (c.state === 1) setState(c, 0, true);
      },
    });
  }

  function menuMessage(c: Child, m: ToWindow): boolean {
    let changed = false;
    const patch = (id: string, props: Props) => {
      const i = c.menus.findIndex(d => d.id === id);
      if (i >= 0) { c.menus[i] = { ...c.menus[i], props: { ...c.menus[i].props, ...props } }; changed = true; }
    };
    if (m.t === 'patch') patch(m.id, m.props);
    else if (m.t === 'patches') for (const it of m.items) patch(it.id, it.props);
    else if (m.t === 'addControl' && isMenu(m.def)) { c.menus.push(m.def); changed = true; }
    else if (m.t === 'removeControl' && c.menus.some(d => d.id === m.id)) {
      const gone = new Set([m.id]);
      for (let grew = true; grew;) { grew = false; for (const d of c.menus) if (d.parentId && gone.has(d.parentId) && !gone.has(d.id)) { gone.add(d.id); grew = true; } }
      c.menus = c.menus.filter(d => !gone.has(d.id));
      changed = true;
    }
    return changed;
  }

  // ---- mouse: move, resize, buttons ---------------------------------------------------------------------------
  function drag(e: MouseEvent, move: (dx: number, dy: number) => void, end: () => void): void {
    e.preventDefault();
    const x0 = e.clientX, y0 = e.clientY;
    const mm = (ev: MouseEvent) => move(ev.clientX - x0, ev.clientY - y0);
    const up = (ev: MouseEvent) => { mm(ev); doc.removeEventListener('mousemove', mm, true); doc.removeEventListener('mouseup', up, true); end(); };
    doc.addEventListener('mousemove', mm, true);
    doc.addEventListener('mouseup', up, true);
  }

  function wire(c: Child): void {
    c.wrap.addEventListener('mousedown', e => {
      if (e.button !== 0) return;
      pick(c);
      const m = metrics(c), r = c.wrap.getBoundingClientRect();
      const bs = num(c.props.BorderStyle, 2);
      if (c.state !== 0 || !(bs === 2 || bs === 5) || !r.width) return;
      const dx = e.clientX - r.left, dy = e.clientY - r.top, b = m.border;
      const l = dx < b, rt = dx >= r.width - b, t = dy < b, bt = dy >= r.height - b;
      if (!(l || rt || t || bt)) return;
      e.stopPropagation();
      const x0 = c.x, y0 = c.y, w0 = m.outerWidth, h0 = m.outerHeight;
      let w = w0, hh = h0;
      drag(e, (ddx, ddy) => {
        const lim = ws();
        w = Math.max(100, rt ? Math.min(w0 + ddx, lim.width - x0) : l ? w0 - Math.max(-x0, Math.min(ddx, w0 - 100)) : w0);
        hh = Math.max(m.titleHeight + 2 * b, bt ? Math.min(h0 + ddy, lim.height - y0) : t ? h0 - Math.max(-y0, Math.min(ddy, h0 - m.titleHeight - 2 * b)) : h0);
        if (l) c.x = x0 + w0 - w;
        if (t) c.y = y0 + h0 - hh;
        c.wrap.style.left = `${c.x}px`; c.wrap.style.top = `${c.y}px`;
        c.mount.resize(twips(w), twips(hh), false);
      }, () => {
        c.props.Width = twips(w); c.props.Height = twips(hh);
        if (c.x !== x0 || c.y !== y0) reportPos(c);
        if (w !== w0 || hh !== h0) c.mount.resize(twips(w), twips(hh), true);
      });
    }, true);
    c.wrap.addEventListener('mousedown', e => {
      const t = e.target as Element;
      if (e.button !== 0 || !t.closest?.('.title-bar') || t.closest('.title-bar-controls') || t.closest('.vb-mdi-child') !== c.wrap) return;
      if (c.state === 2) return;
      const x0 = c.x, y0 = c.y, lx = parseFloat(c.wrap.style.left) || 0, ly = parseFloat(c.wrap.style.top) || 0;
      drag(e, (dx, dy) => {
        if (c.state === 1) return;
        c.x = x0 + dx; c.y = y0 + dy;
        place(c);
      }, () => { if (c.state === 0 && (c.x !== x0 || c.y !== y0)) reportPos(c); else if (c.state === 1) { c.wrap.style.left = `${lx}px`; c.wrap.style.top = `${ly}px`; } });
    });
    c.wrap.addEventListener('click', e => {
      const b = (e.target as Element).closest?.('.title-bar-controls button');
      const l = b?.getAttribute('aria-label');
      if (b && b.closest('.vb-mdi-child') === c.wrap && l && l !== 'Close') button(c, l);   // Close: the form window sends closeRequest
    });
    c.wrap.addEventListener('dblclick', e => {
      const t = e.target as Element;
      if (!t.closest?.('.title-bar') || t.closest('.title-bar-controls') || t.closest('.vb-mdi-child') !== c.wrap) return;
      const bs = num(c.props.BorderStyle, 2);
      if (c.state !== 0) setState(c, 0, true);
      else if ((bs === 2 || bs === 5 || bs === 1) && on(c.props.MaxButton ?? true) && on(c.props.ControlBox ?? true)) setState(c, 2, true);
    });
  }

  // ---- messages -----------------------------------------------------------------------------------------------
  function open(s: FormSnapshot): void {
    const old = children.get(s.key);
    if (old) close(s.key);
    const wrap = h('div', { class: 'vb-mdi-child' });
    wrap.style.zIndex = String(++z);
    el.appendChild(wrap);
    const key = s.key;
    const mount = p.mount(wrap, s, m => p.post(key, m));
    const props: Props = { ...s.form.props };
    const c: Child = { key, wrap, mount, props, visible: true, state: 0, x: 0, y: 0, normal: null,
      menus: s.form.controls.filter(isMenu).map(d => ({ ...d, props: { ...d.props } })), seq: ++seq };
    children.set(key, c);
    const m = metrics(c), w = ws(), pos = num(props.StartUpPosition, 3);
    if (pos === 0) { c.x = Math.round(num(props.Left) / 15); c.y = Math.round(num(props.Top) / 15); }
    else if (pos === 1 || pos === 2) { c.x = Math.round((w.width - m.outerWidth) / 2); c.y = Math.round((w.height - m.outerHeight) / 2); }
    else {
      const per = Math.max(1, Math.floor(Math.min(w.width, w.height) / 2 / 22));
      c.x = c.y = (cascade++ % per) * 22;
    }
    wire(c);
    place(c);
    reportPos(c);
    setState(c, num(props.WindowState), num(props.WindowState) === 2);   // a maximized one tells its size
    chrome();
    refreshBar();
  }

  function close(key: string): void {
    const c = children.get(key);
    if (!c) return;
    children.delete(key);
    c.mount.dispose();
    c.wrap.remove();
    if (activeKey === key) activeKey = null;
    if (!children.size) cascade = 0;
    for (const o of children.values()) if (o.state === 1) place(o);
    chrome();
    refreshBar();
  }

  function toChild(key: string, m: ToWindow): void {
    const c = children.get(key);
    if (!c) return;
    c.mount.receive(m);
    let bar = menuMessage(c, m);
    const form: Props = {};
    if (m.t === 'patch' && m.id === 'form') Object.assign(form, m.props);
    else if (m.t === 'patches') { for (const it of m.items) if (it.id === 'form') Object.assign(form, it.props); }
    else if (m.t === 'show' || m.t === 'hide') {
      c.visible = m.t === 'show';
      c.wrap.style.display = c.visible ? '' : 'none';
      for (const o of children.values()) if (o.state === 1) place(o);
      bar = true;
    }
    if (Object.keys(form).length) {
      const st = form.WindowState;
      delete form.WindowState;
      if (c.state === 2) {   // a maximized window keeps its size; what code set is its normal size
        if ('Width' in form || 'Height' in form) c.normal = { width: num(form.Width, c.normal?.width ?? 0), height: num(form.Height, c.normal?.height ?? 0) };
        const s = maxSize(c);
        if ('Width' in form || 'Height' in form) c.mount.resize(s.width, s.height, false);
        delete form.Width; delete form.Height;
      }
      Object.assign(c.props, form);
      if ('Left' in form || 'Top' in form) { c.x = Math.round(num(c.props.Left) / 15); c.y = Math.round(num(c.props.Top) / 15); }
      if (c.state === 0 && ['Left', 'Top', 'Width', 'Height'].some(k => k in form)) place(c);
      if (st !== undefined) setState(c, num(st), false);
      if ('Caption' in form) bar = true;
    }
    chrome();
    if (bar) refreshBar();
  }

  /** Arrange: vbCascade 0, vbTileHorizontal 1, vbTileVertical 2, vbArrangeIcons 3 (the active window first / in front). */
  function arrange(how: number): void {
    const w = ws();
    if (how === 3) { for (const c of children.values()) if (c.state === 1) place(c); return; }
    const list = [...children.values()].filter(c => c.visible && c.state !== 1);
    for (const c of list) if (c.state === 2) setState(c, 0, true);
    const zOf = (c: Child) => Number(c.wrap.style.zIndex) || 0;
    list.sort((a, b) => (how === 0 ? zOf(a) - zOf(b) : zOf(b) - zOf(a)));   // cascade: the front one last; tile: the front one first
    const rects = how === 0 ? cascadeRects(list.map(c => ({ width: metrics(c).outerWidth, height: metrics(c).outerHeight })), w)
      : tileRects(list.length, { width: w.width, height: Math.max(0, w.height - ([...children.values()].some(c => c.visible && c.state === 1) ? MINIMIZED_HEIGHT : 0)) }, how === 2);
    list.forEach((c, i) => {
      const r = rects[i];
      c.x = r.left; c.y = r.top;
      const wt = twips(r.width), ht = twips(r.height);
      if (wt !== num(c.props.Width) || ht !== num(c.props.Height)) { c.props.Width = wt; c.props.Height = ht; c.mount.resize(wt, ht, true); }
      place(c);
      reportPos(c);
    });
  }

  function relayout(): void {
    if (disposed) return;
    const a = p.surface.workArea();
    el.style.left = `${a.left}px`; el.style.top = `${a.top}px`;
    el.style.width = `${Math.max(0, a.width)}px`; el.style.height = `${Math.max(0, a.height)}px`;
    for (const c of children.values()) {
      if (c.state === 2) {
        const s = maxSize(c);
        if (s.width !== num(c.props.Width) || s.height !== num(c.props.Height)) { c.props.Width = s.width; c.props.Height = s.height; c.mount.resize(s.width, s.height, true); }
      }
      const x = c.x, y = c.y;
      place(c);
      if (c.state === 0 && (c.x !== x || c.y !== y)) reportPos(c);
    }
    chrome();
  }

  // the menu bar (also the merged one) takes Alt, F10 and the Shortcut keys before a child's controls get them
  el.addEventListener('keydown', e => { if (p.surface.menuBar.keyDown(e)) e.stopPropagation(); }, true);
  el.addEventListener('keyup', e => { if (p.surface.menuBar.keyUp(e)) e.stopPropagation(); }, true);
  el.style.overflow = on(p.formProps().ScrollBars ?? true) ? 'auto' : 'hidden';
  relayout();

  return {
    el,
    receive(m) {
      if (disposed) return m.t.startsWith('mdi');
      switch (m.t) {
        case 'mdiOpen': open(m.snapshot); return true;
        case 'mdiTo': toChild(m.key, m.m); return true;
        case 'mdiClose': close(m.key); return true;
        case 'mdiActive': activate(m.key); return true;
        case 'mdiArrange': arrange(m.arrangement); return true;
        default: return false;
      }
    },
    relayout,
    dispose() {
      if (disposed) return;
      for (const k of [...children.keys()]) close(k);
      disposed = true;
      maxBox?.remove();
      el.remove();
    },
  };
}
