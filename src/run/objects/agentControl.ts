// Run-time behaviour of the Agent control (AGENTCTL.DLL, Microsoft Agent 2.0).
//
// Agent1.Characters.Load "Robby" loads a built-in character (model/agent.ts); Agent1.Characters("Robby") is its Character object.
// Show, Hide, Speak, Think, Play, MoveTo, GestureAt and Wait are requests: each returns a Request object and waits in the
// character's queue until the requests before it have finished, as in the real Agent. A request raises RequestStart and
// RequestComplete (Status 0 complete, 3 interrupted by Stop / StopAll). The timing is kept here; the window only draws the
// state (`AgentChars`). Speak also talks through the WebView's speech synthesis when there is one.

import type { VBObject } from '../../lang/host';
import { VBRuntimeError } from '../../lang/errors';
import { Empty, Nothing, VBRef, coerce, isObject, toBool, toStr, type VBValue } from '../../lang/values';
import { AGENT_ANIMATIONS, AGENT_CHARACTERS, AGENT_SIZE, animationName, plainSpeech, speakMs, type AgentCharState } from '../../model/agent';
import type { PropValue } from '../../model/types';
import { Timers, userAction, type RichControl, type RichHost } from './richControl';

const num = (v: VBValue): number => coerce(v, 'Long') as number;
const arg = (args: VBValue[], i: number): VBValue | undefined => (args[i] === undefined || args[i] === Empty ? undefined : args[i]);
const lc = (s: string): string => s.toLowerCase();

/** Request.Status values. */
export const REQUEST = { complete: 0, failed: 1, pending: 2, interrupted: 3, inProgress: 4 } as const;
/** Show / Hide Cause and Move Cause. */
const CAUSE = { userHid: 1, userShowed: 2, programHid: 3, programShowed: 4, userMoved: 1, programMoved: 2 } as const;

/** A simple read-only VB object with the named properties. */
abstract class PropsObject implements VBObject {
  abstract readonly vbTypeName: string;
  protected abstract read(name: string): VBValue | undefined;
  hasMember(name: string): boolean { return this.read(lc(name)) !== undefined || this.methods.includes(lc(name)); }
  protected methods: string[] = [];
  getMember(name: string, args: VBValue[]): VBValue {
    const v = this.read(lc(name));
    if (v === undefined) { if (this.methods.includes(lc(name))) return this.callMethod(name, args) as VBValue; throw new VBRuntimeError(438); }
    if (args.length) throw new VBRuntimeError(450);
    return v;
  }
  setMember(name: string): void { if (this.read(lc(name)) !== undefined) throw new VBRuntimeError(383); throw new VBRuntimeError(438); }
  callMethod(_name: string, _args: VBValue[]): VBValue | Promise<VBValue> { throw new VBRuntimeError(438); }
}

export class RequestObject extends PropsObject {
  readonly vbTypeName = 'IAgentCtlRequest';
  status: number = REQUEST.pending;
  description = '';
  number = 0;
  constructor(readonly id: number) { super(); }
  protected read(name: string): VBValue | undefined {
    switch (name) {
      case 'id': return this.id;
      case 'status': return this.status;
      case 'description': return this.description;
      case 'number': return this.number;
    }
    return undefined;
  }
}

interface Req { obj: RequestObject; kind: string; run(r: Run): Promise<void>; done: Promise<void>; finish(): void }
/** A running request: it can be stopped (the waits end early). */
interface Run { stopped: boolean; wait(ms: number): Promise<void>; onStop(fn: () => void): void }

