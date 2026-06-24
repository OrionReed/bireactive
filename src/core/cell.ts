// cell.ts — symmetric bidirectional reactive engine.
//
// Forward propagation is alien-signals verbatim. Backward is the same lazy
// push-pull run on the transpose of the lens graph, carried by one `LensLink`
// structure (the backward dual of forward's `Link`): `parentEdges` down,
// `childEdges` up, created eagerly at lens construction. One traversal each
// direction:
//
//   role            forward (source → view)      backward (view → source)
//   down edge       subs (who reads me)          parentEdges (my parents)
//   up edge         deps (my deps)               childEdges (my lens-children)
//   push (mark)     propagate (down `subs`)      markDown (down `parentEdges`)
//   pull (resolve)  checkDirty (up `deps`)       resolveCone (up `childEdges`)
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
// Mode table — `getter`/`_bwd` fix forward/writable; the backward shape is read off
// `_bwd` field presence (`merge` / `stateful` / `parentEdges` / `scatter`):
//   source      getter undefined                       (truth in currentValue)
//   derived    getter, no _bwd                         (read-only derived)
//   lens 1→1    getter + _bwd{ put }                    (scalar put)
//   multi-out   getter + _bwd{ put, scatter }           (1→N / N→M tuple put)
//   merge       getter + _bwd{ merge }                  (N→1 backward fold)
//   stateful    getter + _bwd{ put, scatter, stateful } (complement-carrying)
//   pin         getter + _bwd{} no parentEdges          (parentless sink)
// Writable iff `_bwd !== undefined`. `pendingValue` is a source's staged write
// (and a view's armed back-target); a derived cell never uses it forward.

// Counts-first instrumentation: off by default, one branch per site (see _counts).
import { COUNTS, counts } from "./_counts";

// ─────────────────────────────────────────────────────────────────────────
// Module state — mutable engine-wide variables and pooled scratch buffers.
// Every pool is non-reentrant: forward and backward runs never nest, so one
// shared buffer per role suffices (no per-call allocation).
// ─────────────────────────────────────────────────────────────────────────

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
/** Monotone epoch stamped onto `Cell.bEpoch` during a `backResolve` collect, so
 *  diamonds visit each node once without a Set (the backward dual of `cycle`). */
let backCycle = 0;
/** `writeBack`'s explicit descent stack (depth-first, left-to-right), as two
 *  parallel pooled columns. Non-reentrant — a `writeBack` triggers no nested
 *  `writeBack` — so one shared stack suffices (no per-call allocation). */
const wbNode: Cell<unknown>[] = [];
const wbTarget: unknown[] = [];
/** Stateful lenses passed through in a `writeBack`, re-stamped post-order once
 *  their sources are written (versions bumped) so the next forward read sees an
 *  unchanged sum and skips `step` — own-write provenance. Pooled; non-reentrant. */
const wbStateful: Cell<unknown>[] = [];
/** `resolveCone`'s pooled post-order frame stack: the node and its next-child
 *  cursor. Non-reentrant (no nested `resolveCone`), so shared pools suffice. */
const rcNode: Cell<unknown>[] = [];
const rcEdge: (LensLink | undefined)[] = [];

const EMPTY_DIRTY: ReadonlySet<Cell<unknown>> = new Set();

/** Fires on every source value-change. Backward writes reach it via `_writeSource`. */
let writeHook: ((cell: Cell<unknown>) => void) | undefined;

// ─────────────────────────────────────────────────────────────────────────
// Internal constants & types — flag bits, mode bits, and the node/edge records.
// ─────────────────────────────────────────────────────────────────────────

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
  /** Static (set once at construction): a write armed here is structurally
   *  impossible — its mandatory back-spine dead-ends at a sole read-only-derived
   *  parent. Checked atop `arm` so the throw lands before any backward mutation. */
  WriteBlocked: 4,
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

// LensLink — the backward dual of `Link`, the one structure both backward
// traversals use. A lens-edge connects a `child` (a writable view) to one
// `parent` (a back-target) at tuple position `index`. It lives in two lists,
// the backward mirror of forward's `deps`/`subs`:
//   child.parentEdges  (down: my back-targets)      via nextParent
//   parent.childEdges  (up:   my lens-children)      via prevChild/nextChild
// The down-list is built eagerly at construction (the lens topology is static,
// unlike dynamic forward deps), append-only, and never removed — it's intrinsic
// to the view and dies with it (so it needs no back-pointer). The up-list is
// spliced lazily on first back-mark (`linkChild`) and removed in O(1) when a view
// is unwatched (`unlinkChild`), mirroring forward `unlink` — hence doubly-linked.
// `markDown`/`backResolve` descend `parentEdges`; `resolveCone` ascends `childEdges`.
interface LensLink {
  index: number;
  parent: Cell<unknown>;
  child: Cell<unknown>;
  /** Spliced into `parent.childEdges` yet? The down-list (`parentEdges`) is
   *  eager at construction; the up-list is lazy on first back-mark so the
   *  parent's child order is arm-order (co-writer resolution is last-write-wins). */
  linked: boolean;
  nextParent: LensLink | undefined;
  prevChild: LensLink | undefined;
  nextChild: LensLink | undefined;
}

interface Stack<T> {
  value: T;
  prev: Stack<T> | undefined;
}

// ─────────────────────────────────────────────────────────────────────────
// Internal helpers — mode predicates, edge wiring, and the write-hook installer.
// ─────────────────────────────────────────────────────────────────────────

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

/** Create a lens-edge `child →[index] parent`, appending it to `child`'s
 *  `parentEdges` (down) eagerly at construction, in tuple order (so
 *  `parentEdges` is index-ordered). The up-list (`parent.childEdges`) is spliced
 *  lazily on first back-mark (`linkChild`), so child order is arm-order. */
function linkLens(child: Cell<unknown>, parent: Cell<unknown>, index: number): void {
  const e: LensLink = {
    index,
    parent,
    child,
    linked: false,
    nextParent: undefined,
    prevChild: undefined,
    nextChild: undefined,
  };
  if (child.parentEdgesTail !== undefined) child.parentEdgesTail.nextParent = e;
  else child.parentEdges = e;
  child.parentEdgesTail = e;
}

/** Splice a lens-edge into its parent's `childEdges` (the up-traversal list),
 *  once, on first back-mark — so a parent's child order is arm-order and
 *  co-writer resolution is last-write-wins. Idempotent via `linked`. */
function linkChild(e: LensLink): void {
  if (e.linked) return;
  if (COUNTS) counts.linkChild++;
  e.linked = true;
  const parent = e.parent;
  e.prevChild = parent.childEdgesTail;
  if (parent.childEdgesTail !== undefined) parent.childEdgesTail.nextChild = e;
  else parent.childEdges = e;
  parent.childEdgesTail = e;
}

