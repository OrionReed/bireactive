// cell.ts — symmetric bidirectional reactive engine.
//
// Forward propagation is alien-signals verbatim (link/propagate/
// checkDirty/shallowPropagate, Dirty/Pending/Recursed flags, lazy pull).
// Backward is not a second engine: a write "compiles" a view-edit into
// source-edits by walking up `_bwdParent`, applying each lens's `put` to
// compute what the source(s) must become, committing via the SAME
// forward write path. So views are never sticky (a view is always
// `get(source)`; lossy lenses snap), no-op deltas short-circuit for free
// via equality, and backward cost ≤ forward cost.
//
// Duals:
//   * multi-parent lens — a write that SPLITS across N parents
//     (`_put(target)` → per-parent update array, `propagateSplit`); the
//     dual of a getter reading N parents. Covers coupled writables
//     (N→M, e.g. mean/diff). Info the source can't hold lives in a
//     stateful-lens complement, not a bespoke engine kind.
//
// Backward conflicts (N writes reaching one source) are last-write-wins.
// Principled N→1 aggregation is the relate layer's job: a knowledge cell
// folds contributions via its lattice `meet` (confluent), not a bespoke
// lens-level fold.
//
// Core asymmetry: forward deps are IMPLICIT (auto-tracked reads of
// `.value` under `activeSub`); backward targets are EXPLICIT (declared
// at construction in `_bwdParent`). Hence no `activeBwdWrite` global.
//
// Mode table — a cell's role is fully determined by which fields are set:
//   source      getter undefined                 (truth in currentValue)
//   derived    getter, no _bwd                   (read-only derived)
//   lens 1→1    getter + _bwd{ put, parent: Cell }
//   multi-out   getter + _bwd{ put, parent: Cell[] }   (1→N / N→M bwd)
//   stateful    getter + _bwd{ put, parent, stateful } (complement-carrying)
// A cell is writable iff `_bwd !== undefined` (the backward sidecar; see
// `BwdSpec`). `pendingValue` is dual-keyed: a staged forward write for a
// source, a staged backward target for a getter cell (never both).
//
// Scheduling: the VALUE GRAPH is synchronous. A write stages its backward
// contribution and drains `bwdQueue` to a fixpoint before returning, so
// `.value` read-back and lens commits are synchronous everywhere. Only the
// terminal EFFECTS defer — they coalesce onto a `queueMicrotask` (so a burst
// of synchronous writes runs them once, glitch-free). `settle()` drains
// pending effects synchronously for tests/benches. There is no `batch()`:
// microtask coalescing subsumes it.

// Flag bits (alien-signals v2).
const F = {
  None: 0,
  Mutable: 1,
  Watching: 2,
  RecursedCheck: 4,
  Recursed: 8,
  Dirty: 16,
  Pending: 32,
  /** Backward-only: cell has a pending backward contribution queued. */
  BwdQueued: 64,
} as const;

let cycle = 0;
let runDepth = 0;
let notifyIndex = 0;
let queuedLength = 0;
let activeSub: ReactiveNode | undefined;
let flushing = false;
const queued: (Effect | undefined)[] = [];

/** Backward worklist: lens cells with staged writes, drained to a
 *  fixpoint by flush. */
const bwdQueue: Cell<unknown>[] = [];

interface ReactiveNode {
  flags: number;
  deps: Link | undefined;
  depsTail: Link | undefined;
  subs: Link | undefined;
  subsTail: Link | undefined;
  _update(): boolean;
  _notify(): void;
  _unwatched(): void;
}

interface Link {
  version: number;
  dep: ReactiveNode;
  sub: ReactiveNode;
  prevSub: Link | undefined;
  nextSub: Link | undefined;
  prevDep: Link | undefined;
  nextDep: Link | undefined;
}

interface Stack<T> {
  value: T;
  prev: Stack<T> | undefined;
}

// Fires on every SOURCE value-change (the one place truth mutates).
// Backward writes reach it via `_writeSource`, attributing lens edits to
// the source they resolve to.

let writeHook: ((cell: Cell<unknown>) => void) | undefined;

/** Install a hook fired on every source value-change; returns a restore fn. */
export function setCellWriteHook(fn: ((cell: Cell<unknown>) => void) | undefined): () => void {
  const prev = writeHook;
  writeHook = fn;
  return () => {
    writeHook = prev;
  };
}

// alien-signals algorithm (verbatim): link / unlink / propagate / checkDirty.
function link(dep: ReactiveNode, sub: ReactiveNode, version: number): void {
  const prevDep = sub.depsTail;
  if (prevDep !== undefined && prevDep.dep === dep) return;
  const nextDep = prevDep !== undefined ? prevDep.nextDep : sub.deps;
  if (nextDep !== undefined && nextDep.dep === dep) {
    nextDep.version = version;
    sub.depsTail = nextDep;
    return;
  }
  const prevSub = dep.subsTail;
  if (prevSub !== undefined && prevSub.version === version && prevSub.sub === sub) return;
  const isFirstSub = dep.subs === undefined;
  const newLink: Link =
    (sub.depsTail =
    dep.subsTail =
      {
        version,
        dep,
        sub,
        prevDep,
        nextDep,
        prevSub,
        nextSub: undefined,
      });
  if (nextDep !== undefined) nextDep.prevDep = newLink;
  if (prevDep !== undefined) prevDep.nextDep = newLink;
  else sub.deps = newLink;
  if (prevSub !== undefined) prevSub.nextSub = newLink;
  else dep.subs = newLink;
  // First-subscriber lifecycle hook (dual: last-sub in `_unwatched`).
  if (isFirstSub && dep instanceof Cell) {
    const hook = dep._watched;
    if (hook !== undefined) hook.call(dep);
  }
}

function unlink(l: Link, sub: ReactiveNode = l.sub): Link | undefined {
  const { dep, prevDep, nextDep, nextSub, prevSub } = l;
  if (nextDep !== undefined) nextDep.prevDep = prevDep;
  else sub.depsTail = prevDep;
  if (prevDep !== undefined) prevDep.nextDep = nextDep;
  else sub.deps = nextDep;
  if (nextSub !== undefined) nextSub.prevSub = prevSub;
  else dep.subsTail = prevSub;
  if (prevSub !== undefined) prevSub.nextSub = nextSub;
  else if ((dep.subs = nextSub) === undefined) dep._unwatched();
  return nextDep;
}

function propagate(start: Link, innerWrite: boolean): void {
  let l: Link | undefined = start;
  let next: Link | undefined = start.nextSub;
  let stack: Stack<Link | undefined> | undefined;
  top: do {
    const sub: ReactiveNode = l!.sub;
    {
      let flags = sub.flags;
      if (!(flags & (F.RecursedCheck | F.Recursed | F.Dirty | F.Pending))) {
        sub.flags = flags | F.Pending;
        if (innerWrite) sub.flags |= F.Recursed;
      } else if (!(flags & (F.RecursedCheck | F.Recursed))) {
        flags = F.None;
      } else if (!(flags & F.RecursedCheck)) {
        sub.flags = (flags & ~F.Recursed) | F.Pending;
      } else if (!(flags & (F.Dirty | F.Pending)) && isValidLink(l!, sub)) {
        sub.flags = flags | (F.Recursed | F.Pending);
        flags &= F.Mutable;
      } else {
        flags = F.None;
      }
      if (flags & F.Watching) sub._notify();
      if (flags & F.Mutable) {
        const subSubs: Link | undefined = sub.subs;
        if (subSubs !== undefined) {
          const nextSub = (l = subSubs).nextSub;
          if (nextSub !== undefined) {
            stack = { value: next, prev: stack };
            next = nextSub;
          }
          continue;
        }
      }
    }
    if ((l = next!) !== undefined) {
      next = l.nextSub;
      continue;
    }
    while (stack !== undefined) {
      l = stack.value;
      stack = stack.prev;
      if (l !== undefined) {
        next = l.nextSub;
        continue top;
      }
    }
    break;
  } while (true);
}

