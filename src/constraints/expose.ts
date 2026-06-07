// expose.ts — a constraint cluster, oriented as a writable lens.
//
// A constraint network is an *unoriented* relation: it has no inputs or
// outputs, just cells that must agree. A lens is an *oriented* relation —
// one end you write, the rest follow. `exposeVec` picks the orientation:
// it names one bound cell the handle and hands back a single
// `Writable<Vec>` whose backward direction relaxes the cluster.
//
// Writing the handle re-aims a strong soft pull at the target, steps the
// (manually-driven) solver, and reads the settled positions of `free`
// straight out of the solver buffers — so the whole mechanism collapses
// to one composable value. `spring`, `handle`, `crossfade`, `mean` — any
// lens or animator that takes a `Writable<Vec>` now drives the network.
//
// Ownership: `exposeVec` disposes the cluster's reactive driver and takes
// over stepping (the lens body is the only thing that calls `step`), so
// there's no auto-resolve racing the backward pass. Drive the network
// through the returned handle(s), not by writing the bound cells directly.
//
// One cluster, many handles: call `exposeVec` again with a different cell
// to expose another section of the same relation (each write relaxes the
// shared solver). The writeback phase is dropped, so the handles never
// fight over committing the bound signals — each backward pass reads the
// freshly solved positions and returns them as its own updates.

import { Vec, type Writable } from "../core";
import type { Constraints } from "./cluster";
import { prepare, solve } from "./phases";
import { SoftTargetTerm } from "./terms";

type V = { x: number; y: number };

export interface ExposeOpts {
  /** Solver sweeps per write (each `step` runs `cluster.iterations`
   *  inner iterations, warm-started from the previous sweep). Default 4
   *  — enough to land on a reachable target in one write; the cluster
   *  also warm-starts across writes, so a spring/drag refines per frame. */
  iters?: number;
  /** Stiffness of the soft pull toward the written target. High → the
   *  handle lands on the target; lower → it lags onto the manifold like
   *  a dragged-through-load anchor. Default 1e5. */
  stiffness?: number;
}

/** Expose one cell of a `Vec` constraint cluster as a writable lens over
 *  the cluster's solution manifold. `free` is the set whose solved
 *  positions are read back (`handle` must be among them). See module note. */
export function exposeVec(
  c: Constraints,
  free: readonly Writable<Vec>[],
  handle: Writable<Vec>,
  opts: ExposeOpts = {},
): Writable<Vec> {
  const iters = opts.iters ?? 4;
  const stiffness = opts.stiffness ?? 1e5;
  const hidx = free.indexOf(handle);
  if (hidx < 0) throw new Error("exposeVec: handle must be one of `free`");

  // Take over the time loop: the backward pass is the only `step` caller.
  c.dispose();
  // Drop BOTH snapshot and writeback: the solver's own `positions` are the
  // state. `_bind` seeded them from the cells; each write iterates `solve`
  // in place (warm-started), then we read the settled positions back as
  // the lens's updates — committed once by the engine. No re-snapshot means
  // repeated sweeps actually converge, and state persists across writes.
  c.pipeline = [prepare, solve];

  // A re-aimable soft pull standing in for "the value you wrote".
  const seed = handle.peek();
  const drive = new SoftTargetTerm(c.solver, c._bind(handle), [seed.x, seed.y], stiffness);
  c.solver.addTerm(drive);

  const offsets = free.map(f => c.solver.offsets[c._bind(f)]!);
  const readSolved = (i: number): V => {
    const off = offsets[i]!;
    return { x: c.solver.positions[off]!, y: c.solver.positions[off + 1]! };
  };

  return Vec.lens(
    free as readonly Writable<Vec>[],
    (vals: readonly V[]) => vals[hidx]!,
    (target: V) => {
      drive.target[0] = target.x;
      drive.target[1] = target.y;
      for (let i = 0; i < iters; i++) c.step();
      return free.map((_, i) => readSolved(i)) as never;
    },
  ) as Writable<Vec>;
}
