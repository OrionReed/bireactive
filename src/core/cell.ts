// cell.ts — symmetric bidirectional reactive engine.
//
// Forward propagation is alien-signals verbatim (link/propagate/
// checkDirty/shallowPropagate, Dirty/Pending/Recursed flags, lazy pull).
//
// Backward is the SAME shape as forward — a lazy push-pull — not a second
// engine, and it carries NO dynamic side tables: state lives on flags plus two
// STATIC adjacencies that mirror forward's `deps`/`subs`. The lens graph is
// stored both ways at construction: `_bwd.parent` is the down edge (a view's
// declared parents, the dual of `deps`) and `_lensSubs` is its transpose, the
// up edge (a cell's direct lens-children, the dual of `subs`). Backward is then
// the forward engine run on this reverse graph — one traversal each direction:
//
//   role            forward (source → view)      backward (view → source)
//   ----            ------------------------      ------------------------
//   down edge       subs (who reads me)          _bwd.parent (my parents)
//   up edge         deps (my deps)               _lensSubs (my lens-children)
//   push (mark)     propagate (down `subs`)      markDown (down `_bwd.parent`)
//   pull (resolve)  checkDirty (up `deps`)       resolveCone (up `_lensSubs`)
//   commit/compute  _update / getter             writeBack
//   "dirty" flag    Dirty (source staged)        BackDirty (view holds target)
//   "pending" flag  Pending (on the cone)        BackPending (on the back-path)
//
// Forward: a source write PUSHES dirtiness down the cone (`Pending`, cheap
// flagging) and the value is PULLED up on read (`checkDirty` ascends `deps` to
// the `Dirty` source). Backward is the exact dual. A write to a view PUSHES
// (`markDown`): stash the `target` on the view itself (`pendingValue` +
// `BackDirty`, the dual of a source's `Dirty`), descend the static backward
// path flagging each node down to its sources `BackPending` (the dual of
// `Pending`), and wake each source's forward cone so observers re-fire. No `put`
// runs, no source moves. The work is PULLED per read, source-CENTRIC: a read
// that reaches a back-marked cell `backResolve`s — for a source directly, or by
// DESCENDING a view's marked back-path to its sources first. Each source then
// `resolveCone`s: ASCEND `_lensSubs` through the `BackPending` cone to the armed
// views (the dual of `checkDirty` ascending `deps`) and `writeBack` each,
// applying its lens's `put` and staging the source via the SAME forward
// `_writeSource`. A source reflects ALL its writers (they compose into one
// committed value), so a source's cone resolves together and commits once.
// Because resolution follows only the sources the read DEPENDS on, reading one
// chain leaves unrelated sources armed (GRANULAR — does only the work a read
// demands); overlapping co-writers on a shared source all compose; an
// UNOBSERVED write does no backward work; re-writing a view before any read
// keeps only the last target. Reads pull at clean entry points
// (getter top, source `_update`/`_writeSource`, effect `_run`) — never
// mid-compute, so a source-reading `put` never re-enters a half-computed cell.
// Views are never sticky (a view is always `get(source)`; lossy lenses snap),
// no-op deltas short-circuit via equality (the GetPut law).
//
// The ONE irreducibly non-dual ingredient is fan-in accumulation: where the
// forward engine broadcasts one source to N readers, the backward engine
// ACCUMULATES N contributors into one value (the transpose of fan-out). A
// `merge` folds POST-ORDER inside `resolveCone`: its contributors are resolved
// first (each cascades a `put` into the node's `MergeNode`), then it folds ONCE
// by the node's policy (default last-writer-wins) and writes to its parent — the
// dual of a forward getter reading its deps then computing. Everything else —
// 1→1 chains, multi-parent splits (1→N / N→M, e.g. mean/diff), complement-
// carrying stateful lenses — resolves during the walk.
//
// Mode table — a cell's role is fully determined by which fields are set:
//   source      getter undefined                 (truth in currentValue)
//   derived    getter, no _bwd                   (read-only derived)
//   lens 1→1    getter + _bwd{ put, parent: Cell }
//   multi-out   getter + _bwd{ put, parent: Cell[] }   (1→N / N→M bwd)
//   merge       getter + _bwd{ merge }            (N→1 backward fold)
//   stateful    getter + _bwd{ put, parent, stateful } (complement-carrying)
// A cell is writable iff `_bwd !== undefined` (the backward sidecar; see
// `BwdSpec`). `pendingValue` is a source's staged forward write only; a getter
// cell never uses it.