function checkDirty(startLink: Link, startSub: ReactiveNode): boolean {
  let l = startLink,
    sub = startSub;
  let stack: Stack<Link> | undefined;
  let checkDepth = 0,
    dirty = false;
  top: do {
    const dep = l.dep;
    const flags = dep.flags;
    if (sub.flags & F.Dirty) dirty = true;
    else if ((flags & (F.Mutable | F.Dirty)) === (F.Mutable | F.Dirty)) {
      const subs = dep.subs!;
      if (dep._update()) {
        if (subs.nextSub !== undefined) shallowPropagate(subs);
        dirty = true;
      }
    } else if ((flags & (F.Mutable | F.Pending)) === (F.Mutable | F.Pending)) {
      stack = { value: l, prev: stack };
      l = dep.deps!;
      sub = dep;
      ++checkDepth;
      continue;
    }
    if (!dirty) {
      const nextDep = l.nextDep;
      if (nextDep !== undefined) {
        l = nextDep;
        continue;
      }
    }
    while (checkDepth--) {
      l = stack!.value;
      stack = stack!.prev;
      if (dirty) {
        const subs = sub.subs!;
        if (sub._update()) {
          if (subs.nextSub !== undefined) shallowPropagate(subs);
          sub = l.sub;
          continue;
        }
        dirty = false;
      } else {
        sub.flags &= ~F.Pending;
      }
      sub = l.sub;
      const nextDep = l.nextDep;
      if (nextDep !== undefined) {
        l = nextDep;
        continue top;
      }
    }
    return dirty && !!sub.flags;
  } while (true);
}

function shallowPropagate(l: Link): void {
  do {
    const sub = l.sub;
    const flags = sub.flags;
    if ((flags & (F.Pending | F.Dirty)) === F.Pending) {
      sub.flags = flags | F.Dirty;
      if ((flags & (F.Watching | F.RecursedCheck)) === F.Watching) sub._notify();
    }
  } while ((l = l.nextSub!) !== undefined);
}

function isValidLink(checkLink: Link, sub: ReactiveNode): boolean {
  let l = sub.depsTail;
  while (l !== undefined) {
    if (l === checkLink) return true;
    l = l.prevDep;
  }
  return false;
}

function purgeDeps(sub: ReactiveNode): void {
  const depsTail = sub.depsTail;
  let dep = depsTail !== undefined ? depsTail.nextDep : sub.deps;
  while (dep !== undefined) dep = unlink(dep, sub);
}

function disposeAllDepsInReverse(sub: ReactiveNode): void {
  let l = sub.depsTail;
  while (l !== undefined) {
    const prev = l.prevDep;
    unlink(l, sub);
    l = prev;
  }
}

// BwdSpec — the backward sidecar.
//
// Every cell carries the forward fields (links, getter, value cache).
// Only a WRITABLE derived cell — 1→1 lens, multi-output lens, stateful
// lens, or `pin` — needs a backward target and the closures to drive it.
// Those fields live here, off a single `_bwd` pointer, rather than inline
// on `Cell`, so a source/computed stays lean: the forward hot path never
// touches them, and a plain node drops ~64 B. A cell is writable iff
// `_bwd !== undefined`.
//
// The `stateful` payload (the complement machinery of a complement-
// carrying lens) hangs off a named field rather than a union so it stays
// distinctly typed. It's rare, so a plain 1→1 / multi-out lens leaves it
// `undefined` and pays only `parent` + `put` + `queueIdx`.
class BwdSpec {
  /** Backward target(s): one `Cell` (1→1) or `Cell[]` (multi-out). */
  parent: Cell<unknown> | Cell<unknown>[] | undefined = undefined;
  /** Lens `put` — backward derivation (dual of `getter`). A source-reading
   *  1→1 lens is called as `put(target, parentRead)`; others as
   *  `put(target)`. Multi-output: returns a per-parent update array.
   *  Stateful: the spec's `bwd`. */
  // biome-ignore lint/suspicious/noExplicitAny: put fn is opaque shape
  put: ((target: any, current?: any) => any) | undefined = undefined;
  /** Complement machinery; presence IS the stateful-mode discriminant. */
  stateful: StatefulCore | undefined = undefined;
  /** Index in `bwdQueue` of this cell's latest push; the drain skips stale
   *  entries so each cell propagates backward once per flush, last-write. */
  queueIdx = -1;

  // ── inverse memo ──────────────────────────────────────────────────
  // Source-reading 1→1 lenses (`fieldOf`, spread-replace, clamp-aware)
  // recompute `put(target, parent)` on every back-write. `put` is pure in
  // its inputs, so a 1-slot memo keyed on `(target, parentRead)` skips the
  // call when neither moved — the backward analog of forward's "Pending but
  // not Dirty ⇒ don't recompute". `readsSource` marks the 2-arg form
  // (1-arg/source-independent puts key on `target` alone). Only the
  // single-parent `buildLens1` path participates; split/stateful keep their
  // own resolution.
  /** True iff `put` is the 2-arg (parent-reading) form. */
  readsSource = false;
  /** Memo populated. */
  memoOk = false;
  /** Last `(target, parentRead)` → `result`. */
  lastTarget: unknown = undefined;
  lastRead: unknown = undefined;
  lastResult: unknown = undefined;
}

/** Runtime state of a stateful (complement-carrying) lens — the rare
 *  backward mode, kept off `BwdSpec` so plain lenses don't carry its slots.
 *  `put` (the spec's `bwd`) and `parent` stay on `BwdSpec`; this holds the
 *  complement and the closures that project from / advance it. */
class StatefulCore {
  /** Engine-owned memory the view discards. */
  complement: unknown;
  /** Forward projection `fwd(sources, complement) → view`. */
  // biome-ignore lint/suspicious/noExplicitAny: opaque fwd shape
  fwd: (sources: any, complement: any) => any;
  /** Advance the complement: `step(sources, complement, external)`. */
  // biome-ignore lint/suspicious/noExplicitAny: opaque step shape
  step: (sources: any, complement: any, external: boolean) => any;
  /** Source values last written back (own-vs-external test); `undefined`
   *  until the first back-write. */
  lastBwd: unknown[] | undefined = undefined;
  constructor(
    complement: unknown,
    // biome-ignore lint/suspicious/noExplicitAny: opaque fwd shape
    fwd: (sources: any, complement: any) => any,
    // biome-ignore lint/suspicious/noExplicitAny: opaque step shape
    step: (sources: any, complement: any, external: boolean) => any,
  ) {
    this.complement = complement;
    this.fwd = fwd;
    this.step = step;
  }
}

/** Plain T or any read-shape; snapshot via `readNow`, close via `reader`. */
export type Val<T> = T | Read<T>;

/** Covariant read-only surface. */
export interface Read<out T> {
  readonly value: T;
  peek(): T;
}

/** Brand discriminating writable receivers in conditional return types. */
declare const WRITABLE: unique symbol;
export interface WritableBrand {
  readonly [WRITABLE]: never;
}

/** Value type carried by a reactive read shape. */
export type Inner<R> = R extends Cell<infer T> ? T : R extends Read<infer T> ? T : never;

/** The writable form of R: adds the brand + a settable `value`. */
export type Writable<R> = R & WritableBrand & { value: Inner<R> };