/** Remove a lens-edge from its parent's `childEdges` up-list in O(1), and mark it
 *  re-linkable — the backward dual of `unlink` dropping a subscriber from `subs`.
 *  Called when a view is unwatched, to release the parent→child retaining edge (a
 *  later arm re-`linkChild`s). The child's own down-list (`parentEdges`) stays:
 *  it's intrinsic to the view and dies with it. */
function unlinkChild(e: LensLink): void {
  if (COUNTS) counts.unlinkChild++;
  const { parent, prevChild, nextChild } = e;
  if (nextChild !== undefined) nextChild.prevChild = prevChild;
  else parent.childEdgesTail = prevChild;
  if (prevChild !== undefined) prevChild.nextChild = nextChild;
  else parent.childEdges = nextChild;
  e.linked = false;
  e.prevChild = undefined;
  e.nextChild = undefined;
}

/** Precompute `BF.WriteBlocked` once, after a writable's `parentEdges` are linked.
 *  Mirrors `markDown`'s descent exactly: a sole read-only-derived parent dead-ends
 *  (block); a split routes around a read-only parent; otherwise the block is
 *  inherited from any non-read-only parent already flagged. Topology is immutable
 *  and parents are built first, so each node's bit is its parents' bits + one scan. */
function setWriteBlocked(cell: Cell<unknown>): void {
  const pe = cell.parentEdges;
  if (pe === undefined) return; // parentless sink (pin): absorbs, never dead-ends
  const sole = pe.nextParent === undefined;
  for (let e: LensLink | undefined = pe; e !== undefined; e = e.nextParent) {
    const p = e.parent;
    if (isReadOnlyDerived(p)) {
      if (sole) {
        cell.bflags |= BF.WriteBlocked; // markDown would throw at this dead-end
        return;
      }
    } else if (p.bflags & BF.WriteBlocked) {
      cell.bflags |= BF.WriteBlocked; // a descended parent dead-ends deeper
      return;
    }
  }
}

/** Install a hook fired on every source value-change; returns a restore fn. */
export function setCellWriteHook(fn: ((cell: Cell<unknown>) => void) | undefined): () => void {
  const prev = writeHook;
  writeHook = fn;
  return () => {
    writeHook = prev;
  };
}

// ─────────────────────────────────────────────────────────────────────────
// Forward graph engine (internal) — alien-signals verbatim.
// ─────────────────────────────────────────────────────────────────────────

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
  if (COUNTS) counts.link++;
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
  if (COUNTS) counts.unlink++;
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
  if (COUNTS) counts.propagate++;
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
  if (COUNTS) counts.checkDirty++;
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

// ─────────────────────────────────────────────────────────────────────────
// Backward sidecar (internal) — the `_bwd` payload: merge / spec / complement.
// ─────────────────────────────────────────────────────────────────────────

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
// pin) carries one; writable iff `_bwd !== undefined`. The backward shape is read
// off field presence rather than a tag: `merge` set ⇒ fan-in fold; `stateful` set ⇒
// complement-carrying; no `parentEdges` ⇒ pin sink; `scatter` ⇒ tuple `put`. The
// one bit that isn't recoverable from topology is scalar-vs-tuple `put` (a 1-parent
// split still takes a tuple), hence `scatter`.
class BwdSpec {
  /** Lens `put` (dual of `getter`): `put(target)` for 1→1 / multi-out (a
   *  source-reading lens reads its parents at walk time), `put(target, sources, c)`
   *  for stateful. `undefined` for a merge (folds) or pin (absorbs). */
  // biome-ignore lint/suspicious/noExplicitAny: put fn is opaque shape
  put: ((target: any, current?: any) => any) | undefined = undefined;
  /** Fold payload; present ⇒ a fan-in merge. */
  merge: MergeNode<unknown> | undefined = undefined;
  /** Complement state; present ⇒ a complement-carrying (stateful) lens. */
  stateful: StatefulCore | undefined = undefined;
  /** `put` yields a per-parent tuple (split / stateful) vs a scalar (1→1). The
   *  only discriminant not derivable from topology (a 1-parent split is a tuple). */
  scatter = false;
}

/** Runtime state of a symmetric-lens complement, kept off `BwdSpec` so plain
 *  lenses don't carry its slots. See the stateful-lens header for the theory
 *  (symmetric/edit lenses) and the version-stamp provenance. */
class StatefulCore {
  /** Engine-owned memory the view discards. */
  complement: unknown;
  /** Advance the complement: `step(sources, complement)`. Run only when the
   *  sources actually moved (the engine gates it; see the stateful header). */
  // biome-ignore lint/suspicious/noExplicitAny: opaque step shape
  step: (sources: any, complement: any) => any;
  /** Sum of the parents' `version`s as of the last sync. Sources moved iff the
   *  live sum differs — the lazy own-vs-external provenance that replaces a value
   *  witness. A read syncs it after stepping; a back-write re-stamps it post-order
   *  (own writes don't re-step, so `bwd` must leave the complement consistent).
   *  Seeded to `-1` (sums are ≥ 0) so the first use always folds the sources in. */
  stamp = -1;
  constructor(
    complement: unknown,
    // biome-ignore lint/suspicious/noExplicitAny: opaque step shape
    step: (sources: any, complement: any) => any,
  ) {
    this.complement = complement;
    this.step = step;
  }
}

// ─────────────────────────────────────────────────────────────────────────
// Public API — sentinels, read/write shapes, and value-coercion helpers.
// ─────────────────────────────────────────────────────────────────────────

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

/** Per-position value types behind a tuple of read shapes (the tuple form of {@link Inner}). */
type ReadValues<P extends readonly Read<unknown>[]> = { [K in keyof P]: Inner<P[K]> };

/** {@link ReadValues} with each slot also admitting `SKIP` — the per-parent back-update shape. */
type ReadValuesOrSkip<P extends readonly Read<unknown>[]> = { [K in keyof P]: Inner<P[K]> | Skip };

/** Any `Cell` subclass constructor — the constraint for polymorphic-`this` statics. */
// biome-ignore lint/suspicious/noExplicitAny: variance escape for polymorphic-this statics
type AnyCellCtor = new (...args: never[]) => Cell<any>;

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
  /** Debug label; surfaces in cyclic-read errors and graph dumps (see debug.ts). */
  name?: string;
}

/** A lens as a first-class value, unbound from any source: `get` projects A→B,
 *  `put` writes B back into an A. Apply with `cell.through(optic)`; build with
 *  `optic` / `iso` / `atKey` / `compose` (optic.ts). `readsSource` is `false`
 *  only for an `iso`, letting `through` bind a cheaper 1-arg backward. */
