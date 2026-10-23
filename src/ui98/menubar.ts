import { h, mnemonicNodes } from './dom';

export interface MenuItem {
  /** Text; `&` marks the accelerator letter (underlined). */
  label: string;
  /** Shown right-aligned and matched by bindShortcuts, e.g. "Ctrl+S", "F5", "Shift+F7", "Del". */
  shortcut?: string;
  action?: () => void;
  enabled?: () => boolean;
  checked?: () => boolean;
  submenu?: MenuItem[];
  separator?: boolean;
}

export interface MenuDef { label: string; items: MenuItem[] }

/**
 * Win98 menu bar. Click on a title opens its menu, hovering another title while one is open switches,
 * Escape / outside click closes, arrow keys + Enter work while open (no Alt needed).
 * Menus are built when opened, so enabled()/checked() are always current; refresh() updates an open menu.
 */
export function createMenubar(root: HTMLElement, menus: MenuDef[]): { refresh(): void } {
  const doc = root.ownerDocument;
  root.classList.add('mb98');
  // clicking the menu bar must not pull keyboard focus out of the editor / designer
  root.addEventListener('mousedown', e => e.preventDefault());
  const itemOf = new WeakMap<HTMLElement, MenuItem>();
  let openIndex = -1;
  /** The menu (top dropdown or submenu) that the keyboard currently navigates. */
  let level: HTMLElement | null = null;

  const tops = menus.map((m, i) => {
    const el = h('span', { class: 'mb98-top' }, ...mnemonicNodes(m.label));
    el.addEventListener('click', () => (openIndex === i ? close() : open(i)));
    const hover = () => { if (openIndex >= 0 && openIndex !== i) open(i); };
    el.addEventListener('mouseover', hover);
    el.addEventListener('mouseenter', hover);
    root.appendChild(el);
    return el;
  });

  const isEnabled = (it: MenuItem) => !it.separator && (it.enabled ? it.enabled() : true);

  function updateItemEl(el: HTMLElement) {
    const it = itemOf.get(el);
    if (!it || it.separator) return;
    el.classList.toggle('disabled', !isEnabled(it));
    const on = !!it.checked?.();
    el.classList.toggle('checked', on);
    const check = el.querySelector(':scope > .menu98-check');
    if (check) check.textContent = on ? '✓' : '';
  }

  function buildMenu(items: MenuItem[], isSub: boolean): HTMLElement {
    const menu = h('div', { class: isSub ? 'menu98 sub' : 'menu98' });
    menu.addEventListener('click', e => e.stopPropagation());
    for (const it of items) {
      if (it.separator) { menu.appendChild(h('div', { class: 'menu98-item sep' }, h('hr'))); continue; }
      const el = h('div', { class: it.submenu ? 'menu98-item has-sub' : 'menu98-item' },
        h('span', { class: 'menu98-check' }),
        h('span', { class: 'menu98-label' }, ...mnemonicNodes(it.label)),
        h('span', { class: 'menu98-shortcut' }, it.shortcut ?? ''),
        h('span', { class: 'menu98-arrow' }, it.submenu ? '▶' : ''));
      itemOf.set(el, it);
      updateItemEl(el);
      el.addEventListener('mouseover', e => { e.stopPropagation(); hot(menu, el); });
      el.addEventListener('click', e => {
        e.stopPropagation();
        if (!isEnabled(it)) return;
        if (it.submenu) { openSub(el); return; }
        close();
        it.action?.();
      });
      menu.appendChild(el);
    }
    return menu;
  }

  const itemEls = (menu: HTMLElement) => [...menu.children].filter(c => c.classList.contains('menu98-item') && !c.classList.contains('sep')) as HTMLElement[];

  function closeSubs(menu: HTMLElement, except?: HTMLElement) {
    for (const c of itemEls(menu)) if (c !== except) c.querySelector(':scope > .menu98')?.remove();
  }

  function hot(menu: HTMLElement, el: HTMLElement | null) {
    for (const c of itemEls(menu)) c.classList.toggle('hot', c === el);
    level = menu;
    if (el && itemOf.get(el)?.submenu && isEnabled(itemOf.get(el)!)) { closeSubs(menu, el); openSub(el, false); }
    else closeSubs(menu);
  }

  function openSub(el: HTMLElement, focusFirst = false) {
    if (el.querySelector(':scope > .menu98')) return;
    const it = itemOf.get(el)!;
    const sub = buildMenu(it.submenu!, true);
    el.appendChild(sub);
    if (focusFirst) { const first = enabledItems(sub)[0]; if (first) hot(sub, first); }
  }

  const enabledItems = (menu: HTMLElement) => itemEls(menu).filter(e => !e.classList.contains('disabled'));

  function open(i: number) {
    close(false);
    openIndex = i;
    tops[i].classList.add('open');
    const menu = buildMenu(menus[i].items, false);
    tops[i].appendChild(menu);
    level = menu;
    doc.addEventListener('mousedown', onOutside, true);
    doc.addEventListener('keydown', onKey, true);
  }

  function close(release = true) {
    if (openIndex >= 0) {
      tops[openIndex].classList.remove('open');
      tops[openIndex].querySelector(':scope > .menu98')?.remove();
    }
    openIndex = -1;
    level = null;
    if (release) {
      doc.removeEventListener('mousedown', onOutside, true);
      doc.removeEventListener('keydown', onKey, true);
    }
  }

  function onOutside(e: Event) {
    if (!root.contains(e.target as Node)) close();
  }

  function onKey(e: KeyboardEvent) {
    if (openIndex < 0 || !level) return;
    const lvl = level;
    const items = enabledItems(lvl);
    const cur = itemEls(lvl).find(c => c.classList.contains('hot')) ?? null;
    const swallow = () => { e.preventDefault(); e.stopPropagation(); };
    switch (e.key) {
      case 'Escape': swallow(); close(); break;
      case 'ArrowDown': case 'ArrowUp': {
        swallow();
        if (items.length === 0) break;
        const dir = e.key === 'ArrowDown' ? 1 : -1;
        let idx = cur && items.includes(cur) ? items.indexOf(cur) + dir : (dir === 1 ? 0 : items.length - 1);
        if (cur && !items.includes(cur)) idx = dir === 1 ? 0 : items.length - 1;
        idx = (idx + items.length) % items.length;
        hot(lvl, items[idx]);
        break;
      }
      case 'ArrowRight': {
        swallow();
        if (cur && itemOf.get(cur)?.submenu && !cur.classList.contains('disabled')) {
          openSub(cur, false);
          const sub = cur.querySelector<HTMLElement>(':scope > .menu98');
          if (sub) { const first = enabledItems(sub)[0]; if (first) hot(sub, first); }
        } else open((openIndex + 1) % menus.length);
        break;
      }
      case 'ArrowLeft': {
        swallow();
        if (lvl.classList.contains('sub')) {
          const parentItem = lvl.parentElement as HTMLElement;
          lvl.remove();
          level = parentItem.parentElement as HTMLElement;
        } else open((openIndex - 1 + menus.length) % menus.length);
        break;
      }
      case 'Enter': case ' ': {
        swallow();
        if (cur) cur.click();
        break;
      }
    }
  }

  return {
    refresh() {
      if (openIndex < 0) return;
      for (const el of tops[openIndex].querySelectorAll<HTMLElement>('.menu98-item')) updateItemEl(el);
    },
  };
}

