// solver-scc.ts — condensation-scheduled fixpoint (prototype).
//
// Two solvers over the SAME cells + relations, to measure the SCC idea:
//
//   • FlatSolver  — the status-quo approach (today's propagators/solver.ts):
//     one global freshness-gated wave loop over ALL rules until the whole
//     graph is quiescent. A long acyclic chain costs O(depth × rules).
//
//   • SccSolver   — condense the relation graph, then settle each
//     component in topological order. A TRIVIAL component (acyclic,
//     functional) runs its rules exactly ONCE — the fast path, zero
//     iteration. Only a CYCLIC component enters a bounded local
//     fixpoint, and only over its own rules. Acyclic cost is O(rules);
//     the cyclic cost is confined to the cycle.
//
// Both fold contributions through the cell's lattice (so results are
// identical); they differ only in SCHEDULING. The counters expose the
// work each does so tests can assert "acyclic pays once".

import type { Cell } from "./engine";
import { condense } from "./scc";

// biome-ignore lint/suspicious/noExplicitAny: heterogeneous relation graph
type AnyCell = Cell<any>;

export interface Rel {
  readonly reads: readonly AnyCell[];
  readonly writes: readonly AnyCell[];
  readonly key: symbol;
  step(): void;
}

/** Build a relation: `body(emit)` returns a step that deposits into
 *  `writes` via `emit`. Contributions are keyed so re-fires coalesce. */
export function rel(
  reads: readonly AnyCell[],
  writes: readonly AnyCell[],
  body: (emit: <T>(cell: Cell<T>, val: T) => void) => () => void,
): Rel {
  const key = Symbol("rel");
  const emit = <T>(cell: Cell<T>, val: T): void => {
    cell.contribs.set(key, val);
  };
  return { reads, writes, key, step: body(emit) };
}

/** Fold a cell's pending contributions through its lattice. Returns true
 *  iff the committed value moved. No contributions ⇒ no change (so a
 *  discrete cell never collapses to `top` for lack of input). */
function fold(cell: AnyCell): boolean {
  if (cell.contribs.size === 0) return false;
  const lat = cell.lattice;
  let v = lat.monotone ? cell.committed : lat.top;
  for (const c of cell.contribs.values()) v = lat.meet(v, c);
  cell.contribs.clear();
  cell.contradiction = lat.isBottom(v);
  if (lat.equals(v, cell.committed)) return false;
  cell.committed = v;
  return true;
}

const MAX_WAVES = 10_000;

/** Work counters for the last `solve()` — for tests and benches. */
export interface SolveStats {
  ruleFires: number;
  waves: number;
}

// ── flat solver (status quo) ────────────────────────────────────────

export class FlatSolver {
  private readonly rules: Rel[] = [];
  stats: SolveStats = { ruleFires: 0, waves: 0 };

  add(...rs: readonly (Rel | readonly Rel[])[]): this {
    for (const r of rs) {
      if (Array.isArray(r)) this.rules.push(...r);
      else this.rules.push(r as Rel);
    }
    return this;
  }

  solve(): this {
    let fires = 0;
    let waves = 0;
    // First fire: seed every cell.
    let fresh = new Set<AnyCell>();
    for (const r of this.rules) {
      r.step();
      fires++;
    }
    const written = new Set<AnyCell>();
    for (const r of this.rules) for (const w of r.writes) written.add(w);
    for (const w of written) if (fold(w)) fresh.add(w);

    while (fresh.size > 0 && waves < MAX_WAVES) {
      waves++;
      const cur = fresh;
      fresh = new Set<AnyCell>();
      const wr = new Set<AnyCell>();
      for (const r of this.rules) {
        if (!intersects(r.reads, cur)) continue;
        r.step();
        fires++;
        for (const w of r.writes) wr.add(w);
      }
      for (const w of wr) if (fold(w)) fresh.add(w);
    }
    this.stats = { ruleFires: fires, waves };
    return this;
  }
}

// ── SCC-scheduled solver ────────────────────────────────────────────

export class SccSolver {
  private readonly rules: Rel[] = [];
  stats: SolveStats = { ruleFires: 0, waves: 0 };

  add(...rs: readonly (Rel | readonly Rel[])[]): this {
    for (const r of rs) {
      if (Array.isArray(r)) this.rules.push(...r);
      else this.rules.push(r as Rel);
    }
    return this;
  }

  solve(): this {
    // Relation graph: edge read → write for every rule.
    const nodes = new Set<AnyCell>();
    const edges: Array<readonly [AnyCell, AnyCell]> = [];
    for (const r of this.rules) {
      for (const w of r.writes) nodes.add(w);
      for (const rd of r.reads) {
        nodes.add(rd);
        for (const w of r.writes) edges.push([rd, w]);
      }
    }
    const { order, comp, cyclic } = condense(nodes, edges);

    // Assign each rule to the component of its (first) write cell.
    const rulesByComp: Rel[][] = order.map(() => []);
    for (const r of this.rules) {
      const home = r.writes.length > 0 ? comp.get(r.writes[0]!) : undefined;
      if (home !== undefined) rulesByComp[home]!.push(r);
    }

    let fires = 0;
    let waves = 0;
    for (let i = 0; i < order.length; i++) {
      const rules = rulesByComp[i]!;
      if (rules.length === 0) continue;
      if (!cyclic[i]) {
        // Fast path: functional, acyclic. Fire once, fold, done.
        const wr = new Set<AnyCell>();
        for (const r of rules) {
          r.step();
          fires++;
          for (const w of r.writes) wr.add(w);
        }
        for (const w of wr) fold(w);
        continue;
      }
      // Cyclic: bounded local fixpoint over THIS component's rules only.
      // First-fire every rule once (boundary rules read upstream cells
      // outside the component, so freshness-gating alone would never fire
      // them), then gate subsequent waves on intra-component change.
      const members = new Set(order[i]!);
      const seed = new Set<AnyCell>();
      for (const r of rules) {
        r.step();
        fires++;
        for (const w of r.writes) seed.add(w);
      }
      let fresh = new Set<AnyCell>();
      for (const w of seed) if (fold(w) && members.has(w)) fresh.add(w);
      let localWaves = 1;
      while (fresh.size > 0 && localWaves < MAX_WAVES) {
        localWaves++;
        const cur = fresh;
        fresh = new Set<AnyCell>();
        const wr = new Set<AnyCell>();
        for (const r of rules) {
          if (!intersects(r.reads, cur)) continue;
          r.step();
          fires++;
          for (const w of r.writes) wr.add(w);
        }
        for (const w of wr) if (fold(w) && members.has(w)) fresh.add(w);
      }
      waves += localWaves;
    }
    this.stats = { ruleFires: fires, waves };
    return this;
  }
}

function intersects(cells: readonly AnyCell[], set: ReadonlySet<AnyCell>): boolean {
  for (const c of cells) if (set.has(c)) return true;
  return false;
}