// Flag bits (alien-signals v2). Forward owns 1–32; backward adds two duals.
const F = {
  None: 0,
  Mutable: 1,
  Watching: 2,
  RecursedCheck: 4,
  Recursed: 8,
  Dirty: 16,
  Pending: 32,
  /** Backward dual of `Dirty`: this VIEW holds an unresolved back-write target
   *  in `pendingValue` (a getter cell never uses that field forward). The root
   *  of a pending back-write; `writeBack` consumes the target and clears it. */
  BackDirty: 64,
  /** Backward dual of `Pending`: this node lies on the back-path from a
   *  `BackDirty` view down to its sources. `markDown` sets it on descent; it
   *  gates `resolveCone`, which ascends `_lensSubs` only through `BackPending`
   *  nodes (so a read resolves only its own back-cone), and `writeBack` clears
   *  it on the way back down. */
  BackPending: 128,
} as const;

// Named masks (legibility): a cell's whole backward state in one test.
/** Armed root OR on a back-path — i.e. a read must `backResolve` first. */
const BACK_MARKED = F.BackDirty | F.BackPending;

// Mode predicates — the single place a cell's role is read off its fields (see
// the mode table by `BwdSpec`). V8 inlines these; the backward walk reads them
// instead of duplicating `getter`/`_bwd` field probes.
/** Source (truth leaf): no forward derivation. */
function isSource(c: Cell<unknown>): boolean {
  return c.getter === undefined;
}
/** Writable: carries a backward sidecar (lens / multi-out / merge / stateful / pin). */
function isWritable(c: Cell<unknown>): boolean {
  return c._bwd !== undefined;
}
/** Read-only derived: a `derive` with no backward path. A split routes around
 *  it; a sole parent has nowhere to land (the back-walk throws). */
function isReadOnlyDerived(c: Cell<unknown>): boolean {
  return !isSource(c) && !isWritable(c);
}

/** The forward primal a source-reading `bwd` linearizes at, read WITHOUT a
 *  cascading recompute — the lazy dual of reverse-mode AD reusing a STORED
 *  linearization point instead of rematerializing it.
 *
 *  - SOURCE → its staged/live truth (`.value`): cheap (no cone), and lets a
 *    sibling co-writer's staged value compose within the transaction.
 *  - REALIZED derived (not `Dirty`) → its last-settled `currentValue`: no
 *    recompute. PutGet holds for ANY source state, so a stale primal still
 *    round-trips; the last *observed* state is also the one GetPut and lazy
 *    coalescing (PutPut "all at once") want.
 *  - UNREALIZED derived (`Dirty`: never computed / threw / unwatched, so
 *    `currentValue` is not a trustworthy primal) → realize ONCE via `.value`,
 *    seeding `currentValue` for subsequent back-writes. This happens lazily, on
 *    the write that needs it; the normal forward path pays nothing. */
function backPrimal(c: Cell<unknown>): unknown {
  if (c.getter === undefined || c.flags & F.Dirty) return c.value;
  return c.currentValue;
}

/** Register `node` on each backward parent's `_lensSubs` (the reverse edge
 *  `resolveCone` ascends), ONCE, lazily on the first back-write — so a lens only
 *  ever read forward never allocates that adjacency. Idempotent via the dedicated
 *  `_linkedBack` field (NOT a `flags` bit, so a forward recompute that resets
 *  `flags` can never wipe it and make `linkBack` re-push a duplicate); the
 *  registration persists (a lens stays discoverable for later writes). */
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
/** Network running its body, if any. Source writes self-exclude it so a
 *  network reading+writing a cell doesn't re-trigger itself. */
let activeNetwork: _NetworkNode | undefined;
const queued: (Effect | _NetworkNode | undefined)[] = [];
/** Re-entrancy guard: while a back-resolve runs, a `put`'s source read commits
 *  normally (in-order composition) but must NOT trigger a nested resolve. */
let draining = false;

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

