import { createTitleBar, h } from './dom';
import { MSGBOX_ICONS, msgIconFromBits, type MsgIconName } from './icons/msgbox';

export interface DialogButton {
  label: string;
  value: string;
  /** Pressed by Enter; drawn with the heavy default frame and focused on open. */
  default?: boolean;
  /** Pressed by Escape and by the title bar close box. Without any, Escape does nothing and the close box is disabled. */
  cancel?: boolean;
  disabled?: boolean;
}

export interface DialogOptions {
  title: string;
  content: HTMLElement;
  buttons: DialogButton[];
  /** VB InputBox layout: buttons stacked on the right instead of centred along the bottom. */
  buttonsSide?: boolean;
  /** A size grip in the lower right corner; `content` fills the room the dialog gets (it is never smaller than at first). */
  resizable?: boolean;
  /** Where the user left the dialog (moved or resized), kept under this key and used again the next time (in this session). */
  placeKey?: string;
}

/** The place and size the user gave a dialog, by DialogOptions.placeKey. */
const places = new Map<string, { left: number; top: number; width: number; height: number }>();

const FOCUSABLE = 'button:not(:disabled), input:not(:disabled), textarea:not(:disabled), select:not(:disabled), [tabindex]:not([tabindex="-1"])';

/**
 * Generic modal Win98 dialog. Resolves with the `value` of the pressed button.
 * Modal: a full-screen transparent overlay blocks the rest of the document, keys are captured
 * (Enter = default, Escape = cancel, Tab cycles) and never reach other handlers while it is open.
 * An element in `content` with `data-autofocus` receives focus instead of the default button.
 * The title bar moves it; `resizable` adds a size grip.
 */
