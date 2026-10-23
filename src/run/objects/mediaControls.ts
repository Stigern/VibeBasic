// Run-time behaviour of MMControl (MCI32.OCX) and MediaPlayer (MSDXM.OCX).
//
// A file is opened through the form host (RichHost.openMedia, see mediaSource.ts), probed for its length by a media element of this
// (main) window, and named to the form window by `MediaSrc` (a token the window reads the file by, or a Blob URL of this document),
// where an HTML media element plays it: the bytes never go through a patch. The position is kept here by a clock (MediaClock), so
// Mode, Position, Done and EndOfStream do not depend on the window: the window's element follows the state it gets as `MediaCmd`, and
// reports only its end and, when the probe could not tell, its length (UserAction 'ended' / 'duration'), so a Play always ends.

import { VBRuntimeError } from '../../lang/errors';
import { Empty, VBRef, coerce, toBool, toStr, type VBValue } from '../../lang/values';
import { MCI_BUTTONS } from '../../model/controls';
import {
  MCI_ERRORS, MCI_MODE, MCI_NOTIFY, MP_STATE, encodeMediaCmd, fileTitle, formatToMs, isVideoFile, mciIsVideo, mediaMime, msToFormat, volumeGain,
  type MediaCommand,
} from '../../model/media';
import type { PropValue } from '../../model/types';
import type { OpenedMedia } from '../mediaSource';
import { Timers, userAction, type RichControl, type RichHost } from './richControl';

const num = (v: VBValue): number => coerce(v, 'Long') as number;

/** The length (ms) of a media file, read by a media element of this window; 0 when it does not tell in time. Rejects when the
 *  WebView cannot play the file. */
export function probeLength(src: string, video: boolean, timeoutMs = 4000): Promise<number> {
  return new Promise((resolve, reject) => {
    const el = document.createElement(video ? 'video' : 'audio');
    let done = false;
    const finish = (ok: boolean, ms = 0) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      el.removeAttribute('src');
      if (ok) resolve(ms); else reject(new Error('cannot play'));
    };
    const timer = setTimeout(() => finish(true, 0), timeoutMs);
    el.preload = 'metadata';
    el.addEventListener('loadedmetadata', () => { const d = el.duration; finish(true, Number.isFinite(d) && d > 0 ? Math.round(d * 1000) : 0); });
    el.addEventListener('error', () => finish(false));
    el.src = src;
    try { el.load(); } catch { /* the src change loads it anyway */ }
  });
}

/** Opens and probes `path`: the open file (its `src` for the window) and the length. Throws 53 (missing) or 'cannot play'. */
export async function openMedia(h: RichHost, path: string, video: boolean): Promise<{ media: OpenedMedia; length: number }> {
  const mime = mediaMime(path);
  const media = await h.openMedia(path, mime);
  try {
    let probe = media.src, own = false;
    if (!probe.startsWith('blob:') && !probe.startsWith('data:')) {   // a token of the window: read the bytes here once for the probe
      const bytes = await media.bytes();
      if (typeof URL.createObjectURL !== 'function') throw new Error('cannot play');
      probe = URL.createObjectURL(new Blob([bytes as BlobPart], { type: mime }));
      own = true;
    }
    try { return { media, length: await probeLength(probe, video) }; } finally { if (own) URL.revokeObjectURL(probe); }
  } catch (e) {
    media.release();
    throw e;
  }
}

/** The playback state: a position that runs on while playing, up to `to` or the end. */
export class MediaClock {
  src = '';
  length = 0;
  video = false;
  title = '';
  volume = 1;
  muted = false;
  status = '';
  /** Called when playing reaches its end (`to` or the length). */
  onEnd: (() => void) | null = null;
  /** Closes the open file (its Blob URL or token). */
  private release: (() => void) | null = null;
  private at = 0;
  private since: number | null = null;
  private stopAt = -1;
  private seq = 0;
  private timer: ReturnType<typeof setTimeout> | null = null;