function propagate(start: Link, innerWrite: boolean, excluding?: ReactiveNode): void {
  let l: Link | undefined = start;
  let next: Link | undefined = start.nextSub;
  let stack: Stack<Link | undefined> | undefined;
  top: do {
    const sub: ReactiveNode = l!.sub;
    // `excluding` skips one subscriber (used by `network()` so a body
    // writing a cell it subscribes to doesn't re-trigger itself).
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
      // A `BackPending` SOURCE (leaf: no getter) looks unchanged until its
      // back-write resolves; `_update` resolves it (pulls its registered views,
      // runs the `put`s), then reports whether it moved — like a forward-`Dirty`
      // source. Intermediate views are also `BackPending`, but they have a
      // getter and fall through to the `Pending` recurse below.
      ((flags & (F.Mutable | F.BackPending)) === (F.Mutable | F.BackPending) &&
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

// MergeNode — backward fan-in (N→1), the one irreducibly non-dual ingredient.
// Where the forward engine BROADCASTS one source to N subscribers, the backward
// engine ACCUMULATES N contributors into a single value for the parent. The fold
// "falls out" of `resolveCone`'s POST-ORDER: a merge is reached on the ascent
// before its contributors, so its children are resolved first (each cascades a
// `put` down into `contributions`), and the merge folds ONCE on the way back up
// (the node's policy; default last-writer-wins) and writes the result to
// `parent` — exactly like a forward getter reading its deps. No deferral queue,
// no single-entry guard. `contributions` is reused in place (cleared on fold,
// and again on entry to self-heal after a throw); the one merge-owned array.
export type MergeFold<T> = (values: readonly T[]) => T;

class MergeNode<T> {
  readonly foldFn: MergeFold<T> | undefined;
  /** Contributions gathered as this merge's cone resolves; folded and cleared
   *  in `foldMerge` (the merge-owned buffer, mutated in place). The parent it
   *  writes to is just `b.parent` (a merge's `b.parent` IS its fold target), so
   *  this node carries only the policy + buffer — no duplicate edge. */
  contributions: T[] = [];

  constructor(fold: MergeFold<T> | undefined) {
    this.foldFn = fold;
  }
}

// BwdSpec — the backward sidecar.
//
// Every cell carries the forward fields (links, getter, value cache).
// Only a WRITABLE derived cell — 1→1 lens, multi-output lens, merge,
// stateful lens, or `pin` — needs a backward target and the closures to
// drive it. Those fields live here, off a single `_bwd` pointer, rather
// than inline on `Cell`, so a source/computed stays lean: the forward hot
// path never touches them, and a plain node drops ~64 B. A cell is
// writable iff `_bwd !== undefined`.
//
// Two mode payloads hang off named fields rather than one union, so each
// stays distinctly typed: `merge` (the N→1 fold node) and `stateful` (the
// complement machinery of a complement-carrying lens). Both are rare, so
// a plain 1→1 / multi-out lens leaves them `undefined` and pays only
// `parent` + `put`.
class BwdSpec {
  /** Backward target(s): one `Cell` (1→1 / merge) or `Cell[]` (multi-out). */
  parent: Cell<unknown> | Cell<unknown>[] | undefined = undefined;
  /** Lens `put` — backward derivation (dual of `getter`). A 1→1 / multi-out
   *  lens is called as `put(target)` (a source-reading lens reads the current
   *  parent(s) at walk time, untracked); multi-out returns a per-parent update
   *  array. Stateful is the spec's `bwd`, called `put(target, sources, c)`. */
  // biome-ignore lint/suspicious/noExplicitAny: put fn is opaque shape
  put: ((target: any, current?: any) => any) | undefined = undefined;
  /** Backward aggregation node; presence IS the merge-mode discriminant. */
  merge: MergeNode<unknown> | undefined = undefined;
  /** Complement machinery; presence IS the stateful-mode discriminant. */
  stateful: StatefulCore | undefined = undefined;
}

/** Runtime state of a stateful (complement-carrying) lens — the rare
 *  backward mode, kept off `BwdSpec` so plain lenses don't carry its slots.
 *  `put` (the spec's `bwd`) and `parent` stay on `BwdSpec`; this holds the
 *  complement and the closures that project from / advance it. */
class StatefulCore {
  /** Engine-owned memory the view discards. */
  complement: unknown;
  /** Advance the complement: `step(sources, complement, external)`. (The
   *  forward projection `fwd` is captured directly in the getter closure — it
   *  is only ever read there — so it costs no slot here.) */
  // biome-ignore lint/suspicious/noExplicitAny: opaque step shape
  step: (sources: any, complement: any, external: boolean) => any;
  /** Sources this lens last committed back (the own-vs-external test compares
   *  live sources against these); `undefined` until the first back-write. A
   *  back-write reads the live sources into a fresh array, builds the committed
   *  candidate in place, and keeps it as `last` for the next own-vs-external
   *  comparison. */
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
  flags: number = F.Mutable;
  subs: Link | undefined;
  subsTail: Link | undefined;
  deps: Link | undefined;
  depsTail: Link | undefined;

  /** Forward derivation (computed/lens/merge). `undefined` ⇒ source. */
  getter: (() => T) | undefined;

  /** Per-instance equality, always defined (defaults to `Object.is` at
   *  construction) so hot paths call it without an `undefined` branch. */
  _equals: (a: T, b: T) => boolean;
  /** First-subscriber / last-subscriber lifecycle hooks. */
  _watched: (() => void) | undefined;
  _unwatchedHook: (() => void) | undefined;

  /** Source: `currentValue` = committed, `pendingValue` = staged write.
   *  Getter cell: `currentValue` = last derived cache; `pendingValue` unused. */
  currentValue: T;
  pendingValue: T;

  /** Backward sidecar: target(s) + lens closures, or `undefined` for a
   *  read-only cell (source or computed). Allocated only for writable derived
   *  cells, keeping the common node lean. Writability is exactly
   *  `_bwd !== undefined`. See `BwdSpec`. */
  _bwd: BwdSpec | undefined;

  /** Backward dual of `subs`: this cell's direct lens-children — every
   *  writable view that declares it as a parent (`_bwd.parent`). The transpose
   *  of `_bwd.parent`, registered LAZILY on a child's first back-write (`linkBack`,
   *  deduped by `_linkedBack`) and never mutated again — so a cell only ever read
   *  forward never allocates it. `resolveCone` ascends it (gated by `BACK_MARKED`)
   *  exactly as forward `checkDirty` ascends `deps`, so a read resolves only its
   *  own back-cone — no per-write registry, dedup, or emptying. */
  _lensSubs: Cell<unknown>[] | undefined;

  /** Whether this lens has already been registered on its parents' `_lensSubs`
   *  (the reverse edge). A dedicated field rather than a `flags` bit so a forward
   *  recompute resetting `flags` can never clear it — that wipe would let
   *  `linkBack` re-push a duplicate on the next back-write (an unbounded leak). */
  _linkedBack = false;

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
    this._lensSubs = undefined;
    this._linkedBack = false;
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

  /** Source write (alien's signal setter). Self-excludes the active
   *  network so a body writing its own dep doesn't re-trigger itself. Backward
   *  writes stage here too (`writeBack` → `_writeSource`), so this is the single
   *  point where truth mutates. */
  _writeSource(next: T): void {
    // A forward write to a source with an unresolved back-write demand resolves
    // it FIRST, so the later forward write wins (LWW).
    if (this.flags & F.BackPending && !draining) backResolve(this as Cell<unknown>);
    const prev = this.pendingValue;
    this.pendingValue = next;
    if (!this._equals(prev, next)) {
      this.flags = F.Mutable | F.Dirty;
      if (writeHook !== undefined) writeHook(this as Cell<unknown>);
      const subs = this.subs;
      if (subs !== undefined) propagate(subs, runDepth > 0, activeNetwork);
      if (batchDepth === 0 && !flushing && subs !== undefined) flush();
    }
  }

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
    // A `BackPending` source first resolves its armed back-write (`backResolve`
    // pulls the views registered on it, runs the `put`s, stages it via
    // `_writeSource`) — so its `pendingValue` reflects the back-write before we
    // commit it.
    if (this.flags & F.BackPending && !draining) backResolve(this as Cell<unknown>);
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

  /** Backward fan-in node. Forward, the identity view of its parent;
   *  backward, the convergence point where N contributors (upstream lenses
   *  and direct writes) fold into one value for the parent. `fold` is handed
   *  every live push at once; omitted, it is last-writer-wins. */
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
    // Parentless `_bwd`: `writeBack` absorbs at `parent === undefined` before any
    // `put`, so the sink needs no closure — writability is just `_bwd !== undefined`.
    cell._bwd = new BwdSpec();
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
  // Source-reading lenses linearize at the parent's primal (`backPrimal`: the
  // last-settled value for a derived, the staged truth for a source) so the
  // engine always calls the 1-arg form (no arity branch) and never recomputes a
  // derived parent's cone just to read it back.
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
    // Own reused buffer, NOT the getter's `vals`: the walk reads each parent's
    // primal (`backPrimal`), so a separate array avoids aliasing the getter's.
    // `bwd` consumes it synchronously and must not retain it (same as `fwd`);
    // re-entry through the same lens is impossible (the lens graph is a DAG).
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
  const sc = (b.stateful = new StatefulCore(spec.init(seed), spec.step));
  const fwd = spec.fwd as (s: unknown, c: unknown) => unknown;
  b.put = spec.bwd as (t: unknown, c?: unknown) => unknown;
  b.parent = parents;
  cell.getter = (() => {
    for (let i = 0; i < n; i++) vals[i] = parents[i]!.value;
    // External unless the live sources still equal this lens's own last
    // back-write.
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
    // Reading is the PULL. A back-marked cell resolves at this clean entry,
    // BEFORE its own compute, so a source-reading `put` never re-enters a
    // half-computed cell. `backResolve` descends `_bwd` to the sources and pulls
    // the writers registered there, touching only this cell's back-cone
    // (granular — sibling chains untouched).
    if (this.flags & BACK_MARKED && !draining) backResolve(this);
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
    // GetPut for a multi-parent split: its `put` may move sources even when the
    // view is unchanged (a lossy redistribution that `_writeSource`'s per-source
    // equality can't catch), so absorb a write that maps to the current view
    // here. (Stateful excluded — peeking would step its complement.)
    if (Array.isArray(b.parent) && b.stateful === undefined && this._equals(next, this.peek())) {
      return;
    }
    arm(this as Cell<unknown>, next);
  },
  enumerable: false,
  configurable: false,
});

/** Backward push: arm a back-write of `target` on view `node` (the dual of a
 *  source `set`). A re-write of a still-armed view (an unobserved drag) keeps
 *  only the last target — the path down to the sources is already marked, so
 *  skip the walk and coalesce. The trailing `flush` runs effects the push woke;
 *  each effect's read pulls its own cone. */
function arm(node: Cell<unknown>, target: unknown): void {
  if (!(node.flags & F.BackDirty)) {
    markDown(node); // flag path + wake cones, FIRST (a throw arms nothing)
    node.flags |= F.BackDirty;
  }
  node.pendingValue = target; // the view holds its own demand (getters ignore this field)
  if (batchDepth === 0 && !flushing) flush();
}

/** MARK (push), dual of forward `propagate`: descend `start`'s static backward
 *  path down `_bwd.parent` to its sources, flag each node it passes
 *  `BackPending`, register the reverse edge (`linkBack`, lazily on first write),
 *  and wake every source's forward cone (so observers — siblings reading the
 *  source, not just this view's path — re-fire). Runs no `put`: an
 *  over-approximation `resolveCone` later resolves precisely (equality prunes).
 *
 *  The `BackPending` flag is its own dedup: a node already marked has its whole
 *  subtree marked (the path below it is static), so we stop there — diamonds
 *  cost one visit, no epoch counter. A merge relays to its parent. A sole
 *  read-only-derived parent has nowhere to land → throw (partial marks self-heal
 *  on read, since `BackDirty` is never set — see `arm`). The 1→1 spine allocates
 *  nothing (the `stack` is created only on the first branch). */
function markDown(start: Cell<unknown>): void {
  let node: Cell<unknown> = start;
  let stack: Cell<unknown>[] | undefined;
  for (;;) {
    let next: Cell<unknown> | undefined;
    if (isSource(node)) {
      // Leaf (dual of a `Dirty` source): wake its cone ONCE.
      if (!(node.flags & F.BackPending)) {
        node.flags |= F.BackPending;
        const subs = node.subs;
        if (subs !== undefined) propagate(subs, runDepth > 0, activeNetwork);
      }
    } else if (node === start || !(node.flags & F.BackPending)) {
      // On the back-path (dual of a `Pending` intermediate). An already-marked
      // intermediate (≠ start) has its subtree marked — stop (diamond dedup).
      if (node !== start) node.flags |= F.BackPending;
      linkBack(node); // register the reverse edge lazily, on first back-write
      // `b.parent` is the back-target for EVERY mode (a merge's fold target is
      // just its single, always-writable parent), so one descent covers all.
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

/** RESOLVE (pull), dual of forward `checkDirty`: resolve ONE node's whole
 *  back-cone. ASCEND the static reverse adjacency `_lensSubs` (only
 *  `BACK_MARKED` children) to the armed views above, `writeBack`ing each so its
 *  `put`s cascade back down. Resolution is source-CENTRIC (a source must reflect
 *  ALL its writers — they compose into one committed value), so a call on the
 *  source resolves every co-writer together; the source commits once on the read
 *  that follows. `BackDirty` is the dedup (a view resolves once; diamonds and
 *  overlapping co-writers are all found here, since the cone spans every view
 *  above the node).
 *
 *  Recursive so a MERGE folds POST-ORDER (the one non-dual ingredient): a merge
 *  is hit before its contributors, so we resolve its children first — each
 *  cascades a `put` into `contributions` — then fold ONCE on the way back up and
 *  write to the parent, exactly as a forward getter reads its deps then
 *  computes. Recursion depth is the lens-nesting depth (small, and `writeBack`
 *  already recurses the same spine). */
function resolveCone(node: Cell<unknown>): void {
  const b = node._bwd;
  const merge = b !== undefined ? b.merge : undefined;
  if (merge !== undefined) merge.contributions.length = 0; // self-heal a throw-left batch
  // Drive this node's own armed target first (composes before child writes —
  // preserves last-writer-wins order among co-writers of a shared parent).
  if (node.flags & F.BackDirty) {
    node.flags &= ~F.BackDirty;
    writeBack(node, node.pendingValue);
  }
  const children = node._lensSubs;
  if (children !== undefined) {
    for (let i = 0; i < children.length; i++) {
      const c = children[i]!;
      if (c.flags & BACK_MARKED) resolveCone(c);
    }
  }
  node.flags &= ~F.BackPending; // resolved (idempotent with `writeBack`'s clear)
  if (merge !== undefined) foldMerge(b!.parent as Cell<unknown>, merge); // contributors in → fold once
}

/** PULL entry for a back-marked `start`. A read must reflect every pending
 *  back-write to the sources it depends on, so resolution is source-centric: a
 *  source read resolves its own cone; a VIEW read first DESCENDS its marked
 *  back-path (`_bwd.parent` through `BackPending`) to the sources, then resolves
 *  each source's whole cone (so co-writers compose and the source commits once —
 *  reading a view never strands a sibling, and never re-enters a half-committed
 *  source). Merges fold inline, post-order, inside `resolveCone`. The `draining`
 *  guard stops a `put`'s source read from re-entering. */
function backResolve(start: Cell<unknown>): void {
  draining = true;
  ++batchDepth;
  const prev = activeSub;
  activeSub = undefined;
  try {
    if (isSource(start)) {
      resolveCone(start);
    } else {
      // Descend the marked back-path to every source, resolving each source's
      // cone. A view with no source to land on (a `pin` sink) resolves itself.
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
              if (isSource(p)) {
                reached = true;
                if (p.flags & F.BackPending) resolveCone(p);
              } else if (p.flags & F.BackPending) {
                if (next === undefined) next = p;
                else (stack ??= []).push(p);
              }
            }
          } else if (isSource(parent)) {
            reached = true;
            if (parent.flags & F.BackPending) resolveCone(parent);
          } else if (parent.flags & F.BackPending) {
            next = parent;
          }
        }
        if (next !== undefined) node = next;
        else if (stack !== undefined && stack.length > 0) node = stack.pop()!;
        else break;
      }
      if (!reached && start.flags & F.BackDirty) {
        start.flags &= ~F.BackDirty;
        writeBack(start, start.pendingValue);
      }
    }
  } finally {
    activeSub = prev;
    --batchDepth;
    draining = false;
  }
}

/** Resolve any back-write a woken reactive node reads DIRECTLY. `checkDirty`
 *  alone catches back-writes that move a source (it ascends to the source),
 *  but a stateful "stash" moves only the VIEW (the complement echoes a value
 *  back, no source changes) — invisible to a source-based check. Resolving the
 *  node's back-marked deps here makes that view-change visible before the
 *  dirtiness check. Granular: only this node's own deps. */
function resolveBackDeps(node: ReactiveNode): void {
  for (let l = node.deps; l !== undefined; l = l.nextDep) {
    const d = l.dep as Cell<unknown>;
    if (d.flags & BACK_MARKED && !draining) backResolve(d);
  }
}

/** Backward commit/compute (dual of forward `_update`): drive a back-write of
 *  `target` into `node` toward the sources, applying each lens's `put`, clearing
 *  `BackPending` as it descends, and staging each source the instant it is
 *  reached (visible to a later sibling reading that SAME source — spread-replace
 *  field lenses converging on one composite — so it composes rather than
 *  clobbers). An `undefined` per-parent slot prunes a branch (a `put` cuts off
 *  by returning the current source, which equality absorbs); a `merge` just
 *  accumulates (its `resolveCone` folds post-order); a read-only parent throws
 *  (already caught at MARK time). */
function writeBack(node: Cell<unknown>, target: unknown): void {
  if (isSource(node)) {
    node._writeSource(target); // source — staged now, visible to later siblings
    // `_writeSource` reset the flags, clearing `BackPending`. Re-assert it if any
    // lens-child is still armed (an overlapping co-writer through this same
    // source): a later read must still resolve them, else that write is lost.
    // `_lensSubs` holds only ever-back-written children, so this is a short flag
    // scan, not a registry walk.
    const subs = node._lensSubs;
    if (subs !== undefined) {
      for (let i = 0; i < subs.length; i++)
        if (subs[i]!.flags & BACK_MARKED) {
          node.flags |= F.BackPending;
          break;
        }
    }
    return;
  }
  node.flags &= ~F.BackPending; // passing through clears the path marker
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
      // Bring the complement to the current sources before `bwd` (the dual of
      // the forward getter's step) so it measures devs/fracs from a prior
      // sibling write, not a stale snapshot. External unless the sources still
      // equal this lens's own last back-write.
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
      // Build the committed candidate IN `vals` (its source reads are spent) and
      // keep it as `last` for the next own-vs-external comparison.
      for (let i = 0; i < n; i++) if (upd[i] !== undefined) vals[i] = upd[i];
      sc.complement = sc.step(vals, res.complement, false);
      sc.last = vals;
      out = upd;
    } else {
      out = (b.put as (t: unknown) => ReadonlyArray<unknown>)(target);
    }
    let wrote = false;
    for (let i = 0; i < n; i++) {
      const u = out[i];
      if (u !== undefined) {
        wrote = true;
        writeBack(parent[i]!, u);
      }
    }
    // A stateful lens can change its VIEW through the complement alone, moving
    // no source (a degenerate "stash" — e.g. a collapsed axis remembering the
    // written angle, or a broken parse holding the typed text). No source write
    // means the forward cone never fires, so invalidate the node's own cache and
    // propagate to its observers here.
    if (!wrote && sc !== undefined) {
      node.flags |= F.Dirty;
      const subs = node.subs;
      if (subs !== undefined) propagate(subs, runDepth > 0, activeNetwork);
    }
    return;
  }
  // 1→1 lens.
  writeBack(parent, (b.put as (t: unknown) => unknown)(target));
}