// ---------------------------------------------------------------------------------------------------------------------
// Keyboard shortcuts

export interface ParsedShortcut { ctrl: boolean; shift: boolean; alt: boolean; key: string }

const KEY_ALIASES: Record<string, string> = {
  del: 'delete', ins: 'insert', esc: 'escape', return: 'enter', pgup: 'pageup', pgdn: 'pagedown',
  space: ' ', pause: 'break', cancel: 'break',
};

const normKey = (k: string) => {
  const l = k.toLowerCase();
  return KEY_ALIASES[l] ?? l;
};

/** Parses "Ctrl+Shift+F9", "Del", "Ctrl+Break". `Ctrl` stands for Ctrl and Cmd alike. */
export function parseShortcut(s: string): ParsedShortcut {
  const parts = s.split('+').map(p => p.trim()).filter(p => p.length > 0);
  const sc: ParsedShortcut = { ctrl: false, shift: false, alt: false, key: '' };
  // A trailing "+" key ("Ctrl++") ends up empty after the split.
  if (s.endsWith('++')) parts.push('+');
  for (const p of parts) {
    const l = p.toLowerCase();
    if (l === 'ctrl' || l === 'cmd' || l === 'command' || l === 'meta') sc.ctrl = true;
    else if (l === 'shift') sc.shift = true;
    else if (l === 'alt' || l === 'option') sc.alt = true;
    else sc.key = normKey(p);
  }
  return sc;
}

