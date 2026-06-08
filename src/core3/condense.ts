// condense.ts — SCC condensation, batch + dynamic (prototype).
//
// This is the partitioner that keeps cyclic-relationship cost OFF the acyclic
// core. Given the relation graph (an edge u→v whenever some rule reads u and
// writes v), it groups nodes into strongly-connected components:
//
//   • a SINGLETON with no self-loop is a functional, acyclic node — it runs
//     the fast path (evaluate once, no fixpoint), exactly like a plain lens.
//   • a component of size > 1 (or a self-loop) is a genuine cyclic
//     relationship — and ONLY it pays the bounded lattice-fixpoint cost.
//
// The condensation is a DAG, kept in topological (upstream-first) order so a
// scheduler settles each component after its inputs.
//
// ── Tarjan kernel ───────────────────────────────────────────────────
// Iterative (no recursion → no stack overflow on deep graphs), O(V + E),
// shared by the batch `condense` and the dynamic maintainer below (which
// passes a restricted successor view to work on a sub-region).
//
// ── DynCondensation: incremental maintenance ────────────────────────
// The engine wires relations up over time and tears them down. Re-running
// Tarjan over the whole graph on every edit is what we AVOID — the partition
// is maintained incrementally so topology changes are cheap and, crucially,
// LOCAL: editing one corner never re-examines the acyclic remainder.
//
//   • addEdge(u→v) — Pearce-Kelly localized insertion. A "forward" edge
//     (u already before v by ordinal) is O(1). A "back" edge can only create
//     cycles / reordering among components whose ordinal lies in the window
//     [ord(v), ord(u)] — so we re-condense ONLY that window. Nothing outside
//     is touched.
//
//   • removeEdge(u→v) — deletion can SPLIT an SCC (the decremental, harder
//     direction). Cross-component deletes are O(1). A within-component delete
//     re-condenses just that one component, then slots the resulting
//     sub-components into the ordinal gap the old component occupied — a LOCAL
//     renumber bounded to the split, never a global topo pass.
//
// ── Memory ──────────────────────────────────────────────────────────
// One record PER NODE (not five parallel Maps). `out`/`inc` allocate lazily
// (a pure source or sink carries none) and `members` is implicit for a
// singleton (`undefined` ⇒ `{self}`), so a plain acyclic node — the common
// case — costs one record and zero Sets.
//
// Correctness is fuzzed against batch `condense`: after any edit sequence the
// partition must match Tarjan exactly and the ordinals must be a valid linear
// extension of the condensation DAG.

export interface Condensation<T> {
  /** Components in topological order: inputs before dependents. */
  readonly order: readonly (readonly T[])[];
  /** Node → index of its component in `order`. */
  readonly comp: ReadonlyMap<T, number>;
  /** Per component: true iff cyclic (size > 1, or a 1-node self-loop). */
  readonly cyclic: readonly boolean[];
}

/** Iterative Tarjan over an arbitrary node set + successor function.
 *  Returns SCCs in topological (upstream-first) order. `succ` may restrict to
 *  a sub-region — incremental maintenance passes a filtered view — so this is
 *  the shared kernel for both batch and dynamic condensation. */
export function tarjan<T>(nodes: Iterable<T>, succ: (n: T) => readonly T[]): T[][] {
  const index = new Map<T, number>();
  const low = new Map<T, number>();
  const onStack = new Set<T>();
  const stack: T[] = [];
  let idx = 0;
  const comps: T[][] = []; // Tarjan emits in REVERSE topological order.

  interface Frame {
    v: T;
    succ: readonly T[];
    ei: number;
  }

  for (const start of nodes) {
    if (index.has(start)) continue;
    index.set(start, idx);
    low.set(start, idx);
    idx++;
    stack.push(start);
    onStack.add(start);
    const work: Frame[] = [{ v: start, succ: succ(start), ei: 0 }];

    while (work.length > 0) {
      const f = work[work.length - 1]!;
      if (f.ei < f.succ.length) {
        const w = f.succ[f.ei++]!;
        if (!index.has(w)) {
          index.set(w, idx);
          low.set(w, idx);
          idx++;
          stack.push(w);
          onStack.add(w);
          work.push({ v: w, succ: succ(w), ei: 0 });
        } else if (onStack.has(w)) {
          const lv = low.get(f.v)!;
          const iw = index.get(w)!;
          if (iw < lv) low.set(f.v, iw);
        }
      } else {
        const v = f.v;
        if (low.get(v) === index.get(v)) {
          const comp: T[] = [];
          let w: T;
          do {
            w = stack.pop()!;
            onStack.delete(w);
            comp.push(w);
          } while (w !== v);
          comps.push(comp);
        }
        work.pop();
        if (work.length > 0) {
          const parent = work[work.length - 1]!.v;
          const lp = low.get(parent)!;
          const lv = low.get(v)!;
          if (lv < lp) low.set(parent, lv);
        }
      }
    }
  }

  comps.reverse(); // → topological (upstream-first).
  return comps;
}

