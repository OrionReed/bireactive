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

  /** Owning SCC solver while this cell is a relation member, else `undefined`
   *  — presence IS the member discriminant. The cell keeps its INTRINSIC
   *  definition (a source's `undefined` getter, a lens's forward getter); a
   *  governed read projects `_region`'s solved slot instead, and `solve`
   *  recovers the seed from that same intrinsic definition (a source member's
   *  standing in its own `pendingValue`, a lens member's in its retained
   *  `_rel`). Nothing is stowed, so `relax` has nothing to restore. */
  _region: Component | undefined;

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
    this._region = undefined;
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
      if (!flushing && subs !== undefined) flush();
    }
  }

  _update(): boolean {
    const region = this._region;
    if (region !== undefined) {
      // Governed member: recompute its published value by pulling the solver
      // (tracked ⇒ `_region` becomes this member's sole dep) and reading its
      // solved slot. Same protocol as a computed, but a fixed body — the
      // intrinsic getter stays put (it's the seed and the `relax` target).
      this.depsTail = undefined;
      this.flags = F.Mutable | F.RecursedCheck;
      const prev = activeSub;
      activeSub = this;
      let threw = true;
      try {
        ++cycle;
        const old = this.currentValue;
        const next = (this.currentValue = region._project(this as Cell<unknown>) as T);
        threw = false;
        return !this._equals(old, next);
      } finally {
        activeSub = prev;
        this.flags = threw ? F.Mutable | F.Dirty : this.flags & ~F.RecursedCheck;
        purgeDeps(this);
      }
    }
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
    if (this._region !== undefined) {
      // Governed member: value is the component's solved projection, NOT the
      // intrinsic forward/standing. Same read protocol as a computed (validate,
      // `_update`, link), but `_update` projects the solver instead of running
      // the getter — which is left intact for the seed / `relax`.
      if (flags & F.RecursedCheck) {
        throw new RangeError(
          `Cyclic member: ${(this.constructor as { name?: string }).name ?? "?"} read its own value`,
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
      }
      if (activeSub !== undefined) link(this, activeSub, cycle);
      return this.currentValue;
    }
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

/** Commit a value into a SOURCE-shaped leaf (`getter === undefined`). A governed
 *  source member re-seeds its standing (`pendingValue`) and re-solves its region
 *  — there's no member→component dep edge to carry the write (that would cycle),
 *  so the invalidate IS the propagation. A plain source commits and forward-
 *  propagates. Both no-op on an unchanged value. The single leaf-write path,
 *  shared by the setter, the backward pass, and split/stateful forks. */
function commitStanding(target: Cell<unknown>, v: unknown): void {
  const region = target._region;
  if (region !== undefined) {
    if (target._equals(v, target.pendingValue)) return;
    target.pendingValue = v;
    region.invalidate();
    return;
  }
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
      // Leaf source-shaped parent. A PLAIN source takes the `settled` no-op stop
      // (reads a staged pending WITHOUT committing — net-zero revert safety); a
      // governed source member compares against its standing inside
      // `commitStanding` (its `pendingValue` IS the standing, not the projection
      // `settled`/`peek` would return).
      if (parent._region === undefined && parent._equals(push, settled(parent))) return;
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

// ── Component: a cyclic SCC as a first-class solver node ─────────────
//
// A cyclic strongly-connected component is solved by ONE `Component` — a
// computed node whose `_update` reads the component's inputs (each member's
// base assertion + any external cells) and folds the rules to a lattice
// fixpoint in the KNOWLEDGE space `K`, then publishes a concrete `T` per
// member into `solved`. Each member becomes a writable PROJECTION of the
// component: reading it pulls the solver (lazy, glitch-free, in dependency
// order — the ordinary computed path) and returns its slot; writing it flows
// to its base assertion, which the solver reads, so a write re-invalidates
// and the next read re-solves. Members only ever hold `T`; `K` never leaves
// the component, so the acyclic DAG sees plain concrete values.
//
// The whole mechanism is here (a real node + member projection), NOT poked
// into Cell internals from outside: the relate layer only constructs a
// `Component`, disposes it, and relaxes orphaned members. The partition
// (which cells form a component) and the rule registry live in `relate.ts`.

/** A relation rule, folded in knowledge space: `get(c)` yields a member's
 *  current `K` (or an external input lifted via its lattice), `emit(c, k)`
 *  meets `k` into a member. Order-independent (meet is confluent). */
export type RelationBody = (
  get: (c: Cell<unknown>) => unknown,
  emit: (c: Cell<unknown>, k: unknown) => void,
) => void;

/** A `RelationBody` paired with the cells it READS. The solver uses the reads
 *  to gate re-firing (semi-naive): a rule only re-runs when a member it reads
 *  has narrowed this solve. External reads are constant within a solve, so they
 *  never gate — a rule reading only externals fires exactly once. The contract
 *  is that `reads` covers every member the body pulls via `get`; under-declaring
 *  would miss a re-fire and could stop short of the fixpoint. */
export interface CompiledRule {
  readonly body: RelationBody;
  readonly reads: readonly Cell<unknown>[];
}

/** Waves of exact `meet` iteration before a solve starts WIDENING. Any
 *  finite-height lattice (flat, bitset, product of finite) reaches its
 *  fixpoint long before this, so widening never engages and the result is
 *  exact. Only a genuinely infinite descent (a real interval narrowing
 *  forever) crosses the threshold, at which point the lattice's `widen`
 *  guarantees a sound, finite stop. There is NO hard wave cap: termination
 *  is a property of the lattice (finite height, or a `widen`), not a magic
 *  number. */
const WIDEN_AFTER = 64;

const latticeOf = (c: Cell<unknown>): Lattice<unknown, unknown> | undefined =>
  (c.constructor as { lattice?: Lattice<unknown, unknown> }).lattice;

export class Component extends Cell<number> {
  readonly members: readonly Cell<unknown>[];
  private readonly lattices: readonly Lattice<unknown, unknown>[];
  private readonly rules: readonly CompiledRule[];
  /** Reverse freshness index: `readers[i]` lists the rule indices that READ
   *  member slot `i`. When a slot narrows, exactly these rules re-fire. Built
   *  once from each rule's declared reads (externals dropped — constant within a
   *  solve). */
  private readonly readers: readonly number[][];
  /** Per slot: true ⇒ a fully-DERIVED member (a lens whose parent is a fellow
   *  member). It carries no standing assertion — seed ⊤ and let its forward
   *  transformer determine it — and on publish falls back to `fallbacks[i]`
   *  (its frozen value) rather than re-evaluating its seed (which would re-enter
   *  the solve through the parent). A source/channel member is `false`: seed
   *  from its standing/upstream, fall back to that live value. */
  private readonly derived: readonly boolean[];
  /** Per slot: true ⇒ a FREE variable (declared via `free`). It carries no
   *  standing FACT — seed ⊤ so inequality/arithmetic contractors actually
   *  narrow it — but its seed value is the SOFT fallback on publish (its
   *  preferred value when underdetermined). The difference from `derived`: a
   *  derived member has a forward transformer and a frozen fallback; a free
   *  member has no fact and a live fallback. */
  private readonly free: readonly boolean[];
  private readonly fallbacks: readonly unknown[];
  private readonly index = new Map<Cell<unknown>, number>();
  /** Published concrete value per member slot; read by `_project` when a
   *  governed member recomputes. */
  readonly solved: unknown[];
  private version = 0;

  constructor(
    members: readonly Cell<unknown>[],
    lattices: readonly Lattice<unknown, unknown>[],
    rules: readonly CompiledRule[],
    derived: readonly boolean[],
    fallbacks: readonly unknown[],
    free: readonly boolean[],
  ) {
    super(0);
    this.members = members;
    this.lattices = lattices;
    this.rules = rules;
    this.derived = derived;
    this.fallbacks = fallbacks;
    this.free = free;
    // Seed each slot with the member's current value so `_project` reads a
    // well-formed `T` even before the first solve (and if this component is
    // disposed without ever solving) — never `undefined`.
    this.solved = members.map(m => m.currentValue);
    members.forEach((m, i) => this.index.set(m, i));
    const readers: number[][] = members.map(() => []);
    rules.forEach((rule, r) => {
      for (const c of rule.reads) {
        const i = this.index.get(c);
        if (i !== undefined) readers[i]!.push(r);
      }
    });
    this.readers = readers;
    this.getter = () => this.solve();
    this.flags = F.Mutable | F.Dirty;
    // Mark each member governed: an OVERLAY, not a rewrite. The cell keeps its
    // intrinsic definition (a source's `undefined` getter, a lens's forward +
    // `_rel`); only `_region` is set, redirecting reads to this component's
    // solved slot (`_project`, via the governed branch of the value getter /
    // `_update`). The component becomes the member's sole dep lazily on first
    // read; `solve` reads the intact getter straight back for the seed, so
    // nothing is stowed and `relax` has nothing to restore. Drop the member's
    // standalone upstream deps and notify existing subscribers (a topology edit
    // isn't a value write, so nothing else would).
    for (const m of members) {
      disposeAllDepsInReverse(m);
      m._region = this;
      m.flags = F.Mutable | F.Dirty;
      if (m.subs !== undefined) {
        propagate(m.subs, false);
        if (!flushing) flush();
      }
    }
  }

  /** Pull the fixpoint (glitch-free, in dependency order) and return `m`'s
   *  solved projection. The pull tracks against the calling member, making the
   *  component its sole dependency. Called only from a governed member's
   *  `_update`. */
  _project(m: Cell<unknown>): unknown {
    void this.value;
    return this.solved[this.index.get(m)!];
  }

  /** Re-solve trigger for a SOURCE member's standing write. The component reads
   *  standings as plain fields (untracked, so there's no member→component dep
   *  to cycle), so a standing write can't propagate through the dep graph on its
   *  own: this marks the component dirty and notifies its subscribers (members
   *  and watchers) directly (the dual of `_writeSource` for a node with no
   *  upstream dep). */
  invalidate(): void {
    if (this.flags & F.Dirty) return;
    this.flags = F.Mutable | F.Dirty;
    const subs = this.subs;
    if (subs !== undefined) {
      propagate(subs, runDepth > 0);
      if (!flushing) flush();
    }
  }

  /** Fold the component to a lattice fixpoint and publish per member. Runs as
   *  the node's getter (tracked), so every seed/external read becomes a dep —
   *  any of them changing re-invalidates the whole component.
   *
   *  Semi-naive, wave-based (mirrors `src/propagators/solver.ts`): the first
   *  wave fires every rule; each later wave fires only the rules that READ a
   *  slot which narrowed in the previous wave (`readers` reverse index). Firing
   *  in ascending rule index within a wave preserves the cascade order a
   *  full-sweep got "for free", so a chain/ring converges in a few waves rather
   *  than circulating; gating on freshness skips the rules that can't have
   *  changed. Meet is confluent, so the fixpoint is order-independent.
   *
   *  Allocation discipline: one `work` array per solve, an external snapshot
   *  cache (each outside cell lifted once), and two reused frontier buffers so
   *  there's no per-wave array churn. */
  private solve(): number {
    const { members, lattices, rules, readers, index, solved, derived, fallbacks, free } = this;
    const n = members.length;
    const R = rules.length;
    const work = new Array<unknown>(n);
    const fb = new Array<unknown>(n); // concretize fallback, captured at seed time
    const extCache = new Map<Cell<unknown>, unknown>();

    const get = (c: Cell<unknown>): unknown => {
      const i = index.get(c);
      if (i !== undefined) return work[i];
      if (extCache.has(c)) return extCache.get(c);
      const lat = latticeOf(c); // external input: lift via its own lattice
      // A lens chain can loop an external read back through a fellow member
      // that's mid-solve (the engine's own cyclic-read guard). That path
      // simply carries no usable knowledge here ⇒ contribute ⊤.
      let k: unknown;
      try {
        k = lat ? lat.abstract(c.value) : c.value;
      } catch (e) {
        if (!(e instanceof RangeError)) throw e;
        k = lat ? lat.top : undefined;
      }
      extCache.set(c, k);
      return k;
    };

    // Slots that narrowed during the current wave (deduped via `slotDirty`),
    // consumed afterwards to build the next wave's rule frontier.
    const slotDirty = new Uint8Array(n);
    const narrowed: number[] = [];
    let widening = false;
    const emit = (c: Cell<unknown>, k: unknown): void => {
      const i = index.get(c);
      if (i === undefined) return;
      const lat = lattices[i]!;
      const cur = work[i];
      // Monotone meet: combine contributions by greatest-lower-bound. A genuine
      // clash collapses to ⊥ and `concretize` then falls back (notes §7c).
      // Associative/commutative/idempotent ⇒ the fixpoint is order-independent.
      let next = lat.meet(cur, k);
      if (widening && lat.widen !== undefined) next = lat.widen(cur, next);
      if (!lat.equals(cur, next)) {
        work[i] = next;
        if (slotDirty[i] === 0) {
          slotDirty[i] = 1;
          narrowed.push(i);
        }
      }
    };

    // Seed: a DERIVED member carries no assertion (⊤; its forward transformer
    // fills it). A SOURCE member reads its standing straight off the cell
    // (`pendingValue`, untracked — the standing-write path re-invalidates us). A
    // LENS member re-evaluates its INTRINSIC forward getter (never overwritten,
    // tracked ⇒ the live upstream becomes a dep). That re-evaluation may loop
    // back through this very solve (a lens chain re-entering a member); if so,
    // seed ⊤ and keep the member's current value as fallback.
    for (let i = 0; i < n; i++) {
      const lat = lattices[i]!;
      if (derived[i]) {
        work[i] = lat.top;
        fb[i] = fallbacks[i];
        continue;
      }
      const m = members[i]!;
      try {
        // The forward getter (`singleGetter`/`multiGetter`/…) reads `this._rel`,
        // so it must run with `this === m` (the original receiver).
        const g = m.getter;
        const sv = g === undefined ? m.pendingValue : g.call(m);
        // Free variable: ⊤ seed (no fact, so contractors narrow it) but the
        // seed value is its SOFT fallback (still a re-solve dependency).
        work[i] = free[i] ? lat.top : lat.abstract(sv);
        fb[i] = sv;
      } catch (e) {
        if (!(e instanceof RangeError)) throw e;
        work[i] = lat.top;
        fb[i] = m.currentValue; // cached value, no re-entrant read
      }
    }

    // Wave 0 fires every rule; later waves only the readers of narrowed slots.
    // WIDEN_AFTER waves ≈ WIDEN_AFTER·R firings: only a genuinely infinite
    // descent reaches it; finite lattices drain far sooner.
    const widenAt = WIDEN_AFTER * (R || 1);
    let firings = 0;
    const ruleQueued = new Uint8Array(R);
    let frontier: number[] = Array.from({ length: R }, (_, r) => r);
    let next: number[] = [];
    while (frontier.length > 0) {
      narrowed.length = 0;
      for (let f = 0; f < frontier.length; f++) {
        if (++firings > widenAt) widening = true;
        rules[frontier[f]!]!.body(get, emit);
      }
      next.length = 0;
      for (let q = 0; q < narrowed.length; q++) {
        const slot = narrowed[q]!;
        slotDirty[slot] = 0;
        const rs = readers[slot]!;
        for (let j = 0; j < rs.length; j++) {
          const r = rs[j]!;
          if (ruleQueued[r] === 0) {
            ruleQueued[r] = 1;
            next.push(r);
          }
        }
      }
      for (let j = 0; j < next.length; j++) ruleQueued[next[j]!] = 0;
      const tmp = frontier;
      frontier = next;
      next = tmp;
    }
    for (let i = 0; i < n; i++) solved[i] = lattices[i]!.concretize(work[i], fb[i]);

    return ++this.version;
  }

  /** Retire the solver: unlink its inputs (no stale propagation, no leak).
   *  Members are separately re-attached or relaxed by the relate layer. */
  dispose(): void {
    disposeAllDepsInReverse(this);
    this.getter = undefined;
    this.flags = F.None;
  }
}

/** `m` left every relation: drop its component link and revert to standalone.
 *  Its intrinsic getter was never touched, so this is just clearing `_region`
 *  plus a Dirty recompute — a SOURCE member becomes a plain source again (its
 *  standing in `pendingValue` recommits as the live value), a LENS member a
 *  plain lens. The Dirty routes through `checkDirty` so the projection→standalone
 *  transition refires subscribers. No-op on a non-member. */
export function relax(m: Cell<unknown>): void {
  if (m._region === undefined) return;
  disposeAllDepsInReverse(m);
  m._region = undefined;
  m.flags = F.Mutable | F.Dirty;
  if (m.subs !== undefined) {
    propagate(m.subs, false);
    if (!flushing) flush();
  }
}