/** Fold one merge's gathered contributions ONCE (its policy; default
 *  last-writer-wins) and write the result up to its parent. Called post-order
 *  from `resolveCone` once every contributor has cascaded in — fan-in is the one
 *  non-dual ingredient. Runs untracked (`backResolve` already cleared
 *  `activeSub`). */
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
    // Resolve back-writes this effect reads directly (incl. view-only stashes),
    // then let `checkDirty` resolve any `BackPending` source reached deeper.
    if (this.deps !== undefined) resolveBackDeps(this);
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

/** Run effects woken by a write. Backward work is pulled lazily per read
 *  (`resolveBackDeps` + `checkDirty` → `backResolve`, which also folds merges),
 *  so flush owns NO backward bookkeeping — just the effect queue. */
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
    flushing = false;
  }
}

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

// network() — reactive sub-DAG with self-excluded writes.
//
// A watching node (like an Effect) whose body fires when any SUBSCRIBED
// dep changes, but whose own writes self-exclude the node (via
// `activeNetwork`) so it doesn't re-trigger itself. Topology is explicit
// (deps array + later subscribe/unsubscribe; reads in the body add no
// deps) — the building block for constraint networks vs auto-tracked
// effects.

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

class _NetworkNode implements ReactiveNode {
  subs: Link | undefined = undefined;
  subsTail: Link | undefined = undefined;
  deps: Link | undefined = undefined;
  depsTail: Link | undefined = undefined;
  flags: number = F.Watching | F.RecursedCheck;
  body: NetworkBody;
  manual: boolean;
  /** Per-instance last-seen dep values; used to compute `dirty`. */
  lastValues: Map<Cell<unknown>, unknown> = new Map();
  pending = false;
  disposed = false;
  private _ownCycle = 0;
  private _depsSet: Set<Cell<unknown>> = new Set();
  private _handle!: Network;