export function condense<T>(nodes: Iterable<T>, edges: Iterable<readonly [T, T]>): Condensation<T> {
  const adj = new Map<T, T[]>();
  const nodeList: T[] = [];
  const ensure = (n: T): void => {
    if (!adj.has(n)) {
      adj.set(n, []);
      nodeList.push(n);
    }
  };
  for (const n of nodes) ensure(n);
  const selfLoop = new Set<T>();
  for (const [u, v] of edges) {
    ensure(u);
    ensure(v);
    adj.get(u)!.push(v);
    if (u === v) selfLoop.add(u);
  }

  const comps = tarjan(nodeList, n => adj.get(n) ?? []);
  const comp = new Map<T, number>();
  const cyclic: boolean[] = [];
  comps.forEach((c, i) => {
    for (const n of c) comp.set(n, i);
    cyclic.push(c.length > 1 || (c.length === 1 && selfLoop.has(c[0]!)));
  });
  return { order: comps, comp, cyclic };
}

// ── dynamic condensation ────────────────────────────────────────────

/** One record per node. `out`/`inc` are lazy; `members`/`ord` are meaningful
 *  only when the node is a union-find ROOT (`parent === self`), and `members`
 *  is `undefined` for a singleton (⇒ `{self}`). */
interface Rec<T> {
  parent: T;
  ord: number;
  out?: Set<T>;
  inc?: Set<T>;
  members?: Set<T>;
}

export class DynCondensation<T> {
  private readonly node = new Map<T, Rec<T>>();
  private nextOrd = 0;

  /** Nodes recomputed by the most recent edit — locality probe for tests. */
  lastTouched = 0;
  /** Nodes whose component membership may have changed since the last
   *  `drainDirty()` — merges (back-edge recondense) and splits (resplit).
   *  Lets a consumer rebuild only the affected SCCs. */
  private readonly dirty = new Set<T>();

  // ── union-find ────────────────────────────────────────────────────

  private find(x: T): T {
    const node = this.node;
    let r = x;
    let p = node.get(r)!.parent;
    while (p !== r) {
      r = p;
      p = node.get(r)!.parent;
    }
    // path-compress
    let c = x;
    while (node.get(c)!.parent !== r) {
      const n = node.get(c)!;
      const next = n.parent;
      n.parent = r;
      c = next;
    }
    return r;
  }

  /** Members of the component rooted at `rep` (rep included). */
  private memberList(rep: T): T[] {
    const m = this.node.get(rep)!.members;
    return m ? [...m] : [rep];
  }

  private memberCount(rep: T): number {
    const m = this.node.get(rep)!.members;
    return m ? m.size : 1;
  }

  // ── nodes ─────────────────────────────────────────────────────────

  has(n: T): boolean {
    return this.node.has(n);
  }

  addNode(n: T): void {
    if (this.node.has(n)) return;
    this.node.set(n, { parent: n, ord: this.nextOrd++ });
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
    if (this.memberCount(r) > 1) return true;
    return this.node.get(n)!.out?.has(n) ?? false;
  }

  /** Components (member arrays) in topological order. */
  order(): T[][] {
    const reps: T[] = [];
    for (const [n, rec] of this.node) if (rec.parent === n) reps.push(n);
    reps.sort((a, b) => this.node.get(a)!.ord - this.node.get(b)!.ord);
    return reps.map(r => this.memberList(r));
  }

  /** Members of the component containing `n`. */
  membersOf(n: T): T[] {
    return this.memberList(this.find(n));
  }

  /** Take and clear the set of nodes whose component changed (merge/split)
   *  since the last call. */
  drainDirty(): Set<T> {
    const d = new Set(this.dirty);
    this.dirty.clear();
    return d;
  }

  // ── insertion (Pearce-Kelly, localized) ───────────────────────────

  addEdge(u: T, v: T): void {
    this.addNode(u);
    this.addNode(v);
    this.lastTouched = 0;
    const urec = this.node.get(u)!;
    if (urec.out?.has(v)) return;
    (urec.out ??= new Set()).add(v);
    (this.node.get(v)!.inc ??= new Set()).add(u);

    const ru = this.find(u);
    const rv = this.find(v);
    if (ru === rv) return; // internal to a component; still strongly connected
    if (this.node.get(ru)!.ord < this.node.get(rv)!.ord) return; // forward: O(1)
    this.recondenseWindow(this.node.get(rv)!.ord, this.node.get(ru)!.ord);
  }