/** Strict factory input: a literal, or an existing `Writable<Cls>`. */
// biome-ignore lint/suspicious/noExplicitAny: variance escape, mirrors `Inner`
export type Init<C extends Cell<any>> = Inner<C> | Writable<C>;

/** Snapshot a `Val<T>` to plain `T` (one-shot, no tracking). */
export function readNow<T>(v: Val<T>): T {
  if (v instanceof Cell) return v.value as T;
  return v as T;
}

/** Resolve a `Val<T>` to a `() => T` closure that unwraps on each call. */
export function reader<T>(v: Val<T>): () => T {
  if (v instanceof Cell) return () => v.value as T;
  return () => v as T;
}

/** Lazy getter: computes once, installs a non-enumerable own prop under
 *  `key` that shadows this getter on later reads. */
export function lazy<R>(self: object, key: string | symbol, make: () => R): R {
  const v = make();
  Object.defineProperty(self, key, {
    value: v,
    writable: false,
    configurable: false,
    enumerable: false,
  });
  return v;
}

export const isCell = (v: unknown): v is Cell<unknown> => v instanceof Cell;

/** Lens mode: a derived cell that can be written back (has a backward sidecar). */
export const isLens = (v: unknown): v is Cell<unknown> =>
  v instanceof Cell && v.getter !== undefined && v._bwd !== undefined;

/** Read-only mode: derived with no backward path. */
export const isReadonly = (v: unknown): v is Cell<unknown> =>
  v instanceof Cell && v.getter !== undefined && v._bwd === undefined;

/** A meet-semilattice with a contradiction test — the merge law for a
 *  family of knowledge values (interval, rectangle, candidate set). NOT a
 *  per-cell field: a value CLASS declares one as a static, and the relate
 *  layer resolves it only for cells that join a cyclic relation. The engine
 *  proper never sees it — forward writes always overwrite and change
 *  detection is the cell's own `equals`, so the acyclic core pays nothing. */
export interface Lattice<T> {
  /** No information — the identity for `meet`. */
  readonly top: T;
  /** Greatest lower bound of two contributions. Commutative, associative,
   *  idempotent — so a fold is order-independent (confluent). */
  meet(a: T, b: T): T;
  /** Lattice equality — drives the solver's fixpoint test (may differ from
   *  the cell's `equals`, e.g. an ε tolerance over reals). */
  equals(a: T, b: T): boolean;
  /** Self-contradiction: empty interval / empty candidate set / clash. */
  isBottom(a: T): boolean;
}

export interface CellOptions<T = unknown> {
  /** First subscriber attached; fired from `link`. */
  watched?: () => void;
  /** Last subscriber detached; fired from `_unwatched`. */
  unwatched?: () => void;
  /** Per-instance value equality; defaults to `Object.is`. */
  equals?: (a: T, b: T) => boolean;
}

export class Cell<T = unknown> implements ReactiveNode {
  flags: number = F.Mutable;
  subs: Link | undefined;
  subsTail: Link | undefined;
  deps: Link | undefined;
  depsTail: Link | undefined;

  /** Forward derivation (computed/lens). `undefined` ⇒ source. */
  getter: (() => T) | undefined;

  /** Per-instance equality, always defined (defaults to `Object.is` at
   *  construction) so hot paths call it without an `undefined` branch. */
  _equals: (a: T, b: T) => boolean;
  /** First-subscriber / last-subscriber lifecycle hooks. */
  _watched: (() => void) | undefined;
  _unwatchedHook: (() => void) | undefined;

  /** Source: `currentValue` = committed, `pendingValue` = staged write.
   *  Getter cell: `currentValue` = last derived cache, `pendingValue`
   *  reused as the staged backward target (see `set value`). The two
   *  roles never coexist, so two fields suffice for four. */
  currentValue: T;
  pendingValue: T;

  /** Backward sidecar: target(s) + lens closures + queue slot, or
   *  `undefined` for a read-only cell (source or computed). Allocated only
   *  for writable derived cells, keeping the common node lean. Writability
   *  is exactly `_bwd !== undefined`. See `BwdSpec`. */
  _bwd: BwdSpec | undefined;

  constructor(initial: T, opts?: CellOptions<T>) {
    this.currentValue = initial;
    this.pendingValue = initial;
    // Pre-init every optional slot for a stable V8 hidden class across variants.
    this.subs = undefined;
    this.subsTail = undefined;
    this.deps = undefined;
    this.depsTail = undefined;
    this.getter = undefined;
    this._equals = Object.is;
    this._watched = undefined;
    this._unwatchedHook = undefined;
    this._bwd = undefined;
    if (opts !== undefined) {
      if (opts.equals !== undefined) this._equals = opts.equals;
      if (opts.watched !== undefined) this._watched = opts.watched;
      if (opts.unwatched !== undefined) this._unwatchedHook = opts.unwatched;
    }
  }

  // The `value` accessor is installed on the prototype after the class
  // body (V8 JITs a prototype accessor better than a class get/set here).
  // Declared `readonly` so a bare cell is read-only at the TYPE level;
  // writability is added back via `Writable<R>`. The runtime accessor is
  // settable regardless.
  declare readonly value: T;

  _enqueueBwd(): void {
    this.flags |= F.BwdQueued;
    this._bwd!.queueIdx = bwdQueue.length;
    bwdQueue.push(this as Cell<unknown>);
  }

  /** Source write (alien's signal setter). */
  _writeSource(next: T): void {
    const prev = this.pendingValue;
    this.pendingValue = next;
    if (!this._equals(prev, next)) {
      this.flags = F.Mutable | F.Dirty;
      if (writeHook !== undefined) writeHook(this as Cell<unknown>);
      const subs = this.subs;
      if (subs !== undefined) propagate(subs, runDepth > 0);
      if (!flushing && subs !== undefined) flush();
    }
  }

  _update(): boolean {
    if (this.getter !== undefined) {
      // Computed/lens: re-run the forward derivation.
      this.depsTail = undefined;
      this.flags = F.Mutable | F.RecursedCheck;
      const prev = activeSub;
      activeSub = this;
      let threw = true;
      try {
        ++cycle;
        const old = this.currentValue;
        const next = (this.currentValue = this.getter());
        threw = false;
        return !this._equals(old, next);
      } finally {
        activeSub = prev;
        this.flags = threw ? F.Mutable | F.Dirty : this.flags & ~F.RecursedCheck;
        purgeDeps(this);
      }
    }
    this.flags = F.Mutable;
    const prevV = this.currentValue;
    this.currentValue = this.pendingValue;
    return !this._equals(prevV, this.currentValue);
  }

  _notify(): void {}

  _unwatched(): void {
    if (this.getter !== undefined && this.depsTail !== undefined) {
      this.flags = F.Mutable | F.Dirty;
      disposeAllDepsInReverse(this);
      return;
    }
    if (this._unwatchedHook !== undefined) this._unwatchedHook();
  }

  peek(): T {
    const prev = activeSub;
    activeSub = undefined;
    try {
      return this.value;
    } finally {
      activeSub = prev;
    }
  }

  /** Guard: silent coercion to string/number is almost always a bug. */
  [Symbol.toPrimitive](hint: string): never {
    throw new TypeError(`Cell cannot be coerced to ${hint} — use \`.value\``);
  }

  // Construction helpers build via `new this()` so a subclass static
  // (`Vec.lens(...)`) yields a `Vec` with its constructor-set equality.
  // Every lens has a structural backward target (`_bwd.parent`), which is
  // what makes the backward pass well-defined.

