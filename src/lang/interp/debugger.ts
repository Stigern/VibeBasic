// Break-mode debugging for the IDE (VB6 Locals, Watch and Call Stack windows, data tips, Set Next Statement), on top
// of the frame stopped in break mode (`Runtime.breakFrame`) and the runs' call stacks.
//
// Evaluation never touches the stopped frame itself: expressions run in a copy of it (same Variables, so the values
// are the real ones) inside an Immediate run, so an error never reaches the program's handlers and no break happens.

import type { Expr, ProcDecl, Stmt } from '../ast';
import { VBRuntimeError, VBSyntaxError } from '../errors';
import type { VBObject } from '../host';
import { parseExpression } from '../parser';
import {
  EmptyT, NothingT, NullT, VBArray, VBErrorValue, VBRecord, isObject, maybeSingle, single7, toBool, toStr, vbTypeName,
  type VBValue,
} from '../values';
import { EndSignal, runGenerator, type Gen } from './driver';
import { evalExpr, lookup } from './eval';
import type { Runtime } from './program';
import { Frame, MemberRef, ModuleRef, ObjectRef, Run, ValueRef, Variable, lc } from './scope';

/** One active procedure call. */
export interface StackEntry { moduleName: string; procName: string; line: number }

/** Watch Type of the Add Watch dialog. */
export type WatchKind = 'watch' | 'breakTrue' | 'breakChange';
/** A watch: its expression and Context (module and procedure; null is "(All Modules)" / "(All Procedures)"). */
export interface WatchSpec { expression: string; module: string | null; procedure: string | null; kind: WatchKind }

/** A row of the Locals or Watch window; `children` (objects, arrays, records) is asked when the row is expanded. */
export interface DebugNode {
  name: string;
  /** The expression of the row (`a(1)`, `Me.Caption`): an edited value is assigned to it. */
  expr: string;
  value: string;
  type: string;
  /** A plain value (not an object, array or record) of an assignable expression. */
  editable: boolean;
  children?: () => DebugNode[];
}

/** The properties to show for a host object when its row is expanded (the IDE knows them from the control registry). */
export type MemberLister = (obj: VBObject) => readonly string[];

export type EvalResult = { ok: true; value: VBValue } | { ok: false; error: string };

export const OUT_OF_CONTEXT = '<Out of context>';
/** Most elements shown of an array or a collection. */
const MAX_ELEMENTS = 1000;

/** A copy of `bf` in a new Immediate run: the same Variables and With objects, not its error-handler state. */
function copyFrame(rt: Runtime, bf: Frame): Frame {
  const run = new Run(rt);
  run.immediate = true;
  const f = new Frame(run, bf.module, bf.proc, bf.line);
  for (const [k, v] of bf.locals) f.locals.set(k, v);
  f.returnVar = bf.returnVar;
  f.withStack.push(...bf.withStack);
  run.frames.push(f);
  return f;
}

function errorText(e: unknown): string {
  if (e instanceof VBRuntimeError) return `<${e.description}>`;
  if (e instanceof VBSyntaxError) return `<${e.message}>`;
  return `<${e instanceof Error ? e.message : String(e)}>`;
}

/** The value as the Locals and Watch windows show it (strings in quotes; objects, arrays and records have no value text). */
export function valueText(v: VBValue, declared?: string): string {
  if (typeof v === 'string') return `"${v}"`;
  if (v instanceof EmptyT || v instanceof NullT || v instanceof NothingT || v instanceof VBErrorValue) return v.toString();
  if (v instanceof VBArray || v instanceof VBRecord || isObject(v)) return '';
  if (declared === 'Single' && maybeSingle(v)) return toStr(single7(v));
  try { return toStr(v); } catch { return vbTypeName(v); }
}

function arrayType(v: VBArray): string {
  const e = vbTypeName(v).slice(0, -2);
  return v.allocated ? `${e}(${v.bounds.map(([lo, hi]) => `${lo} to ${hi}`).join(', ')})` : `${e}()`;
}