export interface Optic<A, B> {
  readonly get: (a: A) => B;
  readonly put: (b: B, a: A) => A;
  readonly readsSource: boolean;
  /** Compose with a following optic (this first, then `next`). */
  through<C>(next: Optic<B, C>): Optic<A, C>;
}

// ─────────────────────────────────────────────────────────────────────────
// Public API — the Cell class (the one user-facing reactive primitive).
// ─────────────────────────────────────────────────────────────────────────

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

  /** @internal Lens-edges to my back-targets (down); dual of `deps`. `markDown`/
   *  `backResolve` descend this toward sources. Index-ordered. */
  parentEdges: LensLink | undefined;
  /** @internal */
  parentEdgesTail: LensLink | undefined;
  /** @internal Lens-edges to my lens-children (up); dual of `subs`. `resolveCone`
   *  ascends this toward the armed views. */
  childEdges: LensLink | undefined;
  /** @internal */
  childEdgesTail: LensLink | undefined;

  /** @internal Backward flag word (`BF`), dual of forward `flags`. */
  bflags: number;

  /** @internal Visit epoch for `backResolve`'s collect phase (dedups diamonds
   *  without a Set; compared against the global `backCycle`). */
  bEpoch: number;

  /** @internal Monotone committed-change counter. A stateful lens sums its
   *  parents' versions to detect "did my sources move since I last synced?" —
   *  the lazy provenance that replaces a value witness (see the stateful header). */
  version: number;

  /** Optional debug label (`cell(0, { name })`); used by errors and graph dumps. */
  name: string | undefined;

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
    this.parentEdges = undefined;
    this.parentEdgesTail = undefined;
    this.childEdges = undefined;
    this.childEdgesTail = undefined;
    this.bflags = BF.None;
    this.bEpoch = 0;
    this.version = 0;
    this.name = undefined;
    if (opts !== undefined) {
      if (opts.equals !== undefined) this._equals = opts.equals;
      if (opts.watched !== undefined) this._watched = opts.watched;
      if (opts.unwatched !== undefined) this._unwatchedHook = opts.unwatched;
      if (opts.name !== undefined) this.name = opts.name;
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
      this.version++; // stamp the change for stateful-lens provenance (sum-of-versions)
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
      if (COUNTS) counts.recompute++;
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
        const changed = !this._equals(old, next);
        if (changed) this.version++; // derived commit: stamp for stateful provenance
        return changed;
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
    // Backward dual of `unlink` clearing us from each parent's `subs`: release
    // the parent→child retaining edge (the `childEdges` up-list) so a disposed
    // view stops being pinned by a long-lived source. Our own down-list
    // (`parentEdges`) stays — a later arm re-links via `markDown`. Skip a still
    // back-marked view (a pending write needs its edge); rare and bounded.
    if (!(this.bflags & BACK_MARKED)) {
      for (let e = this.parentEdges; e !== undefined; e = e.nextParent) {
        if (e.linked) unlinkChild(e);
      }
    }
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
    return buildLens(this.constructor as CellCtor<Cell<T>>, [this, fwd, bwd]) as this;
  }

  /** Read-only same-type view: the RO dual of the endo `.lens`. For a cross-type view use the typed static
   *  `Target.derive(src, fn)`. */
  derive(this: Cell<T>, fn: (v: T) => T): this {
    return buildDerived(this.constructor as CellCtor<Cell<T>>, () => fn(this.value)) as this;
  }

  /** Apply optic value(s) as a writable lens: `c.through(o)` ≡ `lens(c, o.get,
   *  o.put)`; multiple optics compose left-to-right (`c.through(a, b)` = `a`
   *  then `b`). Cross-type, unlike the endomorphic instance `.lens`. */
  through<B>(this: Cell<T>, o: Optic<T, B>): Writable<Cell<B>>;
  through<B, C>(this: Cell<T>, o1: Optic<T, B>, o2: Optic<B, C>): Writable<Cell<C>>;
  through<B, C, D>(
    this: Cell<T>,
    o1: Optic<T, B>,
    o2: Optic<B, C>,
    o3: Optic<C, D>,
  ): Writable<Cell<D>>;
  // biome-ignore lint/suspicious/noExplicitAny: heterogeneous optic chain
  through(this: Cell<T>, ...optics: Optic<any, any>[]): Writable<Cell<unknown>> {
    // Fold via each optic's own `through` (no import of optic.ts → no cycle).
    const o = optics.length === 1 ? optics[0]! : optics.reduce((a, b) => a.through(b));
    // Preserve put arity: a source-reading optic binds 2-arg; an iso binds 1-arg
    // (reconstruct, no source read), matching `lens`'s `bwd.length` dispatch.
    const bwd = o.readsSource
      ? (target: unknown, cur: unknown) => o.put(target, cur)
      : (target: unknown) => o.put(target, undefined);
    return lens(this as Read<unknown>, o.get, bwd) as Writable<Cell<unknown>>;
  }

  /** Backward fan-in: forwards its parent's value unchanged; on write, folds N
   *  contributors into one value. `fold` defaults to last-writer-wins. */
  merge(this: Cell<T>, fold?: MergeFold<T>): Cell<T> {
    if (this.getter !== undefined && this._bwd === undefined) {
      throw new TypeError("merge: receiver is read-only");
    }
    const parent = this as Cell<T>;
    const cell = new (this.constructor as CellCtor<Cell<T>>)();
    cell.flags = F.Mutable | F.Dirty;
    cell.getter = (): T => parent.value;
    const b = (cell._bwd = new BwdSpec());
    b.merge = new MergeNode<T>(fold) as MergeNode<unknown>;
    linkLens(cell as Cell<unknown>, parent as Cell<unknown>, 0);
    setWriteBlocked(cell as Cell<unknown>);
    return cell as Cell<T>;
  }

  /** Read-only typed view. `Cls.derive(parent, fn)` (1-input),
   *  `Cls.derive(parents, fn)` (N-input), or `Cls.derive(fn)` (closure).
   *  Polymorphic-`this`: `Vec.derive(...)` → `Vec`. */
  static derive<C extends AnyCellCtor, P>(
    this: C,
    parent: Read<P>,
    fn: (v: P) => Inner<InstanceType<C>>,
  ): InstanceType<C>;
  static derive<C extends AnyCellCtor, P extends readonly Read<unknown>[]>(
    this: C,
    parents: P,
    fn: (vals: ReadValues<P>) => Inner<InstanceType<C>>,
  ): InstanceType<C>;
  static derive<C extends AnyCellCtor>(this: C, fn: () => Inner<InstanceType<C>>): InstanceType<C>;
  // biome-ignore lint/suspicious/noExplicitAny: dispatch
  static derive(this: any, ...args: any[]): any {
    return buildDerive(this, args);
  }

  /** Writable lens. `Cls.lens(parent, fwd, bwd)` for one input,
   *  `Cls.lens(parents, fwd, bwd)` for N; a 2-arg `bwd` reads the source,
   *  a 1-arg `bwd` reconstructs it. `Cls.lens(parent(s), spec)` builds a
   *  complement-carrying lens from `{ init, step, fwd, bwd }`. */
  static lens<C extends AnyCellCtor, P>(
    this: C,
    parent: Read<P>,
    fwd: (v: P) => Inner<InstanceType<C>>,
    bwd: (target: Inner<InstanceType<C>>, v: P) => P,
  ): Writable<InstanceType<C>>;
  static lens<C extends AnyCellCtor, P extends readonly Read<unknown>[]>(
    this: C,
    parents: P,
    fwd: (vals: ReadValues<P>) => Inner<InstanceType<C>>,
    bwd: (target: Inner<InstanceType<C>>, vals: ReadValues<P>) => BackUpdates<ReadValuesOrSkip<P>>,
  ): Writable<InstanceType<C>>;
  static lens<C extends AnyCellCtor, P, Cm>(
    this: C,
    parent: Read<P>,
    spec: StatefulLensSpec1<P, Inner<InstanceType<C>>, Cm>,
  ): Writable<InstanceType<C>>;
  static lens<C extends AnyCellCtor, P extends readonly Read<unknown>[], Cm>(
    this: C,
    parents: P,
    spec: StatefulLensSpec<ReadValues<P>, Inner<InstanceType<C>>, Cm>,
  ): Writable<InstanceType<C>>;
  // biome-ignore lint/suspicious/noExplicitAny: dispatch
  static lens(this: any, ...args: any[]): any {
    return buildLens(this, args);
  }

  /** Type predicate against this class: `Vec.is(x)` narrows `x` to `Vec`.
   *  Inherited static; works for any subclass via polymorphic `this`. */
  static is<C extends AnyCellCtor>(this: C, v: unknown): v is InstanceType<C> {
    return v instanceof this;
  }

  /** Coerce `Val<Inner<Cls>>` → `Cls`: instance → identity, RO cell →
   *  tracked `derive`, literal → fresh seed. */
  static coerce<C extends AnyCellCtor>(this: C, v: Val<Inner<InstanceType<C>>>): InstanceType<C> {
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
  static pin<C extends AnyCellCtor>(this: C, v: Inner<InstanceType<C>>): Writable<InstanceType<C>> {
    const cell = new (this as unknown as CellCtor<Cell<unknown>>)();
    cell.flags = F.Mutable | F.Dirty;
    cell.getter = (): unknown => v;
    // Parentless `_bwd`: `writeBack` absorbs it (no parent edges, no closure).
    cell._bwd = new BwdSpec();
    return cell as unknown as Writable<InstanceType<C>>;
  }
}

