// csp.ts — set-narrowing relations over candidate-set cells.
//
// The discrete sibling of `numeric.ts`: same monotone-narrowing model,
// finite-set lattice. Height is bounded by the universe size, so these
// terminate structurally — sudoku, map colouring, type unification.

import { type LatticeCell, merge } from "./lattice";
import { type Propagator, propagator } from "./solver";

type S<E> = LatticeCell<ReadonlySet<E>>;

/** "These cells hold DIFFERENT values." When one collapses to a
 *  singleton `{v}`, eliminate `v` from the others (naked-single
 *  propagation). N(N−1) narrowers. */
export function allDifferent<E>(...cells: S<E>[]): Propagator[] {
  const props: Propagator[] = [];
  for (let i = 0; i < cells.length; i++) {
    for (let j = 0; j < cells.length; j++) {
      if (i === j) continue;
      const src = cells[i]!;
      const dst = cells[j]!;
      props.push(
        propagator([src], [dst], () => {
          const sv = src.value;
          if (sv.size !== 1) return;
          const [only] = sv;
          if (!dst.value.has(only as E)) return;
          const next = new Set(dst.value);
          next.delete(only as E);
          merge(dst, next);
        }),
      );
    }
  }
  return props;
}

/** `a` and `b` hold the same value: intersect both candidate sets.
 *  Unification, lifted to sets. */
export function same<E>(a: S<E>, b: S<E>): Propagator[] {
  return [
    propagator([a], [b], () => {
      merge(b, a.value);
    }),
    propagator([b], [a], () => {
      merge(a, b.value);
    }),
  ];
}

/** Restrict `cell` to `allowed` (intersect). Self-applying. */
export function restrict<E>(cell: S<E>, allowed: Iterable<E>): Propagator {
  const allow = new Set(allowed);
  return propagator([cell], [cell], () => {
    merge(cell, allow);
  });
}