  constructor(private timers: Timers, private send: (p: Record<string, PropValue>) => void) {}

  get playing(): boolean { return this.since !== null; }
  get open(): boolean { return this.src !== ''; }
  private end(): number { return this.stopAt >= 0 ? Math.min(this.stopAt, this.length || Infinity) : this.length || Infinity; }
  position(): number {
    if (this.since === null) return this.at;
    return Math.min(this.end(), this.at + (Date.now() - this.since));
  }

  load(src: string, length: number, video: boolean, title: string, release: (() => void) | null = null): void {
    this.halt();
    this.free();
    this.release = release;
    Object.assign(this, { src, length, video, title, at: 0, stopAt: -1 });
    this.send({ MediaSrc: src, MediaCmd: this.cmd() });
  }
  close(): void {
    this.halt();
    Object.assign(this, { src: '', length: 0, at: 0, stopAt: -1 });
    this.send({ MediaSrc: '', MediaCmd: this.cmd() });
    this.free();
  }
  /** The window's element ended: the end, unless the clock got there first (or is not playing). */
  windowEnded(): void {
    if (this.since === null) return;
    this.timers.clear(this.timer);
    this.reachedEnd();
  }
  /** The window's element knows the length the probe could not tell: the clock can reach the end now. */
  windowLength(ms: number): void {
    if (this.length || !(ms > 0)) return;
    this.length = Math.round(ms);
    if (this.since !== null) {
      this.timers.clear(this.timer);
      const left = this.end() - this.position();
      this.timer = Number.isFinite(left) ? this.timers.after(left, () => this.reachedEnd()) : null;
    }
  }
  /** Plays from `from` (ms; the current position when undefined) to `to` (-1: the end). */
  play(from?: number, to = -1): void {
    this.halt();
    if (from !== undefined) this.at = this.clamp(from);
    this.stopAt = to;
    if (this.at >= this.end()) this.at = 0;   // at the end: from the start again
    this.since = Date.now();
    const left = this.end() - this.at;
    if (Number.isFinite(left)) this.timer = this.timers.after(left, () => this.reachedEnd());
    this.sync();
  }
  pause(): void {
    if (this.since === null) return;
    this.at = this.position();
    this.halt();
    this.sync();
  }
  seek(ms: number): void {
    const was = this.playing, to = this.stopAt;
    this.halt();
    this.at = this.clamp(ms);
    if (was) this.play(undefined, to); else this.sync();
  }
  /** Re-sends the state (volume, mute, status changed). */
  sync(): void { this.send({ MediaCmd: this.cmd() }); }
  dispose(): void { this.halt(); this.free(); }

  private free(): void { const r = this.release; this.release = null; r?.(); }
  private clamp(ms: number): number { return Math.max(0, this.length ? Math.min(this.length, ms) : ms); }
  private halt(): void {
    if (this.since !== null) this.at = this.position();
    this.since = null;
    this.timers.clear(this.timer);
    this.timer = null;
  }
  private reachedEnd(): void {
    this.timer = null;
    this.at = Math.min(this.end(), this.length || this.end());
    this.since = null;
    this.sync();
    this.onEnd?.();
  }
  private cmd(): string {
    const c: MediaCommand = {
      seq: ++this.seq, playing: this.playing, pos: Math.round(this.position()), to: this.stopAt, length: this.length,
      volume: this.volume, muted: this.muted, video: this.video, title: this.title, status: this.status,
    };
    return encodeMediaCmd(c);
  }
}

/** The window's own reports about its media element (not clicks): true when `a` was one. */
export function windowReport(clock: MediaClock, a: Record<string, string | number>): boolean {
  if (a.verb === 'ended') { clock.windowEnded(); return true; }
  if (a.verb === 'duration') { clock.windowLength(Number(a.ms)); return true; }
  return false;
}

