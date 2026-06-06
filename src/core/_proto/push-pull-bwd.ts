// Push-pull backward prototype: a batched single-parent lens write PUSHES (stash
// target + enqueue, O(1), last-write-wins) and is PULLED lazily — the put-chain
// runs only when a source is OBSERVED (reads drain the queue first), so it
// subsumes the eager engine's write-then-read, net-zero-revert, and coalescing
// patches without a `settled` special-case. Cost: a read drains the whole queue
// (cursor-amortized, so interleaved read/write is O(total writes)).

interface Counts {
  put: number; // backward put-chain hops
  fwd: number; // forward projections
  sourceWrites: number; // writeSource calls that actually CHANGED a source
  effectRuns: number; // effect body invocations (re-runs that over-fire)
}
const counts: Counts = { put: 0, fwd: 0, sourceWrites: 0, effectRuns: 0 };
const resetCounts = (): void => {
  counts.put = counts.fwd = counts.sourceWrites = counts.effectRuns = 0;
};

let batchDepth = 0;
const bwdQueue: Lens<unknown>[] = [];
let drainCursor = 0;
const pendingEffects = new Set<Effect>();
let activeEffect: Effect | undefined;

const NONE = Symbol("none");

/** Resolve any not-yet-drained backward writes (the lazy pull). Reads call
 *  this before observing a source; `flush` calls it before effects. */
function drainBwd(): void {
  while (drainCursor < bwdQueue.length) {
    const lens = bwdQueue[drainCursor++]!;
    lens.queued = false;
    lens.resolve();
  }
}

function flush(): void {
  drainBwd();
  bwdQueue.length = 0;
  drainCursor = 0;
  const fire = [...pendingEffects];
  pendingEffects.clear();
  for (const e of fire) e.run();
}

function batch(fn: () => void): void {
  batchDepth++;
  try {
    fn();
  } finally {
    if (--batchDepth === 0) flush();
  }
}

class Source<T> {
  current: T;
  subs = new Set<Effect>();
  constructor(v: T) {
    this.current = v;
  }
  read(): T {
    if (drainCursor < bwdQueue.length) drainBwd();
    if (activeEffect !== undefined) this.subs.add(activeEffect);
    return this.current;
  }
  /** The single place truth mutates. Fires subscribers only on a real
   *  change — net-zero reverts arrive here already coalesced to a no-op. */
  writeSource(x: T): void {
    if (Object.is(x, this.current)) return;
    counts.sourceWrites++;
    this.current = x;
    for (const e of this.subs) pendingEffects.add(e);
  }
}

type AnyNode = Source<unknown> | Lens<unknown>;

class Lens<T> {
  pendingTarget: T | typeof NONE = NONE;
  queued = false;
  constructor(
    readonly parent: AnyNode,
    private readonly fwd: (p: never) => T,
    private readonly put: (target: T, current?: never) => unknown,
    private readonly readsSource: boolean,
  ) {}

  read(): T {
    if (drainCursor < bwdQueue.length) drainBwd();
    counts.fwd++;
    return this.fwd((this.parent as { read(): unknown }).read() as never);
  }

  set value(x: T) {
    if (batchDepth > 0) {
      // PUSH: stash target, enqueue once. Last write wins (overwrite).
      this.pendingTarget = x;
      if (!this.queued) {
        this.queued = true;
        bwdQueue.push(this as Lens<unknown>);
      }
      return;
    }
    // Eager outside a batch: resolve straight through.
    this.pendingTarget = x;
    this.resolve();
  }
  get value(): T {
    return this.read();
  }

  /** Walk the put-chain from this view to its ultimate source and commit
   *  once. Intermediate lenses are traversed directly (not via the queue),
   *  so a depth-D chain is one O(D) walk per drained view — the SAME walk
   *  the eager path does, but run at most once, on demand, last-write. */
  resolve(): void {
    if (this.pendingTarget === NONE) return;
    let cur: Lens<unknown> = this as Lens<unknown>;
    let target: unknown = this.pendingTarget;
    this.pendingTarget = NONE;
    while (true) {
      const parent = cur.parent;
      counts.put++;
      const src = cur.readsSource ? (parent as { read(): unknown }).read() : (undefined as never);
      const push = cur.put(target as never, src as never);
      if (parent instanceof Source) {
        parent.writeSource(push);
        return;
      }
      cur = parent as Lens<unknown>;
      target = push;
    }
  }
}