/** Typed field lens onto `parent.value[key]`. RO parent → RO derive;
 *  writable parent → bidirectional lens with spread-replace `put`. */
export function fieldOf<C extends AnyCellCtor>(
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
  // Spread-replace put, array-aware: cloning an array with object spread would
  // demote it to a plain record, so copy via `slice` and set the index.
  const put = (v: unknown, s: unknown): unknown => {
    if (Array.isArray(s)) {
      const next = s.slice();
      next[key as number] = v;
      return next;
    }
    return { ...(s as object), [key]: v };
  };
  return buildLens(ctor, [parent as Cell<unknown>, get, put]) as InstanceType<C>;
}

// ─────────────────────────────────────────────────────────────────────────
// Lens / derive builders (internal) — wire a `Cls` instance into each mode.
// ─────────────────────────────────────────────────────────────────────────

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

// Shared N-input read getter: refill a construction-owned buffer from the parents
// each read (no per-read alloc), then apply `fwd`. Identical hot closure whether
// the node is a read-only derive-N or a writable split lens.
function arrayGetter(
  parents: Cell<unknown>[],
  fwd: (vals: readonly unknown[]) => unknown,
): () => unknown {
  const n = parents.length;
  const vals = new Array<unknown>(n);
  return () => {
    for (let i = 0; i < n; i++) vals[i] = parents[i]!.value;
    return fwd(vals);
  };
}

// One writable-lens constructor for both shapes. The `Array.isArray` branch is paid
// once at construction and installs the matching specialized hot closures — scalar
// scalar `getter`/`put` for 1→1, the buffer-loop getter + tuple `put` (`scatter`)
// for N→M — so neither hot path changes. A 2-arg call is the
// complement-carrying form and routes to `buildStateful`. `bwd` is always present
// (a read-only N view is a `derive`, built via `buildDerive`).
// biome-ignore lint/suspicious/noExplicitAny: dispatch over the untyped call forms
function buildLens<C extends Cell<any>>(Cls: CellCtor<C>, args: any[]): C {
  const parent0 = args[0];
  if (args.length === 2) {
    return Array.isArray(parent0)
      ? buildStateful(Cls, parent0 as Cell<unknown>[], args[1])
      : buildStateful1(Cls, parent0 as Cell<unknown>, args[1]);
  }
  let parent = parent0;
  let fwd = args[1];
  let bwd = args[2] as (t: unknown, s?: unknown) => unknown;
  // Object-keyed parents → rewrite to the positional array form (key order
  // fixed once; omitted backward keys become SKIP). The tuple fast path below
  // is untouched.
  if (
    parent0 !== null &&
    typeof parent0 === "object" &&
    !Array.isArray(parent0) &&
    !(parent0 instanceof Cell)
  ) {
    const keys = Object.keys(parent0 as object);
    const rec = parent0 as Record<string, Cell<unknown>>;
    const fwdObj = fwd as (vals: Record<string, unknown>) => unknown;
    const bwdObj = bwd as unknown as (
      t: unknown,
      vals: Record<string, unknown>,
    ) => Record<string, unknown>;
    const toObj = (vals: readonly unknown[]): Record<string, unknown> => {
      const o: Record<string, unknown> = {};
      for (let i = 0; i < keys.length; i++) o[keys[i] as string] = vals[i];
      return o;
    };
    parent = keys.map(k => rec[k] as Cell<unknown>);
    fwd = (vals: readonly unknown[]) => fwdObj(toObj(vals));
    bwd = ((t: unknown, vals: readonly unknown[]) => {
      const o = bwdObj(t, toObj(vals));
      return keys.map(k => (k in o ? o[k] : SKIP));
    }) as (t: unknown, s?: unknown) => unknown;
  }
  const readsSource = (bwd as (...xs: unknown[]) => unknown).length >= 2;
  const cell = new Cls();
  cell.flags = F.Mutable | F.Dirty;
  const b = (cell._bwd = new BwdSpec());
  if (Array.isArray(parent)) {
    const parents = parent as Cell<unknown>[];
    const n = parents.length;
    cell.getter = arrayGetter(parents, fwd as (vals: readonly unknown[]) => unknown) as () => never;
    b.scatter = true;
    for (let i = 0; i < n; i++) linkLens(cell as Cell<unknown>, parents[i]!, i);
    if (readsSource) {
      // Own reused buffer (not the getter's) to avoid aliasing; `bwd` consumes it
      // synchronously and must not retain it.
      const argbuf = new Array<unknown>(n);
      const bwdN = bwd as (target: unknown, vals: readonly unknown[]) => unknown;
      b.put = (target: unknown): unknown => {
        for (let i = 0; i < n; i++) argbuf[i] = backPrimal(parents[i]!);
        return bwdN(target, argbuf);
      };
    } else {
      const bwd0 = bwd as (target: unknown) => unknown;
      b.put = (target: unknown): unknown => bwd0(target);
    }
  } else {
    const p = parent as Cell<unknown>;
    cell.getter = (() => (fwd as (v: unknown) => unknown)(p.value)) as () => never;
    // Source-reading lenses linearize at the parent's primal (`backPrimal`), so the
    // engine always calls the 1-arg form and never recomputes the parent's cone.
    b.put = readsSource ? (t: unknown): unknown => bwd(t, backPrimal(p)) : bwd;
    linkLens(cell as Cell<unknown>, p, 0);
  }
  setWriteBlocked(cell as Cell<unknown>);
  return cell;
}