  constructor(body: NetworkBody, manual: boolean) {
    this.body = body;
    this.manual = manual;
  }

  /** Two-phase init so the body sees its own handle on the first fire. */
  _initWithHandle(handle: Network, initialDeps: readonly Cell<unknown>[]): void {
    this._handle = handle;
    this._linkBatch(initialDeps);
    this._runBody(EMPTY_DIRTY);
  }

  _update(): boolean {
    this.flags = F.Mutable;
    return true;
  }

  _notify(): void {
    if (this.manual) {
      this.pending = true;
      this.flags |= F.Watching;
      return;
    }
    queued[queuedLength++] = this;
    this.flags &= ~F.Watching;
  }

  _unwatched(): void {
    this.disposed = true;
    this.flags = F.None;
    disposeAllDepsInReverse(this);
    const sub = this.subs;
    if (sub !== undefined) unlink(sub);
    this.lastValues.clear();
  }

  _run(): void {
    if (this.disposed) return;
    if (this.deps !== undefined) resolveBackDeps(this);
    const flags = this.flags;
    if (flags & F.Dirty || (flags & F.Pending && checkDirty(this.deps!, this))) {
      this._runBody(this._computeDirty());
    } else if (this.deps !== undefined) {
      this.flags = F.Watching;
    }
  }

