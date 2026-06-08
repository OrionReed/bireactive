// incremental.bench.ts — building a graph edge-by-edge.
//
// The engine wires relations incrementally. Compare maintaining the SCC
// partition with DynCondensation vs. re-running batch Tarjan after each
// edge (the naive "recompute on topology change"). For a mostly-acyclic
// graph the incremental path should be near-linear; batch-per-edge is
// quadratic.
//
//   run: npx vite-node src/_proto/unified/incremental.bench.ts

import { bench, group, run } from "mitata";
import { DynCondensation } from "./incremental";
import { condense } from "./scc";

/** A forward chain + a sprinkling of short back edges (small cycles). */
function makeEdges(n: number): Array<[number, number]> {
  const edges: Array<[number, number]> = [];
  for (let i = 0; i < n - 1; i++) edges.push([i, i + 1]);
  for (let i = 10; i < n; i += 50) edges.push([i, i - 3]); // tiny local cycles
  return edges;
}

for (const N of [200, 1000]) {
  const edges = makeEdges(N);
  group(`build graph edge-by-edge (n=${N}, ${edges.length} edges)`, () => {
    bench("incremental (DynCondensation)", () => {
      const dyn = new DynCondensation<number>();
      for (const [u, v] of edges) dyn.addEdge(u, v);
      return dyn.order().length;
    });

    bench("batch Tarjan per edge", () => {
      const seen: Array<[number, number]> = [];
      const nodes = new Set<number>();
      let acc = 0;
      for (const [u, v] of edges) {
        seen.push([u, v]);
        nodes.add(u);
        nodes.add(v);
        acc += condense(nodes, seen).order.length;
      }
      return acc;
    });
  });
}

await run({ format: "mitata" });