  /** Re-condense only the components whose ordinal is in [lo, hi]. The new
   *  back edge can affect nothing outside this window. */
  private recondenseWindow(lo: number, hi: number): void {
    const windowReps: T[] = [];
    const windowNodes = new Set<T>();
    for (const [n, rec] of this.node) {
      if (rec.parent !== n) continue; // roots only
      if (rec.ord >= lo && rec.ord <= hi) {
        windowReps.push(n);
        for (const m of this.memberList(n)) windowNodes.add(m);
      }
    }
    this.lastTouched = windowNodes.size;
    for (const n of windowNodes) this.dirty.add(n);

    // Tarjan over the window's induced subgraph (successors restricted to
    // window nodes). Cycles closed by the new edge live entirely here.
    const succ = (n: T): T[] => {
      const r: T[] = [];
      const o = this.node.get(n)!.out;
      if (o) for (const w of o) if (windowNodes.has(w)) r.push(w);
      return r;
    };
    const sccs = tarjan(windowNodes, succ); // topological order

    // Reassign within the window's own ordinal slots (preserving external
    // order). Old reps in the window are retired.
    const slots = windowReps.map(r => this.node.get(r)!.ord).sort((a, b) => a - b);
    for (const r of windowReps) this.node.get(r)!.members = undefined;
    sccs.forEach((scc, i) => this.setComp(scc, slots[i]!));
  }

  // ── deletion (localized decremental) ───────────────────────────────

  removeEdge(u: T, v: T): void {
    this.lastTouched = 0;
    const urec = this.node.get(u);
    if (!urec?.out?.has(v)) return;
    urec.out.delete(v);
    this.node.get(v)!.inc!.delete(u);

    if (this.find(u) !== this.find(v)) return; // cross-component: DAG edge gone
    this.resplit(this.find(u)); // within a component: it may split
  }

  /** Recompute the SCC structure of one component (after an internal edge was
   *  removed) and slot the resulting sub-components into the ordinal gap the
   *  old component occupied — local, never a global topo pass. */
  private resplit(rep: T): void {
    const oldOrd = this.node.get(rep)!.ord;
    const comp = new Set(this.memberList(rep));
    this.lastTouched = comp.size;
    for (const n of comp) this.dirty.add(n);

    const succ = (n: T): T[] => {
      const r: T[] = [];
      const o = this.node.get(n)!.out;
      if (o) for (const w of o) if (comp.has(w)) r.push(w);
      return r;
    };
    const sccs = tarjan(comp, succ); // topological (upstream-first)
    if (sccs.length === 1) return; // still strongly connected

    // Rebuild membership; the new reps need fresh ordinals.
    this.node.get(rep)!.members = undefined;
    const newReps = sccs.map(scc => scc[0]!);
    for (const scc of sccs) this.setComp(scc, oldOrd); // ord placeholder; set below
    const newRepSet = new Set<T>(newReps);

    // The split sub-components must order strictly after their external
    // in-neighbours and before their out-neighbours. Since the old component
    // held a single valid ordinal `oldOrd`, every external in-neighbour sits
    // below it and every out-neighbour above. We need only the LOWER bound
    // (max external in-neighbour ordinal) and the next existing ordinal above
    // it: the sub-components slot into that gap, in topological order.
    let low = Number.NEGATIVE_INFINITY;
    for (const scc of sccs) {
      for (const n of scc) {
        const inc = this.node.get(n)!.inc;
        if (!inc) continue;
        for (const w of inc) {
          const c = this.find(w);
          if (!newRepSet.has(c)) {
            const o = this.node.get(c)!.ord;
            if (o > low) low = o;
          }
        }
      }
    }
    // `upper` = smallest existing ordinal strictly above `low` (the successor);
    // placing the sub-components below it keeps them ahead of every existing
    // component that must follow. `globalMin` handles the no-in-neighbour case.
    let upper = Number.POSITIVE_INFINITY;
    let globalMin = Number.POSITIVE_INFINITY;
    for (const [n, rec] of this.node) {
      if (rec.parent !== n || newRepSet.has(n)) continue; // existing roots only
      const o = rec.ord;
      if (o < globalMin) globalMin = o;
      if (o > low && o < upper) upper = o;
    }
    if (low === Number.NEGATIVE_INFINITY) {
      // No external in-neighbours → place ahead of everything.
      low = globalMin === Number.POSITIVE_INFINITY ? -1 : globalMin - 1;
      upper = globalMin === Number.POSITIVE_INFINITY ? 0 : globalMin;
    } else if (upper === Number.POSITIVE_INFINITY) {
      upper = low + 1; // `low` was the maximum ordinal in the graph
    }

    const k = newReps.length;
    newReps.forEach((r, i) => {
      this.node.get(r)!.ord = low + ((upper - low) * (i + 1)) / (k + 1);
    });
  }

  /** Point every node of `scc` at its representative (`scc[0]`), set the rep's
   *  members (implicit for a singleton) and ordinal. */
  private setComp(scc: T[], ord: number): void {
    const rep = scc[0]!;
    for (const n of scc) this.node.get(n)!.parent = rep;
    const rrec = this.node.get(rep)!;
    rrec.members = scc.length > 1 ? new Set(scc) : undefined;
    rrec.ord = ord;
  }
}
