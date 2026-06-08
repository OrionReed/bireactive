// scc.bench.ts — does condensation-scheduling actually isolate cyclic cost?
//
// The claim under test: a graph that is MOSTLY an acyclic functional chain
// with a small cyclic island should cost ~O(chain) + O(island), not
// O(chain × depth). The flat freshness-gated drain (today's solver) pays
// the depth as waves, each re-scanning every rule → quadratic. SCC pays
// the chain once.
//
//   run: npx vite-node src/_proto/unified/scc.bench.ts

import { bench, group, run } from "mitata";
import { type Cell, source } from "./engine";
import { type Interval, interval } from "./lattice";
import { FlatSolver, type Rel, rel, SccSolver } from "./solver-scc";

const NINF = Number.NEGATIVE_INFINITY;
const PINF = Number.POSITIVE_INFINITY;
const ival = (lo = NINF, hi = PINF): Cell<Interval> => source<Interval>([lo, hi], interval);
const copy = (a: Cell<Interval>, b: Cell<Interval>): Rel =>
  rel([a], [b], emit => () => emit(b, a.peek()));
const equalI = (a: Cell<Interval>, b: Cell<Interval>): Rel[] => [
  rel([a], [b], emit => () => emit(b, a.peek())),
  rel([b], [a], emit => () => emit(a, b.peek())),
];

/** A length-N acyclic copy chain, seeded at the head. */
function chain(n: number): Rel[] {
  const cells = [ival(0, 100), ...Array.from({ length: n }, () => ival())];
  const rules: Rel[] = [];
  for (let i = 0; i < n; i++) rules.push(copy(cells[i]!, cells[i + 1]!));
  return rules;
}

/** A length-N chain with a small k-cycle spliced into the middle. */
function chainWithCycle(n: number, k: number): Rel[] {
  const head = [ival(0, 100), ...Array.from({ length: n }, () => ival())];
  const rules: Rel[] = [];
  for (let i = 0; i < n; i++) rules.push(copy(head[i]!, head[i + 1]!));
  // splice a k-cycle off the tail
  const ring = Array.from({ length: k }, () => ival());
  rules.push(copy(head[n]!, ring[0]!));
  for (let i = 0; i < k; i++) rules.push(...equalI(ring[i]!, ring[(i + 1) % k]!));
  return rules;
}

for (const N of [50, 200, 800]) {
  group(`acyclic chain (len=${N})`, () => {
    bench("SCC  scheduled", () => new SccSolver().add(...chain(N)).solve());
    bench("flat drain", () => new FlatSolver().add(...chain(N)).solve());
  });
}

group("chain(len=400) + 4-cycle island", () => {
  bench("SCC  scheduled", () => new SccSolver().add(...chainWithCycle(400, 4)).solve());
  bench("flat drain", () => new FlatSolver().add(...chainWithCycle(400, 4)).solve());
});

// Report the work asymmetry once, in numbers, before the timing run.
{
  const probe = (n: number) => {
    const scc = new SccSolver().add(...chain(n)).solve().stats;
    const flat = new FlatSolver().add(...chain(n)).solve().stats;
    return { n, scc, flat };
  };
  console.log("\nwork profile (acyclic chain):");
  for (const n of [50, 200, 800]) {
    const { scc, flat } = probe(n);
    console.log(
      `  len=${String(n).padStart(4)}  SCC: ${scc.ruleFires} fires / ${scc.waves} waves` +
        `   flat: ${flat.ruleFires} fires / ${flat.waves} waves`,
    );
  }
  console.log();
}

await run({ format: "mitata" });
