// engine.ts — core4 v0: ONE engine for acyclic reactivity AND cyclic propagator
// relaxation, with NO separate solver bolted on the side.
//
// ── The thesis ──────────────────────────────────────────────────────
// The acyclic world is the lazy pull/dirty graph everyone knows: `cell` sources,
// `derive` computeds (lazy, memoized), `effect` observers (microtask-batched).
// The *cyclic* world — propagators that mutually constrain writable cells (the
// layout / IK / constraint case) — is not a second engine. It is the SAME write
// path, run to a fixpoint:
//
//   writing a cell ⇒ enqueue the propagators that read it ⇒ drain the worklist,
//   each propagator re-running its `step` ⇒ a step's writes are EQUALITY-GATED,
//   so a write that doesn't change a value enqueues nothing.
//
// That single rule is what makes cycles terminate for free: a consistent cycle
// (a⇄b where the maps agree) settles the instant a re-derivation reproduces the
// value already there — exactly how vezwork's `to`/`ob` layout propagators stop.
// An *inconsistent* cycle (a=b+1 ∧ b=a+1) genuinely cannot settle; we bound the
// drain with a step cap and throw, which is the honest answer (no confluence, no
// termination guarantee for arbitrary cycles — same status as any divergent loop).
//
// ── Two dependency edges per cell, kept apart on purpose ─────────────
//   • `subs`     — pull consumers (derive/effect). Drive lazy invalidation.
//   • `triggers` — propagators that read this cell. Drive the relaxation drain.
// Propagator `step`s read with `.peek()` (untracked) and declare their reads
// explicitly, so the two graphs never bleed into each other.
//
// ── Deliberately omitted (v0) ───────────────────────────────────────
//   • Lattices / TMS / contradiction provenance — concrete relaxation only.
//   • SCC discovery — not needed; equality-gating handles cycles structurally.
//   • alien's bitflag pull core — this proto uses plain sets for clarity.

/** A reactive computation (derive or effect): tracks the nodes it reads. */
interface Computation {
  deps: Set<Source>;
  /** derive: mark stale + cascade. effect: schedule. */
  notify(): void;
}

/** Anything readable/trackable: a `Cell` source or a `Derive` computed. */
interface Source {
  subs: Set<Computation>;
}

// ── Scheduler / drain state ─────────────────────────────────────────
let activeSub: Computation | null = null;
let batchDepth = 0;

const pendingEffects = new Set<Effect>();
let flushScheduled = false;

const worklist: Propagator[] = [];
let draining = false;

/** Total propagator runs allowed in one drain before we declare the region
 *  non-convergent. Generous — a settling region runs O(edges) steps. */
const STEP_CAP = 1_000_000;

function track(node: Source): void {
  if (activeSub === null) return;
  node.subs.add(activeSub);
  activeSub.deps.add(node);
}

/** Cascade staleness through pull consumers; collect effects to flush. */
function invalidate(node: Source): void {
  for (const sub of node.subs) sub.notify();
}

function scheduleEffect(e: Effect): void {
  pendingEffects.add(e);
  if (!flushScheduled && batchDepth === 0) {
    flushScheduled = true;
    queueMicrotask(flushEffects);
  }
}

function flushEffects(): void {
  flushScheduled = false;
  while (pendingEffects.size > 0) {
    const batch = [...pendingEffects];
    pendingEffects.clear();
    for (const e of batch) e.run();
  }
}

/** Run all pending propagator relaxation, then all pending effects, now.
 *  Tests call this to observe the settled state synchronously. */
export function settle(): void {
  drain();
  flushEffects();
}

/** Group writes/wiring so the relaxation drain (and effects) run once at the
 *  end instead of after each individual change. */
export function batch<T>(fn: () => T): T {
  batchDepth++;
  try {
    return fn();
  } finally {
    batchDepth--;
    if (batchDepth === 0) {
      drain();
      if (pendingEffects.size > 0) scheduleFlushIfIdle();
    }
  }
}

function scheduleFlushIfIdle(): void {
  if (!flushScheduled) {
    flushScheduled = true;
    queueMicrotask(flushEffects);
  }
}

// ── Cell: a writable source holding a concrete value ────────────────
export class Cell<T> implements Source {
  subs = new Set<Computation>();
  /** Propagators that read this cell — re-run when it changes. */
  triggers = new Set<Propagator>();

  constructor(
    public value: T,
    readonly equals: (a: T, b: T) => boolean = Object.is,
  ) {}

  /** Tracked read (registers a dependency in the active computation). */
  get(): T {
    track(this);
    return this.value;
  }

  /** Untracked read — for propagator steps and observers that must not
   *  create pull dependencies. */
  peek(): T {
    return this.value;
  }

