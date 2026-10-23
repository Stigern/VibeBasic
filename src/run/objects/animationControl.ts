// Run-time behaviour of Animation (MSCOMCT2.OCX): Open, Play, Stop and Close, and the Start and Stop events.
//
// The file goes the way of MMControl's (mediaControls.ts): the form host opens it (RichHost.openMedia), the window reads it by its token. The
// frame delays of a picture file are read here (model/animation.ts) so that this side knows how long a pass lasts; the position of the
// playback is kept by the same MediaClock as MMControl's, and the window follows it as `MediaCmd`. Frames are numbered from 0. Start and End
// are honoured for how long Play lasts; a picture file always shows its frames from the first (the WebView cannot seek a GIF).
// Errors: 35752 "Unable to open AVI file" (an AVI, or any file that is not a GIF, APNG, WebP, MP4 or WebM), 53 for a missing file, 380 for a Play
// whose Repeat, Start or End do not fit.

import { VBRuntimeError } from '../../lang/errors';
import { Empty, VBRef, coerce, toStr, type VBValue } from '../../lang/values';
import { animationFormat, frameDelays, frameStart } from '../../model/animation';
import type { PropValue } from '../../model/types';
import type { OpenedMedia } from '../mediaSource';
import { MediaClock, openMedia, windowReport } from './mediaControls';
import { Timers, userAction, type RichControl, type RichHost } from './richControl';

const FPS = 30;
const given = (v: VBValue | undefined): v is VBValue => v !== undefined && v !== Empty;
const int = (v: VBValue): number => coerce(v, 'Long') as number;

export class AnimationControl implements RichControl {
  private timers = new Timers();
  private clock: MediaClock;
  private delays: number[] = [];
  private frames = 0;
  private playing = false;
  private repeat = -1;
  private loops = 0;
  private range = { from: 0, to: -1 };
  private gen = 0;

  constructor(private h: RichHost) {
    this.clock = new MediaClock(this.timers, p => { Object.assign(h.props, p); h.send(p); });
    this.clock.onEnd = () => this.passEnded();
    this.clock.volume = 0;
    this.clock.muted = true;
  }

  call(name: string, args: VBValue[]): VBValue | Promise<VBValue> | undefined {
    switch (name) {
      case 'open':
        if (!given(args[0])) throw new VBRuntimeError(450);
        return this.open(toStr(args[0])).then(() => Empty);
      case 'play': this.play(args[0], args[1], args[2]); return Empty;
      case 'stop': this.stop(); return Empty;
      case 'close': this.close(); return Empty;
    }
    return undefined;
  }

  applyState(props: Record<string, PropValue>): void {
    const a = userAction(props);
    if (a) windowReport(this.clock, a);
  }

  private async open(path: string): Promise<void> {
    const fmt = animationFormat(path);
    if (!fmt) throw new VBRuntimeError(35752, 'Unable to open AVI file');
    this.close();
    const gen = ++this.gen;
    let media: OpenedMedia, length: number, delays: number[] = [];
    try {
      if (fmt.kind === 'video') {
        const r = await openMedia(this.h, path, true);
        media = r.media; length = r.length;
      } else {
        media = await this.h.openMedia(path, fmt.mime);
        try {
          delays = frameDelays(await media.bytes(), 'image');
        } catch (e) { media.release(); throw e; }
        length = Math.max(1, delays.reduce((a, b) => a + b, 0));
      }
    } catch (e) {
      throw e instanceof VBRuntimeError && e.number === 53 ? e : new VBRuntimeError(35752, 'Unable to open AVI file');
    }
    if (gen !== this.gen) { media.release(); return; }   // closed or another file opened meanwhile
    this.delays = delays;
    this.frames = fmt.kind === 'video' ? Math.max(1, Math.round(length * FPS / 1000)) : delays.length;
    this.clock.load(media.src, length, fmt.kind === 'video', path.split(/[\\/]/).pop() ?? path, media.release);
    if (this.h.props.AutoPlay === true) this.play(undefined, undefined, undefined);
  }

  /** Play [Repeat], [Start], [End]: Repeat -1 (the default) plays for ever, Start and End are frames (End -1: the last). */
  private play(r: VBValue | undefined, s: VBValue | undefined, e: VBValue | undefined): void {
    const repeat = given(r) ? int(r) : -1, start = given(s) ? int(s) : 0, end = given(e) ? int(e) : -1;
    if (repeat === 0 || repeat < -1 || start < 0 || (end !== -1 && end < start)) throw new VBRuntimeError(380);
    if (!this.clock.open) return;
    if (start >= this.frames || end >= this.frames) throw new VBRuntimeError(380);
    const at = (n: number): number => (this.delays.length ? frameStart(this.delays, n) : Math.round(n * 1000 / FPS));
    this.repeat = repeat;
    this.loops = 0;
    this.range = { from: at(start), to: end === -1 ? -1 : at(end + 1) };
    this.clock.play(this.range.from, this.range.to);
    if (!this.playing) { this.playing = true; void this.h.raise('Start', []); }
  }

  /** A pass has reached its end: another one, or the end of Play. */
  private passEnded(): void {
    this.loops++;
    if (this.repeat === -1 || this.loops < this.repeat) { this.clock.play(this.range.from, this.range.to); return; }
    this.finish();
  }

  private finish(): void {
    if (!this.playing) return;
    this.playing = false;
    void this.h.raise('Stop', []);
  }

  private stop(): void {
    if (!this.clock.open) return;
    this.clock.pause();
    this.finish();
  }

  private close(): void {
    this.gen++;
    if (!this.clock.open) return;
    this.clock.pause();
    this.clock.close();
    this.delays = []; this.frames = 0;
    this.finish();
  }

  dispose(): void {
    this.gen++;
    this.timers.clearAll();
    this.clock.dispose();
  }
}
