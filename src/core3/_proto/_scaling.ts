// Scratch: measure region/condensation scaling under SPARSE incremental edits.
//   run: npx vite-node src/core3/_proto/_scaling.ts
//
// `total` is a bad scaling probe (each part-rule reads every other part ⇒ O(N²)
// EDGES inherently). A chain of `equal` is O(N) edges forming one SCC of N
// members — the honest test of incremental SCC + lazy-region build.
import { settle } from "../cell";
import { num } from "../index";
import { equal } from "../relate";

function timeChain(n: number, read: boolean): number {
  const xs = Array.from({ length: n }, () => num(0));
  const t0 = performance.now();
  for (let i = 0; i < n - 1; i++) equal(xs[i]!, xs[i + 1]!); // N-1 edges, one SCC
  if (read) {
    xs[0]!.value = 5;
    settle();
    void xs[n - 1]!.value;
  }
  return performance.now() - t0;
}

console.log("— build only (no read): pure declare cost —");
for (const n of [50, 100, 200, 400, 800]) {
  timeChain(n, false);
  const ms = Math.min(timeChain(n, false), timeChain(n, false), timeChain(n, false));
  console.log(`n=${String(n).padStart(4)}  ${ms.toFixed(2)}ms  per-edit=${(ms / n).toFixed(4)}ms`);
}
console.log("— build + one read (forces lazy region materialize + solve) —");
for (const n of [50, 100, 200, 400, 800]) {
  timeChain(n, true);
  const ms = Math.min(timeChain(n, true), timeChain(n, true), timeChain(n, true));
  console.log(`n=${String(n).padStart(4)}  ${ms.toFixed(2)}ms  per-edit=${(ms / n).toFixed(4)}ms`);
}