  private _computeDirty(): ReadonlySet<Cell<unknown>> {
    let dirty: Set<Cell<unknown>> | undefined;
    for (const [cell, lastVal] of this.lastValues) {
      if (cell.peek() !== lastVal) {
        if (dirty === undefined) dirty = new Set();
        dirty.add(cell);
      }
    }
    return dirty ?? EMPTY_DIRTY;
  }

  private _runBody(dirty: ReadonlySet<Cell<unknown>>): void {
    // RecursedCheck doubles as the "body running" guard (see flush()).
    this.flags = F.Watching | F.RecursedCheck;
    const prevSettler = activeNetwork;
    activeNetwork = this;
    try {
      ++cycle;
      ++runDepth;
      ++batchDepth;
      try {
        this.body(dirty, this._handle);
      } finally {
        if (!--batchDepth) flush();
      }
    } finally {
      --runDepth;
      activeNetwork = prevSettler;
      this.flags &= ~F.RecursedCheck;
      this.lastValues.clear();
      let l = this.deps;
      while (l !== undefined) {
        const cell = l.dep as Cell<unknown>;
        this.lastValues.set(cell, cell.peek());
        l = l.nextDep;
      }
    }
    this.pending = false;
  }

  flush(): void {
    if (this.disposed) return;
    if (this.flags & F.RecursedCheck) {
      throw new Error(
        "network: flush() called from inside body — would recurse infinitely. " +
          "Return from the body and let the next dep change drive the next fire.",
      );
    }
    this._runBody(this._computeDirty());
  }