/** The Type column: the declared type, `Variant/<subtype>` for a Variant. */
function typeText(v: VBValue, declared: string | undefined): string {
  const actual = v instanceof VBArray ? arrayType(v) : vbTypeName(v);
  if (declared === undefined || declared === actual) return actual;
  if (declared === 'Variant') return `Variant/${actual}`;
  return v instanceof VBArray ? actual : isObject(v) ? `${declared}/${actual}` : declared;
}

const declaredName = (t: Variable['type']): string => (typeof t === 'string' ? t : 'userType' in t ? t.userType : t.objectType);

/** Every index tuple of an array in VB order (the last index varies fastest, as in storage), at most MAX_ELEMENTS. */
function indexTuples(a: VBArray): number[][] {
  const out: number[][] = [];
  const cur = a.bounds.map(([lo]) => lo);
  if (a.bounds.some(([lo, hi]) => hi < lo)) return out;
  for (;;) {
    out.push([...cur]);
    if (out.length >= MAX_ELEMENTS) return out;
    let d = cur.length - 1;
    while (d >= 0 && ++cur[d] > a.bounds[d][1]) { cur[d] = a.bounds[d][0]; d--; }
    if (d < 0) return out;
  }
}

function nodeOf(rt: Runtime, name: string, expr: string, read: () => VBValue, declared: string | undefined, members: MemberLister, assignable = true): DebugNode {
  let v: VBValue;
  try { v = read(); } catch (e) { return { name, expr, value: errorText(e), type: '', editable: false }; }
  const node: DebugNode = { name, expr, value: valueText(v, declared), type: typeText(v, declared), editable: false };
  if (v instanceof VBArray) {
    const a = v;
    if (a.allocated) node.children = () => indexTuples(a).map(ix => {
      const e = `${expr}(${ix.join(', ')})`;
      return nodeOf(rt, e, e, () => a.get(ix), typeof a.elemType === 'string' ? a.elemType : undefined, members, assignable);
    });
  } else if (v instanceof VBRecord) {
    const r = v;
    node.children = () => {
      let info: ReturnType<Runtime['typeInfo']> | undefined;
      try { info = rt.typeInfo(r.typeName); } catch { info = undefined; }
      return [...r.fields.keys()].map(k => {
        const fi = info?.fields.get(k);
        const field = fi?.name ?? k;
        return nodeOf(rt, field, `${expr}.${field}`, () => r.fields.get(k)!, fi ? declaredName(fi.type) : undefined, members, assignable);
      });
    };
  } else if (isObject(v)) {
    const o = v;
    const items = o.items ? safe(() => o.items!()) : undefined;
    const props = safe(() => members(o)) ?? [];
    if (items || props.length) node.children = () => [
      ...(items ?? []).slice(0, MAX_ELEMENTS).map((it, i) => nodeOf(rt, `Item ${i + 1}`, `${expr}(${i + 1})`, () => it, undefined, members, false)),
      ...props.map(p => nodeOf(rt, p, `${expr}.${p}`, () => o.getMember(p, []), undefined, members, assignable)),
    ];
  } else node.editable = assignable;
  return node;
}

function safe<T>(fn: () => T): T | undefined {
  try { return fn(); } catch { return undefined; }
}

// ---------------------------------------------------------------------------
// Set Next Statement: where a statement can be jumped to
// ---------------------------------------------------------------------------

/** The statement lists directly inside a statement (block bodies). */
function innerLists(s: Stmt): Stmt[][] {
  const out: Stmt[][] = [];
  const o = s as unknown as Record<string, unknown>;
  if (Array.isArray(o.body)) out.push(o.body as Stmt[]);
  if (Array.isArray(o.branches)) for (const b of o.branches as { body: Stmt[] }[]) out.push(b.body);
  if (Array.isArray(o.cases)) for (const c of o.cases as { body: Stmt[] }[]) out.push(c.body);
  if (Array.isArray(o.elseBody)) out.push(o.elseBody as Stmt[]);
  return out;
}

