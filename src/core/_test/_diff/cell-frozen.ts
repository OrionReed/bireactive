// cell.ts — symmetric bidirectional reactive engine.
//
// Forward propagation is alien-signals verbatim. Backward is the same lazy
// push-pull run on the transpose of the lens graph — no dynamic side tables,
// state on flags plus two static adjacencies (`_bwd.parent` down, `_lensSubs`
// up) that mirror forward's `deps`/`subs`. One traversal each direction:
//
//   role            forward (source → view)      backward (view → source)
//   down edge       subs (who reads me)          _bwd.parent (my parents)
//   up edge         deps (my deps)               _lensSubs (my lens-children)
//   push (mark)     propagate (down `subs`)      markDown (down `_bwd.parent`)
//   pull (resolve)  checkDirty (up `deps`)       resolveCone (up `_lensSubs`)
//   commit/compute  _update / getter             writeBack
//   "dirty" flag    F.Dirty (source staged)      BF.Dirty (view holds target)
//   "pending" flag  F.Pending (on the cone)      BF.Pending (on the back-path)
//
// Forward flags live on `flags`, backward on a separate `bflags` word, so the
// two never share a bit. A view write marks the back-path `BF.Pending` and wakes
// each source's forward cone; nothing runs until a read pulls (source-centric: a
// source resolves ALL its writers together and commits once). Reads pull only at
// clean entry points (getter top, source `_update`/`_writeSource`, effect
// `_run`), never mid-compute. Fan-in is the one non-dual piece: a `merge`
// accumulates N contributors and folds once, post-order, inside `resolveCone`.
//
// Mode table — a cell's role is fully determined by which fields are set:
//   source      getter undefined                 (truth in currentValue)
//   derived    getter, no _bwd                   (read-only derived)
//   lens 1→1    getter + _bwd{ put, parent: Cell }
//   multi-out   getter + _bwd{ put, parent: Cell[] }   (1→N / N→M bwd)
//   merge       getter + _bwd{ merge }            (N→1 backward fold)
//   stateful    getter + _bwd{ put, parent, stateful } (complement-carrying)
// Writable iff `_bwd !== undefined`. `pendingValue` is a source's staged write
// (and a view's armed back-target); a derived cell never uses it forward.

// Forward flag bits (alien-signals v2), on `flags`.
const F = {
  None: 0,
  Mutable: 1,
  Watching: 2,
  RecursedCheck: 4,
  Recursed: 8,
  Dirty: 16,
  Pending: 32,
} as const;

// Backward flag bits, on a Cell's own `bflags` word (the dual of `flags`).
const BF = {
  None: 0,
  /** Dual of `F.Dirty`: this view holds an unresolved back-target in `pendingValue`. */
  Dirty: 1,
  /** Dual of `F.Pending`: this node is on the back-path to its sources. */
  Pending: 2,
} as const;

/** Armed root OR on a back-path — i.e. a read must `backResolve` first. */
const BACK_MARKED = BF.Dirty | BF.Pending;

// Effect mode bits (on `Effect.mode`), so one watcher class serves both plain
// effects (`None`) and `network()` (which sets these).
const EM = {
  None: 0,
  /** Explicit topology: body reads don't auto-subscribe (no re-link / purge). */
  NoTrack: 1,
  /** Self-exclude the node's own writes (set `activeExcluded` during the body). */
  Exclude: 2,
  /** A wake forces a synchronous flush (eager solve), vs the microtask default. */
  Sync: 4,
  /** Don't auto-fire on a wake; only an explicit `flush()` advances the body. */
  Manual: 8,
} as const;

/** Multi-out / stateful back-write sentinel: "leave this parent untouched."
 *  Every non-`SKIP` slot is written verbatim, `undefined` included; a short array
 *  skips the trailing parents. (1→1 `put` always writes its one parent.) */
export const SKIP: unique symbol = Symbol("bireactive.SKIP");
export type Skip = typeof SKIP;

/** Per-parent back-write result: any prefix of the update tuple, each slot a value
 *  or `SKIP` (so `[a]` / `[a, SKIP]` / `[]` all type against `[A, B]`, while a bare
 *  `undefined` in a non-undefined slot stays an error). */
export type BackUpdates<T extends readonly unknown[]> = number extends T["length"]
  ? T
  : T extends readonly [infer H, ...infer R]
    ? readonly [] | readonly [H, ...BackUpdates<R>]
    : readonly [];

// Mode predicates — the single place a cell's role is read off its fields.
/** Source (truth leaf): no forward derivation. */
function isSource(c: Cell<unknown>): boolean {
  return c.getter === undefined;
}
/** Writable: carries a backward sidecar (lens / multi-out / merge / stateful / pin). */
function isWritable(c: Cell<unknown>): boolean {
  return c._bwd !== undefined;
}
/** Read-only derived: a `derive` with no backward path (back-walk throws on it). */
function isReadOnlyDerived(c: Cell<unknown>): boolean {
  return !isSource(c) && !isWritable(c);
}

/** Forward primal a source-reading `bwd` linearizes at, without a cascading
 *  recompute: live/last-settled value for a source or realized derived, else
 *  realize once via `.value` (PutGet holds for any source state). */
function backPrimal(c: Cell<unknown>): unknown {
  if (c.getter === undefined || c.flags & F.Dirty) return c.value;
  return c.currentValue;
}

/** Register `node` on each backward parent's `_lensSubs` (the edge `resolveCone`
 *  ascends), once, lazily on first back-write. Idempotent via `_linkedBack`. */