class Character {
  x = 40; y = 40; visible = false;
  anim = ''; seq = 0; moveMs = 0;
  text = ''; balloon = false; think = false; textSeq = 0; speakMs = 0; speaking = false;
  idleOn = true; moveCause = 0; visibilityCause = 0;
  queue: Req[] = [];
  pumping = false;
  current: { req: Req; run: Run; stop: () => void } | null = null;
  balloonTimer: ReturnType<typeof setTimeout> | null = null;
  obj: CharacterObject;
  constructor(readonly id: string, readonly sprite: string, public name: string, public description: string, owner: AgentControl) {
    this.obj = new CharacterObject(this, owner);
  }
  state(): AgentCharState {
    return {
      id: this.id, sprite: this.sprite, x: this.x, y: this.y, visible: this.visible, anim: this.anim, seq: this.seq, moveMs: this.moveMs,
      text: this.text, balloon: this.balloon, think: this.think, textSeq: this.textSeq, speakMs: this.speakMs, speaking: this.speaking,
    };
  }
}

export class CharacterObject implements VBObject {
  readonly vbTypeName = 'IAgentCtlCharacter';
  private balloonObj: BalloonObject;
  constructor(private c: Character, private a: AgentControl) { this.balloonObj = new BalloonObject(c, a); }

  hasMember(name: string): boolean { return PROPS.has(lc(name)) || METHODS.has(lc(name)); }
  getMember(name: string, args: VBValue[]): VBValue {
    const l = lc(name);
    if (METHODS.has(l)) return this.callMethod(name, args) as VBValue;
    if (args.length) throw new VBRuntimeError(450);
    const c = this.c;
    switch (l) {
      case 'left': return c.x;
      case 'top': return c.y;
      case 'width': case 'height': case 'originalwidth': case 'originalheight': return AGENT_SIZE;
      case 'visible': return c.visible;
      case 'name': return c.name;
      case 'description': return c.description;
      case 'characterid': return c.id;
      case 'balloon': return this.balloonObj;
      case 'idleon': return c.idleOn;
      case 'movecause': return c.moveCause;
      case 'visibilitycause': return c.visibilityCause;
      case 'soundeffectson': return true;
      case 'active': return 1;
    }
    throw new VBRuntimeError(438);
  }
  setMember(name: string, args: VBValue[], value: VBValue): void {
    if (args.length) throw new VBRuntimeError(450);
    const c = this.c;
    switch (lc(name)) {
      case 'left': c.x = num(value); c.moveMs = 0; this.a.draw(); return;
      case 'top': c.y = num(value); c.moveMs = 0; this.a.draw(); return;
      case 'name': c.name = toStr(value); return;
      case 'description': c.description = toStr(value); return;
      case 'idleon': c.idleOn = toBool(value); return;
      case 'soundeffectson': return;
    }
    if (PROPS.has(lc(name))) throw new VBRuntimeError(383);
    throw new VBRuntimeError(438);
  }
  callMethod(name: string, args: VBValue[]): VBValue | Promise<VBValue> {
    const l = lc(name);
    if (!METHODS.has(l)) throw new VBRuntimeError(438);
    return this.a.characterMethod(this.c, l, args);
  }
}

const PROPS = new Set(['left', 'top', 'width', 'height', 'originalwidth', 'originalheight', 'visible', 'name', 'description', 'characterid', 'balloon',
  'idleon', 'movecause', 'visibilitycause', 'soundeffectson', 'active']);
const METHODS = new Set(['show', 'hide', 'speak', 'think', 'play', 'moveto', 'gestureat', 'stop', 'stopall', 'wait', 'interrupt', 'activate']);

class BalloonObject implements VBObject {
  readonly vbTypeName = 'IAgentCtlBalloon';
  constructor(private c: Character, private a: AgentControl) {}
  hasMember(name: string): boolean { return ['visible', 'enabled', 'style', 'fontname', 'fontsize'].includes(lc(name)); }
  getMember(name: string, args: VBValue[]): VBValue {
    if (args.length) throw new VBRuntimeError(450);
    switch (lc(name)) {
      case 'visible': return this.c.balloon && this.c.text !== '';
      case 'enabled': return true;
      case 'style': return 0;
      case 'fontname': return 'MS Sans Serif';
      case 'fontsize': return 8;
    }
    throw new VBRuntimeError(438);
  }
  setMember(name: string, args: VBValue[], value: VBValue): void {
    if (args.length) throw new VBRuntimeError(450);
    if (lc(name) !== 'visible') { if (this.hasMember(name)) throw new VBRuntimeError(383); throw new VBRuntimeError(438); }
    this.a.setBalloon(this.c, toBool(value));
  }
  callMethod(): VBValue { throw new VBRuntimeError(438); }
}