export function shortcutMatches(sc: ParsedShortcut, e: KeyboardEvent, backspaceAsDelete = false): boolean {
  const ctrlLike = e.ctrlKey || e.metaKey;
  if (sc.ctrl !== ctrlLike || sc.shift !== e.shiftKey || sc.alt !== e.altKey) return false;
  if (normKey(e.key) === sc.key) return true;
  // Mac laptops have no Delete key: Backspace stands in for Del (callers only allow it outside text fields).
  if (backspaceAsDelete && sc.key === 'delete' && e.key === 'Backspace') return true;
  // Cmd+. is how Ctrl+Break is typed on a Mac keyboard.
  return sc.key === 'break' && ctrlLike && e.key === '.';
}

function isEditable(t: EventTarget | null): boolean {
  const el = t as HTMLElement | null;
  if (!el || !('tagName' in el)) return false;
  const tag = el.tagName;
  return tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || el.isContentEditable === true;
}

const CLIPBOARD_KEYS = new Set(['c', 'x', 'v', 'a', 'z', 'y']);

function collect(menus: MenuDef[] | MenuItem[], out: { sc: ParsedShortcut; item: MenuItem }[]) {
  for (const m of menus) {
    const items = 'items' in m ? m.items : [m as MenuItem];
    for (const it of items) {
      if (it.shortcut) out.push({ sc: parseShortcut(it.shortcut), item: it });
      if (it.submenu) collect(it.submenu, out);
    }
  }
}

/**
 * Binds the shortcuts of all menu items (also in submenus) to `target`. "Ctrl+X" matches Ctrl+X and Cmd+X;
 * "Ctrl+Break" also Ctrl+Pause and Cmd+. . Disabled items are skipped. Inside text fields, unmodified keys
 * (Del, ...) and clipboard/undo keys are left to the field. Returns a function that removes the binding.
 */
export function bindShortcuts(menus: MenuDef[], target: Window): () => void {
  const handler = (e: KeyboardEvent) => {
    if (e.defaultPrevented) return;   // a field or widget already consumed the key
    const all: { sc: ParsedShortcut; item: MenuItem }[] = [];
    collect(menus, all);
    const editable = isEditable(e.target);
    let owned = false;
    for (const { sc, item } of all) {
      if (!shortcutMatches(sc, e, !editable)) continue;
      if (editable) {
        const fkey = /^f\d+$/.test(sc.key);
        if (!sc.ctrl && !sc.alt && !fkey) continue;
        if (sc.ctrl && !sc.alt && !sc.shift && CLIPBOARD_KEYS.has(sc.key)) continue;
      }
      if (!item.action) continue;
      // A disabled item still owns its key (so F5 does not reload the webview) but does nothing.
      if (item.enabled && !item.enabled()) { owned = true; continue; }
      e.preventDefault();
      item.action();
      return;
    }
    if (owned) e.preventDefault();
  };
  target.addEventListener('keydown', handler as EventListener);
  return () => target.removeEventListener('keydown', handler as EventListener);
}
