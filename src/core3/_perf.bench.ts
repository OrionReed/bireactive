// _perf.bench.ts — regression probe for the SCC integration work.
//
// Measures the hot paths the changes risk slowing: forward chain + fan
// (pure signal core that must stay alien-signals-fast), and backward lens
// writes. Re-run after each change; the acyclic numbers must not move.
//
//   run: npx vite-node src/core2/_perf.bench.ts

import { bench, group, run } from "mitata";
import { cell, derive, lens } from "./index";

const ITERS = 1000;

group("forward chain (depth 50)", () => {
  bench("core2", () => {
    const a = cell(0);
    let node = a as ReturnType<typeof derive<number>> | typeof a;
    for (let i = 0; i < 50; i++) node = derive(node, (x: number) => x + 1);
    let s = 0;
    for (let k = 0; k < ITERS; k++) {
      a.value = k;
      s += node.value;
    }
    return s;
  });
});

group("forward fan (1 → 200)", () => {
  bench("core2", () => {
    const a = cell(0);
    const ds = Array.from({ length: 200 }, (_, i) => derive(a, (x: number) => x + i));
    let s = 0;
    for (let k = 0; k < ITERS; k++) {
      a.value = k;
      for (const d of ds) s += d.value;
    }
    return s;
  });
});

group("backward lens chain (depth 50)", () => {
  bench("core2", () => {
    const a = cell(0);
    let node = a;
    for (let i = 0; i < 50; i++) {
      node = lens(
        node,
        (x: number) => x + 1,
        (t: number) => t - 1,
      );
    }
    let s = 0;
    for (let k = 0; k < ITERS; k++) {
      node.value = k;
      s += a.value;
    }
    return s;
  });
});

await run({ format: "mitata" });
