// Shared SCC test scaffolding: a deterministic PRNG and an INDEPENDENT
// strongly-connected-components oracle (mutual reachability). The oracle is
// deliberately the slow, obvious algorithm so it can be trusted as ground
// truth for both batch Tarjan and the incremental condensation.

export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t ^= t + Math.imul(t ^ (t >>> 7), 61 | t);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Order-independent signature of a partition (sorted members, sorted parts). */
export function sig<T>(parts: ReadonlyArray<ReadonlyArray<T>>, key: (x: T) => string): string {
  return parts
    .map(p => [...p].map(key).sort().join(","))
    .sort()
    .join("|");
}

/** SCC partition by mutual reachability — O(V·(V+E)), obviously correct.
 *  Returns the partition as member arrays. */
export function oraclePartition<T>(
  nodes: readonly T[],
  edges: ReadonlyArray<readonly [T, T]>,
): T[][] {
  const adj = new Map<T, T[]>();
  for (const n of nodes) adj.set(n, []);
  for (const [u, v] of edges) (adj.get(u) ?? adj.set(u, []).get(u)!).push(v);

  const reach = (s: T): Set<T> => {
    const seen = new Set<T>([s]);
    const stack = [s];
    while (stack.length) {
      const x = stack.pop()!;
      for (const y of adj.get(x) ?? []) if (!seen.has(y)) seen.add(y), stack.push(y);
    }
    return seen;
  };
  const R = new Map<T, Set<T>>();
  for (const n of nodes) R.set(n, reach(n));

  // Group nodes into mutual-reachability classes.
  const repOf = new Map<T, T>();
  const groups = new Map<T, T[]>();
  for (const n of nodes) {
    let rep: T | undefined;
    for (const m of repOf.keys()) {
      if (R.get(n)!.has(m) && R.get(m)!.has(n)) {
        rep = repOf.get(m)!;
        break;
      }
    }
    if (rep === undefined) {
      rep = n;
      groups.set(n, []);
    }
    repOf.set(n, rep);
    groups.get(rep)!.push(n);
  }
  return [...groups.values()];
}

/** Linear-extension check: every cross-component edge points forward in the
 *  given topological order of components. */
export function isLinearExtension<T>(
  order: ReadonlyArray<ReadonlyArray<T>>,
  edges: ReadonlyArray<readonly [T, T]>,
): boolean {
  const idx = new Map<T, number>();
  order.forEach((comp, i) => {
    for (const n of comp) idx.set(n, i);
  });
  for (const [u, v] of edges) {
    if (!idx.has(u) || !idx.has(v)) continue;
    if (idx.get(u)! > idx.get(v)!) return false;
  }
  return true;
}