  subscribe(cells: readonly Cell<unknown>[]): void {
    if (this.disposed) return;
    this._linkBatch(cells);
  }

  unsubscribe(cells: readonly Cell<unknown>[]): void {
    if (this.disposed) return;
    const set = this._depsSet;
    for (const s of cells) {
      if (!set.has(s)) continue;
      set.delete(s);
      let l = this.deps;
      while (l !== undefined) {
        if (l.dep === s) {
          unlink(l, this);
          break;
        }
        l = l.nextDep;
      }
    }
  }

  private _linkBatch(cells: readonly Cell<unknown>[]): void {
    const set = this._depsSet;
    let tail = this.deps;
    if (tail !== undefined) {
      while (tail.nextDep !== undefined) tail = tail.nextDep;
    }
    this.depsTail = tail;
    for (const s of cells) {
      if (set.has(s)) continue;
      set.add(s);
      link(s as ReactiveNode, this, ++this._ownCycle);
    }
  }
}

/** Build a reactive sub-DAG node with explicit topology. The body fires
 *  when any subscribed dep changes (`dirty` = the changed subset), runs
 *  inside `batch()`, and self-excludes its own writes. Topology is the
 *  deps array + later subscribe/unsubscribe (body reads add no deps).
 *  `flush()` from inside the body throws; `manual: true` defers
 *  auto-firing so only `flush()` advances. */
