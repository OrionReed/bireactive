// Counts-first instrumentation — measurement scaffolding, not a public surface.
//
// The methodology (per the redesign brief): judge engine work by *counts*, not
// timings. Every metric here is a discrete, predictable event — a user callback
// invoked, a codepath entered, a node visited, a reverse edge spliced — so a
// correct minimal engine has a *calculable* target and any work above it is
// provably wasted. This is the gate for the unification: a change must not raise
// the forward counts and must hold the backward counts at their minimum.
//
// Off by default. `COUNTS` is one module-level gate; each instrumented site reads
// `if (COUNTS) counts.x++`, so a downstream minifier sees `if (false)` and drops
// it, and when on the cost is a single predictable branch. Flip via `withCounts`.

export interface Counts {
  // Forward (alien push/pull).
  /** A computed/lens/merge getter actually ran (the forward "work" unit). */
  recompute: number;
  /** `propagate` entered (a mark sweep down `subs`). */
  propagate: number;
  /** `checkDirty` entered (a validity pull up `deps`). */
  checkDirty: number;
  /** A dynamic forward edge (`Link`) was created. */
  link: number;
  /** A dynamic forward edge was dropped. */
  unlink: number;

  // Backward (the push/pull dual).
  /** A back-write was armed (legal). */
  arm: number;
  /** A structurally-impossible write was rejected at `arm` (no work done). */
  armBlocked: number;
  /** Nodes visited descending the back-path in `markDown`. */
  markDownVisit: number;
  /** A reverse edge was spliced onto a parent's up-list. */
  linkChild: number;
  /** A reverse edge was released (view unwatched). */
  unlinkChild: number;
  /** Frames entered resolving back-cones (`enterCone`). */
  resolveConeVisit: number;
  /** Nodes popped committing a back-write (`writeBack`). */
  writeBackVisit: number;
  /** Steps of the co-writer re-assert scan (the fan-in re-assert cost). */
  reassertScan: number;
  /** A user `put` (1→1, tuple, or stateful backward) was invoked. */
  put: number;
  /** A merge `fold` was invoked. */
  fold: number;
  /** A stateful `step` was invoked (backward commit path). */
  step: number;
}

function fresh(): Counts {
  return {
    recompute: 0,
    propagate: 0,
    checkDirty: 0,
    link: 0,
    unlink: 0,
    arm: 0,
    armBlocked: 0,
    markDownVisit: 0,
    linkChild: 0,
    unlinkChild: 0,
    resolveConeVisit: 0,
    writeBackVisit: 0,
    reassertScan: 0,
    put: 0,
    fold: 0,
    step: 0,
  };
}

/** Live counter record. Mutated in place so importers hold a stable reference. */
export const counts: Counts = fresh();

/** The single gate. Read at every instrumented site; flip via `withCounts`. */
export let COUNTS = false;

/** Reset all counters to zero (keeps the same object identity). */
export function resetCounts(): void {
  Object.assign(counts, fresh());
}

/** Shallow copy of the current counts. */
export function snapshotCounts(): Counts {
  return { ...counts };
}

/** Run `fn` with counting on from a zero baseline; returns the result and the
 *  counts it accrued. Restores the prior gate state (counters left as measured). */
export function withCounts<T>(fn: () => T): { result: T; counts: Counts } {
  const prevOn = COUNTS;
  resetCounts();
  COUNTS = true;
  try {
    const result = fn();
    return { result, counts: snapshotCounts() };
  } finally {
    COUNTS = prevOn;
  }
}
