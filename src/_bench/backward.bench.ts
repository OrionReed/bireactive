// Backward-engine bench: the rewritten engine (`live`) vs a frozen verbatim copy
// of the pre-rewrite engine (`frozen`), on the paths the rewrite touched —
// 1→1 chains, co-writer fan-in (LWW), merge fan-in, diamonds (bEpoch dedup), and
// wide 1→1 throughput. Each scenario is registered for both engines, side by
// side, so mitata's relative column reads as new-vs-old.
//
//   node --expose-gc node_modules/.bin/vite-node src/_bench/backward.bench.ts

import { bench, do_not_optimize, group, run } from "mitata";
import * as live from "../core/cell";
import * as frozen from "../core/_test/_diff/cell-frozen";

// biome-ignore lint/suspicious/noExplicitAny: cross-module engine surface
type Engine = any;

// A realized steady-state back-write: write the view(s), then read the source —
// the read drives `backResolve` (markDown already armed the cone). After the
// first call the graph is realized, so this measures the hot Pending path.

function backChain(rx: Engine, depth: number): () => unknown {
  const { cell, lens } = rx;
  let top = cell(0);
  const src = top;
  for (let i = 0; i < depth; i++) top = lens(top, (x: number) => x + 1, (t: number) => t - 1);
  let k = 0;
  return () => {
    top.value = k++ & 1023;
    return src.value;
  };
}

function fanInCoWriters(rx: Engine, n: number): () => unknown {
  const { cell, lens } = rx;
  const src = cell(0);
  const views = Array.from({ length: n }, (_, i) =>
    lens(src, (x: number) => x + i, (t: number) => t - i),
  );
  let k = 0;
  return () => {
    const base = k++ & 1023;
    for (let i = 0; i < n; i++) views[i].value = base + i;
    return src.value;
  };
}

function mergeFanIn(rx: Engine, n: number): () => unknown {
  const { cell, lens } = rx;
  const src = cell(0);
  const m = src.merge();
  const cs = Array.from({ length: n }, (_, i) =>
    lens(m, (x: number) => x + i, (t: number) => t - i),
  );
  let k = 0;
  return () => {
    const base = k++ & 1023;
    for (let i = 0; i < n; i++) cs[i].value = base + i;
    return src.value;
  };
}

// Fan-out (k views over one source) then fan-in (one lensN over all of them):
// writing the top forces the back-write through every branch into the shared
// source — the diamond that exercises the bEpoch visited-dedup.
function diamond(rx: Engine, width: number): () => unknown {
  const { cell, lens } = rx;
  const src = cell(0);
  const mid = Array.from({ length: width }, (_, i) =>
    lens(src, (x: number) => x + i, (t: number) => t - i),
  );
  const top = lens(
    mid,
    (vals: number[]) => vals.reduce((a: number, x: number) => a + x, 0),
    (t: number, vals: number[]) => {
      const cur = vals.reduce((a: number, x: number) => a + x, 0);
      const d = (t - cur) / width;
      return vals.map((x: number) => x + d);
    },
  );
  let k = 0;
  return () => {
    top.value = k++ & 1023;
    return src.value;
  };
}

function wideIndependent(rx: Engine, m: number): () => unknown {
  const { cell, lens } = rx;
  const srcs = Array.from({ length: m }, () => cell(0));
  const views = srcs.map((s: unknown) => lens(s, (x: number) => x + 1, (t: number) => t - 1));
  let k = 0;
  return () => {
    const base = k++ & 1023;
    let acc = 0;
    for (let i = 0; i < m; i++) {
      views[i].value = base;
      acc += srcs[i].value as number;
    }
    return acc;
  };
}

function reg(name: string, fn: () => unknown): void {
  for (let i = 0; i < 200; i++) do_not_optimize(fn());
  if ((globalThis as { gc?: () => void }).gc) (globalThis as { gc?: () => void }).gc!();
  bench(name, () => do_not_optimize(fn()));
}

group("chain back-write depth=50", () => {
  reg("new", backChain(live, 50));
  reg("old", backChain(frozen, 50));
});
group("co-writer fan-in N=64 (LWW)", () => {
  reg("new", fanInCoWriters(live, 64));
  reg("old", fanInCoWriters(frozen, 64));
});
group("merge fan-in N=64", () => {
  reg("new", mergeFanIn(live, 64));
  reg("old", mergeFanIn(frozen, 64));
});
group("diamond width=32 (bEpoch dedup)", () => {
  reg("new", diamond(live, 32));
  reg("old", diamond(frozen, 32));
});
group("wide independent M=200 (1→1)", () => {
  reg("new", wideIndependent(live, 200));
  reg("old", wideIndependent(frozen, 200));
});

await run({ format: "mitata" });