function lens<P, T>(
  parent: Source<P> | Lens<P>,
  fwd: (p: P) => T,
  put: (target: T, current?: P) => P,
  readsSource = put.length >= 2,
): Lens<T> {
  return new Lens<T>(
    parent as AnyNode,
    fwd as (p: never) => T,
    put as (t: T, c?: never) => unknown,
    readsSource,
  );
}

class Effect {
  constructor(private readonly body: () => void) {
    this.run();
  }
  run(): void {
    counts.effectRuns++;
    const prev = activeEffect;
    activeEffect = this;
    try {
      this.body();
    } finally {
      activeEffect = prev;
    }
  }
}

let failures = 0;
function check(name: string, cond: boolean, detail = ""): void {
  if (!cond) failures++;
  console.log(`  ${cond ? "PASS" : "FAIL"}  ${name}${detail ? ` — ${detail}` : ""}`);
}

const identity = <P>(s: Source<P> | Lens<P>): Lens<P> =>
  lens(
    s,
    (x: P) => x,
    (t: P) => t,
  );

const clampLens = (s: Source<number>, lo: number, hi: number): Lens<number> =>
  lens(
    s,
    x => Math.max(lo, Math.min(hi, x)),
    t => Math.max(lo, Math.min(hi, t)),
  );

console.log("push-pull backward — does drain-on-read subsume the patches?\n");

// 1. write-then-read consistency inside a batch (no eager walk).
{
  resetCounts();
  const s = new Source(0);
  const v = identity(s);
  let observed = NONE as number | typeof NONE;
  batch(() => {
    v.value = 5;
    observed = v.value; // read mid-batch → drains → resolves → sees 5
  });
  check("write-then-read sees the staged value", observed === 5, `got ${String(observed)}`);
  check("…and the source resolved to it", s.current === 5);
}

// 2. net-zero revert does NOT over-fire (no settled needed).
{
  resetCounts();
  const s = new Source(0);
  const v = identity(s);
  let seen = -1;
  new Effect(() => {
    seen = v.value;
  }); // initial run = 1
  const runsAfterInit = counts.effectRuns;
  batch(() => {
    v.value = 1;
    v.value = 0; // overwrite target → net zero
  });
  check(
    "effect did not re-run on net-zero",
    counts.effectRuns === runsAfterInit,
    `runs=${counts.effectRuns}`,
  );
  check("source never moved", s.current === 0 && counts.sourceWrites === 0);
  check("last value still correct", seen === 0);
}

// 3. cross-view consistency mid-batch (sibling view sees the write).
{
  resetCounts();
  const s = new Source(0);
  const a = identity(s);
  const b = identity(s);
  let viaB = NONE as number | typeof NONE;
  batch(() => {
    a.value = 9;
    viaB = b.value; // reading b drains → a's write committed → b sees 9
  });
  check("sibling view reflects the write", viaB === 9, `got ${String(viaB)}`);
}

// 4. lossy snapping: write out of range, read back the snapped value.
{
  resetCounts();
  const s = new Source(50);
  const v = clampLens(s, 0, 100);
  let back = NONE as number | typeof NONE;
  batch(() => {
    v.value = 999; // clamps to 100
    back = v.value;
  });
  check(
    "lossy lens snaps on write-then-read",
    back === 100 && s.current === 100,
    `got ${String(back)}`,
  );
}

// 5. coalescing: k writes to one view = ONE put-chain at flush.
{
  resetCounts();
  const s = new Source(0);
  const v = identity(s);
  batch(() => {
    for (let i = 1; i <= 100; i++) v.value = i; // last write wins → 100
  });
  check("100 writes coalesce to one resolution", counts.put === 1, `put=${counts.put}`);
  check("…landing the last value", s.current === 100);
}

// 6. deep chain: one observed write = ONE O(D) walk, not per-write.
{
  resetCounts();
  const s = new Source(0);
  let top: Lens<number> = identity(s);
  const D = 16;
  for (let i = 1; i < D; i++) top = identity(top);
  batch(() => {
    top.value = 7;
    top.value = 7; // repeated → still one walk
  });
  check("repeated deep writes = one D-deep walk", counts.put === D, `put=${counts.put} (D=${D})`);
  check("…source committed once", s.current === 7 && counts.sourceWrites === 1);
}

console.log(`\n${failures === 0 ? "ALL PASS" : `${failures} FAILURE(S)`}`);

export {};