function linkBack(node: Cell<unknown>): void {
  if (node._linkedBack) return;
  node._linkedBack = true;
  const parent = node._bwd!.parent; // set for every mode except `pin` (parentless)
  if (parent === undefined) return;
  if (Array.isArray(parent))
    for (let i = 0; i < parent.length; i++) (parent[i]!._lensSubs ??= []).push(node);
  else (parent._lensSubs ??= []).push(node);
}

let cycle = 0;
let runDepth = 0;
let batchDepth = 0;
let notifyIndex = 0;
let queuedLength = 0;
let activeSub: ReactiveNode | undefined;
let flushing = false;
/** A microtask flush is queued. Effects run asynchronously (end of turn), so a
 *  burst of writes wakes each at most once; reads stay synchronous. */
let scheduled = false;
/** A `Sync` watcher (a `network`) is queued: a wake flushes the whole queue
 *  synchronously (eager solve), so a read right after the write sees post-solve
 *  state. Writes that wake plain effects alone defer to the microtask. */
let syncFlush = false;
/** The running self-excluding watcher (`Exclude`-mode `Effect`), passed as
 *  `propagate`'s `excluding` so its own writes don't re-trigger it. */
let activeExcluded: Effect | undefined;
const queued: (Effect | undefined)[] = [];
/** Re-entrancy guard: during a back-resolve a `put`'s source read commits
 *  normally but must NOT trigger a nested resolve. */
let draining = false;

// Pooled backward-traversal buffers (non-reentrant under `draining`, so reused
// across calls — no per-call allocation).
/** `backResolve` phase-1 source worklist (collect, then resolve in phase 2). */
const backSources: Cell<unknown>[] = [];
/** `backResolve` phase-1 dedup of the descent (diamonds visit each node once). */
const backVisited = new Set<Cell<unknown>>();

const EMPTY_DIRTY: ReadonlySet<Cell<unknown>> = new Set();

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

// Fires on every source value-change. Backward writes reach it via `_writeSource`.
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