// -- MMControl -----------------------------------------------------------------------------------------------------

type Pending = { notify: boolean; done: () => void };

export class MciControl implements RichControl {
  private timers = new Timers();
  private clock: MediaClock;
  /** From and To given since the last command (they apply to the next command only, as Notify and Wait do). */
  private given = new Set<string>();
  /** The Play whose end is still to come: its Done (Notify) and the waiting statement (Wait). */
  private pending: Pending | null = null;
  private status: ReturnType<typeof setInterval> | null = null;
  private statusBusy = false;
  private static nextId = 1;

  constructor(private h: RichHost) {
    this.clock = new MediaClock(this.timers, p => this.view(p));
    this.clock.onEnd = () => this.playEnded();
    Object.assign(h.props, { Mode: MCI_MODE.notOpen, Command: '', Error: 0, ErrorMessage: '' });
  }

  private get p(): Record<string, PropValue> { return this.h.props; }
  private view(props: Record<string, PropValue>): void { Object.assign(this.p, props); this.h.send(props); }
  private format(ms: number): number { return msToFormat(ms, Number(this.p.TimeFormat) || 0); }
  private setMode(m: number): void { if (this.p.Mode !== m) this.view({ Mode: m }); }

  get(name: string): VBValue | undefined {
    switch (name) {
      case 'Position': case 'TrackPosition': return this.format(this.clock.position());
      case 'Length': case 'TrackLength': return this.format(this.clock.length);
      case 'Start': return 0;
      case 'Mode': return Number(this.p.Mode);
    }
    return undefined;
  }

  set(name: string, value: VBValue): boolean | Promise<void> {
    switch (name) {
      case 'Command': return this.command(toStr(value)) ?? true;
      case 'From': case 'To': this.p[name] = num(value); this.given.add(name); return true;
      case 'UpdateInterval': {
        const n = num(value);
        if (n < 0 || n > 65535) throw new VBRuntimeError(380);
        this.p.UpdateInterval = n;
        this.startStatus();
        return true;
      }
    }
    return false;
  }

  applyState(props: Record<string, PropValue>): void {
    const a = userAction(props);
    if (!a) return;
    if (windowReport(this.clock, a)) return;
    if (MCI_BUTTONS.includes(String(a.verb) as typeof MCI_BUTTONS[number])) void this.button(String(a.verb));
  }

  /** A click on a button: <Button>Click(Cancel), the command, then <Button>Completed(Errorcode). */
  private async button(b: string): Promise<void> {
    const cancel = new VBRef(0);
    await this.h.raise(`${b}Click`, [cancel]);
    if (toBool(cancel.value)) return;
    await this.command(b, true);
    await this.h.raise(`${b}Completed`, [new VBRef(Number(this.p.Error) || 0)]);
  }

  private setError(n: number): void { this.p.Error = n; this.p.ErrorMessage = n ? MCI_ERRORS[n] ?? '' : ''; }

