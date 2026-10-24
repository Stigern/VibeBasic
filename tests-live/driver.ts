// The stand-in for the user at the Win98 dialogs of the AI flow. The test file mocks showDialog98, messageBox98 and
// compileErrorBox to call this driver: it types the prompt, waits at the waiting dialog, records every preview, answer and
// warning, and presses OK (or Change... / Ask more... with the next scripted wish).

export interface PreviewRecord {
  kind: 'code' | 'form';
  /** Code preview: the "Changes:" list. Form preview: the op lines. */
  lines: string[];
  warnings: string[];
  metrics: string;
  /** Code preview: the After pane as text. */
  after?: string;
  answer: 'ok' | 'change';
}
export interface DialogLog {
  previews: PreviewRecord[];
  answers: { text: string; metrics: string }[];
  notUnderstood: string[];
  warnings: string[];
  waitLabels: string[];
  other: string[];
}

export class Driver {
  prompt = '';
  /** Change... wishes, used one per preview (then OK). */
  changes: string[] = [];
  /** Ask more... texts, used one per AI Answer (then OK). */
  askMore: string[] = [];
  compileChoice: 'ok' | 'ai' = 'ai';
  log: DialogLog = Driver.empty();

  static empty(): DialogLog { return { previews: [], answers: [], notUnderstood: [], warnings: [], waitLabels: [], other: [] }; }

  reset(prompt: string, changes: string[] = [], askMore: string[] = []): void {
    this.prompt = prompt; this.changes = [...changes]; this.askMore = [...askMore]; this.log = Driver.empty();
  }

  dialog(_doc: Document, o: { title: string; content: HTMLElement; buttons: { label: string; value: string }[] }): Promise<string> {
    const c = o.content;
    const values = o.buttons.map(b => b.value);
    const q = <T extends Element>(sel: string) => c.querySelector<T>(sel) ?? (c.matches(sel) ? (c as unknown as T) : null);
    const all = (sel: string) => [...c.querySelectorAll(sel)].map(e => (e.textContent ?? '').trim());
    // the waiting dialog stays open until the reply is in (waitForReply races it against the request)
    const label = q<HTMLElement>('.ai-wait-label');
    if (label) {
      this.log.waitLabels.push(label.textContent ?? '');
      new MutationObserver(() => this.log.waitLabels.push(label.textContent ?? '')).observe(label, { childList: true, characterData: true, subtree: true });
      return new Promise<string>(() => {});
    }
    const prompt = q<HTMLTextAreaElement>('textarea.ai-prompt');
    if (prompt) { prompt.value = this.prompt; return Promise.resolve('ok'); }
    const change = q<HTMLInputElement>('input.ai-change');
    if (change) { change.value = this.changes.shift() ?? ''; return Promise.resolve('ok'); }
    const more = q<HTMLInputElement>('input.ai-ask-more');
    if (more) { more.value = this.askMore.shift() ?? ''; return Promise.resolve('ok'); }
    const metrics = (q<HTMLElement>('.ai-metrics')?.textContent ?? '').trim();
    if (o.title === 'AI Suggestion' && values.includes('change')) {
      const form = !!q('.ai-ops');
      const answer: 'ok' | 'change' = this.changes.length ? 'change' : 'ok';
      this.log.previews.push({
        kind: form ? 'form' : 'code',
        lines: form ? all('.ai-op') : all('.ai-changes li'),
        warnings: all('.ai-warning'),
        metrics,
        ...(form ? {} : { after: [...c.querySelectorAll('.ai-after > div')].map(d => d.textContent ?? '').join('\n') }),
        answer,
      });
      return Promise.resolve(answer);
    }
    if (o.title === 'AI Answer' && values.includes('more')) {
      this.log.answers.push({ text: (q<HTMLElement>('.ai-answer-box')?.textContent ?? '').trim(), metrics });
      return Promise.resolve(this.askMore.length ? 'more' : 'ok');
    }
    const text = (c.textContent ?? '').trim();
    if (/could not be understood/.test(text)) { this.log.notUnderstood.push(text); return Promise.resolve('ok'); }
    this.log.other.push(`${o.title}: ${text.slice(0, 300)}`);
    return Promise.resolve(o.buttons.find(b => b.value === 'ok')?.value ?? o.buttons[0]?.value ?? '');
  }

  messageBox(o: { prompt: string }): Promise<number> {
    this.log.warnings.push(o.prompt);
    return Promise.resolve(1);
  }
}

export const driver = new Driver();
(globalThis as unknown as { __liveDriver: Driver }).__liveDriver = driver;
