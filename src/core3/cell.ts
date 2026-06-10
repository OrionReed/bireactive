// cell.ts — symmetric bidirectional reactive engine.
//
// Forward propagation is alien-signals verbatim (link/propagate/
// checkDirty/shallowPropagate, Dirty/Pending/Recursed flags, lazy pull).
// Backward is not a second engine: a write "compiles" a view-edit into
// source-edits by walking up `_rel.parents`, applying each lens's `bwd` to
// compute what the source(s) must become, committing via the SAME
// forward write path. So views are never sticky (a view is always
// `get(source)`; lossy lenses snap), no-op deltas short-circuit for free
// via equality, and backward cost ≤ forward cost.
//
// Duals:
//   * multi-parent lens — a write that SPLITS across N parents
//     (`bwd(target)` → per-parent update array); the dual of a getter
//     reading N parents. Covers coupled writables (N→M, e.g. mean/diff).
//     Info the source can't hold lives in a stateful-lens complement, not
//     a bespoke engine kind.
//
// Backward conflicts (N writes reaching one source) are last-write-wins.
// Principled N→1 aggregation is the relate layer's job: a knowledge cell
// folds contributions via its lattice `meet` (confluent), not a bespoke
// lens-level fold.
//
// Core asymmetry: forward deps are IMPLICIT (auto-tracked reads of
// `.value` under `activeSub`); backward targets are EXPLICIT (declared
// at construction in `_rel.parents`). Hence no `activeBwdWrite` global.
//
// Mode table — a cell's role is fully determined by which fields are set:
//   source      getter undefined                 (truth in currentValue)
//   derived    getter, no _rel                   (read-only derived)
//   lens 1→1    getter + _rel{ kind: Iso|Lens, parents: Cell }
//   multi-out   getter + _rel{ kind: Split, parents: Cell[] }  (1→N / N→M)
//   stateful    getter + _rel{ kind: Stateful, state }  (complement-carrying)
//   pin         getter + _rel{ kind: Sink }             (parentless sink)
// A cell is writable iff `_rel !== undefined` (the bidirectional transfer;
// see `Transfer`). `pendingValue` is dual-keyed: a staged forward write for a
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

// Transfer — the bidirectional map that defines a writable derived cell.
//
// Every cell carries the forward fields (links, getter, value cache). Only a
// WRITABLE derived cell — a 1→1 lens, a multi-output lens, a complement-
// carrying lens, or `pin` — needs the relation to its parent(s). That relation
// lives here, off a single `_rel` pointer, rather than inline on `Cell`, so a
// source/computed stays lean: the forward hot path never touches it and a plain
// node drops ~64 B. A cell is writable iff `_rel !== undefined`.
//
// ONE object, both directions: `fwd` (the forward map, read by the cell's
// shared getter) and `bwd` (the inverse). It is the single source of truth — the
// relate layer abstracts this SAME object into K-space when the lens sits inside
// a cycle, never re-authoring the maps. `kind` selects the shape, so the
// backward pass switches on it instead of probing `Array.isArray`/flags.
// NOTE: i wounder if this could fold into the flags?
export const K = {
  /** 1→1, source-independent inverse `bwd(target) → parent`. */
  Iso: 0,
  /** 1→1, source-reading inverse `bwd(target, parentRead) → parent`. */
  Lens: 1,
  /** N→M, `bwd(target) → per-parent updates[]` (any source read is baked in). */
  Split: 2,
  /** Complement-carrying; `bwd(target, srcs, c) → { updates, complement }`. */
  Stateful: 3,
  /** Parentless sink (`pin`): forward is a constant, backward absorbs. */
  Sink: 4,
} as const;
type Kind = (typeof K)[keyof typeof K];

// biome-ignore lint/suspicious/noExplicitAny: opaque transfer maps
type Fn = (...args: any[]) => any;

/** Complement state of a `Stateful` transfer — engine-owned memory the view
 *  discards, plus the sources last written back (own-vs-external test). */
interface Complement {
  complement: unknown;
  lastBwd: unknown[] | undefined;
}