/** The last source line a statement covers (its nested statements, ElseIf / Case lines, a For's Next line). */
function lastLine(s: Stmt): number {
  const o = s as unknown as Record<string, unknown>;
  let n = Math.max(s.line, typeof o.nextLine === 'number' ? o.nextLine : 0);
  for (const key of ['branches', 'cases'] as const) {
    if (Array.isArray(o[key])) for (const b of o[key] as { line?: number }[]) n = Math.max(n, b.line ?? 0);
  }
  for (const l of innerLists(s)) for (const x of l) n = Math.max(n, lastLine(x));
  return n;
}

/**
 * The statement of `proc` that Set Next Statement to `line` runs next: the first statement on or after the line, which
 * must be in a block that the current line `at` is inside (the procedure body or a block around it), since the
 * interpreter cannot enter a block in the middle. A string is the reason it cannot.
 */
export function jumpTarget(proc: ProcDecl, at: number, line: number): Stmt | string {
  if (line <= proc.line || line >= proc.endLine) return 'Can\'t set the next statement outside the current procedure';
  let best: { s: Stmt; open: boolean } | undefined;
  const walk = (list: Stmt[], open: boolean): void => {
    for (const s of list) {
      if (s.line >= line && (!best || s.line < best.s.line)) best = { s, open };
      const inside = at >= s.line && at <= lastLine(s);
      for (const l of innerLists(s)) {
        // a block body is "open" when execution is inside it now
        walk(l, open && inside && l.some(x => at >= x.line && at <= lastLine(x)));
      }
    }
  };
  walk(proc.body, true);
  if (!best) return 'Can\'t set the next statement to this line';
  return best.open ? best.s : 'Can\'t set the next statement into a block that is not running';
}

// ---------------------------------------------------------------------------
// The debugger
// ---------------------------------------------------------------------------

interface BreakWatch { spec: WatchSpec; expr: Expr | null; module: string | null; proc: string | null; last?: string; lastFrame?: Frame; seen: boolean }

const EVAL_FAILED = '\u0000error';

export class ProgramDebugger {
  private breakWatches: BreakWatch[] = [];
  private checking = false;

  constructor(private readonly rt: Runtime) {}

  private get frame(): Frame | undefined {
    return this.rt.state === 'break' ? this.rt.breakFrame : undefined;
  }

  /** The procedure call stopped in break mode (the current context), or null. */
  context(): StackEntry | null {
    const f = this.frame;
    return f ? f.location() : null;
  }

  /** The active procedure calls, newest first (nested event handlers before the code they interrupted). */
  callStack(): StackEntry[] {
    const runs = [...this.rt.runs].filter(r => !r.immediate).sort((a, b) => b.seq - a.seq);
    const out: StackEntry[] = [];
    for (const r of runs) {
      for (let i = r.frames.length - 1; i >= 0; i--) if (r.frames[i].proc) out.push(r.frames[i].location());
    }
    return out;
  }

  /** The Locals window: the module row (`Me` in a form) first, then the parameters and locals of the stopped procedure. */
  locals(members: MemberLister = () => []): DebugNode[] {
    const f = this.frame;
    if (!f) return [];
    const rt = this.rt;
    const moduleVars = (): DebugNode[] => [...f.module.vars.values()].filter(v => !v.opts.isConst)
      .map(v => nodeOf(rt, v.name, v.name, () => v.value, declaredName(v.type), members));
    const out: DebugNode[] = [];
    const me = f.module.kind === 'form' ? safe(() => rt.host.resolveName(f.module.name, 'Me')) : undefined;
    if (me) {
      const n = nodeOf(rt, 'Me', 'Me', () => me, undefined, members);
      const props = n.children;
      n.children = () => [...moduleVars(), ...(props?.() ?? [])];
      out.push(n);
    } else if (f.module.vars.size) {
      out.push({ name: f.module.name, expr: f.module.name, value: '', type: f.module.name, editable: false, children: moduleVars });
    }
    for (const v of f.locals.values()) {
      if (v.opts.isConst) continue;
      out.push(nodeOf(rt, v.name, v.name, () => v.value, declaredName(v.type), members));
    }
    return out;
  }