  /** One MCI command. Undefined when it is done; a Promise when the statement waits (Open always, Play and Seek with Wait). */
  private command(raw: string, byButton = false): Promise<void> | undefined {
    const name = raw.trim().toLowerCase();
    const known = ['open', 'close', 'play', 'pause', 'stop', 'back', 'step', 'prev', 'next', 'seek', 'record', 'eject', 'sound', 'save'];
    if (!known.includes(name)) throw new VBRuntimeError(380);
    const p = this.p;
    // Notify, Wait, From and To apply to the next command only (a button's command leaves them alone)
    let notify = false, wait = false, from: number | undefined, to: number | undefined;
    if (!byButton) {
      notify = toBool(p.Notify as VBValue); wait = toBool(p.Wait as VBValue);
      if (this.given.has('From')) from = formatToMs(Number(p.From), Number(p.TimeFormat) || 0);
      if (this.given.has('To')) to = formatToMs(Number(p.To), Number(p.TimeFormat) || 0);
      p.Notify = false; p.Wait = false; this.given.clear();
      p.Command = raw;
    }
    this.setError(0);
    const done = (code: number = this.p.Error ? MCI_NOTIFY.failure : MCI_NOTIFY.successful) => { if (notify) void this.h.raise('Done', [new VBRef(code)]); };
    if (name === 'open') return this.open().then(() => done());
    const isOpen = this.clock.open;
    if (!isOpen && name !== 'close' && name !== 'eject' && name !== 'sound') { this.setError(263); done(); return undefined; }
    // a new command ends the wait for the end of a Play: superseded when it has Notify itself, else aborted
    const interrupts = ['close', 'stop', 'pause', 'seek', 'play', 'prev', 'next', 'back', 'step'];
    if (this.pending && interrupts.includes(name) && !(name === 'pause' && Number(p.Mode) === MCI_MODE.pause)) this.finishPending(notify ? MCI_NOTIFY.superseded : MCI_NOTIFY.aborted);
    switch (name) {
      case 'close': this.close(); break;
      case 'play': return this.play(from, to, notify, wait);
      case 'pause':
        if (Number(p.Mode) === MCI_MODE.pause) return this.play(undefined, undefined, notify, wait);   // Pause again resumes
        if (this.clock.playing) { this.clock.pause(); this.setMode(MCI_MODE.pause); }
        break;
      case 'stop': this.clock.pause(); this.setMode(MCI_MODE.stop); break;
      case 'seek': this.clock.pause(); this.clock.seek(to ?? 0); this.setMode(MCI_MODE.stop); break;
      case 'prev': this.clock.seek(0); break;
      case 'next':
        if (this.clock.playing) { this.clock.pause(); this.setMode(MCI_MODE.stop); }
        this.clock.seek(this.clock.length);
        break;
      case 'back': case 'step': {
        if (p.CanStep !== true) { this.setError(274); break; }
        const frames = Math.max(1, Number(p.Frames) || 1);
        if (this.clock.playing) { this.clock.pause(); this.setMode(MCI_MODE.pause); }
        this.clock.seek(this.clock.position() + (name === 'step' ? 1 : -1) * frames * 1000 / 30);
        break;
      }
      case 'record': case 'save': this.setError(274); break;
      case 'eject': case 'sound': break;   // nothing to eject; Sound is not supported and does nothing
    }
    done();
    return undefined;
  }

  private async open(): Promise<void> {
    const p = this.p;
    if (this.clock.open) this.close();
    const path = String(p.FileName ?? '');
    if (!path) { this.setError(275); return; }
    const video = mciIsVideo(String(p.DeviceType ?? ''), path);
    let r: { media: OpenedMedia; length: number };
    try {
      r = await openMedia(this.h, path, video);
    } catch (e) {
      this.setError(e instanceof VBRuntimeError ? 275 : 296);
      return;
    }
    this.clock.load(r.media.src, r.length, video, fileTitle(path), r.media.release);
    this.view({ Mode: MCI_MODE.stop, CanPlay: true, CanStep: video, CanEject: false, CanRecord: false, Tracks: 1, Track: 1, UsesWindows: video, DeviceID: MciControl.nextId++ });
    this.startStatus();
  }

  private close(): void {
    this.clock.close();
    this.view({ Mode: MCI_MODE.notOpen, CanPlay: false, CanStep: false, Tracks: 0, UsesWindows: false, DeviceID: 0 });
    this.stopStatus();
  }

  private play(from: number | undefined, to: number | undefined, notify: boolean, wait: boolean): Promise<void> | undefined {
    this.clock.play(from, to ?? -1);
    this.setMode(MCI_MODE.play);
    if (!notify && !wait) return undefined;
    const ended = new Promise<void>(resolve => { this.pending = { notify, done: resolve }; });
    return wait ? ended : undefined;
  }

