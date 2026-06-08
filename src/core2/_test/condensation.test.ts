// Condensation correctness — the partitioner that keeps cyclic cost off the
// acyclic core MUST be right ALWAYS. We check three layers:
//   1. batch Tarjan (`condense`) against an independent reachability oracle,
//   2. the dynamic condensation (`DynCondensation`) against batch Tarjan,
//      under fuzzed add/remove edit sequences (merges AND splits),
//   3. structural invariants: linear-extension ordinals, locality bounds.

import { describe, expect, it } from "vitest";
import { DynCondensation } from "../incremental";
import { condense, tarjan } from "../scc";
import { isLinearExtension, mulberry32, oraclePartition, sig } from "./_scc-util";

const S = (n: number): string => String(n);
const oracleSig = (nodes: number[], edges: ReadonlyArray<readonly [number, number]>): string =>
  sig(oraclePartition(nodes, edges), S);

// ── 1. batch Tarjan vs oracle, fixed topologies ─────────────────────

describe("batch Tarjan — fixed topologies vs reachability oracle", () => {
  const cases: Array<{ name: string; nodes: number[]; edges: Array<[number, number]> }> = [
    { name: "empty", nodes: [], edges: [] },
    { name: "single node", nodes: [0], edges: [] },
    { name: "self-loop", nodes: [0], edges: [[0, 0]] },
    { name: "acyclic chain", nodes: [0, 1, 2, 3], edges: [[0, 1], [1, 2], [2, 3]] },
    { name: "simple 3-cycle", nodes: [0, 1, 2], edges: [[0, 1], [1, 2], [2, 0]] },
    {
      name: "two disjoint cycles",
      nodes: [0, 1, 2, 3],
      edges: [[0, 1], [1, 0], [2, 3], [3, 2]],
    },
    {
      name: "diamond (acyclic)",
      nodes: [0, 1, 2, 3],
      edges: [[0, 1], [0, 2], [1, 3], [2, 3]],
    },
    {
      name: "figure-8 (two cycles sharing a node → one SCC)",
      nodes: [0, 1, 2, 3, 4],
      edges: [[0, 1], [1, 0], [1, 2], [2, 3], [3, 4], [4, 2], [2, 1]],
    },
    {
      name: "two cycles joined by a bridge (stay separate)",
      nodes: [0, 1, 2, 3],
      edges: [[0, 1], [1, 0], [1, 2], [2, 3], [3, 2]],
    },
    {
      name: "complete digraph (single SCC)",
      nodes: [0, 1, 2],
      edges: [[0, 1], [1, 0], [0, 2], [2, 0], [1, 2], [2, 1]],
    },
  ];

  for (const c of cases) {
    it(c.name, () => {
      const cond = condense(c.nodes, c.edges);
      expect(sig(cond.order, S)).toBe(oracleSig(c.nodes, c.edges));
      // condense returns topological order → must be a linear extension.
      expect(isLinearExtension(cond.order, c.edges)).toBe(true);
      // cyclic flags agree with component size / self-loop.
      cond.order.forEach((comp, i) => {
        const looped = comp.length === 1 && c.edges.some(([u, v]) => u === comp[0] && v === comp[0]);
        expect(cond.cyclic[i]).toBe(comp.length > 1 || looped);
      });
    });
  }

  it("tarjan kernel emits components in upstream-first order", () => {
    // chain 0→1→2: component [0] must precede [1] precede [2].
    const succ = (n: number): number[] => (n < 2 ? [n + 1] : []);
    const order = tarjan([0, 1, 2], succ);
    expect(order).toEqual([[0], [1], [2]]);
  });
});

// ── 2. DynCondensation vs batch, fuzzed (merges + splits) ───────────

/** Current partition of a DynCondensation as a signature. */
function dynSig(dc: DynCondensation<number>): string {
  return sig(dc.order(), S);
}

describe("DynCondensation — incremental matches batch under fuzzing", () => {
  it("add-only: matches batch after every insertion (100 graphs)", () => {
    for (let seed = 1; seed <= 100; seed++) {
      const rnd = mulberry32(seed);
      const V = 8;
      const nodes = Array.from({ length: V }, (_, i) => i);
      const dc = new DynCondensation<number>();
      for (const n of nodes) dc.addNode(n);
      const edges = new Set<string>();

      const E = 14;
      for (let k = 0; k < E; k++) {
        const u = Math.floor(rnd() * V);
        const v = Math.floor(rnd() * V);
        const key = `${u},${v}`;
        if (edges.has(key)) continue;
        edges.add(key);
        dc.addEdge(u, v);

        const edgeList = [...edges].map(s => s.split(",").map(Number) as [number, number]);
        expect(dynSig(dc)).toBe(oracleSig(nodes, edgeList));
        expect(isLinearExtension(dc.order(), edgeList)).toBe(true);
      }
    }
  });

  it("add + remove: matches batch through merges and splits (80 sequences)", () => {
    for (let seed = 1; seed <= 80; seed++) {
      const rnd = mulberry32(seed * 7 + 1);
      const V = 7;
      const nodes = Array.from({ length: V }, (_, i) => i);
      const dc = new DynCondensation<number>();
      for (const n of nodes) dc.addNode(n);
      const edges = new Set<string>();

      const OPS = 30;
      for (let k = 0; k < OPS; k++) {
        const u = Math.floor(rnd() * V);
        const v = Math.floor(rnd() * V);
        const key = `${u},${v}`;
        if (rnd() < 0.6) {
          if (!edges.has(key)) {
            edges.add(key);
            dc.addEdge(u, v);
          }
        } else if (edges.has(key)) {
          edges.delete(key);
          dc.removeEdge(u, v);
        }
        const edgeList = [...edges].map(s => s.split(",").map(Number) as [number, number]);
        expect(dynSig(dc)).toBe(oracleSig(nodes, edgeList));
        expect(isLinearExtension(dc.order(), edgeList)).toBe(true);
      }
    }
  });
});