  /** Write a value. Drives BOTH graphs: invalidates pull consumers and
   *  feeds the propagator relaxation drain. */
  set(v: T): void {
    if (writeValue(this, v)) maybeDrain();
  }
}

/** Low-level write used by both `Cell.set` and propagator steps. Returns
 *  whether the value actually changed (the equality gate). Never drains —
 *  the caller decides (so in-drain writes just enqueue more work). */
function writeValue<T>(c: Cell<T>, v: T): boolean {
  if (c.equals(c.value, v)) return false;
  c.value = v;
  invalidate(c);
  for (const p of c.triggers) enqueue(p);
  return true;
}

export function cell<T>(value: T, equals?: (a: T, b: T) => boolean): Cell<T> {
  return new Cell(value, equals);
}

// ── Derive: a lazy, memoized read-only computed ─────────────────────
export class Derive<T> implements Source, Computation {
  subs = new Set<Computation>();
  deps = new Set<Source>();
  private dirty = true;
  private cached!: T;

  constructor(
    private readonly fn: () => T,
    private readonly equals: (a: T, b: T) => boolean = Object.is,
  ) {}

  notify(): void {
    if (this.dirty) return;
    this.dirty = true;
    invalidate(this); // cascade to our own consumers
  }

  get(): T {
    track(this);
    if (this.dirty) this.recompute();
    return this.cached;
  }

  peek(): T {
    if (this.dirty) this.recompute();
    return this.cached;
  }

  private recompute(): void {
    for (const dep of this.deps) dep.subs.delete(this);
    this.deps.clear();
    const prev = activeSub;
    activeSub = this;
    try {
      const next = this.fn();
      this.dirty = false;
      this.cached = next;
    } finally {
      activeSub = prev;
    }
  }
}

export function derive<T>(fn: () => T, equals?: (a: T, b: T) => boolean): Derive<T> {
  return new Derive(fn, equals);
}

// ── Effect: a microtask-scheduled observer ──────────────────────────
export class Effect implements Computation {
  deps = new Set<Source>();
  private disposed = false;

  constructor(private readonly fn: () => void) {
    this.run();
  }

  notify(): void {
    if (!this.disposed) scheduleEffect(this);
  }

  run(): void {
    if (this.disposed) return;
    for (const dep of this.deps) dep.subs.delete(this);
    this.deps.clear();
    const prev = activeSub;
    activeSub = this;
    try {
      this.fn();
    } finally {
      activeSub = prev;
    }
  }

  dispose(): void {
    this.disposed = true;
    for (const dep of this.deps) dep.subs.delete(this);
    this.deps.clear();
    pendingEffects.delete(this);
  }
}

export function effect(fn: () => void): Effect {
  return new Effect(fn);
}

// ── Propagator: an n-ary constraint solved by relaxation ────────────
/** A constraint: when any `reads` cell changes, `step` re-runs and narrows/sets
 *  its `writes`. Writes are equality-gated by `writeValue`, so a no-op step ends
 *  the cascade. This is the cyclic mechanism — the same `step` re-runs until the
 *  whole region reproduces itself (a fixpoint) or the step cap fires. */
export class Propagator {
  queued = false;

  constructor(
    readonly reads: readonly Cell<unknown>[],
    readonly step: () => void,
  ) {
    for (const r of reads) r.triggers.add(this);
  }

  dispose(): void {
    for (const r of this.reads) r.triggers.delete(this);
    this.queued = false;
  }
}

function enqueue(p: Propagator): void {
  if (p.queued) return;
  p.queued = true;
  worklist.push(p);
}

function maybeDrain(): void {
  if (batchDepth === 0) drain();
}

/** Run the worklist to a fixpoint. Each propagator's `step` writes via
 *  `writeValue` (equality-gated), which re-enqueues only genuinely-changed
 *  downstream propagators. Consistent cycles stop when nothing changes;
 *  inconsistent ones hit `STEP_CAP` and throw. */
function drain(): void {
  if (draining) return;
  draining = true;
  let steps = 0;
  try {
    while (worklist.length > 0) {
      const p = worklist.shift()!;
      p.queued = false;
      p.step();
      if (++steps > STEP_CAP) {
        worklist.length = 0;
        throw new Error(
          `core4: propagator region did not converge within ${STEP_CAP} steps ` +
            `(inconsistent / non-terminating constraints?)`,
        );
      }
    }
  } finally {
    for (const p of worklist) p.queued = false;
    worklist.length = 0;
    draining = false;
  }
}

/** Declare a constraint. Fires once immediately (first-fire) to establish it,
 *  honouring the active `batch`. `reads` is the trigger set; `step` reads with
 *  `.peek()` and writes via `Cell.set`. */
export function propagator(reads: readonly Cell<unknown>[], step: () => void): Propagator {
  const p = new Propagator(reads, step);
  enqueue(p);
  maybeDrain();
  return p;
}