  /** Evaluates an expression in the stopped frame (function calls run; errors come back as `<description>`). */
  async evaluate(text: string): Promise<EvalResult> {
    const bf = this.frame;
    if (!bf) return { ok: false, error: OUT_OF_CONTEXT };
    let e: Expr;
    try { e = parseExpression(text); } catch (err) { return { ok: false, error: errorText(err) }; }
    const rt = this.rt;
    const f = copyFrame(rt, bf);
    rt.immediateRuns++;
    try {
      return { ok: true, value: await runGenerator(evalExpr(f, e), rt.scope) };
    } catch (err) {
      return { ok: false, error: err instanceof EndSignal ? OUT_OF_CONTEXT : errorText(err) };
    } finally {
      rt.immediateRuns--;
    }
  }

  /** Whether the stopped frame is in a watch's Context. */
  inContext(spec: Pick<WatchSpec, 'module' | 'procedure'>): boolean {
    const f = this.frame;
    return !!f && matches(f, spec.module && lc(spec.module), spec.procedure && lc(spec.procedure));
  }

  /** A Watch window row: the expression's value in the stopped frame, or `<Out of context>`. */
  async watchNode(spec: WatchSpec, members: MemberLister = () => []): Promise<DebugNode> {
    const base = { name: spec.expression, expr: spec.expression, editable: false };
    if (!this.inContext(spec)) return { ...base, value: OUT_OF_CONTEXT, type: 'Empty' };
    const r = await this.evaluate(spec.expression);
    if (!r.ok) return { ...base, value: r.error, type: '' };
    return nodeOf(this.rt, spec.expression, spec.expression, () => r.value, this.declared(spec.expression), members);
  }

