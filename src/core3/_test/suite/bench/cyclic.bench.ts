// cyclic.bench.ts — the propagator relaxation hot path.
//
// Each tick performs ONE edit-then-read over a cyclic `equal` region of a given
// size: writing a member drains the region's propagators to a fixpoint (the
// whole ring/star relaxes as one unit), then the read returns the settled
// value. Exercises the equality-gated relaxation drain across both member and
// rule count.

import { group } from "mitata";
import { num } from "../../../index";
import { equal } from "../../../relate";
import { reg } from "./runner";
import type { Tick } from "./workloads";

/** N cells in an equality ring → one cyclic region of N members, 2N rules. Edit
 *  one, read the opposite node — each tick relaxes the whole region. */
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

group("equality ring: relax one region of N members", () => {
  reg("N=8", equalRing(8));
  reg("N=32", equalRing(32));
  reg("N=128", equalRing(128));
});

group("equality star: relax one shallow region of N spokes", () => {
  reg("N=8", equalStar(8));
  reg("N=32", equalStar(32));
  reg("N=128", equalStar(128));
});