  /** The Play waited for has ended (code: mciSuccessful) or was interrupted. */
  private finishPending(code: number): void {
    const pend = this.pending;
    this.pending = null;
    if (!pend) return;
    pend.done();
    if (pend.notify) void this.h.raise('Done', [new VBRef(code)]);
  }

  private playEnded(): void {
    this.setMode(MCI_MODE.stop);
    this.finishPending(MCI_NOTIFY.successful);
  }

  private startStatus(): void {
    this.stopStatus();
    const ms = Number(this.p.UpdateInterval) || 0;
    if (!ms || !this.clock.open) return;
    this.status = setInterval(() => {
      if (this.statusBusy) return;
      this.statusBusy = true;
      void this.h.raise('StatusUpdate', []).finally(() => { this.statusBusy = false; });
    }, ms);
  }
  private stopStatus(): void { if (this.status) clearInterval(this.status); this.status = null; }

  dispose(): void {
    this.stopStatus();
    this.timers.clearAll();
    this.clock.dispose();
    const pend = this.pending;
    this.pending = null;
    pend?.done();
  }
}

// -- MediaPlayer ---------------------------------------------------------------------------------------------------

const STATUS: Record<number, string> = { [MP_STATE.stopped]: 'Stopped', [MP_STATE.paused]: 'Paused', [MP_STATE.playing]: 'Playing', [MP_STATE.closed]: '' };

export class MediaPlayerControl implements RichControl {
  private timers = new Timers();
  private clock: MediaClock;
  private opening: Promise<void> | null = null;
  private loops = 0;
  private gen = 0;

  constructor(private h: RichHost) {
    this.clock = new MediaClock(this.timers, p => { Object.assign(h.props, p); h.send(p); });
    this.clock.onEnd = () => void this.ended();
    this.clock.volume = volumeGain(Number(h.props.Volume ?? -600));
    this.clock.muted = h.props.Mute === true;
    Object.assign(h.props, { PlayState: MP_STATE.stopped, ReadyState: 0 });
    const f = String(h.props.FileName ?? '');
    if (f) void this.open(f).catch(() => { /* the status line says so */ });
  }

  private get p(): Record<string, PropValue> { return this.h.props; }

  private async setState(n: number): Promise<void> {
    const old = Number(this.p.PlayState);
    this.p.PlayState = n;
    this.clock.status = STATUS[n] ?? '';
    this.clock.sync();
    if (old !== n) await this.h.raise('PlayStateChange', [new VBRef(old), new VBRef(n)]);
  }

  get(name: string): VBValue | undefined {
    switch (name) {
      case 'CurrentPosition': return this.clock.position() / 1000;
      case 'Duration': return this.clock.length / 1000;
    }
    return undefined;
  }

  set(name: string, value: VBValue): boolean | Promise<void> {
    switch (name) {
      case 'FileName': {
        const f = toStr(value);
        this.p.FileName = f;
        return this.open(f);
      }
      case 'CurrentPosition': this.seekTo(Number(coerce(value, 'Double')) * 1000); return true;
      case 'Volume': {
        const v = num(value);
        if (v < -10000 || v > 0) throw new VBRuntimeError(380);
        this.p.Volume = v;
        this.clock.volume = volumeGain(v);
        this.clock.sync();
        return true;
      }
      case 'Mute': {
        const m = toBool(value);
        this.p.Mute = m;
        this.clock.muted = m;
        this.h.send({ Mute: m });
        this.clock.sync();
        return true;
      }
    }
    return false;
  }

  call(name: string, args: VBValue[]): VBValue | Promise<VBValue> | undefined {
    switch (name) {
      case 'play': return this.play().then(() => Empty);
      case 'pause': return this.pause().then(() => Empty);
      case 'stop': return this.stop().then(() => Empty);
      case 'open': {
        if (args[0] === undefined) throw new VBRuntimeError(450);
        const f = toStr(args[0]);
        this.p.FileName = f;
        return this.open(f).then(() => Empty);
      }
    }
    return undefined;
  }