function propagate(start: Link, innerWrite: boolean, excluding?: ReactiveNode): void {
  let l: Link | undefined = start;
  let next: Link | undefined = start.nextSub;
  let stack: Stack<Link | undefined> | undefined;
  top: do {
    const sub: ReactiveNode = l!.sub;
    // `excluding` skips one subscriber (a `network` not re-triggering itself).
    if (sub !== excluding) {
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
    else if (
      (flags & (F.Mutable | F.Dirty)) === (F.Mutable | F.Dirty) ||
      // A back-`Pending` source looks unchanged until `_update` resolves it
      // (pulls its views, runs the `put`s, stages it) and reports if it moved —
      // like a `Dirty` source. That resolve can re-mark nodes on this pull's
      // stack; the unwind below honors any such `F.Dirty`.
      (flags & F.Mutable &&
        (dep as Cell<unknown>).bflags & BF.Pending &&
        isSource(dep as Cell<unknown>))
    ) {
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
      // `dirty` tracks change down this branch, but a node may have been marked
      // `F.Dirty` independently (a stateful stash `writeBack` mid-pull) — honor
      // that too, else we'd clear its `F.Pending` without recomputing.
      if (dirty || sub.flags & F.Dirty) {
        const subs = sub.subs!;
        if (sub._update()) {
          if (subs.nextSub !== undefined) shallowPropagate(subs);
          dirty = true;
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

// MergeNode — backward fan-in (N→1), the one non-dual ingredient: where forward
// broadcasts one source to N subscribers, backward accumulates N contributors
// into one value. Contributors resolve first (each cascades a `put` into
// `contributions`), then the merge folds once on the post-order ascent in
// `resolveCone` and writes to `parent`. `contributions` is the one merge-owned
// buffer, reused in place (cleared on fold, and on entry to self-heal a throw).
export type MergeFold<T> = (values: readonly T[]) => T;

class MergeNode<T> {
  readonly foldFn: MergeFold<T> | undefined;
  /** Contributions gathered as the cone resolves; folded and cleared in `foldMerge`. */
  contributions: T[] = [];

  constructor(fold: MergeFold<T> | undefined) {
    this.foldFn = fold;
  }
}

// BwdSpec — the backward sidecar, off a single `_bwd` pointer so a source/computed
// stays lean. Only a writable derived cell (lens / multi-out / merge / stateful /
// pin) carries one; writable iff `_bwd !== undefined`. `merge` and `stateful` are
// rare named payloads, so a plain lens leaves them `undefined`.
class BwdSpec {
  /** Backward target(s): one `Cell` (1→1 / merge) or `Cell[]` (multi-out). */
  parent: Cell<unknown> | Cell<unknown>[] | undefined = undefined;
  /** Lens `put` (dual of `getter`): `put(target)` for 1→1 / multi-out (a
   *  source-reading lens reads its parents at walk time), `put(target, sources, c)`
   *  for stateful. */
  // biome-ignore lint/suspicious/noExplicitAny: put fn is opaque shape
  put: ((target: any, current?: any) => any) | undefined = undefined;
  /** Presence IS the merge-mode discriminant. */
  merge: MergeNode<unknown> | undefined = undefined;
  /** Presence IS the stateful-mode discriminant. */
  stateful: StatefulCore | undefined = undefined;
}

/** Runtime state of a stateful (complement-carrying) lens, kept off `BwdSpec` so
 *  plain lenses don't carry its slots. */
class StatefulCore {
  /** Engine-owned memory the view discards. */
  complement: unknown;
  /** Advance the complement: `step(sources, complement, external)`. */
  // biome-ignore lint/suspicious/noExplicitAny: opaque step shape
  step: (sources: any, complement: any, external: boolean) => any;
  /** Sources last committed back (own-vs-external test); `undefined` until first
   *  back-write, then the committed candidate built in place. */
  last: unknown[] | undefined = undefined;
  constructor(
    complement: unknown,
    // biome-ignore lint/suspicious/noExplicitAny: opaque step shape
    step: (sources: any, complement: any, external: boolean) => any,
  ) {
    this.complement = complement;
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

export interface CellOptions<T = unknown> {
  /** First subscriber attached; fired from `link`. */
  watched?: () => void;
  /** Last subscriber detached; fired from `_unwatched`. */
  unwatched?: () => void;
  /** Per-instance value equality; defaults to `Object.is`. */
  equals?: (a: T, b: T) => boolean;
}

export class Cell<T = unknown> implements ReactiveNode {
  /** @internal */
  flags: number;
  /** @internal */
  subs: Link | undefined;
  /** @internal */
  subsTail: Link | undefined;
  /** @internal */
  deps: Link | undefined;
  /** @internal */
  depsTail: Link | undefined;

  /** @internal Forward derivation (computed/lens/merge). `undefined` ⇒ source. */
  getter: (() => T) | undefined;

  /** @internal Per-instance equality; always defined (defaults to `Object.is`). */
  _equals: (a: T, b: T) => boolean;
  /** @internal First-subscriber / last-subscriber lifecycle hooks. */
  _watched: (() => void) | undefined;
  /** @internal */
  _unwatchedHook: (() => void) | undefined;

  /** @internal Source: committed value + staged write. */
  currentValue: T;
  /** @internal */
  pendingValue: T;

  /** @internal Backward sidecar; `undefined` iff read-only. Writability is `_bwd !== undefined`. */
  _bwd: BwdSpec | undefined;

  /** @internal Backward dual of `subs`: direct lens-children for back-write cone traversal. */
  _lensSubs: Cell<unknown>[] | undefined;

  /** @internal Backward flag word (`BF`), dual of forward `flags`. */
  bflags: number;

  /** @internal Guards against `linkBack` re-registering a duplicate in `_lensSubs`. */
  _linkedBack: boolean;

  // Every slot assigned once, in declaration order, for a stable V8 hidden class.
  constructor(initial: T, opts?: CellOptions<T>) {
    this.flags = F.Mutable;
    this.subs = undefined;
    this.subsTail = undefined;
    this.deps = undefined;
    this.depsTail = undefined;
    this.getter = undefined;
    this._equals = Object.is;
    this._watched = undefined;
    this._unwatchedHook = undefined;
    this.currentValue = initial;
    this.pendingValue = initial;
    this._bwd = undefined;
    this._lensSubs = undefined;
    this.bflags = BF.None;
    this._linkedBack = false;
    if (opts !== undefined) {
      if (opts.equals !== undefined) this._equals = opts.equals;
      if (opts.watched !== undefined) this._watched = opts.watched;
      if (opts.unwatched !== undefined) this._unwatchedHook = opts.unwatched;
    }
  }

  // Installed on the prototype after the class body (V8 JITs a prototype accessor
  // better). `readonly` so a bare cell is read-only at the type level; writability
  // returns via `Writable<R>`. The runtime accessor is settable regardless.
  declare readonly value: T;

  /** @internal Single write-commit point; self-excludes the active network. */
  _writeSource(next: T): void {
    // Resolve any pending back-write first, so the later forward write wins (LWW).
    if (this.bflags & BF.Pending && !draining) backResolve(this as Cell<unknown>);
    const prev = this.pendingValue;
    this.pendingValue = next;
    if (!this._equals(prev, next)) {
      this.flags = F.Mutable | F.Dirty;
      if (writeHook !== undefined) writeHook(this as Cell<unknown>);
      const subs = this.subs;
      if (subs !== undefined) {
        // Convert the cone's arm-time `Pending` into `Dirty` so a second observer
        // (not just the first reader) sees the change. If this lands mid-pull, the
        // freshly-`Dirty` nodes are honored by `checkDirty`'s unwind.
        propagate(subs, runDepth > 0, activeExcluded);
        autoFlush();
      }
    }
  }

  /** @internal */
  _update(): boolean {
    if (this.getter !== undefined) {
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
    // A back-`Pending` source resolves its armed back-write first, so
    // `pendingValue` reflects it before we commit.
    if (this.bflags & BF.Pending && !draining) backResolve(this as Cell<unknown>);
    this.flags = F.Mutable;
    const prevV = this.currentValue;
    this.currentValue = this.pendingValue;
    return !this._equals(prevV, this.currentValue);
  }

  /** @internal */
  _notify(): void {}

  /** @internal */
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

  // Construction helpers build via `new this()` so a subclass static
  // (`Vec.lens(...)`) yields a `Vec` with its constructor-set equality.

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

  /** Backward fan-in: forward the identity view of its parent, backward the point
   *  where N contributors fold into one value. `fold` defaults to last-writer-wins. */
  merge(this: Cell<T>, fold?: MergeFold<T>): Cell<T> {
    if (this.getter !== undefined && this._bwd === undefined) {
      throw new TypeError("merge: receiver is read-only");
    }
    const parent = this as Cell<T>;
    const cell = new (this.constructor as CellCtor<Cell<T>>)();
    cell.flags = F.Mutable | F.Dirty;
    cell.getter = (): T => parent.value;
    const b = (cell._bwd = new BwdSpec());
    b.parent = parent as Cell<unknown>;
    b.merge = new MergeNode<T>(fold) as MergeNode<unknown>;
    return cell as Cell<T>;
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
    ) => BackUpdates<{ [K in keyof P]: (P[K] extends Read<infer V> ? V : never) | Skip }>,
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

  /** Coerce `Val<Inner<Cls>>` → `Cls`: instance → identity, RO cell →
   *  tracked `derive`, literal → fresh seed. */
  // biome-ignore lint/suspicious/noExplicitAny: variance escape
  static coerce<C extends new (...args: never[]) => Cell<any>>(
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
    // Parentless `_bwd`: `writeBack` absorbs at `parent === undefined`, no closure.
    cell._bwd = new BwdSpec();
    return cell as unknown as Writable<InstanceType<C>>;
  }
}

/** Typed field lens onto `parent.value[key]`. RO parent → RO derive;
 *  writable parent → bidirectional lens with spread-replace `put`. */
// biome-ignore lint/suspicious/noExplicitAny: variance escape
export function fieldOf<C extends new (...args: never[]) => Cell<any>>(
  // biome-ignore lint/suspicious/noExplicitAny: parent is contravariant on put
  parent: Cell<any>,
  key: string | number | symbol,
  Cls: C,
): InstanceType<C> {
  const ctor = Cls as unknown as CellCtor<Cell<unknown>>;
  const get = (s: unknown): unknown => (s as Record<string | number | symbol, unknown>)[key];
  const ro = parent.getter !== undefined && parent._bwd === undefined;
  if (ro) {
    return buildDerived(ctor, () => get(parent.value)) as InstanceType<C>;
  }
  return buildLens1(
    ctor,
    parent as Cell<unknown>,
    get,
    (v, s) => ({ ...(s as object), [key]: v }),
    true,
  ) as InstanceType<C>;
}

// Each `new Cls()` yields the right subclass, then sets the mode fields.

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
  // Source-reading lenses linearize at the parent's primal (`backPrimal`), so the
  // engine always calls the 1-arg form and never recomputes the parent's cone.
  b.put = readsSource ? (t: unknown): unknown => bwd(t, backPrimal(parent)) : bwd;
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
  if (readsSource) {
    // Own reused buffer (not the getter's `vals`) to avoid aliasing; `bwd`
    // consumes it synchronously and must not retain it.
    const args = new Array<unknown>(n);
    b.put = (target: unknown): unknown => {
      for (let i = 0; i < n; i++) args[i] = backPrimal(parents[i]!);
      return bwd(target, args);
    };
  } else {
    b.put = (target: unknown): unknown => bwd(target);
  }
  return cell;
}

// Stateful lens (complement-carrying) — a lens that carries memory the source
// can't hold (a `lowercase` view's casing, a principal-axis angle's winding):
//   init(srcs)              → seed the complement
//   fwd(srcs, c)            → the view
//   step(srcs, c, external) → advance the complement (`external` = outside change)
//   bwd(target, srcs, c)    → { updates, complement } (per-parent + new complement)
// All four are pure and read no cells; the engine owns `c`, stepping it to the
// current sources before `bwd` so `bwd` sees an up-to-date complement.

export interface StatefulBwd<S extends readonly unknown[], C> {
  /** Per-parent updates: a value (written verbatim, `undefined` included) or
   *  `SKIP` to leave that parent. A short array skips the trailing parents. */
  updates: BackUpdates<{ [K in keyof S]: S[K] | Skip }>;
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
  const sc = (b.stateful = new StatefulCore(spec.init(seed), spec.step));
  const fwd = spec.fwd as (s: unknown, c: unknown) => unknown;
  b.put = spec.bwd as (t: unknown, c?: unknown) => unknown;
  b.parent = parents;
  cell.getter = (() => {
    for (let i = 0; i < n; i++) vals[i] = parents[i]!.value;
    // External unless the live sources still equal this lens's own last back-write.
    let external = true;
    const lb = sc.last;
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
    return fwd(vals, sc.complement);
  }) as () => never;
  return cell;
}

// Single-source stateful lens: the `buildLens1` of the complement path, with
// direct index-0 access. The spec stays array-shaped, so `b.parent` stays an
// array for the shared split backward path.
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
  const sc = (b.stateful = new StatefulCore(spec.init([parent.peek()]), spec.step));
  const fwd = spec.fwd as (s: unknown, c: unknown) => unknown;
  b.put = spec.bwd as (t: unknown, c?: unknown) => unknown;
  b.parent = [parent];
  const vals: unknown[] = [undefined];
  cell.getter = (() => {
    const v = (vals[0] = parent.value);
    const lb = sc.last;
    const external = lb === undefined || lb[0] !== v;
    sc.complement = sc.step(vals, sc.complement, external);
    return fwd(vals, sc.complement);
  }) as () => never;
  return cell;
}

// Shared runtime dispatch for `derive`/`lens` — statics pass the typed subclass,
// free functions pass plain `Cell`, so the two forms can't drift.
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

// Installed on the prototype (not a class accessor): V8 JITs it better and keeps
// the field-only class shape for a stable hidden class.
Object.defineProperty(Cell.prototype, "value", {
  get(this: Cell<unknown>): unknown {
    // Reading is the PULL: a back-marked cell resolves here, before its own
    // compute, so a source-reading `put` never re-enters a half-computed cell.
    if (this.bflags & BACK_MARKED && !draining) backResolve(this);
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
      }
      if (activeSub !== undefined) link(this, activeSub, cycle);
      return this.currentValue;
    }
    // Source path.
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
    const b = this._bwd;
    if (b === undefined) {
      throw new TypeError("Cannot write to a computed");
    }
    // GetPut for a multi-parent split: absorb a write equal to the current view
    // (its `put` could redistribute sources past per-source equality). Stateful
    // excluded — peeking would step its complement.
    if (Array.isArray(b.parent) && b.stateful === undefined && this._equals(next, this.peek())) {
      return;
    }
    arm(this as Cell<unknown>, next);
  },
  enumerable: false,
  configurable: false,
});

/** Backward push: arm a back-write of `target` on view `node` (dual of a source
 *  `set`). A re-write of a still-armed view keeps only the last target (the path
 *  is already marked); `autoFlush` wakes the effects the push woke. */
function arm(node: Cell<unknown>, target: unknown): void {
  if (!(node.bflags & BF.Dirty)) {
    markDown(node); // flag path + wake cones FIRST (a throw arms nothing)
    node.bflags |= BF.Dirty;
  }
  node.pendingValue = target;
  autoFlush();
}

/** MARK (push), dual of `propagate`: descend `start`'s static back-path down
 *  `_bwd.parent` to its sources, flag each `BF.Pending`, register the reverse edge
 *  (`linkBack`), and wake every source's forward cone. Runs no `put`.
 *
 *  `BF.Pending` self-dedups: an already-marked node has its subtree marked, so
 *  descent stops (diamonds cost one visit). A sole read-only-derived parent has
 *  nowhere to land → throw. The 1→1 spine allocates nothing. */
function markDown(start: Cell<unknown>): void {
  let node: Cell<unknown> = start;
  let stack: Cell<unknown>[] | undefined;
  for (;;) {
    let next: Cell<unknown> | undefined;
    if (isSource(node)) {
      // Leaf (dual of a `Dirty` source): wake its cone ONCE.
      if (!(node.bflags & BF.Pending)) {
        node.bflags |= BF.Pending;
        const subs = node.subs;
        if (subs !== undefined) propagate(subs, runDepth > 0, activeExcluded);
      }
    } else if (node === start || !(node.bflags & BF.Pending)) {
      // On the back-path. An already-marked intermediate (≠ start) has its
      // subtree marked — stop (diamond dedup).
      if (node !== start) node.bflags |= BF.Pending;
      linkBack(node);
      // `b.parent` is the back-target for every mode, so one descent covers all.
      const parent = node._bwd!.parent;
      if (parent !== undefined) {
        if (Array.isArray(parent)) {
          const multi = parent.length > 1;
          for (let i = 0; i < parent.length; i++) {
            const p = parent[i]!;
            if (isReadOnlyDerived(p)) {
              // A split routes around it; a sole parent can't.
              if (!multi) throw new TypeError("Cannot write through to a computed");
            } else if (next === undefined) next = p;
            else (stack ??= []).push(p);
          }
        } else if (isReadOnlyDerived(parent)) {
          throw new TypeError("Cannot write through to a computed");
        } else {
          next = parent;
        }
      }
    }
    if (next !== undefined) {
      node = next;
    } else if (stack !== undefined && stack.length > 0) {
      node = stack.pop()!;
    } else {
      return;
    }
  }
}

/** RESOLVE (pull), dual of `checkDirty`: resolve one node's whole back-cone.
 *  Ascend `_lensSubs` (only `BACK_MARKED` children) to the armed views,
 *  `writeBack`ing each. Source-centric — a source reflects all its writers, so a
 *  call on it resolves every co-writer together and commits once.
 *
 *  Post-order: drive own armed target first (last-writer-wins among co-writers),
 *  recurse children, clear `BF.Pending`, then fold a merge once its contributors
 *  have cascaded in. Recursion depth is the (small) lens-nesting depth. Idempotent,
 *  so phase-2 can call it unconditionally. */
function resolveCone(node: Cell<unknown>): void {
  const b = node._bwd;
  const merge = b !== undefined ? b.merge : undefined;
  if (merge !== undefined) merge.contributions.length = 0;
  if (node.bflags & BF.Dirty) {
    node.bflags &= ~BF.Dirty;
    writeBack(node, node.pendingValue);
  }
  const children = node._lensSubs;
  if (children !== undefined) {
    for (let i = 0; i < children.length; i++) {
      const c = children[i]!;
      if (c.bflags & BACK_MARKED) resolveCone(c);
    }
  }
  node.bflags &= ~BF.Pending;
  if (merge !== undefined) foldMerge(b!.parent as Cell<unknown>, merge);
}

/** PULL entry for a back-marked `start`. A source resolves its own cone; a view
 *  first descends its marked back-path to the sources, then resolves each. The
 *  `draining` guard stops a `put`'s source read from re-entering.
 *
 *  Two-phase: phase 1 collects the distinct sources (clearing nothing), phase 2
 *  `resolveCone`s each. Capturing the full source set before any `writeBack` runs
 *  means a sibling commit can't drop a co-writer's source from the worklist.
 *  `backVisited` dedups the descent. */
function backResolve(start: Cell<unknown>): void {
  draining = true;
  ++batchDepth;
  const prev = activeSub;
  activeSub = undefined;
  const sourcesBase = backSources.length;
  try {
    if (isSource(start)) {
      resolveCone(start);
      return;
    }
    // Phase 1 (collect): descend the `BF.Pending` cone, gathering distinct
    // sources. `reached` = a source was found (else `start` is a `pin` sink).
    let node: Cell<unknown> = start;
    let stack: Cell<unknown>[] | undefined;
    let reached = false;
    for (;;) {
      let next: Cell<unknown> | undefined;
      const b = node._bwd;
      const parent = b !== undefined ? b.parent : undefined; // merge's parent IS b.parent
      if (parent !== undefined) {
        if (Array.isArray(parent)) {
          for (let i = 0; i < parent.length; i++) {
            const p = parent[i]!;
            if (!(p.bflags & BF.Pending) || backVisited.has(p)) continue;
            backVisited.add(p);
            if (isSource(p)) {
              reached = true;
              backSources.push(p);
            } else if (next === undefined) next = p;
            else (stack ??= []).push(p);
          }
        } else if (parent.bflags & BF.Pending && !backVisited.has(parent)) {
          backVisited.add(parent);
          if (isSource(parent)) {
            reached = true;
            backSources.push(parent);
          } else next = parent;
        }
      }
      if (next !== undefined) node = next;
      else if (stack !== undefined && stack.length > 0) node = stack.pop()!;
      else break;
    }
    // Phase 2 (resolve): each collected source's whole cone, once.
    for (let i = sourcesBase; i < backSources.length; i++) resolveCone(backSources[i]!);
    if (!reached && start.bflags & BF.Dirty) {
      start.bflags &= ~BF.Dirty;
      writeBack(start, start.pendingValue);
    }
  } finally {
    backSources.length = sourcesBase;
    backVisited.clear();
    activeSub = prev;
    --batchDepth;
    draining = false;
  }
}

/** Resolve any back-write a woken node reads directly. `checkDirty` catches
 *  back-writes that move a source, but a stateful stash moves only the VIEW (no
 *  source changes) — invisible to a source-based check, so resolve this node's
 *  back-marked deps here. A forward-only wake walks no cone and pays nothing. */
function resolveBackDeps(node: ReactiveNode): void {
  for (let l = node.deps; l !== undefined; l = l.nextDep) {
    const d = l.dep as Cell<unknown>;
    if (d.bflags & BACK_MARKED && !draining) backResolve(d);
  }
}

/** Backward commit/compute (dual of `_update`): drive a back-write of `target`
 *  toward the sources, applying each lens's `put` and staging each source as it's
 *  reached (so a later sibling composes rather than clobbers). A `SKIP` slot prunes
 *  a branch; every other slot is written verbatim, `undefined` included. */
function writeBack(node: Cell<unknown>, target: unknown): void {
  if (isSource(node)) {
    node._writeSource(target); // staged now, visible to later siblings
    // Clear this source's `BF.Pending`, then re-assert iff a lens-child is STILL
    // armed (an overlapping co-writer) — else that write is lost, and leaving it
    // set unconditionally would strand `BF.Pending` on every fan-in source.
    node.bflags &= ~BF.Pending;
    const subs = node._lensSubs;
    if (subs !== undefined) {
      for (let i = 0; i < subs.length; i++)
        if (subs[i]!.bflags & BACK_MARKED) {
          node.bflags |= BF.Pending;
          break;
        }
    }
    return;
  }
  node.bflags &= ~BF.Pending; // passing through clears the path marker
  const b = node._bwd;
  if (b === undefined) throw new TypeError("Cannot write through to a computed");
  if (b.merge !== undefined) {
    b.merge.contributions.push(target); // gathered here; `resolveCone` folds post-order
    return;
  }
  const parent = b.parent;
  if (parent === undefined) return; // pin sink: absorb
  if (Array.isArray(parent)) {
    const n = parent.length;
    let out: ReadonlyArray<unknown>;
    const sc = b.stateful;
    if (sc !== undefined) {
      const vals = new Array<unknown>(n);
      for (let i = 0; i < n; i++) vals[i] = parent[i]!.value;
      // Step the complement to the current sources before `bwd` (so it measures
      // from a prior sibling write, not a stale snapshot). External unless the
      // sources still equal this lens's own last back-write.
      const last = sc.last;
      let external = last === undefined;
      if (last !== undefined) {
        for (let i = 0; i < n; i++)
          if (vals[i] !== last[i]) {
            external = true;
            break;
          }
      }
      sc.complement = sc.step(vals, sc.complement, external);
      const res = (
        b.put as (t: unknown, s: unknown, c: unknown) => StatefulBwd<unknown[], unknown>
      )(target, vals, sc.complement);
      const upd = res.updates as ReadonlyArray<unknown>;
      // Build the committed candidate in `vals` and keep it as `last`. A `SKIP`
      // or short-`upd` slot leaves that parent at its current `vals[i]`.
      const um = upd.length < n ? upd.length : n;
      for (let i = 0; i < um; i++) if (upd[i] !== SKIP) vals[i] = upd[i];
      sc.complement = sc.step(vals, res.complement, false);
      sc.last = vals;
      out = upd;
    } else {
      out = (b.put as (t: unknown) => ReadonlyArray<unknown>)(target);
    }
    // A short `out` skips the trailing parents; `SKIP` skips a slot
    let wrote = false;
    const m = out.length < n ? out.length : n;
    for (let i = 0; i < m; i++) {
      const u = out[i];
      if (u !== SKIP) {
        wrote = true;
        writeBack(parent[i]!, u);
      }
    }
    // A stateful lens can change its VIEW through the complement alone, moving no
    // source (a "stash"). The forward cone never fires, so invalidate this node's
    // cache and propagate to its observers here.
    if (!wrote && sc !== undefined) {
      node.flags |= F.Dirty;
      const subs = node.subs;
      if (subs !== undefined) propagate(subs, runDepth > 0, activeExcluded);
    }
    return;
  }
  // 1→1 lens.
  writeBack(parent, (b.put as (t: unknown) => unknown)(target));
}

/** Fold a merge's contributions once (policy; default last-writer-wins) and write
 *  the result up to its parent. Called post-order from `resolveCone`. */
function foldMerge(parent: Cell<unknown>, mn: MergeNode<unknown>): void {
  const vals = mn.contributions;
  const fold = mn.foldFn;
  let folded: unknown;
  if (fold !== undefined) folded = fold(vals);
  else if (vals.length > 0) folded = vals[vals.length - 1];
  else return; // last-writer-wins with no contributor: leave the parent
  vals.length = 0; // reuse the merge-owned buffer in place (fold must not retain it)
  writeBack(parent, folded);
}

/** Writable source; passes an existing `Writable` through (idempotent). */
export function cell<T>(initial: T | Writable<Cell<T>>, opts?: CellOptions<T>): Writable<Cell<T>> {
  if (initial instanceof Cell) return initial as Writable<Cell<T>>;
  return new Cell(initial as T, opts) as Writable<Cell<T>>;
}

// Bare (untyped) factories: plain `Cell`, inferring `R` from the closures.
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
  ) => { [K in keyof P]: (P[K] extends Read<infer V> ? V : never) | Skip },
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

// Effect — one watcher class for both auto-tracked effects and explicit-topology
// networks: alien-signals' effect plus the `EM` mode toggles `network()` needs.
class Effect implements ReactiveNode {
  flags: number = F.Watching | F.RecursedCheck;
  subs: Link | undefined = undefined;
  subsTail: Link | undefined = undefined;
  deps: Link | undefined = undefined;
  depsTail: Link | undefined = undefined;
  fn: () => (() => void) | void;
  cleanup: (() => void) | undefined = undefined;
  /** Watcher-behavior bits (`EM`); `EM.None` for a plain effect. */
  mode: number;

  constructor(fn: () => (() => void) | void, mode: number = EM.None) {
    this.fn = fn;
    this.mode = mode;
  }

  _update(): boolean {
    this.flags = F.Mutable;
    return true;
  }

  _notify(): void {
    const mode = this.mode;
    if (mode & EM.Manual) {
      this.flags |= F.Watching; // re-arm but don't queue; only `flush()` advances
      return;
    }
    if (mode & EM.Sync) {
      // Eager watcher (network): append + force a synchronous flush.
      queued[queuedLength++] = this;
      syncFlush = true;
      this.flags &= ~F.Watching;
      return;
    }
    // Plain effect: batch-insert this effect and any subscribed to it, in
    // dependency order (alien-signals).
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
    // Resolve back-writes this node reads directly (incl. view-only stashes);
    // `checkDirty` resolves any back-`Pending` source reached deeper.
    if (this.deps !== undefined) resolveBackDeps(this);
    const flags = this.flags;
    if (flags & F.Dirty || (flags & F.Pending && checkDirty(this.deps!, this))) {
      if (this.cleanup) {
        this._runCleanup();
        if (!this.flags) return;
      }
      this._invoke();
    } else if (this.deps !== undefined) {
      this.flags = F.Watching;
    }
  }

  /** Run the body — the single path for first fire, scheduled re-run, and manual
   *  `flush()`. Auto-tracks deps unless `NoTrack`; self-excludes writes under `Exclude`. */
  _invoke(): void {
    const noTrack = this.mode & EM.NoTrack;
    if (!noTrack) this.depsTail = undefined;
    this.flags = F.Watching | F.RecursedCheck;
    const prevSub = activeSub;
    const prevExc = activeExcluded;
    activeSub = noTrack ? undefined : this;
    if (this.mode & EM.Exclude) activeExcluded = this;
    try {
      ++cycle;
      ++runDepth;
      const ret = this.fn();
      this.cleanup = typeof ret === "function" ? ret : undefined;
    } finally {
      --runDepth;
      activeSub = prevSub;
      activeExcluded = prevExc;
      this.flags &= ~F.RecursedCheck;
      if (!noTrack) purgeDeps(this);
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
  e._invoke();
  return () => e._unwatched();
}

/** Run effects woken by a write. Backward work is pulled lazily per read, so
 *  flush owns no backward bookkeeping — just the effect queue. */
function flush(): void {
  if (flushing) return;
  flushing = true;
  try {
    while (notifyIndex < queuedLength) {
      const e = queued[notifyIndex]!;
      queued[notifyIndex++] = undefined;
      e._run();
    }
  } finally {
    notifyIndex = 0;
    queuedLength = 0;
    syncFlush = false;
    flushing = false;
  }
}

/** Queue an effect flush for the end of the current microtask turn (idempotent).
 *  A write wakes effects asynchronously; many writes in one turn coalesce. */
function schedule(): void {
  if (scheduled) return;
  scheduled = true;
  queueMicrotask(() => {
    scheduled = false;
    flush();
  });
}

/** Resolve the queue after a write: no-op inside a `batch`/flush (the barrier
 *  owns flushing), else synchronously if a `Sync` watcher is waiting (eager
 *  solve) or deferred to the microtask (coalesced effects). */
function autoFlush(): void {
  if (batchDepth !== 0 || flushing) return;
  if (syncFlush) flush();
  else schedule();
}

/** Run all pending effects now, synchronously — the escape hatch for code that
 *  must observe effect side-effects before yielding. Reads never need it. */
export function settle(): void {
  flush();
}

/** Group writes and flush effects synchronously at the end of `fn`. Effects
 *  coalesce on the microtask turn anyway; reach for `batch` only to run the woken
 *  effects before the call returns. */
export function batch<R>(fn: () => R): R {
  ++batchDepth;
  try {
    return fn();
  } finally {
    if (!--batchDepth) flush();
  }
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

// network() — reactive sub-DAG with explicit topology and self-excluded writes
// (an `Effect` in `NoTrack | Exclude` mode), the building block for constraint
// networks. Its body fires when any subscribed dep changes; its own writes
// self-exclude so it doesn't re-trigger itself.

/** Handle to a `network` invocation. */
export interface Network {
  /** Tear down: unsubscribe from every cell, drop internal state. */
  dispose(): void;
  /** Run the body now (manual mode's only advance; no-op if unchanged). */
  flush(): void;
  /** Add cells to the topology (idempotent; does NOT fire the body). */
  // biome-ignore lint/suspicious/noExplicitAny: deps come in many flavours
  subscribe(...cells: Cell<any>[]): void;
  /** Remove cells from the topology (idempotent; does NOT fire). */
  // biome-ignore lint/suspicious/noExplicitAny: deps come in many flavours
  unsubscribe(...cells: Cell<any>[]): void;
}

type NetworkBody = (dirty: ReadonlySet<Cell<unknown>>, handle: Network) => void;

/** Build a reactive sub-DAG. The body fires when any subscribed dep changes
 *  (`dirty` = the changed subset), self-excludes its own writes, and (auto mode)
 *  resolves synchronously. `manual: true` defers firing so only `flush()` advances;
 *  `flush()` from inside the body throws. Network-specific state (last-values,
 *  handle) lives in this closure, so the shared `Effect` carries none of it. */
export function network(
  // biome-ignore lint/suspicious/noExplicitAny: deps come in many flavours
  deps: readonly Cell<any>[],
  body: NetworkBody,
  opts?: { manual?: boolean },
): Network {
  const lastValues = new Map<Cell<unknown>, unknown>();
  const depsSet = new Set<Cell<unknown>>();
  let ownCycle = 0;
  let disposed = false;
  // Forward-declared so the closures below can reach the node; assigned before
  // any runs (the first `_invoke` happens after construction).
  let node!: Effect;

  const computeDirty = (): ReadonlySet<Cell<unknown>> => {
    let dirty: Set<Cell<unknown>> | undefined;
    for (const [c, last] of lastValues) {
      if (c.peek() !== last) (dirty ??= new Set()).add(c);
    }
    return dirty ?? EMPTY_DIRTY;
  };

  const linkDeps = (cells: readonly Cell<unknown>[]): void => {
    let tail = node.deps;
    if (tail !== undefined) while (tail.nextDep !== undefined) tail = tail.nextDep;
    node.depsTail = tail;
    for (const s of cells) {
      if (depsSet.has(s)) continue;
      depsSet.add(s);
      link(s as ReactiveNode, node, ++ownCycle);
    }
  };

  const unlinkDeps = (cells: readonly Cell<unknown>[]): void => {
    for (const s of cells) {
      if (!depsSet.has(s)) continue;
      depsSet.delete(s);
      for (let l = node.deps; l !== undefined; l = l.nextDep) {
        if (l.dep === s) {
          unlink(l, node);
          break;
        }
      }
    }
  };

  const handle: Network = {
    dispose: () => {
      if (disposed) return;
      disposed = true;
      node._unwatched();
      lastValues.clear();
    },
    flush: () => {
      if (disposed) return;
      // RecursedCheck doubles as the "body running" guard.
      if (node.flags & F.RecursedCheck) {
        throw new Error("network: flush() called from inside body — would recurse infinitely.");
      }
      batch(() => node._invoke());
    },
    subscribe: (...cells) => {
      if (!disposed) linkDeps(cells as Cell<unknown>[]);
    },
    unsubscribe: (...cells) => {
      if (!disposed) unlinkDeps(cells as Cell<unknown>[]);
    },
  };

  // The Effect body: hand the changed subset to the user body, then re-snapshot
  // the deps for the next fire.
  const run = (): void => {
    const dirty = computeDirty();
    try {
      body(dirty, handle);
    } finally {
      lastValues.clear();
      for (let l = node.deps; l !== undefined; l = l.nextDep) {
        const c = l.dep as Cell<unknown>;
        lastValues.set(c, c.peek());
      }
    }
  };

  node = new Effect(run, EM.NoTrack | EM.Exclude | (opts?.manual ? EM.Manual : EM.Sync));
  linkDeps(deps as readonly Cell<unknown>[]);
  batch(() => node._invoke()); // first fire (lastValues empty ⇒ EMPTY_DIRTY)
  return handle;
}

// ── value-class authoring helpers ──────────────────────────────────
// `fieldLens`/`cachedDerive` are the two getter forms a value class declares;
// the choice between them is the local declaration of writability. For arbitrary
// cached views, use `lazy()` directly.

/** Bidirectional field lens onto `parent.value[key]` (write spread-replaces),
 *  cached per (instance, key). `Writable<Cls>` on a writable parent, bare `Cls` on RO.
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
    fieldOf(parent as unknown as Cell<unknown>, key as string | symbol, Cls),
  ) as never;
}

/** Read-only derived view via `Cls.derive(parent, fn)`, memoized per
 *  (instance, key). The cache is the point.
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

// ── dependency-graph introspection ─────────────────────────────────

// One node in the engine's dep linked list; we only read `dep`/`nextDep`.
interface DepLink {
  dep: Cell<unknown>;
  nextDep: DepLink | undefined;
}

/** Every cell `s` transitively depends on, including itself (BFS, peeking each
 *  computed to populate deps; `seen` breaks cycles). */
export function transitiveDeps(s: Cell<unknown>): Set<Cell<unknown>> {
  const seen = new Set<Cell<unknown>>();
  const queue: Cell<unknown>[] = [s];
  while (queue.length > 0) {
    const cur = queue.shift()!;
    if (seen.has(cur)) continue;
    seen.add(cur);
    const c = cur as unknown as {
      getter?: () => unknown;
      deps?: DepLink | undefined;
    };
    if (c.getter !== undefined) {
      void cur.value;
      let l: DepLink | undefined = c.deps;
      while (l !== undefined) {
        queue.push(l.dep);
        l = l.nextDep;
      }
    }
  }
  return seen;
}
