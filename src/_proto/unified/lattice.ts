// lattice.ts — the merge law a cell carries (prototype).
//
// Every cell in the unified engine carries a `Lattice<T>`: a `top` (no
// information), a `meet` (combine two contributions), and a `bottom`
// test (the contributions contradict). This is the ONE place that
// answers "what happens when N values arrive at a cell" — it replaces
// both forward overwrite and the old backward `merge()` fold with a
// single principled operation.
//
// The crucial distinction is `monotone`:
//   • monotone (interval, set) — knowledge that only ever sharpens.
//     The cell WARM-STARTS each settle (base = committed); cycles
//     terminate by lattice height. This is the propagator world.
//   • non-monotone / discrete (a plain value) — `top` = unknown, each
//     value is an atom, `meet` of two DISTINCT atoms = ⊥ (contradiction).
//     The cell RESETS each settle (base = top), so a new producer value
//     replaces rather than contradicts the old. This is the signal /
//     lens world: a derived cell is functional (one producer → overwrite),
//     and a source written through two views that disagree is an honest
//     ⊥, not silent last-write-wins.

/** A meet-semilattice with a contradiction element. */
export interface Lattice<T> {
  /** No information — identity for `meet`. */
  readonly top: T;
  /** Greatest lower bound of two contributions. */
  meet(a: T, b: T): T;
  /** Value equality — change detection. */
  equals(a: T, b: T): boolean;
  /** Self-contradiction (the empty interval / empty set / clash). */
  isBottom(a: T): boolean;
  /** Knowledge-lattice (warm-start across settles) vs flat/discrete
   *  (reset to `top` each settle). See module header. */
  readonly monotone: boolean;
}

/** Shared contradiction sentinel for discrete lattices. */
export const BOTTOM: unique symbol = Symbol("⊥");

/** The flat lattice over `T`: `top` = unknown, distinct values clash to
 *  ⊥. This is what a plain `cell` carries — overwrite forward, conflict
 *  detection backward. */
export function discrete<T>(equals: (a: T, b: T) => boolean = Object.is): Lattice<T> {
  const TOP = Symbol("⊤") as unknown as T;
  const eq = (a: T, b: T): boolean => {
    if ((a as unknown) === BOTTOM || (b as unknown) === BOTTOM)
      return (a as unknown) === (b as unknown);
    if ((a as unknown) === TOP || (b as unknown) === TOP) return (a as unknown) === (b as unknown);
    return equals(a, b);
  };
  return {
    top: TOP,
    monotone: false,
    equals: eq,
    isBottom: a => (a as unknown) === BOTTOM,
    meet: (a, b) => {
      if ((a as unknown) === TOP) return b;
      if ((b as unknown) === TOP) return a;
      if ((a as unknown) === BOTTOM || (b as unknown) === BOTTOM) return BOTTOM as unknown as T;
      return equals(a, b) ? a : (BOTTOM as unknown as T);
    },
  };
}

// ── interval lattice (monotone) ─────────────────────────────────────

export type Interval = readonly [number, number];
const EPS = 1e-9;

export const interval: Lattice<Interval> = {
  top: [Number.NEGATIVE_INFINITY, Number.POSITIVE_INFINITY],
  monotone: true,
  meet: (a, b) => [Math.max(a[0], b[0]), Math.min(a[1], b[1])],
  equals: (a, b) => Math.abs(a[0] - b[0]) <= EPS && Math.abs(a[1] - b[1]) <= EPS,
  isBottom: a => a[0] > a[1] + EPS,
};

export function width(i: Interval): number {
  return i[1] - i[0];
}

export function point(i: Interval): number | undefined {
  return i[1] - i[0] <= EPS && Number.isFinite(i[0]) ? (i[0] + i[1]) / 2 : undefined;
}

// ── finite-set lattice (monotone) ───────────────────────────────────

export function set<E>(universe: Iterable<E>): Lattice<ReadonlySet<E>> {
  const top: ReadonlySet<E> = new Set(universe);
  const equals = (a: ReadonlySet<E>, b: ReadonlySet<E>): boolean => {
    if (a === b) return true;
    if (a.size !== b.size) return false;
    for (const v of a) if (!b.has(v)) return false;
    return true;
  };
  return {
    top,
    monotone: true,
    equals,
    isBottom: a => a.size === 0,
    meet: (a, b) => {
      const [small, big] = a.size <= b.size ? [a, b] : [b, a];
      const out = new Set<E>();
      for (const v of small) if (big.has(v)) out.add(v);
      return out;
    },
  };
}
