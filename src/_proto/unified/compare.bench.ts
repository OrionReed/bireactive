// compare.bench.ts — unified prototype vs the production cell engine.
//
// Goal: see whether the staged settle-to-fixpoint model is in the same
// ballpark for the SIGNAL-degenerate case (a chain/fan of pure forward
// derivations), and measure the backward + cycle paths that the prod
// engine can't express as cheaply.
//
//   run: npx vite-node src/_proto/unified/compare.bench.ts

import "../../_test/setup";
import { type Cell, cell, derive, lens as plens, type Writable } from "@bireactive/core";
import { bench, group, run } from "mitata";
import { computed, lens1, settle, source } from "./engine";
import { type Interval, interval } from "./lattice";

const CHAIN = 50;
const ITERS = 1000;

group(`forward chain (len=${CHAIN}, ${ITERS} writes+reads)`, () => {
  bench("prod  derive chain", () => {
    const a = cell(0);
    let node: Cell<number> = a;
    for (let i = 0; i < CHAIN; i++) node = derive(node, (x: number) => x + 1);
    let s = 0;
    for (let k = 0; k < ITERS; k++) {
      a.value = k;
      s += node.value;
    }
    return s;
  });

  bench("proto computed chain", () => {
    const a = source(0);
    let node = a;
    for (let i = 0; i < CHAIN; i++) node = computed([node], ([x]) => (x as number) + 1);
    let s = 0;
    for (let k = 0; k < ITERS; k++) {
      a.value = k;
      s += node.value as number;
    }
    return s;
  });
});

const FAN = 200;
group(`fan-out (1 → ${FAN} derived, ${ITERS} writes+reads)`, () => {
  bench("prod  derive fan", () => {
    const a = cell(0);
    const ds = Array.from({ length: FAN }, (_, i) => derive(a, (x: number) => x + i));
    let s = 0;
    for (let k = 0; k < ITERS; k++) {
      a.value = k;
      for (const d of ds) s += d.value;
    }
    return s;
  });

  bench("proto computed fan", () => {
    const a = source(0);
    const ds = Array.from({ length: FAN }, (_, i) => computed([a], ([x]) => (x as number) + i));
    let s = 0;
    for (let k = 0; k < ITERS; k++) {
      a.value = k;
      for (const d of ds) s += d.value as number;
    }
    return s;
  });
});

group(`backward lens write (chain len=${CHAIN}, ${ITERS} writes)`, () => {
  bench("prod  lens chain bwd", () => {
    const a = cell(0);
    let node: Writable<Cell<number>> = a;
    for (let i = 0; i < CHAIN; i++) {
      node = plens(
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

  bench("proto lens chain bwd", () => {
    const a = source(0);
    let node = a;
    for (let i = 0; i < CHAIN; i++) {
      node = lens1(
        node,
        x => (x as number) + 1,
        t => (t as number) - 1,
      );
    }
    let s = 0;
    for (let k = 0; k < ITERS; k++) {
      node.value = k;
      s += a.value as number;
    }
    return s;
  });
});

// The prod engine has no native cyclic-constraint primitive; this is the
// path the unified model adds. Reported standalone (no comparison).
group(`proto-only: interval relaxation (${ITERS} narrowings)`, () => {
  bench("proto a=b 2-cycle settle", () => {
    let s = 0;
    for (let k = 0; k < ITERS; k++) {
      const a = source<Interval>([0, 100], interval);
      a.value = [k % 50, 100 - (k % 50)];
      settle();
      s += a.value[0];
    }
    return s;
  });
});

await run({ format: "mitata" });