/** Agent1.Characters: Load, Unload and the characters by CharacterID (`Characters("Robby")`, `Characters.Character("Robby")`). */
class CharactersObject implements VBObject {
  readonly vbTypeName = 'IAgentCtlCharacters';
  readonly defaultMember = 'Character';
  constructor(private a: AgentControl) {}
  hasMember(name: string): boolean { return ['character', 'item', 'load', 'unload'].includes(lc(name)); }
  getMember(name: string, args: VBValue[]): VBValue { return this.callMethod(name, args) as VBValue; }
  setMember(): void { throw new VBRuntimeError(383); }
  callMethod(name: string, args: VBValue[]): VBValue {
    switch (lc(name)) {
      case 'character': case 'item':
        if (args.length !== 1) throw new VBRuntimeError(450);
        return this.a.character(toStr(args[0])).obj;
      case 'load': return this.a.load(args);
      case 'unload':
        if (args.length !== 1) throw new VBRuntimeError(450);
        this.a.unload(toStr(args[0]));
        return Empty;
    }
    throw new VBRuntimeError(438);
  }
}

export class AgentControl implements RichControl {
  private chars = new Map<string, Character>();
  private characters = new CharactersObject(this);
  private timers = new Timers();
  private nextReq = 1;
  private disposed = false;

  constructor(private h: RichHost) { h.props.AgentChars = []; }

  get(name: string, args: VBValue[]): VBValue | undefined {
    if (name !== 'Characters') return undefined;
    if (args.length > 1) throw new VBRuntimeError(450);
    return args.length ? this.character(toStr(args[0])).obj : this.characters;
  }

  // -- Characters ------------------------------------------------------------------------------------------------

  character(id: string): Character {
    const c = this.chars.get(lc(id));
    if (!c) throw new VBRuntimeError(-2147213311, `The character "${id}" is not loaded`);
    return c;
  }

  /** Characters.Load CharacterID, [LoadKey]: the CharacterID (or the file name in LoadKey) names a built-in character. */
  load(args: VBValue[]): VBValue {
    if (args.length < 1) throw new VBRuntimeError(450);
    const id = toStr(args[0]);
    const file = arg(args, 1) !== undefined ? toStr(args[1]) : '';
    const fromFile = file.split(/[\\/]/).pop()!.replace(/\.ac[sf]$/i, '');
    const known = AGENT_CHARACTERS[lc(id)] ?? AGENT_CHARACTERS[lc(fromFile)];
    if (!known) throw new VBRuntimeError(-2147024894, `The character "${file || id}" cannot be found. The known characters are Robby and Wizard`);
    if (this.chars.has(lc(id))) throw new VBRuntimeError(-2147213310, `The character "${id}" is already loaded`);
    const c = new Character(id, known.sprite, known.name, known.description, this);
    c.x = 40 + 112 * this.chars.size;
    this.chars.set(lc(id), c);
    this.draw();
    const r = new RequestObject(this.nextReq++);
    r.status = REQUEST.complete;
    return r;
  }

  unload(id: string): void {
    const c = this.character(id);
    this.stopAll(c);
    this.timers.clear(c.balloonTimer);
    this.chars.delete(lc(id));
    this.draw();
  }

  /** The window gets every character's state. */
  draw(): void {
    if (this.disposed) return;
    const lines = [...this.chars.values()].map(c => JSON.stringify(c.state()));
    this.h.props.AgentChars = lines;
    this.h.send({ AgentChars: lines });
  }