// Stateful lens (complement-carrying) — a lens that carries memory the source
// can't hold (a `lowercase` view's casing, a principal-axis angle's winding):
//   init(srcs)        → seed the complement
//   fwd(srcs, c)      → the view
//   step(srcs, c)     → advance the complement (optional; defaults to `init`)
//   bwd(target, s, c) → { updates, complement } (per-parent + new complement)
// All four are pure and read no cells; the engine owns `c`. A single-source lens
// (`lens(parent, spec)`, one cell not an array) takes the scalar fast-path
// (`StatefulLensSpec1`): `init`/`step`/`fwd`/`bwd` see the source value directly,
// and `bwd` returns a scalar `{ update, complement }` — no tuple, no `vals` buffer.
//
// This is a SYMMETRIC LENS WITH COMPLEMENT in the literature (Hofmann, Pierce &
// Wagner, "Symmetric Lenses", POPL 2011): `step`+`fwd` are the complement-carrying
// `putr`, `bwd` is `putl`, `init` seeds the shared complement `C`. The complement
// is path-dependent (winding, casing), so this is a genuine symmetric lens, not a
// constant-complement ("very well-behaved") one where `S ≅ V × C`.
//
// PROVENANCE without a flag. `step` must run on an *outside* change and be skipped
// on this lens's own back-write (else trim-style lenses re-derive from a degraded
// source and lose the complement). The engine decides which by asking "did my
// sources move since I last synced?": each cell carries a monotone `version`
// (bumped on every committed change), and the lens remembers the SUM of its
// parents' versions (`StatefulCore.stamp`). Live sum ≠ stamp ⇒ a source moved ⇒
// step. This is the lazy, O(1)-per-lens replacement for a value witness: a
// co-writer bumping a shared source during draining raises the sum (caught), and
// an external write before the next read bumps it too (caught) — both because the
// version lives on the source, not on a flag on the lens. A single bit cannot do
// this (it can't survive an external write landing between back-write and read).
//
// An own back-write moves its sources too, so `writeBack` re-stamps the lens
// post-order (after the sources are written): the sum is back in sync, so the next
// read skips `step` and trusts `bwd`'s complement. The contract this buys: `bwd`
// must return a complement CONSISTENT with its `updates` — it can't stash a stale
// value and lean on a later `step` to repair it (there won't be one). The stamp is
// seeded to `-1` so the very first use always folds the sources into the seed.
//
// This is the degenerate EDIT LENS (Hofmann–Pierce–Wagner edit lenses; Diskin,
// Xiong & Czarnecki delta lenses) with the trivial alphabet `{ Replace(v) }`; when
// the alphabet grows, `step`/`bwd` take the edit and the version-stamp generalizes
// to the edit's provenance, received directly rather than reconstructed.
//
// Law `step` must satisfy: re-running it on an unchanged source is a fixpoint —
//   step(s, step(s, c)) === step(s, c).
// This is what lets the engine SKIP `step` on an own back-write (the complement
// from `bwd` is already settled): the `init` default returns a pure function of
// `s`; an accumulating `step` is a no-op once the source stops moving.

export interface StatefulBwd<S extends readonly unknown[], C> {
  /** Per-parent updates: a value (written verbatim, `undefined` included) or
   *  `SKIP` to leave that parent. A short array skips the trailing parents. */
  updates: BackUpdates<{ [K in keyof S]: S[K] | Skip }>;
  complement: C;
}

export interface StatefulLensSpec<S extends readonly unknown[], V, C> {
  init: (sources: S) => C;
  /** Advance the complement on an outside change. Optional — defaults to `init`
   *  (the memoryless refresh); the engine runs it only when sources actually move. */
  step?: (sources: S, complement: C) => C;
  fwd: (sources: S, complement: C) => V;
  bwd: (target: V, sources: S, complement: C) => StatefulBwd<S, C>;
}

/** Single-source `bwd` result: a scalar `update` (or `SKIP`) plus the complement. */
export interface StatefulBwd1<S, C> {
  update: S | Skip;
  complement: C;
}

/** Single-source stateful spec — the scalar fast-path of `StatefulLensSpec`: one
 *  parent, so `init`/`step`/`fwd`/`bwd` take the source value directly, not a tuple. */
