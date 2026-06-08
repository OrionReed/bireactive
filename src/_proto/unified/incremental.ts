// incremental.ts — dynamic SCC condensation (prototype).
//
// The engine wires relations up over time (and tears them down). Re-running
// Tarjan over the whole graph on every edit is what we want to AVOID — the
// partition should be maintained incrementally so topology changes are
// cheap and, crucially, LOCAL: editing one corner never re-examines the
// acyclic remainder.
//
// Two operations, asymmetric by nature:
//
//   • addEdge(u→v)  — Pearce-Kelly localized insertion. Maintains a
//     topological ordinal per component. A "forward" edge (u already
//     before v) is O(1). A "back" edge can only create cycles / reordering
//     among components whose ordinal lies in the window [ord(v), ord(u)] —
//     so we re-condense ONLY that window (and renumber within its own
//     ordinal slots). Nothing outside the window is touched.
//
//   • removeEdge(u→v) — deletion can SPLIT an SCC, which is the genuinely
//     hard (decremental) direction. Cross-component deletes are O(1) (an
//     edge in the DAG vanishes, no component changes). A within-component
//     delete recomputes that one component's split, then renumbers the
//     condensation by a topo pass. Deletion is rarer (disposal), so we pay
//     there rather than burden insertion. A fully-local decremental scheme
//     is possible but deferred.
//
// Correctness is checked in the test by fuzzing against batch `condense`:
// after any edit sequence the partition must match Tarjan exactly, and the
// ordinals must be a valid linear extension of the condensation DAG.

import { tarjan } from "./scc";

export class DynCondensation<T> {
  private readonly out = new Map<T, Set<T>>();
  private readonly inc = new Map<T, Set<T>>();
  /** Union-find parent; a node's component is `find(node)`. */
  private readonly uf = new Map<T, T>();
  /** Component members, keyed by representative. */
  private readonly members = new Map<T, Set<T>>();
  /** Topological ordinal, keyed by representative. Distinct, may be gappy. */
  private readonly ord = new Map<T, number>();
  private nextOrd = 0;

  /** Nodes recomputed by the most recent edit — locality probe for tests. */
  lastTouched = 0;

  // ── union-find ────────────────────────────────────────────────────

  private find(x: T): T {
    let r = x;
    while (this.uf.get(r) !== r) r = this.uf.get(r)!;
    // path-compress
    let c = x;
    while (this.uf.get(c) !== r) {
      const n = this.uf.get(c)!;
      this.uf.set(c, r);
      c = n;
    }
    return r;
  }

  // ── nodes ─────────────────────────────────────────────────────────

  has(n: T): boolean {
    return this.uf.has(n);
  }

  addNode(n: T): void {
    if (this.uf.has(n)) return;
    this.uf.set(n, n);
    this.out.set(n, new Set());
    this.inc.set(n, new Set());
    this.members.set(n, new Set([n]));
    this.ord.set(n, this.nextOrd++);
  }

  // ── queries ───────────────────────────────────────────────────────

  /** Representative of `n`'s component. */
  component(n: T): T {
    return this.find(n);
  }

  sameComponent(a: T, b: T): boolean {
    return this.find(a) === this.find(b);
  }

  /** Cyclic = component of size > 1, or a single node with a self-loop. */
  isCyclic(n: T): boolean {
    const r = this.find(n);
    const m = this.members.get(r)!;
    if (m.size > 1) return true;
    return this.out.get(n)?.has(n) ?? false;
  }

  /** Components (member arrays) in topological order. */
  order(): T[][] {
    const reps = [...this.members.keys()];
    reps.sort((a, b) => this.ord.get(a)! - this.ord.get(b)!);
    return reps.map(r => [...this.members.get(r)!]);
  }

  // ── insertion (Pearce-Kelly, localized) ───────────────────────────