  setBalloon(c: Character, on: boolean): void {
    if (c.balloon === on) return;
    c.balloon = on && c.text !== '';
    this.draw();
    void this.h.raise(on ? 'BalloonShow' : 'BalloonHide', [new VBRef(c.id)]);
  }

  // -- requests --------------------------------------------------------------------------------------------------

  characterMethod(c: Character, name: string, args: VBValue[]): VBValue {
    switch (name) {
      case 'show': { const fast = arg(args, 0) !== undefined && toBool(args[0]); return this.request(c, 'Show', r => this.show(c, fast, r)); }
      case 'hide': { const fast = arg(args, 0) !== undefined && toBool(args[0]); return this.request(c, 'Hide', r => this.hide(c, fast, r)); }
      case 'speak': case 'think': {
        const text = plainSpeech(arg(args, 0) !== undefined ? toStr(args[0]) : '');
        return this.request(c, name === 'speak' ? 'Speak' : 'Think', r => this.speak(c, text, name === 'think', r));
      }
      case 'play': {
        if (arg(args, 0) === undefined) throw new VBRuntimeError(450);
        const anim = animationName(toStr(args[0]));
        if (!anim) throw new VBRuntimeError(-2147213305, `The animation "${toStr(args[0])}" does not exist`);
        return this.request(c, 'Play', r => this.play(c, anim, r));
      }
      case 'moveto': {
        if (arg(args, 0) === undefined || arg(args, 1) === undefined) throw new VBRuntimeError(450);
        const x = num(args[0]), y = num(args[1]), speed = arg(args, 2) !== undefined ? Math.max(0, num(args[2])) : 1000;
        return this.request(c, 'Move', r => this.moveTo(c, x, y, speed, r));
      }
      case 'gestureat': {
        if (arg(args, 0) === undefined || arg(args, 1) === undefined) throw new VBRuntimeError(450);
        const dx = num(args[0]) - (c.x + AGENT_SIZE / 2), dy = num(args[1]) - (c.y + AGENT_SIZE / 2);
        const anim = Math.abs(dx) >= Math.abs(dy) ? (dx < 0 ? 'GestureLeft' : 'GestureRight') : (dy < 0 ? 'GestureUp' : 'GestureDown');
        return this.request(c, 'Play', r => this.play(c, anim, r));
      }
      case 'wait': {
        const other = arg(args, 0);
        if (!(other instanceof RequestObject)) throw new VBRuntimeError(other === undefined ? 450 : 13);
        return this.request(c, 'Wait', () => this.whenDone(other));
      }
      case 'stop': {
        const which = arg(args, 0);
        if (which === undefined) this.stopAll(c);
        else if (which instanceof RequestObject) this.stopRequest(which);
        else if (!(isObject(which) || which === Nothing)) throw new VBRuntimeError(13);
        return Empty;
      }
      case 'stopall': this.stopAll(c); return Empty;
      case 'interrupt': case 'activate': return true;
    }
    throw new VBRuntimeError(438);
  }

  private reqs = new Map<RequestObject, Req>();

  private request(c: Character, kind: string, run: (r: Run) => Promise<void>): RequestObject {
    const obj = new RequestObject(this.nextReq++);
    let finish!: () => void;
    const done = new Promise<void>(res => { finish = res; });
    const req: Req = { obj, kind, run, done, finish };
    this.reqs.set(obj, req);
    c.queue.push(req);
    if (!c.pumping) void this.pump(c);
    return obj;
  }

  private whenDone(o: RequestObject): Promise<void> { return this.reqs.get(o)?.done ?? Promise.resolve(); }

  /** Runs the character's requests one after the other. */
  private async pump(c: Character): Promise<void> {
    c.pumping = true;
    try { await this.pumpQueue(c); } finally { c.pumping = false; }
  }

