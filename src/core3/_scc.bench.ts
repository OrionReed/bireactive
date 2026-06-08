// _scc.bench.ts — time + ALLOCATION probe for the dynamic condensation.
//
//   run: node --expose-gc node_modules/.bin/vite-node src/core2/_scc.bench.ts
//
// Goal: confirm the acyclic/forward path is allocation-free per edge, and
// quantify the bounded cost of the cyclic paths (back-edge recondense,
// remove/split). "retained" = net heap growth per op (the data structure);
// "transient" = garbage produced per op (GC pressure). Forward edges should
// show ~0 transient; recondense/split scale with the touched region.

import { DynCondensation } from "./incremental";
import { condense } from "./scc";

const gc: () => void = (globalThis as { gc?: () => void }).gc ?? (() => {});
const heap = (): number => {
  gc();
  return process.memoryUsage().heapUsed;
};
const fmt = (b: number): string => `${b >= 0 ? "+" : ""}${b.toFixed(1)} B`;

if (!(globalThis as { gc?: unknown }).gc) {
  console.log("⚠  run with --expose-gc for accurate allocation numbers\n");
}

// ── retained memory per node ────────────────────────────────────────

function retainedPerNode(
  label: string,
  build: (dc: DynCondensation<number>, n: number) => void,
  N: number,
): void {
  gc();
  const before = process.memoryUsage().heapUsed;
  const dc = new DynCondensation<number>();
  build(dc, N);
  gc();
  const after = process.memoryUsage().heapUsed;
  // keep dc alive past measurement
  if (dc.order().length < 0) throw new Error("unreachable");
  console.log(`  ${label.padEnd(28)} ${fmt((after - before) / N)} / node   (N=${N})`);
}

// ── per-op time + transient allocation ──────────────────────────────

function probe(
  label: string,
  setup: () => { dc: DynCondensation<number>; ops: Array<() => void> },
): void {
  const { ops } = setup();
  // warm
  ops[0]?.();
  const iters = ops.length;

  const t0 = performance.now();
  const base = heap();
  let live = base;
  for (let i = 1; i < iters; i++) {
    ops[i]!();
  }
  const dirtyHeap = process.memoryUsage().heapUsed; // garbage + retained
  const t1 = performance.now();
  live = heap(); // retained only
  const n = iters - 1;
  const transient = (dirtyHeap - base) / n;
  const retained = (live - base) / n;
  const us = ((t1 - t0) / n) * 1000;
  console.log(
    `  ${label.padEnd(28)} ${us.toFixed(3)} µs/op   retained ${fmt(retained)}/op   ~transient ${fmt(transient)}/op`,
  );
}

console.log("retained memory (steady state):");
retainedPerNode(
  "acyclic chain",
  (dc, N) => {
    for (let i = 0; i < N - 1; i++) dc.addEdge(i, i + 1);
  },
  20_000,
);
retainedPerNode(
  "single big cycle",
  (dc, N) => {
    for (let i = 0; i < N; i++) dc.addEdge(i, (i + 1) % N);
  },
  20_000,
);

console.log("\nforward growth (the acyclic hot path):");
probe("forward addEdge (+ new node)", () => {
  const dc = new DynCondensation<number>();
  const N = 50_000;
  const ops: Array<() => void> = [];
  for (let i = 0; i < N - 1; i++) ops.push(() => dc.addEdge(i, i + 1));
  return { dc, ops };
});
probe("forward edge (existing nodes)", () => {
  // pre-create every node, then add only forward edges between them — this
  // is relate's steady-state hot path (cells exist; relations come and go).
  const dc = new DynCondensation<number>();
  const N = 50_000;
  for (let i = 0; i < N; i++) dc.addNode(i);
  const ops: Array<() => void> = [];
  for (let i = 0; i < N - 1; i++) ops.push(() => dc.addEdge(i, i + 1));
  return { dc, ops };
});

console.log("\nback-edge recondense (window = W components):");
for (const W of [8, 64, 512]) {
  probe(`back edge over window ${W}`, () => {
    // many disjoint chains of length W laid out consecutively, then close
    // each into a cycle with one back edge → each recondense touches W nodes.
    const dc = new DynCondensation<number>();
    const groups = 400;
    for (let g = 0; g < groups; g++) {
      const base = g * W;
      for (let i = 0; i < W - 1; i++) dc.addEdge(base + i, base + i + 1);
    }
    const ops: Array<() => void> = [];
    for (let g = 0; g < groups; g++) {
      const base = g * W;
      ops.push(() => dc.addEdge(base + W - 1, base)); // back edge → fuse W
    }
    return { dc, ops };
  });
}

console.log("\nremove/split (decremental — renumbers condensation):");
for (const N of [16, 128, 1024]) {
  probe(`remove edge in cycle ${N}`, () => {
    // independent cycles of size N; remove the closing edge of each → split.
    const dc = new DynCondensation<number>();
    const groups = 200;
    for (let g = 0; g < groups; g++) {
      const base = g * N;
      for (let i = 0; i < N; i++) dc.addEdge(base + i, base + ((i + 1) % N));
    }
    const ops: Array<() => void> = [];
    for (let g = 0; g < groups; g++) {
      const base = g * N;
      ops.push(() => dc.removeEdge(base + N - 1, base));
    }
    return { dc, ops };
  });
}

console.log("\nbatch condense (cold full build):");
{
  const N = 50_000;
  const nodes = Array.from({ length: N }, (_, i) => i);
  const edges: Array<[number, number]> = [];
  for (let i = 0; i < N - 1; i++) edges.push([i, i + 1]);
  condense(nodes, edges); // warm
  gc();
  const b = process.memoryUsage().heapUsed;
  const t0 = performance.now();
  const c = condense(nodes, edges);
  const t1 = performance.now();
  const dirty = process.memoryUsage().heapUsed;
  if (c.order.length !== N) throw new Error("bad");
  console.log(
    `  ${"chain N=50k".padEnd(28)} ${(t1 - t0).toFixed(2)} ms   ~transient ${fmt((dirty - b) / N)}/node`,
  );
}