// ── 3. explicit merge / split / overlap behaviours ──────────────────

describe("DynCondensation — merge, overlap, split", () => {
  it("a back edge MERGES two components into one SCC", () => {
    const dc = new DynCondensation<number>();
    dc.addEdge(0, 1); // {0}→{1}
    dc.addEdge(1, 2); // {0}→{1}→{2}
    expect(dc.sameComponent(0, 2)).toBe(false);
    dc.addEdge(2, 0); // closes the cycle → {0,1,2}
    expect(dc.sameComponent(0, 2)).toBe(true);
    expect(dc.membersOf(0).sort()).toEqual([0, 1, 2]);
    expect(dc.isCyclic(0)).toBe(true);
  });

  it("overlapping cycles fuse (figure-8 shares a node)", () => {
    const dc = new DynCondensation<number>();
    // cycle A: 0→1→0 ; cycle B: 1→2→1 ; share node 1 → all one SCC
    dc.addEdge(0, 1);
    dc.addEdge(1, 0);
    dc.addEdge(1, 2);
    dc.addEdge(2, 1);
    expect(dc.sameComponent(0, 2)).toBe(true);
    expect(dc.membersOf(0).sort()).toEqual([0, 1, 2]);
  });

  it("merging two pre-existing cycles via a bridge pair", () => {
    const dc = new DynCondensation<number>();
    dc.addEdge(0, 1);
    dc.addEdge(1, 0); // {0,1}
    dc.addEdge(2, 3);
    dc.addEdge(3, 2); // {2,3}
    expect(dc.sameComponent(0, 2)).toBe(false);
    dc.addEdge(1, 2);
    dc.addEdge(2, 1); // bidirectional bridge → fuse all four
    expect(dc.sameComponent(0, 3)).toBe(true);
    expect(dc.membersOf(0).sort()).toEqual([0, 1, 2, 3]);
  });

  it("removing a cycle edge SPLITS the SCC correctly", () => {
    const dc = new DynCondensation<number>();
    dc.addEdge(0, 1);
    dc.addEdge(1, 2);
    dc.addEdge(2, 0); // {0,1,2}
    expect(dc.membersOf(0).sort()).toEqual([0, 1, 2]);
    dc.removeEdge(2, 0); // break the cycle → 3 singletons, chain 0→1→2
    expect(dc.sameComponent(0, 1)).toBe(false);
    expect(dc.order().map(c => c[0])).toEqual([0, 1, 2]); // topo order preserved
  });

  it("partial split: a big SCC drops to a smaller cycle + tail", () => {
    const dc = new DynCondensation<number>();
    // 0→1→2→3→0 (one 4-cycle) plus chord 1→3
    for (const [u, v] of [[0, 1], [1, 2], [2, 3], [3, 0], [1, 3]] as [number, number][]) {
      dc.addEdge(u, v);
    }
    expect(dc.membersOf(0).sort()).toEqual([0, 1, 2, 3]);
    // remove 2→3: cycle 0→1→2→3→0 broken, but 1→3→0→1 still cyclic
    dc.removeEdge(2, 3);
    expect(dc.sameComponent(0, 1)).toBe(true); // 0,1,3 still a cycle
    expect(dc.sameComponent(0, 3)).toBe(true);
    expect(dc.sameComponent(0, 2)).toBe(false); // 2 fell out
  });

  it("cross-component edge removal is a no-op for the partition", () => {
    const dc = new DynCondensation<number>();
    dc.addEdge(0, 1); // DAG edge between singletons
    dc.addEdge(1, 2);
    const before = dynSig(dc);
    dc.removeEdge(0, 1);
    expect(dynSig(dc)).toBe(before); // partition unchanged
    expect(dc.lastTouched).toBe(0); // O(1): no component recompute
  });
});

// ── 4. locality / overhead ──────────────────────────────────────────

describe("DynCondensation — locality and overhead", () => {
  it("building an in-order acyclic chain never re-condenses (lastTouched stays 0)", () => {
    const dc = new DynCondensation<number>();
    const N = 200;
    let totalTouched = 0;
    for (let i = 0; i < N; i++) {
      dc.addEdge(i, i + 1); // always a forward edge
      totalTouched += dc.lastTouched;
    }
    expect(totalTouched).toBe(0); // O(1) per edge, zero recondensation work
    expect(dc.order().length).toBe(N + 1); // all singletons
  });

  it("a local back edge touches only its window, not the whole graph", () => {
    const dc = new DynCondensation<number>();
    const N = 200;
    for (let i = 0; i < N; i++) dc.addEdge(i, i + 1);
    // small back edge 5→4 closes a 2-cycle {4,5}; window is tiny.
    dc.addEdge(5, 4);
    expect(dc.lastTouched).toBeLessThanOrEqual(3); // NOT ~N
    expect(dc.membersOf(4).sort()).toEqual([4, 5]);
  });

  it("a spanning back edge legitimately touches the whole window", () => {
    const dc = new DynCondensation<number>();
    const N = 50;
    for (let i = 0; i < N; i++) dc.addEdge(i, i + 1);
    dc.addEdge(N, 0); // closes the giant cycle → one SCC
    expect(dc.lastTouched).toBe(N + 1);
    expect(dc.membersOf(0).length).toBe(N + 1);
  });
});