export function network(
  // biome-ignore lint/suspicious/noExplicitAny: deps come in many flavours
  deps: readonly Cell<any>[],
  body: (dirty: ReadonlySet<Cell<unknown>>, handle: Network) => void,
  opts?: { manual?: boolean },
): Network {
  const node = new _NetworkNode(body, opts?.manual ?? false);
  const handle: Network = {
    dispose: () => node._unwatched(),
    flush: () => node.flush(),
    subscribe: (...cells) => node.subscribe(cells),
    unsubscribe: (...cells) => node.unsubscribe(cells),
  };
  node._initWithHandle(handle, deps as readonly Cell<unknown>[]);
  return handle;
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

// ── dependency-graph introspection ─────────────────────────────────

// One node in the engine's dep linked list; we only read `dep`/`nextDep`.
interface DepLink {
  dep: Cell<unknown>;
  nextDep: DepLink | undefined;
}

/** Every cell `s` transitively depends on, including itself. Raw cells
 *  return `{s}`; lens chains return the chain plus all parents. BFS,
 *  peeking each Computed to populate deps; the `seen` set breaks cycles.
 *  Used by `Propagators` to expand declared reads into their transitive
 *  parent set. Inspection is safe: it only reads engine state and peeks
 *  `.value` (idempotent for lazy Computeds). */
export function transitiveDeps(s: Cell<unknown>): Set<Cell<unknown>> {
  const seen = new Set<Cell<unknown>>();
  const queue: Cell<unknown>[] = [s];
  while (queue.length > 0) {
    const cur = queue.shift()!;
    if (seen.has(cur)) continue;
    seen.add(cur);
    // Cast to reach engine fields the typed Cell<T> shape doesn't surface.
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
