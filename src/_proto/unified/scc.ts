// scc.ts — strongly-connected-component condensation (prototype).
//
// This is the partitioner that keeps cyclic-relationship cost OFF the
// acyclic core. Given the relation graph (an edge u→v whenever some rule
// reads u and writes v), Tarjan condenses it into SCCs:
//
//   • a SINGLETON component with no self-loop is a functional, acyclic
//     node — it runs the fast path (evaluate once, no fixpoint), exactly
//     like today's signal/lens.
//   • a component of size > 1 (or a self-loop) is a genuine cyclic
//     relationship — and ONLY it pays the bounded lattice-fixpoint cost.
//
// The condensation is a DAG, returned in topological (upstream-first)
// order so a scheduler settles each component after its inputs.
//
// Implementation notes for "fast & correct always":
//   • Iterative Tarjan (no recursion → no stack overflow on deep graphs).
//   • Single pass, O(V + E), no allocation per edge beyond the adjacency.
//   • Cycles only ever form among EXPLICITLY-declared relations, so in
//     the real engine this runs over the small relational subgraph and
//     only when topology changes — never on a value update.

export interface Condensation<T> {
  /** Components in topological order: inputs before dependents. */
  readonly order: readonly (readonly T[])[];
  /** Node → index of its component in `order`. */
  readonly comp: ReadonlyMap<T, number>;
  /** Per component: true iff cyclic (size > 1, or a 1-node self-loop). */
  readonly cyclic: readonly boolean[];
}

/** Iterative Tarjan over an arbitrary node set + successor function.
 *  Returns SCCs in topological (upstream-first) order. `succ` may restrict
 *  to a sub-region — incremental maintenance passes a filtered view — so
 *  this is the shared kernel for both batch and dynamic condensation. */
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