  private async pumpQueue(c: Character): Promise<void> {
    while (c.queue.length && !this.disposed) {
      const req = c.queue[0];
      let stopped = false;
      const stops: (() => void)[] = [];
      const run: Run = {
        get stopped() { return stopped; },
        wait: ms => new Promise<void>(res => {
          if (stopped) { res(); return; }
          const t = this.timers.after(ms, res);
          stops.push(() => { this.timers.clear(t); res(); });
        }),
        onStop: fn => { stops.push(fn); },
      };
      c.current = { req, run, stop: () => { if (stopped) return; stopped = true; for (const f of stops.splice(0)) f(); } };
      req.obj.status = REQUEST.inProgress;
      await this.h.raise('RequestStart', [new VBRef(req.obj)]);
      if (!stopped) {
        try { await req.run(run); } catch { req.obj.status = REQUEST.failed; }
      }
      c.current = null;
      const at = c.queue.indexOf(req);
      if (at >= 0) c.queue.splice(at, 1);
      if (req.obj.status !== REQUEST.failed) req.obj.status = stopped ? REQUEST.interrupted : REQUEST.complete;
      if (stopped && req.obj.status === REQUEST.interrupted) req.obj.description = 'The request was interrupted';
      this.complete(req);
      if (this.disposed) return;
      await this.h.raise('RequestComplete', [new VBRef(req.obj)]);
    }
  }

  private complete(req: Req): void { this.reqs.delete(req.obj); req.finish(); }

  private stopRequest(o: RequestObject): void {
    for (const c of this.chars.values()) {
      if (c.current?.req.obj === o) { c.current.stop(); return; }
      const at = c.queue.findIndex(r => r.obj === o);
      if (at >= 0) { const [r] = c.queue.splice(at, 1); this.interrupted(r); return; }
    }
  }

  private stopAll(c: Character): void {
    const waiting = c.queue.filter(r => r !== c.current?.req);
    c.queue = c.current ? [c.current.req] : [];
    c.current?.stop();
    for (const r of waiting) this.interrupted(r);
  }

  /** A request stopped before it started: Status 3, RequestComplete. */
  private interrupted(r: Req): void {
    r.obj.status = REQUEST.interrupted;
    r.obj.description = 'The request was interrupted';
    this.complete(r);
    void this.h.raise('RequestComplete', [new VBRef(r.obj)]);
  }

  // -- what the requests do ----------------------------------------------------------------------------------------

  private animate(c: Character, anim: string): void { c.anim = anim; c.seq++; this.draw(); }

  private async play(c: Character, anim: string, r: Run): Promise<void> {
    this.animate(c, anim);
    await r.wait(AGENT_ANIMATIONS[anim] ?? 1000);
    this.animate(c, '');
  }

  private async show(c: Character, fast: boolean, r: Run): Promise<void> {
    const was = c.visible;
    c.visible = true;
    c.visibilityCause = CAUSE.programShowed;
    if (fast || was) this.draw(); else this.animate(c, 'Showing');
    if (!was) void this.h.raise('Show', [new VBRef(c.id), new VBRef(CAUSE.programShowed)]);
    if (!fast && !was) { await r.wait(AGENT_ANIMATIONS.Showing); this.animate(c, ''); }
  }

  private async hide(c: Character, fast: boolean, r: Run): Promise<void> {
    if (!c.visible) return;
    if (!fast) { this.animate(c, 'Hiding'); await r.wait(AGENT_ANIMATIONS.Hiding); }
    c.visible = false; c.anim = ''; c.seq++;
    c.balloon = false;
    c.visibilityCause = CAUSE.programHid;
    this.draw();
    void this.h.raise('Hide', [new VBRef(c.id), new VBRef(CAUSE.programHid)]);
  }