/** A `Lens` (source-reading 1→1) recomputes `bwd(target, parentRead)` on every
 *  back-write. `bwd` is pure in its inputs, so a 1-slot memo keyed on
 *  `(target, parentRead)` skips the call when neither moved — the backward
 *  analog of forward's "Pending but not Dirty ⇒ don't recompute". Allocated
 *  lazily on first back-write, so only `Lens` cells ever carry it. */
class InverseMemo {
  ok = false;
  target: unknown = undefined;
  read: unknown = undefined;
  result: unknown = undefined;
}

class Transfer {
  /** Shape discriminant (see `K`). */
  kind: Kind;
  /** Input cell(s): one `Cell` (Iso/Lens), `Cell[]` (Split/Stateful), or
   *  `undefined` (Sink). */
  parents: Cell<unknown> | Cell<unknown>[] | undefined = undefined;
  /** Forward map, applied by the cell's shared getter. Iso/Lens: `(v) → view`;
   *  Split/Stateful: `(vals) → view`; Sink: `() → view`. */
  fwd: Fn;
  /** Inverse map; arity per `kind` (see `K`). */
  bwd: Fn;
  /** Stateful only: advance the complement, `(srcs, complement, external)`. */
  step: Fn | undefined = undefined;
  /** Stateful only: the complement + last back-write. */
  state: Complement | undefined = undefined;
  /** Split/Stateful only: reused forward-read buffer (allocated once). */
  scratch: unknown[] | undefined = undefined;
  /** Lens only: lazy inverse memo. */
  memo: InverseMemo | undefined = undefined;
  /** Index in `bwdQueue` of this cell's latest push; the drain skips stale
   *  entries so each cell propagates backward once per flush, last-write. */
  queueIdx = -1;

