// relate.ts — propagator combinators over plain cells.
//
// The engine (`constrain` + the relaxation drain) lives in `cell.ts`, fused into
// the same write path as the acyclic forward/backward engine: a propagator is
// just a plain function `body(read, write)` registered with the cells it reads
// and writes. Committing a value into a cell relaxes the propagators reading it
// to a fixpoint, so a cyclic region (e.g. an `equal` ring) is solved as ONE unit
// — no region object, condensation, or lattice. This module is the ergonomic
// surface on top: `assert` and `equal`, plus the re-exported `constrain`.
//
// Cost isolation: a plain cell with no propagator reading it never touches any
// of this; only a cell a propagator reads carries a `readersOf` entry, and only
// a write into such a cell drains.

import { type Cell, constrain } from "./cell";

export { constrain };

// biome-ignore lint/suspicious/noExplicitAny: heterogeneous propagator graph
type AnyCell = Cell<any>;

/** Write `value` into `c`. Plain `c.value = value` does the same — `assert` is
 *  just the explicit spelling at a relationship site, and it relaxes any
 *  propagators reading `c`. */
export function assert<T>(c: Cell<T>, value: T): void {
  (c as { value: T }).value = value;
}

/** `a = b` — a two-way mirror. Writing either side relaxes the other to match;
 *  a chain (`equal(a,b)`, `equal(b,c)`) forms one cyclic region that settles as
 *  a unit. Value-type agnostic: it copies, it doesn't compute. */
export function equal<T>(a: Cell<T>, b: Cell<T>): () => void {
  const ca = a as AnyCell;
  const cb = b as AnyCell;
  const d1 = constrain([ca], [cb], (read, write) => write(cb, read(ca)));
  const d2 = constrain([cb], [ca], (read, write) => write(ca, read(cb)));
  return () => {
    d1();
    d2();
  };
}
