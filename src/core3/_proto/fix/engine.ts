// engine.ts — Design-B spine: ONE lazy pull that handles acyclic and cyclic
// regions uniformly, discovering SCCs DURING the pull (Tarjan lowlink) with NO
// maintained condensation, then solving each discovered SCC to a fixpoint.
//
// ── The thesis ──────────────────────────────────────────────────────
// The system computes the least fixpoint of a monotone system of equations over
// a product lattice, observed lazily and glitch-free. Acyclic is the degenerate
// fixpoint that converges in one pass. So there is ONE evaluation mechanism — a
// demand-driven DFS — and cyclic structure is *discovered* by that DFS exactly
// the way alien-signals discovers the acyclic dep graph: as a side effect of
// evaluation, never maintained as a separate data structure.
//
// ── Why Tarjan-during-pull (not a bare on-stack flag) ───────────────
// A bare "re-entered an on-stack cell ⇒ it's a head" rule mis-reads a flat
// strongly-connected chain a⇄b⇄c… as N *nested* cycles (every back-edge spawns
// its own head), which makes the solve blow up combinatorially. The correct
// notion is the SCC ROOT: the earliest-on-stack cell reachable from a back-edge.
// That is precisely Tarjan's lowlink, computed inline as the DFS evaluates. One
// SCC ⇒ one head ⇒ one bounded fixpoint loop over its members.
//
// ── Shape ───────────────────────────────────────────────────────────
//   evaluate(c): first visit assigns index=lowlink, runs c's rules (a DFS over
//   deps that updates lowlink). When lowlink==index, c is an SCC root: pop its
//   members off the Tarjan stack and `solveSCC` them to a fixpoint (Kleene, with
//   per-cell `widen` to bound tall lattices). A 1-member root with no self-loop
//   is the acyclic fast path — `solveSCC` returns after the single pass it
//   already did. Solved members are memoized FINAL for the epoch.
//
// ── Deliberately omitted (next steps) ───────────────────────────────
//   • Incrementality: a fact edit bumps a global `epoch` (coarse, whole-graph
//     invalidation). Reads stay lazy (only the demand cone is visited). A real
//     engine wants dirtying + a generation-validated memo of discovered SCCs so
//     steady edits don't re-walk. This spine validates the CORE math first.
//   • Iterative (non-recursive) traversal — alien's link-list walk. This proto
//     recurses, so chain DEPTH is JS-stack-bounded.
//   • Dynamic (value-dependent) dependencies re-tracked per iteration; lenses /
//     value classes / backward writes. All layer on top unchanged.

/** A bounded join-semilattice. `widen` bounds the ascent so cycles over TALL
 *  lattices terminate; omit it for finite lattices (defaults to `join` ⇒ exact
 *  Kleene iteration). */
export interface Lattice<V> {
  readonly bottom: V;
  join(a: V, b: V): V;
  eq(a: V, b: V): boolean;
  widen?(prev: V, next: V, iter: number): V;
}

/** A monotone propagator: reads cells via `get`, returns its contribution to the
 *  owning cell. The cell's value is `join(fact, …contributions)`. */
export type Rule<V> = (get: (c: Cell<V>) => V) => V;

export class Cell<V> {
  /** Memoized value — FINAL when `validEpoch === net.epoch`, else the live
   *  provisional written during an in-progress solve. */
  value: V;
  fact: V;
  readonly rules: Rule<V>[] = [];

  // ── final memo ──
  validEpoch = -1;

  // ── Tarjan state (valid only within the current DFS, keyed by visitGen) ──
  visit = -1;
  index = 0;
  lowlink = 0;
  onStack = false;
  /** Set during the DFS pass iff one of c's rules reads c itself. */
  selfLoop = false;

  constructor(
    readonly net: Net<V>,
    fact: V,
  ) {
    this.fact = fact;
    this.value = fact;
  }
}

