// Propagators — the monotone, partial-information solver layer.
//
// Cells hold partial knowledge on a lattice; propagators only ever
// narrow it (`merge`). Fixpoint iteration terminates by the structure
// of the lattice, so there is no divergence panic and no fuel cap that
// can lie. Two lattices cover the surface: intervals (layout, ranges,
// graph layering) and finite sets (CSP, sudoku, type inference).

export { Box, box } from "@bireactive/core";
export {
  type Interval,
  interval,
  intervalCell,
  isContradiction,
  isTop,
  type Lattice,
  type LatticeCell,
  latticeCell,
  latticeFor,
  merge,
  point,
  set,
  setCell,
  width,
} from "./lattice";
export { type Propagator, propagator, Solver, type SolverOpts, solve, solver } from "./solver";
export { add, bound, equal, fix, order, total } from "./numeric";
export { allDifferent, restrict, same } from "./csp";
export { col, type FlexOpts, type Item, row } from "./flex";
export {
  attach,
  centerInside,
  follow,
  type GridOpts,
  grid,
  inset,
  lockSize,
  pinEdge,
  type Side,
} from "./layout";