  private async moveTo(c: Character, x: number, y: number, speed: number, r: Run): Promise<void> {
    if (c.x === x && c.y === y) return;
    c.x = x; c.y = y; c.moveMs = c.visible ? speed : 0;
    this.draw();
    if (c.moveMs) await r.wait(speed);
    c.moveMs = 0;
    c.moveCause = CAUSE.programMoved;
    void this.h.raise('Move', [new VBRef(c.id), new VBRef(x), new VBRef(y), new VBRef(CAUSE.programMoved)]);
  }

  private async speak(c: Character, text: string, think: boolean, r: Run): Promise<void> {
    this.timers.clear(c.balloonTimer);
    const ms = speakMs(text);
    const shown = c.visible && text !== '';
    Object.assign(c, { text, think, balloon: shown, speaking: shown && !think, speakMs: ms });
    c.textSeq++;
    this.draw();
    if (shown) void this.h.raise('BalloonShow', [new VBRef(c.id)]);
    const voice = !think && text !== '' ? speech(text) : null;
    if (voice) {
      r.onStop(voice.cancel);
      await Promise.race([voice.done, r.wait(ms * 3 + 2000)]);
      if (!r.stopped) await r.wait(200);
    } else await r.wait(ms);
    if (this.disposed) return;   // cut short by dispose: no balloon timer after clearAll
    c.speaking = false;
    this.draw();
    // the balloon stays a moment after the last word, then goes (the next Speak keeps it)
    c.balloonTimer = this.timers.after(r.stopped ? 0 : 1500, () => {
      c.balloonTimer = null;
      if (c.speaking || !c.balloon) return;
      c.balloon = false;
      this.draw();
      void this.h.raise('BalloonHide', [new VBRef(c.id)]);
    });
  }

  // -- the user ----------------------------------------------------------------------------------------------------

  applyState(props: Record<string, PropValue>): void {
    const a = userAction(props);
    const c = a ? this.chars.get(lc(String(a.id))) : undefined;
    if (!a || !c) return;
    const mouse = [c.id, Number(a.button) || 1, Number(a.shift) || 0, Number(a.x) || 0, Number(a.y) || 0].map(v => new VBRef(v));
    switch (a.verb) {
      case 'click': void this.h.raise('Click', mouse); break;
      case 'dblclick': void this.h.raise('DblClick', mouse); break;
      case 'dragstart': void this.h.raise('DragStart', mouse); break;
      case 'dragend':
        c.x = Number(a.x) || 0; c.y = Number(a.y) || 0; c.moveMs = 0; c.moveCause = CAUSE.userMoved;
        this.h.props.AgentChars = [...this.chars.values()].map(ch => JSON.stringify(ch.state()));   // the window has it there already
        void this.h.raise('DragComplete', mouse).then(() => this.h.raise('Move', [new VBRef(c.id), new VBRef(c.x), new VBRef(c.y), new VBRef(CAUSE.userMoved)]));
        break;
    }
  }

  dispose(): void {
    this.disposed = true;
    for (const c of this.chars.values()) { c.current?.stop(); for (const r of c.queue) this.complete(r); c.queue = []; }
    this.timers.clearAll();   // a Speak in progress stopped its own voice (stop above); others' speech goes on
  }
}

/** Says `text` with the WebView's speech synthesis; null when there is none. `cancel` stops it while it is not over (the Web Speech
 *  API has only the global cancel(), so that also drops what another Agent has queued; once this one ended it touches nothing). */
function speech(text: string): { done: Promise<void>; cancel: () => void } | null {
  const synth = globalThis.speechSynthesis;
  const Utterance = globalThis.SpeechSynthesisUtterance;
  if (!synth || typeof Utterance !== 'function') return null;
  try {
    const u = new Utterance(text);
    u.rate = 1.05; u.pitch = 1.1;
    let over = false;
    const done = new Promise<void>(res => { u.onend = u.onerror = () => { over = true; res(); }; });
    synth.speak(u);
    return { done, cancel: () => { if (over) return; over = true; try { synth.cancel(); } catch { /* gone */ } } };
  } catch {
    return null;
  }
}