export class Net<V> {
  /** Bumped on every fact edit — coarse invalidation of all final memos. */
  epoch = 0;
  /** Bumped per top-level `read` — resets Tarjan index/lowlink lazily. */
  private visitGen = 0;
  private indexCtr = 0;
  private readonly tstack: Cell<V>[] = [];
  /** Instrumentation. */
  ruleEvals = 0;
  sccSolves = 0;
  maxSccSize = 0;

  constructor(readonly lat: Lattice<V>) {}

  cell(fact: V = this.lat.bottom): Cell<V> {
    return new Cell(this, fact);
  }

  rule(target: Cell<V>, r: Rule<V>): void {
    target.rules.push(r);
  }

  set(c: Cell<V>, fact: V): void {
    c.fact = fact;
    this.epoch++;
  }

  resetStats(): void {
    this.ruleEvals = 0;
    this.sccSolves = 0;
    this.maxSccSize = 0;
  }

  /** Demand a cell's value — the single entry point. */
  read(c: Cell<V>): V {
    if (c.validEpoch === this.epoch) return c.value; // final memo
    this.visitGen++;
    this.indexCtr = 0;
    return this.evaluate(c);
  }

  /** Tarjan `strongconnect`, fused with provisional evaluation. Returns c's
   *  current value (provisional until its SCC root finalizes it). */
  private evaluate(c: Cell<V>): V {
    c.visit = this.visitGen;
    c.index = c.lowlink = this.indexCtr++;
    c.onStack = true;
    c.selfLoop = false;
    this.tstack.push(c);
    c.value = this.lat.bottom; // provisional seed (cycle_initial)

    // First pass: compute a provisional value and discover SCC structure.
    c.value = this.lat.join(c.fact, this.contribute(c, true));

    if (c.lowlink === c.index) {
      // c is an SCC root — pop its members (everything above c on the stack).
      const members: Cell<V>[] = [];
      for (;;) {
        const m = this.tstack.pop()!;
        m.onStack = false;
        members.push(m);
        if (m === c) break;
      }
      this.solveSCC(members);
      for (const m of members) m.validEpoch = this.epoch; // finalize
    }
    return c.value;
  }

  /** Run c's rules. In DFS mode (`dfs`), recurse into unvisited deps and fold
   *  Tarjan lowlinks; otherwise read current values directly (solve sweep). */
  private contribute(c: Cell<V>, dfs: boolean): V {
    const lat = this.lat;
    let v = lat.bottom;
    const get = dfs
      ? (dep: Cell<V>): V => {
          if (dep === c) c.selfLoop = true;
          if (dep.validEpoch === this.epoch) return dep.value; // settled
          if (dep.visit !== this.visitGen) {
            const dv = this.evaluate(dep);
            if (dep.onStack && dep.lowlink < c.lowlink) c.lowlink = dep.lowlink;
            return dv;
          }
          if (dep.onStack && dep.index < c.lowlink) c.lowlink = dep.index;
          return dep.value; // provisional (in-SCC) or already-settled
        }
      : (dep: Cell<V>): V => dep.value;
    for (const rule of c.rules) {
      this.ruleEvals++;
      v = lat.join(v, rule(get));
    }
    return v;
  }

  /** Iterate a discovered SCC's members to a fixpoint (chaotic Kleene; `widen`
   *  bounds tall lattices). A 1-member SCC with no self-dependency converges on
   *  the provisional already computed — the acyclic fast path. */
  private solveSCC(members: Cell<V>[]): void {
    const lat = this.lat;
    const widen = lat.widen ?? ((p, n) => lat.join(p, n));
    this.sccSolves++;
    if (members.length > this.maxSccSize) this.maxSccSize = members.length;

    // A lone member with no self-loop is already at its fixpoint (the acyclic
    // fast path — its provisional was the final value).
    if (members.length === 1 && !members[0]!.selfLoop) return;

    let iter = 0;
    for (;;) {
      let changed = false;
      for (const m of members) {
        const next = widen(m.value, lat.join(m.fact, this.contribute(m, false)), iter);
        if (!lat.eq(next, m.value)) {
          m.value = next;
          changed = true;
        }
      }
      iter++;
      if (!changed) return;
    }
  }
}