  applyState(props: Record<string, PropValue>): void {
    const a = userAction(props);
    if (!a || windowReport(this.clock, a)) return;
    const len = this.clock.length;
    switch (a.verb) {
      case 'play': void this.play(); break;
      case 'pause': void (this.clock.playing ? this.pause() : this.play()); break;
      case 'stop': void this.stop(); break;
      case 'seek': this.seekTo(Number(a.pos) || 0); break;
      case 'skipback': this.seekTo(0); break;
      case 'rewind': this.seekTo(this.clock.position() - 5000); break;
      case 'forward': this.seekTo(this.clock.position() + 5000); break;
      case 'skipfwd': if (len) this.seekTo(len); break;
      case 'mute': this.set('Mute', !this.clock.muted); break;
    }
  }

  /** Opens `path` (FileName = path or Open path); with AutoStart it starts playing. */
  private open(path: string): Promise<void> {
    const gen = ++this.gen;
    const run = async (): Promise<void> => {
      if (this.clock.playing || Number(this.p.PlayState) !== MP_STATE.stopped) await this.stop();
      if (!path) { this.clock.close(); this.p.ReadyState = 0; return; }
      this.p.ReadyState = 1;
      this.clock.status = 'Opening...';
      this.clock.sync();
      let r: { media: OpenedMedia; length: number };
      try {
        r = await openMedia(this.h, path, isVideoFile(path));
      } catch (e) {
        if (gen !== this.gen) return;
        this.p.ReadyState = 0;
        this.clock.close();
        this.clock.status = 'Cannot open the file';
        this.clock.sync();
        throw e instanceof VBRuntimeError ? e : new VBRuntimeError(5, 'Cannot play this file');
      }
      if (gen !== this.gen) { r.media.release(); return; }
      this.clock.load(r.media.src, r.length, isVideoFile(path), fileTitle(path), r.media.release);
      this.p.ReadyState = 4;
      this.clock.status = 'Ready';
      this.clock.sync();
      if (this.p.AutoStart !== false) await this.start();   // not play(): that waits for this very opening
    };
    const p = run();
    this.opening = p.catch(() => undefined).finally(() => { if (this.opening === p) this.opening = null; });
    return p;
  }

  private async play(): Promise<void> {
    if (this.opening) await this.opening;
    await this.start();
  }
  private async start(): Promise<void> {
    if (!this.clock.open) return;
    if (this.clock.playing) return;
    if (Number(this.p.PlayState) === MP_STATE.stopped) this.loops = 0;
    this.clock.play();
    await this.setState(MP_STATE.playing);
  }
  private async pause(): Promise<void> {
    if (!this.clock.playing) return;
    this.clock.pause();
    await this.setState(MP_STATE.paused);
  }
  private async stop(): Promise<void> {
    this.clock.pause();
    if (this.clock.open) this.clock.seek(0);
    await this.setState(MP_STATE.stopped);
  }
  private seekTo(ms: number): void {
    const old = this.clock.position() / 1000;
    this.clock.seek(ms);
    void this.h.raise('PositionChange', [new VBRef(old), new VBRef(this.clock.position() / 1000)]);
  }

  /** The end of the file: again for PlayCount (0 = for ever), else EndOfStream and Stopped (back at the start with AutoRewind). */
  private async ended(): Promise<void> {
    const count = Number(this.p.PlayCount ?? 1);
    this.loops++;
    if (count === 0 || this.loops < count) { this.clock.play(0); return; }
    await this.h.raise('EndOfStream', [new VBRef(0)]);
    if (this.p.AutoRewind !== false) this.clock.seek(0);
    await this.setState(MP_STATE.stopped);
  }

  dispose(): void { this.gen++; this.timers.clearAll(); this.clock.dispose(); }
}