  /** The declared type of a plain variable name in the stopped frame (`Long` for a Long holding 0), else undefined. */
  private declared(text: string): string | undefined {
    const f = this.frame;
    const name = text.trim();
    if (!f || !/^[A-Za-z_]\w*[$%&!#@]?$/.test(name)) return undefined;
    const b = lookup(f, lc(name.replace(/[$%&!#@]$/, '')), name);
    return b instanceof Variable ? declaredName(b.type) : undefined;
  }

  /**
   * A data tip (hovering `x` or `obj.Prop` in break mode): `x = 5`, or null when there is nothing to show. Free of side
   * effects: only variables, constants, record fields and object properties are read, never a procedure or function.
   */
  dataTip(text: string): string | null {
    const f = this.frame;
    if (!f) return null;
    let e: Expr;
    try { e = parseExpression(text); } catch { return null; }
    let v: VBValue | ModuleRef | undefined;
    try { v = this.peek(f, e); } catch { return null; }
    if (v === undefined || v instanceof ModuleRef || v instanceof VBArray || v instanceof VBRecord) return null;
    if (isObject(v)) {
      const o = v;
      if (o.defaultMember === undefined) return null;
      try { v = o.getMember(o.defaultMember, []); } catch { return null; }
      if (isObject(v)) return null;
    }
    return `${text} = ${valueText(v as VBValue, this.declared(text))}`;
  }

  /** The side-effect free value of a name or `a.b.c` chain (undefined: not one, or it would run code). */
  private peek(f: Frame, e: Expr): VBValue | ModuleRef | undefined {
    if (e.kind === 'name') {
      const key = lc(e.name);
      if (key === 'me') return f.rt.host.resolveName(f.module.name, 'Me');
      const b = lookup(f, key, e.name);
      if (b instanceof Variable) return b.value;
      if (b instanceof ValueRef) return b.value;
      if (b instanceof ObjectRef) return b.obj;
      if (b instanceof ModuleRef) return b;
      if (b instanceof MemberRef) return b.obj.getMember(b.name, []);
      return undefined;
    }
    if (e.kind === 'member') {
      const base = this.peek(f, e.object);
      const key = lc(e.name);
      if (base instanceof ModuleRef) return base.module.vars.get(key)?.value;
      if (base instanceof VBRecord) return base.fields.get(key);
      if (base !== undefined && isObject(base)) return base.hasMember(e.name) ? base.getMember(e.name, []) : undefined;
    }
    return undefined;
  }

  /**
   * The watches of the project. Break When Value Is True / Changes ones are checked at every statement boundary
   * while there are any (no cost otherwise); in break mode their values in the stopped frame are the starting point.
   */
  async setWatches(specs: readonly WatchSpec[]): Promise<void> {
    const old = new Map(this.breakWatches.map(w => [watchKey(w.spec), w]));
    const list: BreakWatch[] = [];
    for (const spec of specs) {
      if (spec.kind === 'watch') continue;
      const prev = old.get(watchKey(spec));
      if (prev) { list.push(prev); continue; }
      let expr: Expr | null;
      try { expr = parseExpression(spec.expression); } catch { expr = null; }
      const w: BreakWatch = { spec, expr, module: spec.module && lc(spec.module), proc: spec.procedure && lc(spec.procedure), seen: false };
      const bf = this.frame;
      if (bf && expr && matches(bf, w.module, w.proc)) {
        const r = await this.evaluate(spec.expression);
        w.last = r.ok ? stateOf(w, r.value) : EVAL_FAILED;
        w.lastFrame = bf;
        w.seen = true;
      }
      list.push(w);
    }
    this.breakWatches = list;
    this.rt.watchHook = list.some(w => w.expr) ? f => this.check(f) : null;
  }

  /** At a statement boundary of `f`: true when a break watch fires (its value changed, or became True). */
  private *check(f: Frame): Gen<boolean> {
    if (this.checking) return false;
    this.checking = true;
    let fire = false;
    try {
      for (const w of this.breakWatches) {
        if (!w.expr || !matches(f, w.module, w.proc)) continue;
        let now: string;
        try {
          now = stateOf(w, yield* evalExpr(copyFrame(this.rt, f), w.expr));
        } catch (e) {
          if (e instanceof EndSignal) throw e;
          now = EVAL_FAILED;
        }
        // a new call of the watch's procedure starts again (its locals are new)
        const fresh = !w.seen || (w.proc !== null && w.lastFrame !== f);
        if (!fresh && now !== w.last && (w.spec.kind === 'breakChange' || now === 'true')) fire = true;
        w.last = now;
        w.lastFrame = f;
        w.seen = true;
      }
    } finally {
      this.checking = false;
    }
    return fire;
  }

  /**
   * Set Next Statement (Ctrl+F9): the statement on `line` (or the first one after it) of the stopped procedure runs
   * next. Returns null when set (answer the break with 'continue': the program breaks again on that statement before
   * running it), else the reason it cannot.
   */
  setNextStatement(line: number): string | null {
    const f = this.frame;
    if (!f || !f.proc) return 'Can\'t set the next statement here';
    const t = jumpTarget(f.proc, f.line, line);
    if (typeof t === 'string') return t;
    this.rt.nextJump = { frame: f, stmt: t };
    this.rt.pauseRequested = true;
    return null;
  }
}

function matches(f: Frame, module: string | null, proc: string | null): boolean {
  if (module !== null && lc(f.module.sourceName) !== module) return false;
  return proc === null || (f.proc !== null && lc(f.proc.name) === proc);
}

const watchKey = (s: WatchSpec): string => `${s.kind}|${s.module ?? ''}|${s.procedure ?? ''}|${s.expression}`;

/** What a break watch compares: True / not True, or the value (objects by identity). */
function stateOf(w: BreakWatch, v: VBValue): string {
  if (w.spec.kind === 'breakTrue') { try { return toBool(v) ? 'true' : 'false'; } catch { return 'false'; } }
  return fingerprint(v);
}

const ids = new WeakMap<object, number>();
let nextId = 0;
function fingerprint(v: VBValue): string {
  if (v instanceof VBArray) return `${arrayType(v)}[${v.values().map(fingerprint).join(',')}]`;
  if (v instanceof VBRecord) return `{${[...v.fields.values()].map(fingerprint).join(',')}}`;
  if (isObject(v)) {
    let id = ids.get(v);
    if (id === undefined) ids.set(v, id = ++nextId);
    return `#${id}`;
  }
  return `${vbTypeName(v)}:${valueText(v)}`;
}