export function showDialog98(doc: Document, o: DialogOptions): Promise<string> {
  return new Promise<string>(resolve => {
    const cancelBtn = o.buttons.find(b => b.cancel && !b.disabled);
    const defBtn = o.buttons.find(b => b.default && !b.disabled);
    const previouslyFocused = doc.activeElement as HTMLElement | null;

    let finished = false;
    const finish = (value: string) => {
      if (finished) return;
      finished = true;
      if (o.placeKey && pinned) places.set(o.placeKey, { left: win.offsetLeft, top: win.offsetTop, width: win.offsetWidth, height: win.offsetHeight });
      doc.removeEventListener('keydown', onKey, true);
      doc.removeEventListener('focusin', onFocusIn, true);
      overlay.remove();
      try { previouslyFocused?.focus?.(); } catch { /* element may be gone */ }
      resolve(value);
    };

    const buttonEls = new Map<DialogButton, HTMLButtonElement>();
    // `dlg98-abort`: the owner of the dialog is gone (the run session ended); closes it as if cancelled.
    const abort = () => finish((cancelBtn ?? o.buttons.find(b => !b.disabled))?.value ?? '');
    for (const b of o.buttons) {
      buttonEls.set(b, h('button', {
        type: 'button',
        class: b.default ? 'default' : '',
        disabled: !!b.disabled,
        onclick: () => finish(b.value),
      }, b.label));
    }

    const title = createTitleBar(o.title, {
      closeDisabled: !cancelBtn,
      onClose: () => { if (cancelBtn) finish(cancelBtn.value); },
    });
    const buttonRow = h('div', { class: o.buttonsSide ? 'dlg98-buttons side' : 'dlg98-buttons' }, ...buttonEls.values());
    const body = h('div', { class: o.buttonsSide ? 'window-body dlg98-body side' : 'window-body dlg98-body' }, o.content, buttonRow);
    const win = h('div', { class: o.resizable ? 'window dlg98 dlg98-resizable' : 'window dlg98', role: 'dialog', 'aria-modal': 'true' }, title.bar, body);
    const overlay = h('div', { class: 'dlg98-overlay' }, win);
    overlay.addEventListener('dlg98-abort', abort);
    // Swallow pointer events outside the dialog so the document below cannot be used.
    overlay.addEventListener('mousedown', e => { if (e.target === overlay) e.preventDefault(); });

    // Moving and sizing: the first drag pins the (centred) dialog where it is, with the size it has, in viewport pixels.
    let pinned = false, minW = 0, minH = 0;
    const pin = (r: { left: number; top: number; width: number; height: number }) => {
      pinned = true;
      win.classList.add('dlg98-pinned');
      Object.assign(win.style, { left: `${r.left}px`, top: `${r.top}px`, width: `${r.width}px`, height: `${r.height}px` });
    };
    const pinHere = () => {
      if (pinned) return;
      const r = win.getBoundingClientRect();
      minW = r.width; minH = r.height;
      pin({ left: r.left, top: r.top, width: r.width, height: r.height });
    };
    /** Follows the mouse from a mousedown until the button is released; `move` gets the distance from the start. */
    const drag = (e: MouseEvent, move: (dx: number, dy: number) => void) => {
      e.preventDefault();
      const sx = e.clientX, sy = e.clientY;
      const onMove = (ev: MouseEvent) => move(ev.clientX - sx, ev.clientY - sy);
      const onUp = () => { doc.removeEventListener('mousemove', onMove, true); doc.removeEventListener('mouseup', onUp, true); };
      doc.addEventListener('mousemove', onMove, true);
      doc.addEventListener('mouseup', onUp, true);
    };
    title.bar.addEventListener('mousedown', e => {
      if (e.button !== 0 || (e.target as Element).closest('.title-bar-controls')) return;
      pinHere();
      const x0 = win.offsetLeft, y0 = win.offsetTop, w = win.offsetWidth;
      const vw = doc.documentElement.clientWidth, vh = doc.documentElement.clientHeight;
      drag(e, (dx, dy) => {
        // a part of the title bar stays on the screen, so the dialog can always be taken back
        win.style.left = `${vw ? Math.min(vw - 40, Math.max(40 - w, x0 + dx)) : x0 + dx}px`;
        win.style.top = `${vh ? Math.min(vh - 20, Math.max(0, y0 + dy)) : y0 + dy}px`;
      });
    });
    if (o.resizable) {
      const grip = h('div', { class: 'mdi98-grip dlg98-grip' });
      win.appendChild(grip);
      grip.addEventListener('mousedown', e => {
        if (e.button !== 0) return;
        e.stopPropagation();
        pinHere();
        const w0 = win.offsetWidth, h0 = win.offsetHeight;
        drag(e, (dx, dy) => {
          win.style.width = `${Math.max(minW, w0 + dx)}px`;
          win.style.height = `${Math.max(minH, h0 + dy)}px`;
        });
      });
    }

    const isTopmost = () => {
      const all = doc.querySelectorAll('.dlg98-overlay');
      return all[all.length - 1] === overlay;
    };

    /** Enter / Escape / Tab handling. Returns nothing; callers decide about propagation. */
    function handleKey(e: KeyboardEvent) {
      const target = e.target as Element | null;
      const inDialog = !!target && overlay.contains(target as Node);
      if (e.key === 'Enter') {
        // Enter on another focused button presses that button (native behaviour).
        if (inDialog && target!.tagName === 'BUTTON' && !(target as HTMLElement).classList.contains('default')) return;
        e.preventDefault();
        if (defBtn) buttonEls.get(defBtn)!.click();
      } else if (e.key === 'Escape') {
        e.preventDefault();
        if (cancelBtn) buttonEls.get(cancelBtn)!.click();
      } else if (e.key === 'Tab') {
        e.preventDefault();
        const els = [...win.querySelectorAll<HTMLElement>(FOCUSABLE)];
        if (els.length === 0) return;
        const i = els.indexOf(doc.activeElement as HTMLElement);
        const next = e.shiftKey ? (i <= 0 ? els.length - 1 : i - 1) : (i + 1) % els.length;
        els[next].focus();
      }
    }

    // Keys whose target is outside the topmost dialog (focus left behind, or dispatched on the document):
    // handled here and never reach IDE shortcut handlers.
    function onKey(e: KeyboardEvent) {
      if (!isTopmost()) return;
      if (e.target && overlay.contains(e.target as Node)) return; // handled by onOverlayKey after widgets had their say
      e.stopPropagation();
      handleKey(e);
    }

    // Keys from inside the dialog bubble through its widgets first (tabs, combo ...). A widget that consumed
    // the key calls preventDefault, which we respect. Nothing leaves the dialog afterwards.
    function onOverlayKey(e: KeyboardEvent) {
      if (!isTopmost()) return;
      if (!e.defaultPrevented) handleKey(e);
      e.stopPropagation();
    }

    function onFocusIn(e: FocusEvent) {
      if (!isTopmost()) return;
      const t = e.target as Node | null;
      if (t && !overlay.contains(t)) (win.querySelector<HTMLElement>(FOCUSABLE))?.focus();
    }

    overlay.addEventListener('keydown', onOverlayKey);
    doc.body.appendChild(overlay);
    const saved = o.placeKey ? places.get(o.placeKey) : undefined;
    if (saved) {   // where the user left it last time: never smaller than now, and on the screen
      const r = win.getBoundingClientRect(), vw = doc.documentElement.clientWidth, vh = doc.documentElement.clientHeight;
      minW = r.width; minH = r.height;
      const width = Math.max(minW, vw ? Math.min(saved.width, vw) : saved.width), height = Math.max(minH, vh ? Math.min(saved.height, vh) : saved.height);
      pin({ width, height,
        left: vw ? Math.min(Math.max(0, saved.left), Math.max(0, vw - width)) : saved.left,
        top: vh ? Math.min(Math.max(0, saved.top), Math.max(0, vh - height)) : saved.top });
    }
    doc.addEventListener('keydown', onKey, true);
    doc.addEventListener('focusin', onFocusIn, true);

    const auto = o.content.matches('[data-autofocus]') ? o.content : o.content.querySelector<HTMLElement>('[data-autofocus]');
    if (auto) {
      auto.focus();
      if (auto instanceof HTMLInputElement) auto.select();
    } else if (defBtn) buttonEls.get(defBtn)!.focus();
    else win.querySelector<HTMLElement>(FOCUSABLE)?.focus();
  });
}

