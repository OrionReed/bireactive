// solver.ts — the monotone fixpoint engine.
//
// A propagator declares the cells it `reads` and `writes` and a `step()`
// that narrows its writes via `merge()`. The solver runs them to a
// fixpoint, freshness-gated: only propagators whose reads narrowed in
// the prior wave re-run.
//
// Termination is a property of the lattice, not a fuel cap. Finite-set
// cells shrink to a floor; interval cells shrink toward a point. So a
// run either reaches a fixpoint or (for cyclic real-interval descent
// that only converges in the limit) stops at `maxWaves` holding a SOUND
// over-approximation — never a wrong or oscillating value. There is no
// `DivergedError`: monotone narrowing cannot diverge, only slow-converge.
//
// Reads are expanded transitively at install time (via `transitiveDeps`)
// so a propagator reading a lens chain also re-fires when a parent of
// that chain narrows — no silent freshness gaps.

import { type Cell, network as makeNetwork, type Network, transitiveDeps } from "@bireactive/core";
import { isContradiction } from "./lattice";

// biome-ignore lint/suspicious/noExplicitAny: heterogeneous cell registry
type AnyCell = Cell<any>;

/** Reads/writes declare the topology; `step()` narrows the writes. */
export interface Propagator {
  // biome-ignore lint/suspicious/noExplicitAny: heterogeneous topology
  readonly reads: readonly Cell<any>[];
  // biome-ignore lint/suspicious/noExplicitAny: heterogeneous topology
  readonly writes: readonly Cell<any>[];
  step(): void;
}

/** Plain-object propagator: no new cell type required to participate. */
export function propagator(
  // biome-ignore lint/suspicious/noExplicitAny: see header
  reads: readonly Cell<any>[],
  // biome-ignore lint/suspicious/noExplicitAny: see header
  writes: readonly Cell<any>[],
  step: () => void,
): Propagator {
  return { reads, writes, step };
}

export interface SolverOpts {
  /** Safety bound on fixpoint waves for cyclic real-interval descent
   *  that converges only in the limit. Default 10_000. Finite lattices
   *  reach a fixpoint long before this. Hitting it stops with a sound
   *  result — it never throws. */
  maxWaves?: number;
  /** Don't auto-run on read changes; advance via `.step()`. For animated
   *  solvers and narrowing visualisations. */
  manual?: boolean;
}

interface Entry {
  p: Propagator;
  expanded: readonly AnyCell[];
}

export class Solver {
  private readonly _entries: Entry[] = [];
  private readonly _maxWaves: number;
  private readonly _manual: boolean;
  private _network?: Network;
  private _firstFire: Propagator[] = [];
  private _fresh = new Set<AnyCell>();
  /** True iff the last drain hit `maxWaves` without reaching a fixpoint
   *  (still sound, just not fully converged). */
  stalled = false;

  constructor(opts: SolverOpts = {}) {
    this._maxWaves = opts.maxWaves ?? 10_000;
    this._manual = opts.manual ?? false;
  }

  /** Register propagators (arrays from combinators may be spread). Each
   *  first-fires once; later waves are freshness-gated. */
  add(...props: readonly (Propagator | readonly Propagator[])[]): this {
    const start = this._entries.length;
    const newDeps = new Set<AnyCell>();
    for (const p of props) {
      if (Array.isArray(p)) for (const pp of p) this._addOne(pp, newDeps);
      else this._addOne(p as Propagator, newDeps);
    }
    for (let i = start; i < this._entries.length; i++) this._firstFire.push(this._entries[i]!.p);
    if (this._network === undefined) {
      this._install();
    } else {
      this._network.subscribe(...newDeps);
      this._network.flush();
    }
    return this;
  }

  /** Advance the fixpoint up to `waves` passes (default: to convergence).
   *  Meaningful in `manual` mode; auto mode drains inline. */
  step(waves: number = this._maxWaves): void {
    if (this._network === undefined) return;
    this._network.flush();
    this._drain(waves);
  }

  /** Cells whose knowledge has collapsed to a contradiction. */
  contradictions(): AnyCell[] {
    const out = new Set<AnyCell>();
    for (const { p } of this._entries) {
      for (const w of p.writes) if (isContradiction(w)) out.add(w);
      for (const r of p.reads) if (isContradiction(r)) out.add(r);
    }
    return [...out];
  }

  /** True iff any participating cell is a contradiction. */
  get feasible(): boolean {
    return this.contradictions().length === 0;
  }

  get count(): number {
    return this._entries.length;
  }

  dispose(): void {
    this._network?.dispose();
    this._network = undefined;
  }

  private _addOne(p: Propagator, newDeps: Set<AnyCell>): void {
    const expanded = expandReads(p.reads);
    this._entries.push({ p, expanded });
    for (const s of expanded) newDeps.add(s);
  }

  private _install(): void {
    const allDeps = new Set<AnyCell>();
    for (const { expanded } of this._entries) for (const s of expanded) allDeps.add(s);
    this._network = makeNetwork(
      [...allDeps] as readonly Cell<unknown>[],
      dirty => {
        for (const p of this._firstFire) {
          for (const w of runPropagator(p)) this._fresh.add(w);
        }
        this._firstFire = [];
        for (const s of dirty) this._fresh.add(s);
        if (!this._manual) this._drain(this._maxWaves);
      },
      { manual: this._manual },
    );
  }

  private _drain(maxWaves: number): void {
    if (this._entries.length === 0) return;
    let waves = 0;
    while (this._fresh.size > 0 && waves < maxWaves) {
      waves++;
      const fresh = this._fresh;
      this._fresh = new Set<AnyCell>();
      for (const { p, expanded } of this._entries) {
        if (!intersects(expanded, fresh)) continue;
        for (const w of runPropagator(p)) this._fresh.add(w);
      }
    }
    // Sound either way: leftover fresh just means more narrowing was
    // available than `maxWaves` allowed. Flag it; never throw.
    this.stalled = this._fresh.size > 0;
    if (this.stalled) this._fresh = new Set<AnyCell>();
  }
}

/** Expand declared reads to include transitive (lens-chain) parents. */
function expandReads(reads: readonly AnyCell[]): readonly AnyCell[] {
  const out = new Set<AnyCell>();
  for (const r of reads) for (const dep of transitiveDeps(r)) out.add(dep);
  return [...out];
}

/** Run `step()`; return the writes whose value actually changed. */
function runPropagator(p: Propagator): Set<AnyCell> {
  const before: unknown[] = new Array(p.writes.length);
  for (let i = 0; i < p.writes.length; i++) before[i] = p.writes[i]!.peek();
  p.step();
  const changed = new Set<AnyCell>();
  for (let i = 0; i < p.writes.length; i++) {
    if (p.writes[i]!.peek() !== before[i]) changed.add(p.writes[i]!);
  }
  return changed;
}

function intersects(expanded: readonly AnyCell[], fresh: ReadonlySet<AnyCell>): boolean {
  for (const r of expanded) if (fresh.has(r)) return true;
  return false;
}

/** A solver holding `props`. */
export function solve(...props: readonly (Propagator | readonly Propagator[])[]): Solver {
  return new Solver().add(...props);
}

export function solver(opts: SolverOpts = {}): Solver {
  return new Solver(opts);
}