  /** Endomorphic lens. A 2-arg `bwd(view, current)` consults the current
   *  source; a 1-arg `bwd(view)` reconstructs it from the view alone. */
  lens(this: Cell<T>, fwd: (v: T) => T, bwd: (target: T, current: T) => T): this {
    return buildLens1(
      this.constructor as CellCtor<Cell<T>>,
      this as Cell<unknown>,
      fwd as (v: unknown) => unknown,
      bwd as (t: unknown, s?: unknown) => unknown,
      bwd.length >= 2,
    ) as this;
  }

  /** Read-only same-type view: the RO dual of the endo `.lens`. For a cross-type view use the typed static
   *  `Target.derive(src, fn)`. */
  derive(this: Cell<T>, fn: (v: T) => T): this {
    return buildDerived(this.constructor as CellCtor<Cell<T>>, () => fn(this.value)) as this;
  }

  /** Read-only typed view. `Cls.derive(parent, fn)` (1-input),
   *  `Cls.derive(parents, fn)` (N-input), or `Cls.derive(fn)` (closure).
   *  Polymorphic-`this`: `Vec.derive(...)` → `Vec`. */
  // biome-ignore lint/suspicious/noExplicitAny: variance escape
  static derive<C extends new (...args: never[]) => Cell<any>, P>(
    this: C,
    parent: Read<P>,
    fn: (v: P) => Inner<InstanceType<C>>,
  ): InstanceType<C>;
  // biome-ignore lint/suspicious/noExplicitAny: variance escape
  static derive<C extends new (...args: never[]) => Cell<any>, P extends readonly Read<unknown>[]>(
    this: C,
    parents: P,
    fn: (
      vals: { [K in keyof P]: P[K] extends Read<infer V> ? V : never },
    ) => Inner<InstanceType<C>>,
  ): InstanceType<C>;
  // biome-ignore lint/suspicious/noExplicitAny: variance escape
  static derive<C extends new (...args: never[]) => Cell<any>>(
    this: C,
    fn: () => Inner<InstanceType<C>>,
  ): InstanceType<C>;
  // biome-ignore lint/suspicious/noExplicitAny: dispatch
  static derive(this: any, ...args: any[]): any {
    return dispatchDerive(this, args);
  }

  /** Writable lens. `Cls.lens(parent, fwd, bwd)` for one input,
   *  `Cls.lens(parents, fwd, bwd)` for N; a 2-arg `bwd` reads the source,
   *  a 1-arg `bwd` reconstructs it. `Cls.lens(parent(s), spec)` builds a
   *  complement-carrying lens from `{ init, step, fwd, bwd }`. */
  // biome-ignore lint/suspicious/noExplicitAny: variance escape
  static lens<C extends new (...args: never[]) => Cell<any>, P>(
    this: C,
    parent: Read<P>,
    fwd: (v: P) => Inner<InstanceType<C>>,
    bwd: (target: Inner<InstanceType<C>>, v: P) => P,
  ): Writable<InstanceType<C>>;
  // biome-ignore lint/suspicious/noExplicitAny: variance escape
  static lens<C extends new (...args: never[]) => Cell<any>, P extends readonly Read<unknown>[]>(
    this: C,
    parents: P,
    fwd: (
      vals: { [K in keyof P]: P[K] extends Read<infer V> ? V : never },
    ) => Inner<InstanceType<C>>,
    bwd: (
      target: Inner<InstanceType<C>>,
      vals: { [K in keyof P]: P[K] extends Read<infer V> ? V : never },
    ) => { [K in keyof P]?: P[K] extends Read<infer V> ? V : never },
  ): Writable<InstanceType<C>>;
  // biome-ignore lint/suspicious/noExplicitAny: variance escape
  static lens<C extends new (...args: never[]) => Cell<any>, P, Cm>(
    this: C,
    parent: Read<P>,
    spec: StatefulLensSpec<readonly [P], Inner<InstanceType<C>>, Cm>,
  ): Writable<InstanceType<C>>;
  static lens<
    C extends new (
      ...args: never[]
      // biome-ignore lint/suspicious/noExplicitAny: variance escape
    ) => Cell<any>,
    P extends readonly Read<unknown>[],
    Cm,
  >(
    this: C,
    parents: P,
    spec: StatefulLensSpec<
      { [K in keyof P]: P[K] extends Read<infer V> ? V : never },
      Inner<InstanceType<C>>,
      Cm
    >,
  ): Writable<InstanceType<C>>;
  // biome-ignore lint/suspicious/noExplicitAny: dispatch
  static lens(this: any, ...args: any[]): any {
    return dispatchLens(this, args);
  }

  /** Type predicate against this class: `Vec.is(x)` narrows `x` to `Vec`.
   *  Inherited static; works for any subclass via polymorphic `this`. */
  // biome-ignore lint/suspicious/noExplicitAny: variance escape
  static is<C extends new (...args: never[]) => Cell<any>>(
    this: C,
    v: unknown,
  ): v is InstanceType<C> {
    return v instanceof this;
  }

  /** Lift `Val<Inner<Cls>>` → `Cls`: instance → identity, RO cell →
   *  tracked `derive`, literal → fresh seed. */
  // biome-ignore lint/suspicious/noExplicitAny: variance escape
  static from<C extends new (...args: never[]) => Cell<any>>(
    this: C,
    v: Val<Inner<InstanceType<C>>>,
  ): InstanceType<C> {
    if (v instanceof this) return v as InstanceType<C>;
    if (v instanceof Cell) {
      // biome-ignore lint/suspicious/noExplicitAny: dispatch
      return (this as any).derive(() => readNow(v)) as InstanceType<C>;
    }
    return new (this as unknown as new (init?: Inner<InstanceType<C>>) => InstanceType<C>)(
      v as Inner<InstanceType<C>>,
    ) as InstanceType<C>;
  }

  /** Writable-shaped constant: always reads `v`, absorbs writes
   *  (parentless sink lens), for APIs demanding bidirectionality. */
  // biome-ignore lint/suspicious/noExplicitAny: variance escape
  static pin<C extends new (...args: never[]) => Cell<any>>(
    this: C,
    v: Inner<InstanceType<C>>,
  ): Writable<InstanceType<C>> {
    const cell = new (this as unknown as CellCtor<Cell<unknown>>)();
    cell.flags = F.Mutable | F.Dirty;
    cell.getter = (): unknown => v;
    const b = (cell._bwd = new BwdSpec());
    b.put = (): unknown => undefined; // absorb (no parent → sink)
    return cell as unknown as Writable<InstanceType<C>>;
  }

  /** Typed field lens onto `parent.value[key]`. A read-only computed
   *  parent yields a RO derive view; any writable parent yields a
   *  bidirectional field lens with spread-replace `put`. */
  // biome-ignore lint/suspicious/noExplicitAny: variance escape
  static fieldOf<C extends new (...args: never[]) => Cell<any>>(
    // biome-ignore lint/suspicious/noExplicitAny: parent is contravariant on put
    parent: Cell<any>,
    key: string | number | symbol,
    Cls: C,
  ): InstanceType<C> {
    const ctor = Cls as unknown as CellCtor<Cell<unknown>>;
    const get = (s: unknown): unknown => (s as Record<string | number | symbol, unknown>)[key];
    // Read-only ⇔ computed: a getter with no backward sidecar.
    const ro = parent.getter !== undefined && parent._bwd === undefined;
    if (ro) {
      return buildDerived(ctor, () => get(parent.value)) as InstanceType<C>;
    }
    // Spread-replace reads the current source ⇒ source-reading (lens) form.
    return buildLens1(
      ctor,
      parent as Cell<unknown>,
      get,
      (v, s) => ({ ...(s as object), [key]: v }),
      true,
    ) as InstanceType<C>;
  }
}

// Each `new Cls()` yields the right subclass (so `Vec.lens(...)` returns
// a `Vec`), then sets the mode fields. Module-level so statics can call them.

