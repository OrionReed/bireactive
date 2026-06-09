// cyclic.bench.ts — the propagator/SCC solver hot path.
//
// Each tick performs ONE edit-then-read over a cyclic relation component of a
// given size, which forces a full component re-solve (write a member → its
// assertion bumps → the next read pulls the solver). This is the workload the
// worklist + warm-start changes target: the chaotic solver re-runs every rule
// every wave (`Component.solve`), so cost grows with both member and rule
// count. Uses only the public `equal` API so the numbers stay a valid
// before/after yardstick across the solver refactor; contractor-based
// (genuinely multi-wave) workloads are appended once `order`/`add` land.

import { group } from "mitata";
import { num } from "../../../index";
import { bound, equal, free, order } from "../../../relate";
import { reg } from "./runner";
import type { Tick } from "./workloads";

const PINF = Number.POSITIVE_INFINITY;

/** N cells in an equality ring → one SCC of N members, 2N rules. Edit one,
 *  read the opposite node — each tick re-solves the whole component. */
function equalRing(n: number): Tick {
  const cs = Array.from({ length: n }, (_, i) => num(i));
  for (let i = 0; i < n; i++) equal(cs[i]!, cs[(i + 1) % n]!);
  const read = cs[n >> 1]!;
  return i => {
    cs[0]!.value = i;
    return read.value;
  };
}

/** A center cell `equal` to N spokes → SCC of N+1, 2N rules, shallow. Stresses
 *  the per-wave rule count (exactly what the freshness gate prunes). */
function equalStar(n: number): Tick {
  const center = num(0);
  const spokes = Array.from({ length: n }, (_, i) => num(i + 1));
  for (const s of spokes) equal(center, s);
  const read = spokes[n - 1]!;
  return i => {
    center.value = i;
    return read.value;
  };
}

/** A fact head feeding an `order` chain of N free vars (`x_i + 1 ≤ x_{i+1}`) →
 *  one SCC; a bound at the head must propagate hop-by-hop to the tail. The
 *  multi-wave shape: chaotic re-fires all ~2N rules every wave (O(N²)); the
 *  worklist fires only the next hop's rules each wave (O(N)). Edit the head,
 *  read the tail. */
function orderChain(n: number): Tick {
  const head = num(0); // a FACT — writing it pins, re-seeding the solve
  const xs = Array.from({ length: n }, () => num(0));
  for (const x of xs) free(x);
  bound(xs[n - 1]!, 0, PINF); // keep the tail in the component, unbounded above
  order(head, xs[0]!, 1);
  for (let i = 0; i < n - 1; i++) order(xs[i]!, xs[i + 1]!, 1);
  const tail = xs[n - 1]!;
  return i => {
    head.value = i;
    return tail.value;
  };
}

group("equality ring: re-solve one SCC of N members", () => {
  reg("N=8", equalRing(8));
  reg("N=32", equalRing(32));
  reg("N=128", equalRing(128));
});

group("order chain: propagate a bound down N free vars", () => {
  reg("N=8", orderChain(8));
  reg("N=32", orderChain(32));
  reg("N=128", orderChain(128));
});

group("equality star: re-solve one shallow SCC of N spokes", () => {
  reg("N=8", equalStar(8));
  reg("N=32", equalStar(32));
  reg("N=128", equalStar(128));
});
