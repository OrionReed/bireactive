// lattice.ts — the partial-information substrate for real propagators.
//
// A propagator network is monotone: cells hold *partial knowledge* that
// only ever sharpens. The thing that makes that work is a lattice —
// a `top` (no information), a `meet` (combine two pieces of knowledge),
// and a `bottom` test (the knowledge contradicts itself).
//
// Because `meet` only narrows and lattices here have well-founded
// descent (finite sets shrink; intervals shrink toward a point),
// fixpoint iteration TERMINATES by construction. No fuel cap, no
// divergence panic — the structure of the lattice is the guarantee.
//
// Two instances cover everything downstream:
//   • `interval`        — `[lo, hi]` numeric bounds (layout, ranges, layering)
//   • `set(universe)`   — finite candidate sets (CSP, sudoku, type inference)
//
// A `LatticeCell<T>` is a plain `cell<T>` tagged with its lattice (via a
// WeakMap), so `merge()` and the solver can narrow generically without a
// new cell type — the non-coloring property is preserved.

import { type Cell, cell, type Writable } from "@bireactive/core";

/** A meet-semilattice with a greatest element and a contradiction test.
 *  `meet` is the only way information enters a cell, so it must be
 *  commutative, associative, idempotent, and ≤ both inputs. */
export interface Lattice<T> {
  /** No information — the identity for `meet`. */
  readonly top: T;
  /** Greatest lower bound: combine two pieces of partial knowledge. */
  meet(a: T, b: T): T;
  /** Value equality — drives change detection (and cell de-duping). */
  equals(a: T, b: T): boolean;
  /** Self-contradiction: the empty interval / empty candidate set. */
  isBottom(a: T): boolean;
}

/** A `cell<T>` carrying a `Lattice<T>` so `merge` can narrow generically. */
export type LatticeCell<T> = Writable<Cell<T>>;

const latticeOf = new WeakMap<Cell<unknown>, Lattice<unknown>>();

/** The lattice a cell was minted with, or `undefined` for a plain cell. */
export function latticeFor<T>(c: Cell<T>): Lattice<T> | undefined {
  return latticeOf.get(c as Cell<unknown>) as Lattice<T> | undefined;
}

/** Mint a cell over `lat`, seeded at `top` (no information) by default. */
export function latticeCell<T>(lat: Lattice<T>, init: T = lat.top): LatticeCell<T> {
  const c = cell<T>(init, { equals: lat.equals });
  latticeOf.set(c as Cell<unknown>, lat as Lattice<unknown>);
  return c;
}

/** Narrow `c` by `info` (monotone meet). No-ops when nothing sharpens, so
 *  it's safe to call in any order and any number of times. Returns true
 *  iff the cell actually narrowed. */
export function merge<T>(c: LatticeCell<T>, info: T): boolean {
  const lat = latticeOf.get(c as Cell<unknown>) as Lattice<T> | undefined;
  if (lat === undefined) throw new Error("merge: cell was not minted via latticeCell");
  const cur = c.peek();
  const next = lat.meet(cur, info);
  if (lat.equals(next, cur)) return false;
  c.value = next;
  return true;
}

/** True when the cell's knowledge has collapsed to a contradiction. */
export function isContradiction<T>(c: Cell<T>): boolean {
  const lat = latticeOf.get(c as Cell<unknown>) as Lattice<T> | undefined;
  return lat?.isBottom(c.peek()) ?? false;
}

/** True when the cell still holds no information (its lattice `top`). */
export function isTop<T>(c: Cell<T>): boolean {
  const lat = latticeOf.get(c as Cell<unknown>) as Lattice<T> | undefined;
  if (lat === undefined) return false;
  return lat.equals(c.peek(), lat.top);
}

// ── interval lattice ────────────────────────────────────────────────

/** An inclusive numeric interval `[lo, hi]`. `top` is `[-∞, ∞]`;
 *  `lo > hi` is bottom (the empty interval). */
export type Interval = readonly [number, number];

/** Float slop so a hair of rounding doesn't read as a contradiction. */
const EPS = 1e-9;

export const interval: Lattice<Interval> = {
  top: [Number.NEGATIVE_INFINITY, Number.POSITIVE_INFINITY],
  meet: (a, b) => [Math.max(a[0], b[0]), Math.min(a[1], b[1])],
  equals: (a, b) => a[0] === b[0] && a[1] === b[1],
  isBottom: a => a[0] > a[1] + EPS,
};

/** Interval cell, optionally seeded with bounds (defaults to `top`). */
export function intervalCell(
  lo: number = Number.NEGATIVE_INFINITY,
  hi: number = Number.POSITIVE_INFINITY,
): LatticeCell<Interval> {
  return latticeCell(interval, [lo, hi]);
}

/** Width of an interval (`Infinity` if unbounded, negative if bottom). */
export function width(i: Interval): number {
  return i[1] - i[0];
}

/** A single value, or `undefined` when the interval isn't a point. */
export function point(i: Interval): number | undefined {
  return i[1] - i[0] <= EPS && Number.isFinite(i[0]) ? (i[0] + i[1]) / 2 : undefined;
}

// ── set lattice ─────────────────────────────────────────────────────

/** A finite candidate-set lattice over `universe`. `top` is the whole
 *  universe (all candidates open); `meet` intersects; bottom is empty.
 *  Height is `|universe|`, so narrowing always terminates. */
export function set<E>(universe: Iterable<E>): Lattice<ReadonlySet<E>> {
  const top: ReadonlySet<E> = new Set(universe);
  const eq = (a: ReadonlySet<E>, b: ReadonlySet<E>): boolean => {
    if (a === b) return true;
    if (a.size !== b.size) return false;
    for (const v of a) if (!b.has(v)) return false;
    return true;
  };
  return {
    top,
    meet: (a, b) => {
      const [small, big] = a.size <= b.size ? [a, b] : [b, a];
      const out = new Set<E>();
      for (const v of small) if (big.has(v)) out.add(v);
      return out;
    },
    equals: eq,
    isBottom: a => a.size === 0,
  };
}

/** Candidate-set cell over `universe`, seeded with `init` (defaults to
 *  the whole universe). */
export function setCell<E>(universe: Iterable<E>, init?: Iterable<E>): LatticeCell<ReadonlySet<E>> {
  const lat = set(universe);
  return latticeCell(lat, init === undefined ? lat.top : new Set(init));
}
