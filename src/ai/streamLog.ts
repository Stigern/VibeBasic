// The text the model has streamed so far, drawn into the waiting dialog's inset box: thinking in grey, the answer in black.
import { h } from '../ui98/dom';
import type { AiDeltaKind } from './sse';

export const THINKING_COLOR = '#808080';
export const FIX_SEPARATOR = '--- Checking and fixing ---';

/** `node` holds the first `shown` characters of `text`; only the last segment still grows. */
type Seg = { kind: AiDeltaKind | 'sep'; text: string; node?: Text; shown: number };

const requestFrame = (f: () => void): number =>
  typeof requestAnimationFrame === 'function' ? requestAnimationFrame(f) : (setTimeout(f, 16) as unknown as number);
const cancelFrame = (id: number): void => {
  if (typeof cancelAnimationFrame === 'function') cancelAnimationFrame(id); else clearTimeout(id);
};

/**
 * Survives from one waiting dialog to the next, so the check-and-fix retry continues in the same text.
 * DOM updates are batched per animation frame and only append what is new; the box follows the end of the text unless the user
 * scrolled up.
 */
export class StreamLog {
  private segs: Seg[] = [];
  private box: HTMLElement | null = null;
  private pending = 0;
  /** Segments before this one are finished and drawn in full. */
  private drawn = 0;

  add(kind: AiDeltaKind, text: string): void {
    const last = this.segs[this.segs.length - 1];
    if (last && last.kind === kind) last.text += text;
    else this.segs.push({ kind, text: (kind === 'content' && last?.kind === 'reasoning' ? '\n\n' : '') + text, shown: 0 });
    this.schedule();
  }

  /** A line between the first answer and the retry. */
  separator(line = FIX_SEPARATOR): void {
    if (this.segs.length) this.segs.push({ kind: 'sep', text: `\n\n${line}\n\n`, shown: 0 });
    this.schedule();
  }

  /** Draws into `box` (a fresh element per dialog) and keeps it up to date until `detach`. */
  attach(box: HTMLElement): void {
    this.box = box;
    for (const g of this.segs) { g.node = undefined; g.shown = 0; }
    this.drawn = 0;
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
    for (let i = this.drawn; i < this.segs.length; i++) {
      const g = this.segs[i];
      if (!g.node) {
        g.node = document.createTextNode('');
        box.append(h('span', {
          class: g.kind === 'reasoning' ? 'ai-thinking' : g.kind === 'content' ? 'ai-answer' : 'ai-sep',
          style: `color:${g.kind === 'reasoning' ? THINKING_COLOR : '#000'}`,
        }, g.node));
      }
      if (g.shown < g.text.length) { g.node.appendData(g.text.slice(g.shown)); g.shown = g.text.length; }
      if (i < this.segs.length - 1) this.drawn = i + 1;
    }
    if (atBottom) box.scrollTop = box.scrollHeight;
  }
}
