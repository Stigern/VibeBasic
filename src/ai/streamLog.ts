// The text the model has streamed so far, drawn into the waiting dialog's inset box: thinking in grey, the answer in black.
import { h } from '../ui98/dom';
import type { AiDeltaKind } from './sse';

export const THINKING_COLOR = '#808080';
export const FIX_SEPARATOR = '--- Checking and fixing ---';

type Seg = { kind: AiDeltaKind | 'sep'; text: string; el?: HTMLElement };

const requestFrame = (f: () => void): number =>
  typeof requestAnimationFrame === 'function' ? requestAnimationFrame(f) : (setTimeout(f, 16) as unknown as number);
const cancelFrame = (id: number): void => {
  if (typeof cancelAnimationFrame === 'function') cancelAnimationFrame(id); else clearTimeout(id);
};

/**
 * Survives from one waiting dialog to the next, so the check-and-fix retry continues in the same text.
 * DOM updates are batched per animation frame; the box follows the end of the text unless the user scrolled up.
 */
export class StreamLog {
  private segs: Seg[] = [];
  private box: HTMLElement | null = null;
  private pending = 0;

  add(kind: AiDeltaKind, text: string): void {
    const last = this.segs[this.segs.length - 1];
    if (last && last.kind === kind) last.text += text;
    else this.segs.push({ kind, text: (kind === 'content' && last?.kind === 'reasoning' ? '\n\n' : '') + text });
    this.schedule();
  }

  /** A line between the first answer and the retry. */
  separator(): void {
    if (this.segs.length) this.segs.push({ kind: 'sep', text: `\n\n${FIX_SEPARATOR}\n\n` });
    this.schedule();
  }

  /** Draws into `box` (a fresh element per dialog) and keeps it up to date until `detach`. */
  attach(box: HTMLElement): void {
    this.box = box;
    for (const g of this.segs) g.el = undefined;
    this.flush();
  }

  detach(): void {
    this.box = null;
    if (this.pending) { cancelFrame(this.pending); this.pending = 0; }
  }

  private schedule(): void {
    if (!this.box || this.pending) return;
    this.pending = requestFrame(() => { this.pending = 0; this.flush(); });
  }

  private flush(): void {
    const box = this.box;
    if (!box) return;
    const atBottom = box.scrollTop + box.clientHeight >= box.scrollHeight - 4;
    for (const g of this.segs) {
      if (!g.el) {
        g.el = h('span', {
          class: g.kind === 'reasoning' ? 'ai-thinking' : g.kind === 'content' ? 'ai-answer' : 'ai-sep',
          style: `color:${g.kind === 'reasoning' ? THINKING_COLOR : '#000'}`,
        });
        box.append(g.el);
      }
      if (g.el.textContent !== g.text) g.el.textContent = g.text;
    }
    if (atBottom) box.scrollTop = box.scrollHeight;
  }
}