  constructor(kind: Kind, fwd: Fn, bwd: Fn) {
    this.kind = kind;
    this.fwd = fwd;
    this.bwd = bwd;
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

/** Lens mode: a derived cell that can be written back (has a transfer). */
export const isLens = (v: unknown): v is Cell<unknown> =>
  v instanceof Cell && v.getter !== undefined && v._rel !== undefined;

/** Read-only mode: derived with no backward path. */
export const isReadonly = (v: unknown): v is Cell<unknown> =>
  v instanceof Cell && v.getter !== undefined && v._rel === undefined;

/** A writable derived cell's structural inputs (its lens parents), normalised to
 *  an array; `[]` for a source or read-only cell. The relation engine reads this
 *  to fold lens dataflow edges into the graph WITHOUT naming `Transfer`. */
function parentsOf(c: Cell<unknown>): readonly Cell<unknown>[] {
  const r = c._rel;
  if (r === undefined) return EMPTY_PARENTS;
  const p = r.parents;
  return p instanceof Cell ? [p] : Array.isArray(p) ? (p as Cell<unknown>[]) : EMPTY_PARENTS;
}
const EMPTY_PARENTS: readonly Cell<unknown>[] = [];

/** A meet-semilattice over a KNOWLEDGE type `K`, distinct from the cell's
 *  VALUE type `T`. `K` carries partial information during a cyclic solve;
 *  `abstract` lifts a concrete seed/input into `K` and `concretize` collapses
 *  it back to a `T` at the component boundary (falling back to the cell's
 *  current value when underdetermined, so no `K` ever escapes into the DAG).
 *  See `lattice.ts` for the `flat`/`interval`/`tuple` combinators.
 *
 *  NOT a per-cell field: a value CLASS declares one as a static, and the
 *  relate layer resolves it only for cells that join a cyclic relation. The
 *  acyclic core never sees it — forward writes overwrite and change detection
 *  is the cell's own `equals`, so it pays nothing. */
export interface Lattice<T, K = T> {
  /** No information — the identity for `meet`. */
  readonly top: K;
  /** Greatest lower bound of two contributions. Commutative, associative,
   *  idempotent — so a fold is order-independent (confluent). */
  meet(a: K, b: K): K;
  /** Lattice equality — drives the solver's fixpoint test (may differ from
   *  the cell's `equals`, e.g. an ε tolerance over reals). */
  equals(a: K, b: K): boolean;
  /** Self-contradiction: empty interval / empty candidate set / clash. */
  isBottom(a: K): boolean;
  /** Lift a concrete value (a seed, or an external input) into knowledge. */
  abstract(v: T): K;
  /** Collapse knowledge to a concrete value; `fallback` (the cell's current
   *  value) is returned when `k` is underdetermined. */
  concretize(k: K, fallback: T): T;
  /** The single concrete value `k` pins down, or `undefined` when `k` is
   *  underdetermined (not exactly one value) or bottom. Drives the
   *  flat-precision lens transformer inside a cycle: a lens fires forward
   *  only once its parent's knowledge is pinned. */
  pinned(k: K): T | undefined;
  /** Convergence accelerator for INFINITE-height lattices (real intervals):
   *  given the previous and freshly-narrowed knowledge, return a value that
   *  guarantees the descending chain terminates (a sound post-fixpoint). A
   *  finite-height lattice (`flat`, bitset, product of finite) omits it —
   *  naive iteration already terminates, so termination is a property of the
   *  lattice, never a global iteration cap. */
  widen?(prev: K, next: K): K;
  /** Map this knowledge through a MONOTONE scalar `f`, staying in the same `K`
   *  representation — the lattice's own knowledge-transformer for a homomorphic
   *  (Iso) lens. An interval maps endpoint-wise (the whole band flows); a
   *  lattice that can't represent a band omits it, and the cyclic lens-lift
   *  falls back to pin-gated transfer (fire only once the value is pinned).
   *  Defined only where band-level narrowing is sound. */
  image?(k: K, f: (t: number) => number): K;
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

  /** Bidirectional transfer: the forward/backward maps + parent(s) + queue
   *  slot, or `undefined` for a read-only cell (source or computed). Allocated
   *  only for writable derived cells, keeping the common node lean. Writability
   *  is exactly `_rel !== undefined`. See `Transfer`. */
  _rel: Transfer | undefined;

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
    this._rel = undefined;
    if (opts !== undefined) {
      if (opts.equals !== undefined) this._equals = opts.equals;
      if (opts.watched !== undefined) this._watched = opts.watched;
      if (opts.unwatched !== undefined) this._unwatchedHook = opts.unwatched;
    }
  }

  // The `value` accessor is installed on the prototype after the class
  // Declared `readonly` so a bare cell is read-only at the TYPE level;
  // writability is added back via `Writable<R>`. The runtime accessor is
  // settable regardless.
  declare readonly value: T;

  _enqueueBwd(): void {
    this.flags |= F.BwdQueued;
    this._rel!.queueIdx = bwdQueue.length;
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
      // Push relaxation: schedule the propagators reading this just-committed
      // source, then drain to a fixpoint (unless we're already inside a drain,
      // in which case they're picked up by the running loop).
      scheduleReaders(this as Cell<unknown>);
      if (!flushing && subs !== undefined) flush();
      if (!relaxing && relaxQueue.length > 0) relax();
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
  // Every lens has a structural backward target (`_rel.parents`), which is
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
    cell.getter = sinkGetter as () => never;
    // Sink: forward is the constant `v`; backward absorbs (no parent).
    cell._rel = new Transfer(
      K.Sink,
      (): unknown => v,
      (): unknown => undefined,
    );
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
    // Read-only ⇔ computed: a getter with no transfer.
    const ro = parent.getter !== undefined && parent._rel === undefined;
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

// Shared forward getters, one per `Transfer` kind — assigned at build time so a
// writable derived cell carries NO per-instance getter closure. Each reads its
// maps and parents off `this._rel` (bound at the `this.getter()` call site);
// reading `parent.value` tracks the forward dep exactly as a closure would.

/** Iso/Lens forward: apply `fwd` to the single parent's live value. */
function singleGetter(this: Cell<unknown>): unknown {
  const r = this._rel!;
  return r.fwd((r.parents as Cell<unknown>).value);
}

/** Split forward: read each parent into the reused scratch, then `fwd(scratch)`. */
function multiGetter(this: Cell<unknown>): unknown {
  const r = this._rel!;
  const parents = r.parents as Cell<unknown>[];
  const s = r.scratch!;
  for (let i = 0; i < parents.length; i++) s[i] = parents[i]!.value;
  return r.fwd(s);
}

/** Stateful forward: detect own-vs-external change, advance the complement via
 *  `step`, then project with `fwd(scratch, complement)`. */
function statefulGetter(this: Cell<unknown>): unknown {
  const r = this._rel!;
  const parents = r.parents as Cell<unknown>[];
  const s = r.scratch!;
  const n = parents.length;
  for (let i = 0; i < n; i++) s[i] = parents[i]!.value;
  const state = r.state!;
  // External unless the live sources still equal this lens's own last back-write.
  let external = true;
  const lb = state.lastBwd;
  if (lb !== undefined) {
    external = false;
    for (let i = 0; i < n; i++) {
      if (s[i] !== lb[i]) {
        external = true;
        break;
      }
    }
  }
  state.complement = r.step!(s, state.complement, external);
  return r.fwd(s, state.complement);
}

/** Sink forward (`pin`): the stored constant. */
function sinkGetter(this: Cell<unknown>): unknown {
  return this._rel!.fwd();
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
  cell.getter = singleGetter as () => never;
  // `fwd`/`bwd` are canonical: `singleGetter` reads `fwd`, the backward pass
  // reads `bwd`, AND the relate layer lifts BOTH into knowledge transformers
  // when this lens sits inside a cycle. `kind` separates the source-independent
  // inverse (`Iso`, `bwd(target)`) from the source-reading one (`Lens`,
  // `bwd(target, parentRead)`), which gets a lazy `(target, read)` memo.
  cell._rel = new Transfer(readsSource ? K.Lens : K.Iso, fwd, bwd);
  cell._rel.parents = parent;
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
  const cell = new Cls();
  cell.flags = F.Mutable | F.Dirty;
  if (bwd === undefined) {
    // Read-only derive-N: a closure getter and NO transfer (not writable, so
    // `_rel` must stay `undefined`; `multiGetter` needs a transfer to read).
    const vals = new Array<unknown>(n);
    cell.getter = (() => {
      for (let i = 0; i < n; i++) vals[i] = parents[i]!.value;
      return fwd(vals);
    }) as () => never;
    return cell;
  }
  cell.getter = multiGetter as () => never;
  // Split `bwd` is always called `bwd(target)`: bake source-reading in here so
  // the backward pass stays uniform. Forward and backward share `scratch` (never
  // reentrant within one synchronous read), matching the old single-`vals` slot.
  const scratch = new Array<unknown>(n);
  const bwdFn = readsSource
    ? (target: unknown): unknown => {
        for (let i = 0; i < n; i++) scratch[i] = parents[i]!.peek();
        return bwd(target, scratch);
      }
    : (target: unknown): unknown => bwd(target);
  const r = (cell._rel = new Transfer(K.Split, fwd, bwdFn));
  r.parents = parents;
  r.scratch = scratch;
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
  const cell = new Cls();
  cell.flags = F.Mutable | F.Dirty;
  cell.getter = statefulGetter as () => never;
  const seed = new Array<unknown>(n);
  for (let i = 0; i < n; i++) seed[i] = parents[i]!.peek();
  const r = (cell._rel = new Transfer(K.Stateful, spec.fwd as Fn, spec.bwd as Fn));
  r.step = spec.step as Fn;
  r.state = { complement: spec.init(seed), lastBwd: undefined };
  r.scratch = new Array<unknown>(n);
  r.parents = parents;
  return cell;
}

// Single-source stateful lens: the `buildLens1` of the complement path. The
// spec stays array-shaped (`init: ([s]) => …`), so a length-1 parents array +
// scratch feed the shared `statefulGetter` and the shared split backward path.
// biome-ignore lint/suspicious/noExplicitAny: variance escape
function buildStateful1<C extends Cell<any>>(
  Cls: CellCtor<C>,
  parent: Cell<unknown>,
  // biome-ignore lint/suspicious/noExplicitAny: opaque spec
  spec: StatefulLensSpec<any, any, any>,
): C {
  const cell = new Cls();
  cell.flags = F.Mutable | F.Dirty;
  cell.getter = statefulGetter as () => never;
  const r = (cell._rel = new Transfer(K.Stateful, spec.fwd as Fn, spec.bwd as Fn));
  r.step = spec.step as Fn;
  r.state = { complement: spec.init([parent.peek()]), lastBwd: undefined };
  r.scratch = [undefined];
  r.parents = [parent];
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
    // A propagator member is a plain source: its concrete value is kept current
    // by the relaxation drain on write, so it reads through the ordinary source
    // path below — no region resolution, projection, or overlay on the hot read.
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
    // Source-shaped target (plain source OR a governed source member, which has
    // no getter either): `commitStanding` commits + forward-propagates a plain
    // source, or re-seeds a member's standing and re-solves its region.
    if (this.getter === undefined) {
      commitStanding(this, next);
      return;
    }
    // Backward write — uniformly staged + enqueued, no eager path. The
    // write parks the target in `pendingValue` (unused by a getter's forward
    // path), enqueues one backward intent, and drains synchronously (`flush`)
    // unless we're already inside a drain. The drain walks every queued cell
    // once, last-write-wins, settling the value graph before control returns
    // — so read-back is synchronous everywhere.
    const r = this._rel;
    if (r === undefined) {
      throw new TypeError("Cannot write to a computed");
    }
    // View-level GetPut no-op skip for a Split / Stateful view: peeking is safe
    // (it recomputes from its parents) and the skip is REQUIRED so a lossy split
    // absorbs a same-view write rather than flattening the sub-grid remainder its
    // parents carry. A single-parent view is NOT peeked here (peeking a staged
    // source would commit its pending value and could over-fire); the drain's
    // `settled` no-op stop prunes its no-op without committing. This also makes a
    // relation-member write cheap: it never solves the projection, just stages.
    const multi = r.kind === K.Split || r.kind === K.Stateful;
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
// Walk up `_rel.parents`, applying each transfer's `bwd` until a source is
// committed (via the forward write path). One pass, switching on `rel.kind`:
// Iso/Lens continue the single-parent walk, Split/Stateful fork across N
// parents and stop. Not a second engine: every path terminates in
// `_writeSource`.

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

/** Commit a value into a SOURCE-shaped leaf (`getter === undefined`). Commits +
 *  forward-propagates, and (via `_writeSource`) schedules + drains the
 *  propagators reading it. No-ops on an unchanged value. The single leaf-write
 *  path, shared by the setter, the backward pass, and split/stateful forks. */
function commitStanding(target: Cell<unknown>, v: unknown): void {
  target._writeSource(v);
}

function propagateBwd(start: Cell<unknown>, target: unknown): void {
  let cell = start;
  let v = target;
  while (true) {
    const r = cell._rel!;
    if (r.kind === K.Split || r.kind === K.Stateful) {
      // Fork the write across N parents (dual of a getter reading N parents).
      propagateFork(cell, r, v);
      return;
    }
    if (r.kind === K.Sink) return; // Parentless (`pin`): write absorbed.

    const parent = r.parents as Cell<unknown>;
    let push: unknown;
    if (r.kind === K.Lens) {
      // Source-reading 1→1 lens: read the parent once, then memoize the inverse
      // on `(target, parentRead)`. On a hit we skip the `bwd` body entirely.
      const read = settled(parent);
      let memo = r.memo;
      if (memo?.ok && memo.target === v && memo.read === read) {
        push = memo.result;
      } else {
        push = r.bwd(v, read);
        if (memo === undefined) memo = r.memo = new InverseMemo();
        memo.target = v;
        memo.read = read;
        memo.result = push;
        memo.ok = true;
      }
    } else {
      // Iso: source-independent inverse, cheap enough to skip the memo.
      push = r.bwd(v);
    }

    // Concrete no-op stop: if the parent already holds `push`, committing
    // changes nothing upstream, so the walk stops. Sound for ANY topology
    // (no speculation). A lossy lens hides an off-grid edit by returning
    // the current source from `bwd`. `settled` reads a staged source's
    // pending value WITHOUT committing it, so a net-zero revert leaves the
    // source unchanged and downstream un-fired.
    if (parent.getter === undefined) {
      // Leaf source-shaped parent: `settled` no-op stop (reads a staged pending
      // WITHOUT committing — net-zero revert safety), else commit.
      if (parent._equals(push, settled(parent))) return;
      commitStanding(parent, push);
      return;
    }
    // Parent is a lens (governed or not): no-op stop, else keep walking.
    if (parent._equals(push, settled(parent))) return;
    cell = parent;
    v = push;
  }
}

/** Fork a Split/Stateful cell's write across its N parents. The transfer's
 *  `bwd` returns the per-parent update array (`undefined` ⇒ leave parent);
 *  each defined update recurses via `propagateBwd`. Always runs inside the
 *  drain (`flush`), so per-parent commits coalesce under that one flush. */
function propagateFork(cell: Cell<unknown>, r: Transfer, target: unknown): void {
  const parents = r.parents as Cell<unknown>[];
  const n = parents.length;

  // STATEFUL lens: `bwd` reads the complement and returns per-parent updates
  // plus the post-write complement. We commit the stepped complement and fork
  // the source updates; absorption is the lens's job (its `bwd` returns
  // `undefined` updates, forked as no-ops).
  if (r.kind === K.Stateful) {
    const state = r.state!;
    // Bring the complement current with the sources before the back-write (a
    // source may have changed without the view being read, leaving `step`
    // un-run). Untracked, so reading `.value` adds no dependency.
    void cell.value;
    const vals = new Array<unknown>(n);
    for (let i = 0; i < n; i++) vals[i] = parents[i]!.peek();
    const res = r.bwd(target, vals, state.complement) as StatefulBwd<unknown[], unknown>;
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
    state.complement = r.step!(cand, res.complement, false);
    if (!anyWrite) {
      // Complement-only change (no source moves): mark dirty for a correct next read.
      cell.flags = F.Mutable | F.Dirty;
      return;
    }
    state.lastBwd = cand;
    forkInto(parents, updates, n);
    return;
  }

  // SPLIT: `bwd(target)` yields per-parent updates (source-reading baked in at
  // build). No speculation: each defined update forks to its parent, where
  // `_writeSource`'s equality check prunes no-op sources and the forward pass
  // prunes unchanged views. Absorption ⇒ `undefined` updates.
  const updates = r.bwd(target) as ReadonlyArray<unknown>;
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
    if (parent.getter === undefined) commitStanding(parent, u);
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
      const cb = cell._rel!;
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

// ── Propagators: cyclic regions by concrete equality-gated relaxation ─
//
// `constrain(reads, writes, body)` declares a PROPAGATOR: `body` reads its
// inputs and writes concrete values to its outputs. There is NO region object,
// condensation, lattice, or member overlay — relational cells stay plain
// values, read through the ordinary source path. The only state is a per-source
// list of "propagators that read me" (`readersOf`).
//
// Mechanism (push relaxation). Committing a CHANGED value into a source — the
// single `_writeSource` choke point shared by user writes, lens back-writes,
// and a propagator's own writes — SCHEDULES every propagator reading it. The
// schedule then DRAINS: each body runs, its writes route back through the value
// setter, and a write that actually changes a value reschedules ITS readers.
// The setter's equality test IS the fixpoint detector — the drain stops when no
// write changes anything — so a whole cyclic region relaxes as ONE unit in a
// single drain, and a divergent (over-constrained) region trips `RELAX_CAP`.
//
// `equal` is a two-way mirror; directional layout propagators (`beside`,
// `distance`, …) fall straight out; and lenses compose for free — writing a
// lens routes through `propagateBwd` to its source, whose commit reschedules,
// so a rule reading a lens is indexed under that lens's underlying source.
//
// Eagerness note: a write relaxes its region immediately (work is bounded by
// equality-gating, so only actually-changed propagators re-fire). On-read
// laziness (defer the drain until a region member is demanded) is a future
// refinement, not a correctness requirement.

// biome-ignore lint/suspicious/noExplicitAny: heterogeneous propagator graph
type AnyCell = Cell<any>;

/** A propagator body: read inputs, write outputs. `read(c)` is a cell's current
 *  settled value; `write(c, v)` routes through the value setter (a source
 *  commit, or a lens back-write), equality-gated. For a confluent region the
 *  drain order is irrelevant; a divergent one trips the cap. */
export type RelationBody = (
  read: (c: Cell<unknown>) => unknown,
  write: (c: Cell<unknown>, v: unknown) => void,
) => void;

interface Rule {
  readonly reads: readonly AnyCell[];
  readonly body: RelationBody;
  /** On the drain queue right now — the dedup guard. */
  queued: boolean;
}

/** Propagators that READ each SOURCE cell. A rule reading a lens/computed is
 *  indexed under the SOURCE(s) at the root of that read's parent chain: a source
 *  is the only node that commits (`_writeSource`) and reschedules, and a lens's
 *  value moves only when its source does. */
const readersOf = new WeakMap<AnyCell, Rule[]>();

function addReader(c: AnyCell, rule: Rule): void {
  if (c.getter === undefined) {
    let rs = readersOf.get(c);
    if (rs === undefined) readersOf.set(c, (rs = []));
    rs.push(rule);
    return;
  }
  for (const p of parentsOf(c)) addReader(p as AnyCell, rule);
}

function removeReader(c: AnyCell, rule: Rule): void {
  if (c.getter === undefined) {
    const rs = readersOf.get(c);
    if (rs === undefined) return;
    const i = rs.indexOf(rule);
    if (i >= 0) rs.splice(i, 1);
    if (rs.length === 0) readersOf.delete(c);
    return;
  }
  for (const p of parentsOf(c)) removeReader(p as AnyCell, rule);
}

/** Divergence guard: cap on total rule firings in one drain. A confluent region
 *  settles in O(rules · diameter) firings, far under this; only an
 *  over-constrained cycle with no fixpoint reaches it. */
const RELAX_CAP = 1_000_000;

const relaxQueue: Rule[] = [];
let relaxing = false;

/** Enqueue the propagators reading a just-committed source (from
 *  `_writeSource`). The drain runs once the outermost write unwinds. */
function scheduleReaders(c: AnyCell): void {
  const rs = readersOf.get(c);
  if (rs === undefined) return;
  for (const r of rs) {
    if (!r.queued) {
      r.queued = true;
      relaxQueue.push(r);
    }
  }
}

const relaxRead = (c: Cell<unknown>): unknown => c.peek();
const relaxWrite = (c: Cell<unknown>, v: unknown): void => {
  (c as { value: unknown }).value = v;
};

/** Drain scheduled propagators to a fixpoint. A rule's writes go through the
 *  setter, whose `_writeSource` enqueues further rules (we are `relaxing`, so it
 *  only enqueues — this loop picks them up), so the entire perturbed region
 *  settles in one pass. Runs untracked: a body's reads/writes never bind to the
 *  `activeSub` that triggered the originating write (e.g. an effect that sets a
 *  cell). */
function relax(): void {
  relaxing = true;
  const prev = activeSub;
  activeSub = undefined;
  let firings = 0;
  try {
    while (relaxQueue.length > 0) {
      if (++firings > RELAX_CAP) {
        throw new RangeError("propagator relaxation did not converge (over-constrained cycle?)");
      }
      const r = relaxQueue.shift()!;
      r.queued = false;
      r.body(relaxRead, relaxWrite);
    }
  } finally {
    relaxing = false;
    activeSub = prev;
    for (const r of relaxQueue) r.queued = false;
    relaxQueue.length = 0;
  }
}

/** Declare a propagator: `body` writes `writes` from `reads`. Indexes it under
 *  the sources its reads bottom out at, fires it once to seed (so the
 *  relationship holds immediately), and returns a disposer. `writes` is the
 *  declared output set — the bipartite edge — kept explicit so a relationship
 *  reads as `reads → writes`; it is not needed to schedule (a write reschedules
 *  via its own source commit). */
export function constrain(
  reads: readonly AnyCell[],
  _writes: readonly AnyCell[],
  body: RelationBody,
): () => void {
  const rule: Rule = { reads, body, queued: false };
  for (const r of reads) addReader(r, rule);
  rule.queued = true;
  relaxQueue.push(rule);
  if (!relaxing) relax();
  return () => {
    for (const r of reads) removeReader(r, rule);
  };
}