// biome-ignore lint/suspicious/noExplicitAny: variance escape for subclass ctors (contravariant _equals)
type CellCtor<C extends Cell<any>> = new (...args: never[]) => C;

// biome-ignore lint/suspicious/noExplicitAny: variance escape
function buildDerived<C extends Cell<any>>(Cls: CellCtor<C>, getter: () => unknown): C {
  const cell = new Cls();
  cell.getter = getter as () => never;
  cell.flags = F.Mutable | F.Dirty;
  return cell;
}

// biome-ignore lint/suspicious/noExplicitAny: variance escape
function buildLens1<C extends Cell<any>>(
  Cls: CellCtor<C>,
  parent: Cell<unknown>,
  fwd: (v: unknown) => unknown,
  bwd: (t: unknown, s?: unknown) => unknown,
  readsSource: boolean,
): C {
  const cell = new Cls();
  cell.flags = F.Mutable | F.Dirty;
  cell.getter = (() => fwd(parent.value)) as () => never;
  const b = (cell._bwd = new BwdSpec());
  // Store `bwd` raw + a `readsSource` flag instead of baking `settled(parent)`
  // into a 1-arg closure. `propagateBwd` reads the parent once (for the memo
  // key) and passes it in, so the parent snapshot isn't read twice and the
  // inverse can be memoized on `(target, parentRead)`.
  b.put = bwd;
  b.readsSource = readsSource;
  b.parent = parent;
  return cell;
}

// biome-ignore lint/suspicious/noExplicitAny: variance escape
function buildLensN<C extends Cell<any>>(
  Cls: CellCtor<C>,
  parents: Cell<unknown>[],
  fwd: (vals: readonly unknown[]) => unknown,
  bwd: ((target: unknown, vals?: readonly unknown[]) => ReadonlyArray<unknown>) | undefined,
  readsSource: boolean,
): C {
  const n = parents.length;
  const vals = new Array<unknown>(n);
  const cell = new Cls();
  cell.flags = F.Mutable | F.Dirty;
  cell.getter = (() => {
    for (let i = 0; i < n; i++) vals[i] = parents[i]!.value;
    return fwd(vals);
  }) as () => never;
  if (bwd === undefined) return cell; // read-only derive-N
  const b = (cell._bwd = new BwdSpec());
  b.parent = parents;
  b.put = readsSource
    ? (target: unknown): unknown => {
        for (let i = 0; i < n; i++) vals[i] = parents[i]!.peek();
        return bwd(target, vals);
      }
    : (target: unknown): unknown => bwd(target);
  return cell;
}

// Stateful lens (complement-carrying).
//
// The third writable kind (alongside source-independent `iso` and
// source-reading `lens`). Carries a COMPLEMENT — memory the source can't
// hold (the casing a `lowercase` view discards, the winding a principal-
// axis angle accumulates):
//   init(srcs)              → seed the complement
//   fwd(srcs, c)            → the view
//   step(srcs, c, external) → advance the complement (forward / on commit);
//                             `external` = outside change vs own back-write
//   bwd(target, srcs, c)    → { updates, complement }: per-parent updates
//                             (`undefined` ⇒ leave parent) + new complement
//
// All four are pure (the equality check evaluates them speculatively);
// `bwd`/`step` read no cells (backward runs untracked). The engine owns
// `c`, advancing it only on a real forward recompute or commit. Before
// `bwd` runs the engine steps `c` to the current sources, so `bwd` always
// sees an up-to-date complement.

export interface StatefulBwd<S extends readonly unknown[], C> {
  updates: { readonly [K in keyof S]: S[K] | undefined };
  complement: C;
}

export interface StatefulLensSpec<S extends readonly unknown[], V, C> {
  init: (sources: S) => C;
  step: (sources: S, complement: C, external: boolean) => C;
  fwd: (sources: S, complement: C) => V;
  bwd: (target: V, sources: S, complement: C) => StatefulBwd<S, C>;
}

// biome-ignore lint/suspicious/noExplicitAny: variance escape
function buildStateful<C extends Cell<any>>(
  Cls: CellCtor<C>,
  parents: Cell<unknown>[],
  // biome-ignore lint/suspicious/noExplicitAny: opaque spec
  spec: StatefulLensSpec<any, any, any>,
): C {
  const n = parents.length;
  const vals = new Array<unknown>(n);
  const cell = new Cls();
  cell.flags = F.Mutable | F.Dirty;
  const b = (cell._bwd = new BwdSpec());
  const seed = new Array<unknown>(n);
  for (let i = 0; i < n; i++) seed[i] = parents[i]!.peek();
  const sc = (b.stateful = new StatefulCore(
    spec.init(seed),
    spec.fwd as (s: unknown, c: unknown) => unknown,
    spec.step,
  ));
  b.put = spec.bwd as (t: unknown, c?: unknown) => unknown;
  b.parent = parents;
  cell.getter = (() => {
    for (let i = 0; i < n; i++) vals[i] = parents[i]!.value;
    // External unless the live sources still equal this lens's own last
    // back-write.
    let external = true;
    const lb = sc.lastBwd;
    if (lb !== undefined) {
      external = false;
      for (let i = 0; i < n; i++) {
        if (vals[i] !== lb[i]) {
          external = true;
          break;
        }
      }
    }
    sc.complement = sc.step(vals, sc.complement, external);
    return sc.fwd(vals, sc.complement);
  }) as () => never;
  return cell;
}

// Single-source stateful lens: the `buildLens1` of the complement path.
// Drops the per-read copy/external loops to direct index-0 access; the
// spec stays array-shaped (`init: ([s]) => …`), so a reused length-1
// `vals` still feeds the closures and `b.parent` stays an array for the
// shared split backward path.
// biome-ignore lint/suspicious/noExplicitAny: variance escape
function buildStateful1<C extends Cell<any>>(
  Cls: CellCtor<C>,
  parent: Cell<unknown>,
  // biome-ignore lint/suspicious/noExplicitAny: opaque spec
  spec: StatefulLensSpec<any, any, any>,
): C {
  const cell = new Cls();
  cell.flags = F.Mutable | F.Dirty;
  const b = (cell._bwd = new BwdSpec());
  const sc = (b.stateful = new StatefulCore(
    spec.init([parent.peek()]),
    spec.fwd as (s: unknown, c: unknown) => unknown,
    spec.step,
  ));
  b.put = spec.bwd as (t: unknown, c?: unknown) => unknown;
  b.parent = [parent];
  const vals: unknown[] = [undefined];
  cell.getter = (() => {
    const v = (vals[0] = parent.value);
    const lb = sc.lastBwd;
    const external = lb === undefined || lb[0] !== v;
    sc.complement = sc.step(vals, sc.complement, external);
    return sc.fwd(vals, sc.complement);
  }) as () => never;
  return cell;
}

// Shared runtime dispatch for `derive`/`lens`, parameterized by the cell
// constructor: the polymorphic-`this` statics pass the typed subclass
// (`Vec.derive` → Vec), the free functions pass the plain `Cell`. One body
// each so the static and free forms can't drift (typed overloads live at
// the call sites; only these `any` runtime bodies are shared).
// biome-ignore lint/suspicious/noExplicitAny: dispatch
function dispatchDerive(ctor: CellCtor<Cell<any>>, args: any[]): unknown {
  if (args.length === 1) return buildDerived(ctor, args[0]);
  const [parent, fn] = args;
  if (Array.isArray(parent)) return buildLensN(ctor, parent, fn, undefined, false);
  return buildDerived(ctor, () => fn((parent as Cell<unknown>).value));
}