export interface StatefulLensSpec1<S, V, C> {
  init: (source: S) => C;
  step?: (source: S, complement: C) => C;
  fwd: (source: S, complement: C) => V;
  bwd: (target: V, source: S, complement: C) => StatefulBwd1<S, C>;
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
  // Default `step` is the memoryless refresh (`init`); the engine runs it only on
  // an outside change, so the `external ? init(s) : c` idiom needs no user `step`.
  const init = spec.init as (s: unknown) => unknown;
  const step = (spec.step ?? init) as (s: unknown, c: unknown) => unknown;
  const sc = (b.stateful = new StatefulCore(spec.init(seed), step));
  // Sentinel: version sums are ≥ 0, so the first read (or back-write) always
  // steps once, folding the initial sources into the seed complement. The
  // `init`/`step` split is seed-then-fold: `init` need not see the sources.
  sc.stamp = -1;
  const fwd = spec.fwd as (s: unknown, c: unknown) => unknown;
  b.put = spec.bwd as (t: unknown, c?: unknown) => unknown;
  b.scatter = true;
  for (let i = 0; i < n; i++) linkLens(cell as Cell<unknown>, parents[i]!, i);
  cell.getter = (() => {
    let ver = 0;
    for (let i = 0; i < n; i++) {
      vals[i] = parents[i]!.value;
      ver += parents[i]!.version;
    }
    // Step only when sources moved since the last sync (lazy own-vs-external).
    if (ver !== sc.stamp) {
      if (COUNTS) counts.step++;
      sc.complement = sc.step(vals, sc.complement);
      sc.stamp = ver;
    }
    return fwd(vals, sc.complement);
  }) as () => never;
  setWriteBlocked(cell as Cell<unknown>);
  return cell;
}

// Single-source stateful fast-path: one parent, so no `vals` buffer and a scalar
// `step`/`fwd`/`bwd` — the version stamp is just the parent's `version`. Same
// provenance and laziness as the N-source `buildStateful`, minus the array work.
// biome-ignore lint/suspicious/noExplicitAny: variance escape
function buildStateful1<C extends Cell<any>>(
  Cls: CellCtor<C>,
  parent: Cell<unknown>,
  // biome-ignore lint/suspicious/noExplicitAny: opaque spec
  spec: StatefulLensSpec1<any, any, any>,
): C {
  const cell = new Cls();
  cell.flags = F.Mutable | F.Dirty;
  const b = (cell._bwd = new BwdSpec());
  const init = spec.init as (s: unknown) => unknown;
  const step = (spec.step ?? init) as (s: unknown, c: unknown) => unknown;
  const sc = (b.stateful = new StatefulCore(init(parent.peek()), step));
  sc.stamp = -1; // sentinel: first use folds the source in (see `buildStateful`)
  const fwd = spec.fwd as (s: unknown, c: unknown) => unknown;
  b.put = spec.bwd as (t: unknown, c?: unknown) => unknown;
  // `scatter` stays false: writeBack routes this through the scalar stateful branch.
  linkLens(cell as Cell<unknown>, parent, 0);
  cell.getter = (() => {
    const x = parent.value;
    const ver = parent.version;
    if (ver !== sc.stamp) {
      if (COUNTS) counts.step++;
      sc.complement = sc.step(x, sc.complement);
      sc.stamp = ver;
    }
    return fwd(x, sc.complement);
  }) as () => never;
  setWriteBlocked(cell as Cell<unknown>);
  return cell;
}

// One read-only-derive constructor: a bare closure (`derive(fn)`), a single tracked
// read (`derive(p, fn)`), or an N-parent read (`derive(ps, fn)`) — each lands in
// `buildDerived` with the matching getter. (Writable `lens(...)` is `buildLens`;
// statics pass the typed subclass, free functions plain `Cell`, so neither drifts.)
// biome-ignore lint/suspicious/noExplicitAny: dispatch over the untyped call forms
function buildDerive<C extends Cell<any>>(Cls: CellCtor<C>, args: any[]): C {
  if (args.length === 1) return buildDerived(Cls, args[0]);
  const parent = args[0];
  const fn = args[1];
  if (Array.isArray(parent)) return buildDerived(Cls, arrayGetter(parent as Cell<unknown>[], fn));
  return buildDerived(Cls, () => fn((parent as Cell<unknown>).value));
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
          `Cyclic computed: ${this.name ?? (this.constructor as { name?: string }).name ?? "?"} read its own value`,
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
    // excluded (`scatter` but `stateful` set) — peeking would step its complement.
    if (b.scatter && b.stateful === undefined && this._equals(next, this.peek())) {
      return;
    }
    arm(this as Cell<unknown>, next);
  },
  enumerable: false,
  configurable: false,
});

// ─────────────────────────────────────────────────────────────────────────
// Backward graph engine (internal) — arm / markDown / resolveCone / writeBack.
// ─────────────────────────────────────────────────────────────────────────

/** Backward push: arm a back-write of `target` on view `node` (dual of a source
 *  `set`). A re-write of a still-armed view keeps only the last target (the path
 *  is already marked); `autoFlush` wakes the effects the push woke. */
function arm(node: Cell<unknown>, target: unknown): void {
  // Structural reject first: a write whose back-spine dead-ends throws before
  // touching any backward state (atomic — nothing armed, nothing marked).
  if (node.bflags & BF.WriteBlocked) {
    if (COUNTS) counts.armBlocked++;
    throw new TypeError("Cannot write through to a computed");
  }
  if (COUNTS) counts.arm++;
  if (!(node.bflags & BF.Dirty)) {
    markDown(node); // flag path + wake cones FIRST (a throw arms nothing)
    node.bflags |= BF.Dirty;
  }
  node.pendingValue = target;
  autoFlush();
}

/** MARK (push), dual of `propagate`: descend `start`'s static back-path down
 *  `parentEdges` to its sources, flag each `BF.Pending`, and wake every source's
 *  forward cone. Runs no `put`.
 *
 *  `BF.Pending` self-dedups: an already-marked node has its subtree marked, so
 *  descent stops (diamonds cost one visit). A read-only-derived parent is skipped
 *  (a split routes around it; a sole one is pre-rejected by `arm`'s
 *  `BF.WriteBlocked` check). The 1→1 spine allocates nothing. */