// ---------------------------------------------------------------------------------------------------------------------
// MsgBox

export const vbOK = 1, vbCancel = 2, vbAbort = 3, vbRetry = 4, vbIgnore = 5, vbYes = 6, vbNo = 7;

const BUTTON_SETS: { label: string; value: number }[][] = [
  [{ label: 'OK', value: vbOK }],
  [{ label: 'OK', value: vbOK }, { label: 'Cancel', value: vbCancel }],
  [{ label: 'Abort', value: vbAbort }, { label: 'Retry', value: vbRetry }, { label: 'Ignore', value: vbIgnore }],
  [{ label: 'Yes', value: vbYes }, { label: 'No', value: vbNo }, { label: 'Cancel', value: vbCancel }],
  [{ label: 'Yes', value: vbYes }, { label: 'No', value: vbNo }],
  [{ label: 'Retry', value: vbRetry }, { label: 'Cancel', value: vbCancel }],
];

function normalizeNewlines(s: string): string {
  return s.replace(/\r\n|\r/g, '\n');
}

export function messageContent(prompt: string, icon: MsgIconName | undefined): HTMLElement {
  const text = h('div', { class: 'dlg98-text' }, normalizeNewlines(prompt));
  const row = h('div', { class: 'dlg98-message' });
  if (icon) {
    const holder = h('div', { class: 'dlg98-icon', dataset: { icon } });
    holder.innerHTML = MSGBOX_ICONS[icon];
    row.appendChild(holder);
  }
  row.appendChild(text);
  return row;
}

/**
 * VB6 MsgBox. `buttons` uses the VB constants: `& 7` selects the button set, `& 0x70` the icon,
 * `& 0x300` the default button. Resolves with vbOK..vbNo.
 * Escape / the title bar close box press Cancel, or OK for a lone OK button; with Yes/No and
 * Abort/Retry/Ignore they do nothing (as in VB6).
 */
export async function messageBox98(doc: Document, o: { prompt: string; title: string; buttons: number }): Promise<number> {
  const set = BUTTON_SETS[o.buttons & 7] ?? BUTTON_SETS[0];
  const wanted = (o.buttons & 0x300) >> 8;
  const defIdx = wanted < set.length ? wanted : 0;
  const hasCancel = set.some(b => b.value === vbCancel);
  const buttons: DialogButton[] = set.map((b, i) => ({
    label: b.label,
    value: String(b.value),
    default: i === defIdx,
    cancel: hasCancel ? b.value === vbCancel : set.length === 1,
  }));
  const v = await showDialog98(doc, { title: o.title, content: messageContent(o.prompt, msgIconFromBits(o.buttons)), buttons });
  return Number(v);
}

/** VB6 InputBox: prompt on the left, OK/Cancel stacked on the right, edit field below. Cancel/Escape give "". */
export async function inputBox98(doc: Document, o: { prompt: string; title: string; defaultText: string }): Promise<string> {
  const input = h('input', { type: 'text', class: 'dlg98-input', value: o.defaultText ?? '', 'data-autofocus': '' });
  const content = h('div', { class: 'dlg98-inputcontent' },
    h('div', { class: 'dlg98-text' }, normalizeNewlines(o.prompt)),
    input);
  const v = await showDialog98(doc, {
    title: o.title, content, buttonsSide: true,
    buttons: [{ label: 'OK', value: 'ok', default: true }, { label: 'Cancel', value: 'cancel', cancel: true }],
  });
  return v === 'ok' ? input.value : '';
}

/** Compile error shown before a program starts. Help is disabled (there is no help file). */
/** `askAi` adds the Ask AI button after OK; 'ai' when it was pressed. */
export async function compileErrorBox(doc: Document, message: string, o: { askAi?: boolean } = {}): Promise<'ok' | 'ai'> {
  const v = await showDialog98(doc, {
    title: 'VibeBasic',
    content: messageContent(`Compile error:\n\n${message}`, 'exclamation'),
    buttons: [{ label: 'OK', value: 'ok', default: true, cancel: true }, ...(o.askAi ? [{ label: 'Ask AI', value: 'ai' }] : []), { label: 'Help', value: 'help', disabled: true }],
  });
  return v === 'ai' ? 'ai' : 'ok';
}
