// scaling.ts — characterize the spine's cost shape.
//   run: npx vite-node src/core3/_proto/fix/scaling.ts
//
// The headline question: with NO maintained condensation, what does cost look
// like for (a) acyclic chains, (b) many small SCCs, (c) one giant SCC? The old
// engine paid Θ(N²) just to BUILD the condensation incrementally; here there is
// no build at all — declaration is O(1) per edge — so we measure SOLVE cost,
// counting rule evaluations (the honest unit, independent of constant factors).

import { type Lattice, Net } from "./engine";

const BITS = 6;
const FULL = (1 << BITS) - 1;
const subset: Lattice<number> = { bottom: FULL, join: (a, b) => a & b, eq: (a, b) => a === b };

function row(label: string, n: number, declMs: number, evals: number, solveMs: number): void {
  console.log(
    `${label.padEnd(18)} n=${String(n).padStart(5)}  decl=${declMs.toFixed(2)}ms  ` +
      `ruleEvals=${String(evals).padStart(9)}  (${(evals / n).toFixed(1)}/cell)  solve=${solveMs.toFixed(2)}ms`,
  );
}

// (a) ACYCLIC chain: c0 ← c1 ← … ← c_{n-1}. Read the tail. Should be ~1 eval/cell.
function acyclic(n: number): void {
  const net = new Net(subset);
  const cs = Array.from({ length: n }, () => net.cell(FULL));
  net.set(cs[0]!, 0b101010);
  const t0 = performance.now();
  for (let i = 1; i < n; i++) net.rule(cs[i]!, get => get(cs[i - 1]!));
  const t1 = performance.now();
  net.resetStats();
  net.read(cs[n - 1]!);
  const t2 = performance.now();
  row("acyclic chain", n, t1 - t0, net.ruleEvals, t2 - t1);
}

// (b) MANY SMALL SCCs: n/2 independent 2-cycles a_i ⇄ b_i. Read every cell.
function smallSccs(n: number): void {
  const net = new Net(subset);
  const cs = Array.from({ length: n }, (_, i) => net.cell(i % 7 === 0 ? 0b110110 : FULL));
  const t0 = performance.now();
  for (let i = 0; i + 1 < n; i += 2) {
    net.rule(cs[i]!, get => get(cs[i + 1]!));
    net.rule(cs[i + 1]!, get => get(cs[i]!));
  }
  const t1 = performance.now();
  net.resetStats();
  for (let i = 0; i < n; i++) net.read(cs[i]!);
  const t2 = performance.now();
  row("many 2-cycles", n, t1 - t0, net.ruleEvals, t2 - t1);
}

// (c) ONE GIANT SCC: equality chain a0 ⇄ a1 ⇄ … ⇄ a_{n-1} (bidirectional ⇒ one
//     SCC of n members). Read one end. This is the worst case for a naive
//     single-head Kleene (info crawls one hop/sweep) — the case a WTO iteration
//     order fixes later. Measured here to quantify exactly that gap.
function bigScc(n: number): void {
  const net = new Net(subset);
  const cs = Array.from({ length: n }, () => net.cell(FULL));
  net.set(cs[0]!, 0b101010);
  const t0 = performance.now();
  for (let i = 0; i + 1 < n; i++) {
    net.rule(cs[i]!, get => get(cs[i + 1]!));
    net.rule(cs[i + 1]!, get => get(cs[i]!));
  }
  const t1 = performance.now();
  net.resetStats();
  net.read(cs[n - 1]!);
  const t2 = performance.now();
  row("big equality SCC", n, t1 - t0, net.ruleEvals, t2 - t1);
}

// NOTE: this prototype pulls via plain recursion, so chain DEPTH is bounded by
// the JS stack (~a few thousand). Production would use alien's iterative
// link-list traversal (no recursion). Capped here accordingly.
console.log("— acyclic: expect ~1 eval/cell, flat —");
for (const n of [100, 500, 1000]) acyclic(n);
console.log("— many small SCCs: expect O(n), flat per-cell (shallow recursion) —");
for (const n of [100, 1000, 10000]) smallSccs(n);
console.log("— one giant SCC (naive single-head Kleene; WTO is the fix) —");
for (const n of [50, 100, 200, 400]) bigScc(n);