function markDown(start: Cell<unknown>): void {
  let node: Cell<unknown> = start;
  let stack: Cell<unknown>[] | undefined;
  for (;;) {
    if (COUNTS) counts.markDownVisit++;
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
      for (let e = node.parentEdges; e !== undefined; e = e.nextParent) {
        linkChild(e); // register this view on the parent's up-list (arm-order)
        const p = e.parent;
        // Read-only parent: a split routes around it (its `put` SKIPs it). A sole
        // read-only parent can't be routed — but that's `BF.WriteBlocked`, already
        // rejected in `arm`, so the descent never reaches such a node here.
        if (isReadOnlyDerived(p)) continue;
        if (next === undefined) next = p;
        else (stack ??= []).push(p);
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
 *  Ascend `childEdges` (only `BACK_MARKED` children) to the armed views,
 *  `writeBack`ing each. Source-centric — a source reflects all its writers, so a
 *  call on it resolves every co-writer together and commits once.
 *
 *  Iterative post-order over the back-cone, via an explicit frame stack of
 *  {node, next-child cursor}. On entering a
 *  node (pre): clear a merge's contributions, then `writeBack` if it holds an armed
 *  target. After its children drain (post): clear `BF.Pending`, then fold a merge.
 *  Children are walked in forward `childEdges` order (so a co-writer's last write
 *  wins) and a per-call `bEpoch` dedups diamonds — the merge fold lands at its true
 *  post-order position, interleaved with sibling writes, not deferred.
 *  Idempotent, so phase-2 of `backResolve` can call it unconditionally. */
function resolveCone(root: Cell<unknown>): void {
  const epoch = ++backCycle;
  root.bEpoch = epoch;
  enterCone(root);
  rcNode[0] = root;
  rcEdge[0] = root.childEdges;
  let fp = 1;
  while (fp > 0) {
    let e = rcEdge[fp - 1];
    let descended = false;
    while (e !== undefined) {
      const c = e.child;
      e = e.nextChild;
      if (c.bflags & BACK_MARKED && c.bEpoch !== epoch) {
        c.bEpoch = epoch;
        rcEdge[fp - 1] = e; // resume here when we pop back to this frame
        enterCone(c);
        rcNode[fp] = c;
        rcEdge[fp] = c.childEdges;
        fp++;
        descended = true;
        break;
      }
    }
    if (descended) continue;
    // Children exhausted → post-order work for this frame's node.
    const node = rcNode[--fp]!;
    node.bflags &= ~BF.Pending;
    const b = node._bwd;
    // A merge has exactly one parent-edge; fold its gathered contributions to it.
    if (b !== undefined && b.merge !== undefined) foldMerge(node.parentEdges!.parent, b.merge);
  }
}

/** `resolveCone` pre-order work: reset a merge's buffer, drive an armed target. */
function enterCone(node: Cell<unknown>): void {
  if (COUNTS) counts.resolveConeVisit++;
  const b = node._bwd;
  if (b !== undefined && b.merge !== undefined) b.merge.contributions.length = 0;
  if (node.bflags & BF.Dirty) {
    node.bflags &= ~BF.Dirty;
    writeBack(node, node.pendingValue);
  }
}

/** PULL entry for a back-marked `start`. A source resolves its own cone; a view
 *  first descends its marked back-path to the sources, then resolves each. The
 *  `draining` guard stops a `put`'s source read from re-entering.
 *
 *  Two-phase: phase 1 collects the distinct sources (clearing nothing), phase 2
 *  `resolveCone`s each. Capturing the full source set before any `writeBack` runs
 *  means a sibling commit can't drop a co-writer's source from the worklist. A
 *  per-call `bEpoch` stamp dedups the descent (diamonds visit each node once). */
function backResolve(start: Cell<unknown>): void {
  draining = true;
  ++batchDepth;
  const prev = activeSub;
  activeSub = undefined;
  const sourcesBase = backSources.length;
  const epoch = ++backCycle;
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
      for (let e = node.parentEdges; e !== undefined; e = e.nextParent) {
        const p = e.parent;
        if (!(p.bflags & BF.Pending) || p.bEpoch === epoch) continue;
        p.bEpoch = epoch;
        if (isSource(p)) {
          reached = true;
          backSources.push(p);
        } else if (next === undefined) next = p;
        else (stack ??= []).push(p);
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
 *  a branch; every other slot is written verbatim, `undefined` included.
 *
 *  Iterative depth-first, left-to-right (children pushed in reverse onto the
 *  pooled `wbNode`/`wbTarget` stack), so a sibling read sees a prior sibling's
 *  staged write — bounded by pooled stack memory, not the call stack. */
function writeBack(node: Cell<unknown>, target: unknown): void {
  wbNode[0] = node;
  wbTarget[0] = target;
  let top = 1;
  let sTop = 0;
  while (top > 0) {
    if (COUNTS) counts.writeBackVisit++;
    const cur = wbNode[--top]!;
    const tgt = wbTarget[top];
    if (isSource(cur)) {
      cur._writeSource(tgt); // staged now, visible to later siblings
      // Clear this source's `BF.Pending`, then re-assert iff a lens-child is STILL
      // armed (an overlapping co-writer) — else that write is lost, and leaving it
      // set unconditionally would strand `BF.Pending` on every fan-in source.
      // Scan from the TAIL: `resolveCone` drives children head→tail, so the last
      // still-armed co-writer sits near the tail — found in O(1) until the final
      // one, turning a fan-in's re-assert from O(N²) into O(N). (Order is
      // irrelevant; this is a find-any.)
      cur.bflags &= ~BF.Pending;
      for (let e = cur.childEdgesTail; e !== undefined; e = e.prevChild) {
        if (COUNTS) counts.reassertScan++;
        if (e.child.bflags & BACK_MARKED) {
          cur.bflags |= BF.Pending;
          break;
        }
      }
      continue;
    }
    cur.bflags &= ~BF.Pending; // passing through clears the path marker
    const b = cur._bwd;
    if (b === undefined) throw new TypeError("Cannot write through to a computed");
    const mn = b.merge;
    if (mn !== undefined) {
      mn.contributions.push(tgt); // gathered here; `resolveCone` folds post-order
      continue;
    }
    const pe = cur.parentEdges;
    if (pe === undefined) continue; // pin sink (parentless): absorb
    const sc = b.stateful;
    if (sc !== undefined && !b.scatter) {
      // Single-source stateful fast-path (scalar `bwd`); one index-0 parent edge.
      const p = pe.parent;
      const x = p.value;
      const ver = p.version;
      if (ver !== sc.stamp) {
        if (COUNTS) counts.step++;
        sc.complement = sc.step(x, sc.complement);
      }
      if (COUNTS) counts.put++;
      const res = (b.put as (t: unknown, s: unknown, c: unknown) => StatefulBwd1<unknown, unknown>)(
        tgt,
        x,
        sc.complement,
      );
      sc.complement = res.complement;
      wbStateful[sTop++] = cur;
      const u = res.update;
      if (u !== SKIP) {
        wbNode[top] = p;
        wbTarget[top] = u;
        top++;
      } else {
        // Stash: the view moved through the complement alone (see the scatter case).
        cur.flags |= F.Dirty;
        const subs = cur.subs;
        if (subs !== undefined) propagate(subs, runDepth > 0, activeExcluded);
      }
      continue;
    }
    if (b.scatter) {
      // Gather ordered parents (index-ordered edges) for the tuple `put`.
      let n = 0;
      for (let e: LensLink | undefined = pe; e !== undefined; e = e.nextParent) n++;
      const parents = new Array<Cell<unknown>>(n);
      for (let e: LensLink | undefined = pe; e !== undefined; e = e.nextParent)
        parents[e.index] = e.parent;
      let out: ReadonlyArray<unknown>;
      if (sc !== undefined) {
        const vals = new Array<unknown>(n);
        let ver = 0;
        for (let i = 0; i < n; i++) {
          vals[i] = parents[i]!.value;
          ver += parents[i]!.version;
        }
        // Refresh the complement only if a source moved since the last sync — e.g.
        // a prior sibling co-writer bumped a shared source. A pure own re-write
        // (sum unchanged) skips it: `bwd` already gets the settled complement.
        if (ver !== sc.stamp) {
          if (COUNTS) counts.step++;
          sc.complement = sc.step(vals, sc.complement);
        }
        if (COUNTS) counts.put++;
        const res = (
          b.put as (t: unknown, s: unknown, c: unknown) => StatefulBwd<unknown[], unknown>
        )(tgt, vals, sc.complement);
        const upd = res.updates as ReadonlyArray<unknown>;
        // Commit `bwd`'s complement directly; it must be consistent with `updates`
        // (no reliance on a post-write `step`). The stamp is re-set post-order (after
        // the sources are written and their versions bumped) so the next forward read
        // sees an unchanged sum and skips `step` — own-write provenance.
        sc.complement = res.complement;
        wbStateful[sTop++] = cur;
        out = upd;
      } else {
        if (COUNTS) counts.put++;
        out = (b.put as (t: unknown) => ReadonlyArray<unknown>)(tgt);
      }
      // Push non-SKIP children in REVERSE so index 0 is popped (processed) first
      // — depth-first, left-to-right. A short `out` skips the trailing parents.
      let wrote = false;
      const m = out.length < n ? out.length : n;
      for (let i = m - 1; i >= 0; i--) {
        const u = out[i];
        if (u !== SKIP) {
          wrote = true;
          wbNode[top] = parents[i]!;
          wbTarget[top] = u;
          top++;
        }
      }
      // A stateful lens can change its VIEW through the complement alone, moving no
      // source (a "stash"; `!wrote` ⇒ no children pushed). The forward cone never
      // fires, so invalidate this node's cache and propagate to its observers here.
      if (!wrote && sc !== undefined) {
        cur.flags |= F.Dirty;
        const subs = cur.subs;
        if (subs !== undefined) propagate(subs, runDepth > 0, activeExcluded);
      }
      continue;
    }
    // 1→1 lens (single index-0 parent-edge).
    if (COUNTS) counts.put++;
    wbNode[top] = pe.parent;
    wbTarget[top] = (b.put as (t: unknown) => unknown)(tgt);
    top++;
  }
  // Post-order re-stamp: now the sources are written (versions bumped), record
  // each on-path stateful lens's parent-version sum, so its next forward read
  // sees an unchanged sum and skips `step`. Integers only — no `fwd`, no commit.
  for (let i = 0; i < sTop; i++) {
    const sc = wbStateful[i]!._bwd!.stateful!;
    let ver = 0;
    for (let e = wbStateful[i]!.parentEdges; e !== undefined; e = e.nextParent) {
      ver += e.parent.version;
    }
    sc.stamp = ver;
    wbStateful[i] = undefined as unknown as Cell<unknown>;
  }
}

/** Fold a merge's contributions once (policy; default last-writer-wins) and write
 *  the result up to its parent. Called post-order from `resolveCone`. */
function foldMerge(parent: Cell<unknown>, mn: MergeNode<unknown>): void {
  if (COUNTS) counts.fold++;
  const vals = mn.contributions;
  const fold = mn.foldFn;
  let folded: unknown;
  if (fold !== undefined) folded = fold(vals);
  else if (vals.length > 0) folded = vals[vals.length - 1];
  else return; // last-writer-wins with no contributor: leave the parent
  vals.length = 0; // reuse the merge-owned buffer in place (fold must not retain it)
  writeBack(parent, folded);
}

// ─────────────────────────────────────────────────────────────────────────
// Public API — factories (cell / derive / lens) over the builders above.
// ─────────────────────────────────────────────────────────────────────────

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
  fn: (vals: ReadValues<P>) => R,
): Cell<R>;
export function derive<R>(fn: () => R): Cell<R>;
// biome-ignore lint/suspicious/noExplicitAny: dispatch
export function derive(...args: any[]): any {
  return buildDerive(CELL_CTOR, args);
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
  fwd: (vals: ReadValues<P>) => R,
  bwd: (target: R, vals: ReadValues<P>) => ReadValuesOrSkip<P>,
): Writable<Cell<R>>;
export function lens<S extends Record<string, Read<unknown>>, R>(
  parents: S,
  fwd: (vals: { [K in keyof S]: Inner<S[K]> }) => R,
  bwd: (
    target: R,
    vals: { [K in keyof S]: Inner<S[K]> },
  ) => Partial<{ [K in keyof S]: Inner<S[K]> | Skip }>,
): Writable<Cell<R>>;
export function lens<P, R, C>(parent: Read<P>, spec: StatefulLensSpec1<P, R, C>): Writable<Cell<R>>;
export function lens<P extends readonly Read<unknown>[], R, C>(
  parents: P,
  spec: StatefulLensSpec<ReadValues<P>, R, C>,
): Writable<Cell<R>>;
// biome-ignore lint/suspicious/noExplicitAny: dispatch
export function lens(...args: any[]): any {
  return buildLens(CELL_CTOR, args);
}

// ─────────────────────────────────────────────────────────────────────────
// Effects & schedulers — the Effect watcher (internal) and the public
// effect / batch / network / flush surface built on it.
// ─────────────────────────────────────────────────────────────────────────

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
  // Error locality: one effect throwing must not strand its siblings. Drain the
  // whole queue, catching each body; surface the first error after the queue is
  // empty (later errors are dropped — the engine stays consistent, the user still
  // sees a failure). A throwing body isn't re-queued (its `F.Watching` is already
  // cleared); it re-arms on the next wake.
  let err: unknown;
  let threw = false;
  try {
    while (notifyIndex < queuedLength) {
      const e = queued[notifyIndex]!;
      queued[notifyIndex++] = undefined;
      try {
        e._run();
      } catch (ex) {
        if (!threw) {
          err = ex;
          threw = true;
        }
      }
    }
  } finally {
    notifyIndex = 0;
    queuedLength = 0;
    syncFlush = false;
    flushing = false;
  }
  if (threw) throw err;
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
// (an `Effect` in `NoTrack | Exclude` mode), used to build constraint networks.
// Its body fires when any subscribed dep changes; its own writes self-exclude so
// it doesn't re-trigger itself.

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
 *  (instance, key).
 *
 *      get magnitude() {
 *        return cachedDerive(this, "magnitude", Num, v => Math.hypot(v.x, v.y));
 *      } */
// biome-ignore lint/suspicious/noExplicitAny: variance escape, mirrors Cls.derive
export function cachedDerive<S extends Cell<any>, C extends AnyCellCtor>(
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