// biome-ignore lint/suspicious/noExplicitAny: dispatch
function dispatchLens(ctor: CellCtor<Cell<any>>, args: any[]): unknown {
  const [parent, a, b] = args;
  if (args.length === 2) {
    const ps = Array.isArray(parent) ? (parent as Cell<unknown>[]) : [parent as Cell<unknown>];
    return ps.length === 1 ? buildStateful1(ctor, ps[0]!, a) : buildStateful(ctor, ps, a);
  }
  const readsSource = (b as (...xs: unknown[]) => unknown).length >= 2;
  if (Array.isArray(parent)) return buildLensN(ctor, parent, a, b, readsSource);
  return buildLens1(ctor, parent, a, b, readsSource);
}

// Install `value` on the prototype (for silly TypeScript inference reasons I'd like to avoid if we can figure it out).
Object.defineProperty(Cell.prototype, "value", {
  get(this: Cell<unknown>): unknown {
    const flags = this.flags;
    if (this.getter !== undefined) {
      if (flags & F.RecursedCheck) {
        throw new RangeError(
          `Cyclic computed: ${(this.constructor as { name?: string }).name ?? "?"} read its own value`,
        );
      }
      if (
        flags & F.Dirty ||
        (flags & F.Pending &&
          (checkDirty(this.deps!, this) || ((this.flags = flags & ~F.Pending), false)))
      ) {
        if (this._update()) {
          const subs = this.subs;
          if (subs !== undefined) shallowPropagate(subs);
        }
      } else if (!flags) {
        // First read: lazy init.
        this.flags = F.Mutable | F.RecursedCheck;
        const prev = activeSub;
        activeSub = this;
        let threw = true;
        try {
          this.currentValue = this.getter();
          threw = false;
        } finally {
          activeSub = prev;
          this.flags = threw ? F.Mutable | F.Dirty : this.flags & ~F.RecursedCheck;
        }
      }
      if (activeSub !== undefined) link(this, activeSub, cycle);
      return this.currentValue;
    }
    // Cell path.
    if (flags & F.Dirty) {
      this.flags = F.Mutable;
      const prevV = this.currentValue;
      this.currentValue = this.pendingValue;
      if (!this._equals(prevV, this.currentValue)) {
        const subs = this.subs;
        if (subs !== undefined) shallowPropagate(subs);
      }
    }
    if (activeSub !== undefined) link(this, activeSub, cycle);
    return this.currentValue;
  },
  set(this: Cell<unknown>, next: unknown): void {
    if (this.getter === undefined) {
      this._writeSource(next);
      return;
    }
    // Backward write — uniformly staged + enqueued, no eager path. The
    // write parks the target in `pendingValue` (unused by a getter's forward
    // path), enqueues one backward intent, and drains synchronously (`flush`)
    // unless we're already inside a drain. The drain walks every queued cell
    // once, last-write-wins, settling the value graph before control returns
    // — so read-back is synchronous everywhere.
    const b = this._bwd;
    if (b === undefined) {
      throw new TypeError("Cannot write to a computed");
    }
    // View-level GetPut no-op skip for a multi-parent / stateful view:
    // peeking is safe (it recomputes from its parents) and the skip is
    // REQUIRED so a lossy split absorbs a same-view write rather than
    // flattening the sub-grid remainder its parents carry. A single-parent
    // view is NOT peeked here (peeking a staged source would commit its
    // pending value and could over-fire); the drain's `settled` no-op stop
    // prunes its no-op without committing. This also makes a relation-member
    // write cheap: it never solves the projection, it just stages to base.
    const multi = Array.isArray(b.parent) || b.stateful !== undefined;
    if (multi && this._equals(next, this.peek())) return;
    this.pendingValue = next;
    if (!(this.flags & F.BwdQueued)) this._enqueueBwd();
    if (!flushing) flush();
  },
  enumerable: false,
  configurable: false,
});

// Backward pass (propagateBwd).
//
// Walk up `_bwdParent`, applying `put` at each lens until a source is
// committed (via the forward write path). Not a second engine: every path
// terminates in `_writeSource`.

// Backward evaluation runs UNTRACKED so `bwd`/`step`/`fwd` reads don't
// establish forward deps on whatever `activeSub` is writing (e.g. an
// effect that writes a lens). All backward entry points route through here.
function bwdUntracked(cell: Cell<unknown>, target: unknown): void {
  const prev = activeSub;
  activeSub = undefined;
  try {
    propagateBwd(cell, target);
  } finally {
    activeSub = prev;
  }
}

/** A cell's current value for the backward pass's internal no-op checks,
 *  WITHOUT side effects. A source staged earlier in this drain reads its
 *  pending value directly; reading it via `peek` would COMMIT the pending
 *  value (`_update`: currentValue = pendingValue), so a later net-zero
 *  revert would look like a real change and over-fire downstream. A
 *  non-source (lens/computed) has no such hazard and recomputes via peek. */
function settled(cell: Cell<unknown>): unknown {
  return cell.getter === undefined && (cell.flags & F.Dirty) !== 0
    ? cell.pendingValue
    : cell.peek();
}

function propagateBwd(start: Cell<unknown>, target: unknown): void {
  let cell = start;
  let v = target;
  while (true) {
    // Multi-parent lens: SPLIT the write into each parent (dual of a
    // getter reading N parents — the `put` yields N upstream values).
    const cb = cell._bwd!;
    const parent = cb.parent;
    if (Array.isArray(parent)) {
      propagateSplit(cell, v);
      return;
    }
    let push: unknown;
    if (cb.readsSource && parent !== undefined) {
      // Source-reading 1→1 lens: read the parent once, then memoize the
      // inverse on `(target, parentRead)` (see BwdSpec memo). On a hit we
      // skip the `put` body entirely.
      const read = settled(parent);
      if (cb.memoOk && cb.lastTarget === v && cb.lastRead === read) {
        push = cb.lastResult;
      } else {
        push = cb.put!(v, read);
        cb.lastTarget = v;
        cb.lastRead = read;
        cb.lastResult = push;
        cb.memoOk = true;
      }
    } else {
      // Source-independent put (1-arg) or `pin` (ignores `v`): key on target.
      if (cb.memoOk && cb.lastTarget === v) {
        push = cb.lastResult;
      } else {
        push = cb.put!(v);
        cb.lastTarget = v;
        cb.lastResult = push;
        cb.memoOk = true;
      }
    }

    // Parentless lens (e.g. `pin`): no upstream, write absorbed. Sink.
    if (parent === undefined) return;

    // Concrete no-op stop: if the parent already holds `push`, committing
    // changes nothing upstream, so the walk stops. Sound for ANY topology
    // (no speculation). A lossy lens hides an off-grid edit by returning
    // the current source from `put`. `settled` reads a staged source's
    // pending value WITHOUT committing it, so a net-zero revert leaves the
    // source unchanged and downstream un-fired.
    if (parent._equals(push, settled(parent))) return;

    if (parent.getter === undefined) {
      // Source: commit + forward-propagate (the forward write).
      parent._writeSource(push);
      return;
    }
    // Parent is a lens: keep walking, carrying its new view value.
    cell = parent;
    v = push;
  }
}

/** Split a multi-parent cell's write across its N parents. `_put(target)`
 *  returns the per-parent update array (`undefined` ⇒ leave parent);
 *  each defined update recurses via `propagateBwd`. Always runs inside the
 *  drain (`flush`), so per-parent commits coalesce under that one flush. */
