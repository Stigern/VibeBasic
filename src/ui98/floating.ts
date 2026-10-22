// Body-level popup layer: dropdown lists and editor popups live here, position:fixed under (or above) their
// anchor, so no overflow:hidden/auto ancestor (Properties cells, tab panels, panes) can clip them.

export type CloseReason = 'outside' | 'escape' | 'resize' | 'scroll' | 'api';

export interface Floating {
  el: HTMLElement;
  close(reason?: CloseReason): void;
  /** Re-measure the anchor and place the popup again (e.g. after its content changed size). */
  place(): void;
}

export interface FloatingOptions {
  /** Minimum width; the anchor's width is the default minimum. */
  minWidth?: number;
  /** 'left' lines up left edges (lists); 'right' lines up right edges (Properties editors). */
  align?: 'left' | 'right';
  /** Called once when the popup closes, with the reason. */
  onClose?: (reason: CloseReason) => void;
}

const LAYER = 'popup98-layer';

/** The shared layer under <body>, created on first use. */
export function popupLayer(doc: Document): HTMLElement {
  let layer = doc.querySelector<HTMLElement>(`body > .${LAYER}`);
  if (!layer) {
    layer = doc.createElement('div');
    layer.className = LAYER;
    doc.body.appendChild(layer);
  }
  return layer;
}

/** Shows `content` in the popup layer next to `anchor`. Closes on an outside mousedown, Escape, window resize
 *  and on scroll of any ancestor of the anchor. */
export function showFloating(anchor: HTMLElement, content: HTMLElement, o: FloatingOptions = {}): Floating {
  const doc = anchor.ownerDocument;
  const win = doc.defaultView!;
  const el = doc.createElement('div');
  el.className = 'popup98';
  el.appendChild(content);
  popupLayer(doc).appendChild(el);
  let open = true;

  const place = () => {
    const r = anchor.getBoundingClientRect();
    const vw = win.innerWidth || doc.documentElement.clientWidth;
    const vh = win.innerHeight || doc.documentElement.clientHeight;
    el.style.minWidth = `${Math.max(r.width, o.minWidth ?? 0)}px`;
    const w = el.offsetWidth, ht = el.offsetHeight;
    let left = o.align === 'right' ? r.right - w : r.left;
    left = Math.max(0, Math.min(left, vw - w));
    let top = r.bottom;
    if (top + ht > vh && r.top - ht >= 0) top = r.top - ht;   // no room below: open upwards
    el.style.left = `${left}px`;
    el.style.top = `${top}px`;
  };

  const close = (reason: CloseReason = 'api') => {
    if (!open) return;
    open = false;
    el.remove();
    doc.removeEventListener('mousedown', onDown, true);
    doc.removeEventListener('keydown', onKey, true);
    doc.removeEventListener('scroll', onScroll, true);
    win.removeEventListener('resize', onResize);
    o.onClose?.(reason);
  };
  const onDown = (e: Event) => {
    const t = e.target as Node | null;
    if (t && (el.contains(t) || anchor.contains(t))) return;
    close('outside');
  };
  const onKey = (e: KeyboardEvent) => {
    if (e.key !== 'Escape') return;
    e.preventDefault();
    e.stopPropagation();   // Escape only closes the popup (it does not also cancel the editor or a dialog)
    close('escape');
  };
  const onScroll = (e: Event) => {
    const t = e.target;
    if (t instanceof win.Node && el.contains(t)) return;   // scrolling the popup's own list
    if (t === doc || (t instanceof win.Node && t.contains(anchor))) close('scroll');
  };
  const onResize = () => close('resize');

  doc.addEventListener('mousedown', onDown, true);
  doc.addEventListener('keydown', onKey, true);
  doc.addEventListener('scroll', onScroll, true);
  win.addEventListener('resize', onResize);
  place();
  return { el, close, place };
}