  addEdge(u: T, v: T): void {
    this.addNode(u);
    this.addNode(v);
    this.lastTouched = 0;
    if (this.out.get(u)!.has(v)) return;
    this.out.get(u)!.add(v);
    this.inc.get(v)!.add(u);

    const ru = this.find(u);
    const rv = this.find(v);
    if (ru === rv) return; // internal to a component; still strongly connected
    if (this.ord.get(ru)! < this.ord.get(rv)!) return; // forward edge: O(1)
    this.recondenseWindow(this.ord.get(rv)!, this.ord.get(ru)!);
  }

  /** Re-condense only the components whose ordinal is in [lo, hi]. The new
   *  back edge can affect nothing outside this window. */
  private recondenseWindow(lo: number, hi: number): void {
    const windowReps: T[] = [];
    const windowNodes = new Set<T>();
    for (const [rep, o] of this.ord) {
      if (o >= lo && o <= hi) {
        windowReps.push(rep);
        for (const m of this.members.get(rep)!) windowNodes.add(m);
      }
    }
    this.lastTouched = windowNodes.size;

    // Tarjan over the window's induced subgraph (successors restricted to
    // window nodes). Cycles closed by the new edge live entirely here.
    const succ = (n: T): T[] => {
      const r: T[] = [];
      for (const w of this.out.get(n)!) if (windowNodes.has(w)) r.push(w);
      return r;
    };
    const sccs = tarjan(windowNodes, succ); // topological order

    // Reassign within the window's own ordinal slots (preserving external
    // order). Old reps in the window are retired.
    const slots = windowReps.map(r => this.ord.get(r)!).sort((a, b) => a - b);
    for (const r of windowReps) {
      this.ord.delete(r);
      this.members.delete(r);
    }
    sccs.forEach((scc, i) => {
      const rep = scc[0]!;
      for (const n of scc) this.uf.set(n, rep);
      this.members.set(rep, new Set(scc));
      this.ord.set(rep, slots[i]!);
    });
  }

  // ── deletion ──────────────────────────────────────────────────────

  removeEdge(u: T, v: T): void {
    this.lastTouched = 0;
    if (!this.out.get(u)?.has(v)) return;
    this.out.get(u)!.delete(v);
    this.inc.get(v)!.delete(u);

    if (this.find(u) !== this.find(v)) return; // cross-component: DAG edge gone
    // Within a component: it may split. Recompute just this component.
    this.resplit(this.find(u));
  }

  /** Recompute the SCC structure of one component (after an internal edge
   *  was removed) and renumber the whole condensation by a topo pass. */
  private resplit(rep: T): void {
    const comp = this.members.get(rep)!;
    this.lastTouched = comp.size;
    const succ = (n: T): T[] => {
      const r: T[] = [];
      for (const w of this.out.get(n)!) if (comp.has(w)) r.push(w);
      return r;
    };
    const sccs = tarjan(comp, succ);
    if (sccs.length === 1) return; // still strongly connected, nothing to do

    this.members.delete(rep);
    this.ord.delete(rep);
    for (const scc of sccs) {
      const r = scc[0]!;
      for (const n of scc) this.uf.set(n, r);
      this.members.set(r, new Set(scc));
    }
    this.renumber();
  }

  /** Kahn topological sort of the current component DAG → fresh ordinals. */
  private renumber(): void {
    const reps = [...this.members.keys()];
    const outC = new Map<T, Set<T>>();
    const indeg = new Map<T, number>();
    for (const r of reps) {
      outC.set(r, new Set());
      indeg.set(r, 0);
    }
    for (const r of reps) {
      for (const n of this.members.get(r)!) {
        for (const w of this.out.get(n)!) {
          const rw = this.find(w);
          if (rw === r) continue;
          if (!outC.get(r)!.has(rw)) {
            outC.get(r)!.add(rw);
            indeg.set(rw, indeg.get(rw)! + 1);
          }
        }
      }
    }
    const queue: T[] = reps.filter(r => indeg.get(r) === 0);
    let o = 0;
    this.nextOrd = 0;
    while (queue.length > 0) {
      const r = queue.shift()!;
      this.ord.set(r, o++);
      for (const w of outC.get(r)!) {
        indeg.set(w, indeg.get(w)! - 1);
        if (indeg.get(w) === 0) queue.push(w);
      }
    }
    this.nextOrd = o;
  }
}