function propagateSplit(cell: Cell<unknown>, target: unknown): void {
  const b = cell._bwd!;
  const parents = b.parent as Cell<unknown>[];
  const n = parents.length;

  // STATEFUL lens: `bwd` reads the complement and returns per-parent
  // updates plus the post-write complement. We commit the stepped
  // complement and fork the source updates; absorption is the lens's job
  // (its `bwd` returns `undefined` updates, forked as no-ops).
  const sc = b.stateful;
  if (sc !== undefined) {
    // Bring the complement current with the sources before the back-write
    // (a source may have changed without the view being read, leaving
    // `step` un-run). Untracked, so reading `.value` adds no dependency.
    void cell.value;
    const vals = new Array<unknown>(n);
    for (let i = 0; i < n; i++) vals[i] = parents[i]!.peek();
    const res = (b.put as (t: unknown, s: unknown, c: unknown) => StatefulBwd<unknown[], unknown>)(
      target,
      vals,
      sc.complement,
    );
    const updates = res.updates as ReadonlyArray<unknown>;
    const cand = new Array<unknown>(n);
    let anyWrite = false;
    for (let i = 0; i < n; i++) {
      const u = updates[i];
      if (u === undefined) {
        cand[i] = vals[i];
      } else {
        cand[i] = u;
        anyWrite = true;
      }
    }
    sc.complement = sc.step(cand, res.complement, false);
    if (!anyWrite) {
      // Complement-only change (no source moves): mark dirty for a correct next read.
      cell.flags = F.Mutable | F.Dirty;
      return;
    }
    sc.lastBwd = cand;
    forkInto(parents, updates, n);
    return;
  }

  const updates = b.put!(target) as ReadonlyArray<unknown>;

  // No speculation: each defined update forks to its parent, where
  // `_writeSource`'s equality check prunes no-op sources and the forward
  // pass prunes unchanged views. Absorption ⇒ `undefined` updates.
  forkInto(parents, updates, n);
}

/** Route each defined update to its parent: a source commits directly, a
 *  lens/multi-parent re-enters the backward pass. Runs inside the drain,
 *  so commits coalesce into the in-progress flush. */
function forkInto(parents: Cell<unknown>[], updates: ReadonlyArray<unknown>, n: number): void {
  for (let i = 0; i < n; i++) {
    const u = updates[i];
    if (u === undefined) continue;
    const parent = parents[i]!;
    if (parent.getter === undefined) parent._writeSource(u);
    else propagateBwd(parent, u);
  }
}

/** Writable source; passes an existing `Writable` through (idempotent). */
export function cell<T>(initial: T | Writable<Cell<T>>, opts?: CellOptions<T>): Writable<Cell<T>> {
  if (initial instanceof Cell) return initial as Writable<Cell<T>>;
  return new Cell(initial as T, opts) as Writable<Cell<T>>;
}

// Bare (untyped) factories. Construct a plain `Cell`, inferring `R`
// from the closures (the polymorphic-`this` statics are for typed
// subclasses like `Vec.lens`).

const CELL_CTOR = Cell as unknown as CellCtor<Cell<unknown>>;

/** Untyped read-only view: `derive(parent, fn)`, `derive(parents, fn)`,
 *  or `derive(fn)` (closure). */
export function derive<P, R>(parent: Read<P>, fn: (v: P) => R): Cell<R>;
export function derive<P extends readonly Read<unknown>[], R>(
  parents: P,
  fn: (vals: { [K in keyof P]: P[K] extends Read<infer V> ? V : never }) => R,
): Cell<R>;
export function derive<R>(fn: () => R): Cell<R>;
// biome-ignore lint/suspicious/noExplicitAny: dispatch
export function derive(...args: any[]): any {
  return dispatchDerive(CELL_CTOR, args);
}

/** Untyped lens, inferring `R` from the closures. A 2-arg `bwd` reads the
 *  source, a 1-arg `bwd` reconstructs it; `lens(parent(s), spec)` builds a
 *  complement-carrying lens. */
export function lens<P, R>(
  parent: Read<P>,
  fwd: (v: P) => R,
  bwd: (target: R, v: P) => P,
): Writable<Cell<R>>;
export function lens<P extends readonly Read<unknown>[], R>(
  parents: P,
  fwd: (vals: { [K in keyof P]: P[K] extends Read<infer V> ? V : never }) => R,
  bwd: (
    target: R,
    vals: { [K in keyof P]: P[K] extends Read<infer V> ? V : never },
  ) => { [K in keyof P]?: P[K] extends Read<infer V> ? V : never },
): Writable<Cell<R>>;
export function lens<P, R, C>(
  parent: Read<P>,
  spec: StatefulLensSpec<readonly [P], R, C>,
): Writable<Cell<R>>;
export function lens<P extends readonly Read<unknown>[], R, C>(
  parents: P,
  spec: StatefulLensSpec<{ [K in keyof P]: P[K] extends Read<infer V> ? V : never }, R, C>,
): Writable<Cell<R>>;
// biome-ignore lint/suspicious/noExplicitAny: dispatch
export function lens(...args: any[]): any {
  return dispatchLens(CELL_CTOR, args);
}

// Effect — alien-signals verbatim.
class Effect implements ReactiveNode {
  flags: number = F.Watching | F.RecursedCheck;
  subs: Link | undefined = undefined;
  subsTail: Link | undefined = undefined;
  deps: Link | undefined = undefined;
  depsTail: Link | undefined = undefined;
  fn: () => (() => void) | void;
  cleanup: (() => void) | undefined = undefined;

  constructor(fn: () => (() => void) | void) {
    this.fn = fn;
    const prev = activeSub;
    activeSub = this;
    try {
      ++runDepth;
      const ret = fn();
      this.cleanup = typeof ret === "function" ? ret : undefined;
    } finally {
      --runDepth;
      activeSub = prev;
      this.flags &= ~F.RecursedCheck;
    }
  }

  _update(): boolean {
    this.flags = F.Mutable;
    return true;
  }

  _notify(): void {
    let e: Effect = this;
    let insertIndex = queuedLength;
    const firstInsertedIndex = insertIndex;
    do {
      queued[insertIndex++] = e;
      e.flags &= ~F.Watching;
      const next = e.subs?.sub as Effect | undefined;
      if (next === undefined || !(next.flags & F.Watching)) break;
      e = next;
    } while (true);
    queuedLength = insertIndex;
    let idx = insertIndex,
      firstIdx = firstInsertedIndex;
    while (firstIdx < --idx) {
      const left = queued[firstIdx];
      queued[firstIdx++] = queued[idx];
      queued[idx] = left;
    }
  }

  _unwatched(): void {
    this.flags = F.None;
    disposeAllDepsInReverse(this);
    const sub = this.subs;
    if (sub !== undefined) unlink(sub);
    if (this.cleanup) this._runCleanup();
  }

  _run(): void {
    const flags = this.flags;
    if (flags & F.Dirty || (flags & F.Pending && checkDirty(this.deps!, this))) {
      if (this.cleanup) {
        this._runCleanup();
        if (!this.flags) return;
      }
      this.depsTail = undefined;
      this.flags = F.Watching | F.RecursedCheck;
      const prev = activeSub;
      activeSub = this;
      try {
        ++cycle;
        ++runDepth;
        const ret = this.fn();
        this.cleanup = typeof ret === "function" ? ret : undefined;
      } finally {
        --runDepth;
        activeSub = prev;
        this.flags &= ~F.RecursedCheck;
        purgeDeps(this);
      }
    } else if (this.deps !== undefined) {
      this.flags = F.Watching;
    }
  }

  _runCleanup(): void {
    const c = this.cleanup!;
    this.cleanup = undefined;
    const prev = activeSub;
    activeSub = undefined;
    try {
      c();
    } finally {
      activeSub = prev;
    }
  }
}

export function effect(fn: () => (() => void) | void): () => void {
  const e = new Effect(fn);
  return () => e._unwatched();
}

// Alternates backward-drain and effect-drain to a fixpoint: backward
// commits sources (queuing effects); effects may write (more effects /
// more bwd entries). Loops until both queues are exhausted.

// Scheduling, split by role:
//   • flush()      — SYNCHRONOUS backward drain. Commits sources to a
//                    fixpoint so the value graph is fully settled before
//                    control returns; `.value` read-back and lens/split
//                    commits are synchronous everywhere. It does NOT run
//                    effects — it only SCHEDULES them.
//   • runEffects() — terminal effects, drained on a MICROTASK. Coalesces
//                    many writes' notifications into one tick. An effect
//                    that writes commits its value graph synchronously (its
//                    own flush) and queues further effects, so the loop
//                    reaches a fixpoint across however many ticks it takes.
//   • settle()     — drain pending effects synchronously (test/bench bridge).

function flush(): void {
  if (flushing) return;
  flushing = true;
  let bwdIndex = 0;
  try {
    while (bwdIndex < bwdQueue.length) {
      const cell = bwdQueue[bwdIndex]!;
      const cb = cell._bwd!;
      if (cb.queueIdx !== bwdIndex || !(cell.flags & F.BwdQueued)) {
        bwdIndex++;
        continue;
      }
      bwdIndex++;
      cell.flags &= ~F.BwdQueued;
      bwdUntracked(cell, cell.pendingValue);
    }
  } finally {
    bwdQueue.length = 0;
    flushing = false;
  }
  if (notifyIndex < queuedLength) scheduleEffects();
}

let effectsScheduled = false;

function scheduleEffects(): void {
  if (effectsScheduled) return;
  effectsScheduled = true;
  queueMicrotask(runEffects);
}

function runEffects(): void {
  effectsScheduled = false;
  // A throwing effect aborts the loop; reset the queue in `finally` so the
  // skipped effects are dropped (not resumed by the next unrelated write),
  // matching a synchronous flush's transactional drain.
  try {
    while (notifyIndex < queuedLength) {
      const e = queued[notifyIndex]!;
      queued[notifyIndex++] = undefined;
      e._run();
    }
  } finally {
    notifyIndex = 0;
    queuedLength = 0;
  }
}

/** Settle pending effects synchronously (test/bench escape hatch). */
export function settle(): void {
  flush();
  runEffects();
}

export function untracked<R>(fn: () => R): R {
  const prev = activeSub;
  activeSub = undefined;
  try {
    return fn();
  } finally {
    activeSub = prev;
  }
}

// MISC stuff used by a few places, to revisit...

// ── value-class authoring helpers ──────────────────────────────────
//
// `fieldLens`/`cachedDerive` are the two getter forms a value class declares.
// The choice between them IS the local declaration of writability at each
// getter (mirroring `: this` invertible method returns). For arbitrary
// cached views, use `lazy()` directly.

/** Bidirectional field lens onto `parent.value[key]`; write spread-
 *  replaces the composite. Cached per (instance, key). Return type is
 *  conditional: `Writable<Cls>` on a writable parent, bare `Cls` on RO.
 *
 *      get x() { return fieldLens(this, "x", Num); } */
export function fieldLens<
  // biome-ignore lint/suspicious/noExplicitAny: variance escape on Cls.lens
  S extends Cell<any>,
  K extends keyof Inner<S>,
  C extends new (
    ...args: never[]
  ) => Cell<Inner<S>[K]>,
>(
  parent: S,
  key: K,
  Cls: C,
): S extends WritableBrand ? Writable<InstanceType<C>> : InstanceType<C> {
  return lazy(parent, key as string | symbol, () =>
    Cell.fieldOf(parent as unknown as Cell<unknown>, key as string | symbol, Cls),
  ) as never;
}

/** Read-only derived view via `Cls.derive(parent, fn)`, memoized per
 *  (instance, key); always bare `Cls` (RO). The cache is the point — the
 *  getter form, not a new kind of cell.
 *
 *      get magnitude() {
 *        return cachedDerive(this, "magnitude", Num, v => Math.hypot(v.x, v.y));
 *      } */
// biome-ignore lint/suspicious/noExplicitAny: variance escape, mirrors Cls.derive
export function cachedDerive<S extends Cell<any>, C extends new (...args: never[]) => Cell<any>>(
  parent: S,
  key: string | symbol,
  Cls: C,
  fn: (v: Inner<S>) => Inner<InstanceType<C>>,
): InstanceType<C> {
  // biome-ignore lint/suspicious/noExplicitAny: variance escape on Cls.derive
  return lazy(parent, key, () => (Cls as any).derive(parent, fn)) as InstanceType<C>;
}

// ── relation-group support (the relate layer's only engine hooks) ────
//
// An SCC is a generalized COMPUTED. The whole component is solved by one
// internal computed node `G` (the solver). Each member stays the SAME cell
// the user made, but while it participates it behaves as a writable
// projection of `G`: reading it PULLS `G` (so the fixpoint runs lazily, in
// dependency order, glitch-free — the ordinary computed path), and writing
// it flows to its `base` source (its standing assertion), which `G` reads —
// so a write invalidates `G` and the next read re-solves. Leaving every
// relation restores it to a plain source. Members are never split into
// input/output cells: the duality lives inside one node.
//
// These are the only places the engine knows relations exist; the partition,
// the lattice fold, and the scheduling policy all live in `relate.ts`.

/** Internal computed (a per-SCC solver `G`); not user-visible. `getter`
 *  runs the fixpoint and stashes member results; its return value is just a
 *  freshness token. */
export function internalComputed<T>(getter: () => T): Cell<T> {
  const c = new Cell<T>(undefined as T);
  c.getter = getter;
  c.flags = F.Mutable | F.Dirty;
  return c;
}

/** Retire an internal computed: unlink its inputs so they stop referencing
 *  it (no stale propagation, no leak). Idempotent. */
export function disposeInternalComputed<T>(c: Cell<T>): void {
  disposeAllDepsInReverse(c);
  c.getter = undefined;
  c.flags = F.None;
}

/** Turn `m` into a writable projection of its group: forward reads run
 *  `project` (which pulls the solver), backward writes flow to `base`. Marks
 *  `m` dirty and notifies existing subscribers so derived views re-pull, then
 *  schedules them (a topology edit isn't a source write, so nothing else
 *  would). A member is a single-parent lens, so the `set` path never peeks
 *  its solved view — writes stage straight to `base`. */
export function becomeMember<T>(m: Cell<T>, project: () => T, base: Cell<T>): void {
  m.getter = project as () => never;
  const b = (m._bwd = new BwdSpec());
  b.parent = base as Cell<unknown>;
  b.put = (t: unknown): unknown => t; // write-through to the assertion
  m.flags = F.Mutable | F.Dirty;
  if (m.subs !== undefined) {
    propagate(m.subs, false);
    if (!flushing) flush();
  }
}

/** Restore `m` to a plain source holding `value` (it left every relation).
 *  Drops the projection deps, then stages `value` as a normal pending source
 *  write (Dirty) — NOT a direct `currentValue` poke. The member's cached
 *  `currentValue` still holds the last SOLVED projection, so going through
 *  the Dirty/`_update` protocol is what lets `checkDirty` see a real change
 *  and refire subscribers (an effect validates its deps before re-running;
 *  a direct poke would report "unchanged" and the effect would skip). */
export function resignMember<T>(m: Cell<T>, value: T): void {
  m.getter = undefined;
  m._bwd = undefined;
  disposeAllDepsInReverse(m);
  m.pendingValue = value;
  m.flags = F.Mutable | F.Dirty;
  if (m.subs !== undefined) {
    propagate(m.subs, false);
    if (!flushing) flush();
  }
}
