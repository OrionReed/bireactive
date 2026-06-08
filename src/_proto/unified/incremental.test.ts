// Dynamic condensation must always agree with batch Tarjan, and must keep
// edits LOCAL (forward edges are free; a back edge only touches its
// ordinal window). We fuzz the partition against `condense` as the oracle.

import { describe, expect, it } from "vitest";
import { DynCondensation } from "./incremental";
import { condense } from "./scc";

/** Canonical partition signature: node → sorted member list of its SCC. */
function partition<T>(nodeOf: (n: T) => Iterable<T>, nodes: T[]): Map<T, string> {
  const sig = new Map<T, string>();
  for (const n of nodes) {
    const members = [...nodeOf(n)].map(String).sort();
    sig.set(n, members.join(","));
  }
  return sig;
}

function batchPartition(nodes: number[], edges: Array<[number, number]>): Map<number, string> {
  const { order, comp } = condense(nodes, edges);
  return partition(n => order[comp.get(n)!]!, nodes);
}

function dynPartition(dyn: DynCondensation<number>, nodes: number[]): Map<number, string> {
  const order = dyn.order();
  const sig = new Map<number, string>();
  for (const n of nodes) {
    const grp = order.find(g => g.includes(n))!;
    sig.set(n, grp.map(String).sort().join(","));
  }
  return sig;
}

/** Every cross-component edge must respect the ordinal order. */
function isLinearExtension(dyn: DynCondensation<number>, edges: Array<[number, number]>): boolean {
  for (const [u, v] of edges) {
    if (dyn.sameComponent(u, v)) continue;
    const ou = dyn.order().findIndex(g => g.includes(u));
    const ov = dyn.order().findIndex(g => g.includes(v));
    if (ou >= ov) return false;
  }
  return true;
}

function mulberry32(seed: number): () => number {
  let a = seed;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t ^= t + Math.imul(t ^ (t >>> 7), 61 | t);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

describe("DynCondensation — agrees with batch Tarjan (fuzz)", () => {
  it("matches partition after every insertion, across many seeds", () => {
    for (let seed = 1; seed <= 40; seed++) {
      const rng = mulberry32(seed);
      const N = 12;
      const nodes = Array.from({ length: N }, (_, i) => i);
      const dyn = new DynCondensation<number>();
      for (const n of nodes) dyn.addNode(n);
      const edges: Array<[number, number]> = [];

      for (let step = 0; step < 30; step++) {
        const u = Math.floor(rng() * N);
        const v = Math.floor(rng() * N);
        dyn.addEdge(u, v);
        edges.push([u, v]);

        const dynSig = dynPartition(dyn, nodes);
        const batchSig = batchPartition(nodes, edges);
        expect(dynSig).toEqual(batchSig);
        expect(isLinearExtension(dyn, edges)).toBe(true);
      }
    }
  });

  it("matches after random insertions AND deletions", () => {
    for (let seed = 100; seed <= 130; seed++) {
      const rng = mulberry32(seed);
      const N = 10;
      const nodes = Array.from({ length: N }, (_, i) => i);
      const dyn = new DynCondensation<number>();
      for (const n of nodes) dyn.addNode(n);
      const live = new Set<string>();
      const edges = () => [...live].map(s => s.split(",").map(Number) as [number, number]);

      for (let step = 0; step < 40; step++) {
        const u = Math.floor(rng() * N);
        const v = Math.floor(rng() * N);
        const key = `${u},${v}`;
        if (live.has(key) && rng() < 0.4) {
          dyn.removeEdge(u, v);
          live.delete(key);
        } else {
          dyn.addEdge(u, v);
          live.add(key);
        }
        expect(dynPartition(dyn, nodes)).toEqual(batchPartition(nodes, edges()));
        expect(isLinearExtension(dyn, edges())).toBe(true);
      }
    }
  });
});

describe("DynCondensation — locality", () => {
  it("forward edges are O(1) (zero nodes recomputed)", () => {
    const dyn = new DynCondensation<number>();
    for (let i = 0; i < 100; i++) dyn.addEdge(i, i + 1); // ascending chain
    // Every edge was forward → nothing re-condensed.
    expect(dyn.lastTouched).toBe(0);
    // Adding another forward (skip) edge: still free.
    dyn.addEdge(0, 50);
    expect(dyn.lastTouched).toBe(0);
  });

  it("a back edge only touches its ordinal window, not the whole graph", () => {
    const dyn = new DynCondensation<number>();
    for (let i = 0; i < 100; i++) dyn.addEdge(i, i + 1); // chain 0..100
    // Back edge 10 → 5 closes a small cycle; window is ~[5..10].
    dyn.addEdge(10, 5);
    expect(dyn.lastTouched).toBeLessThanOrEqual(7);
    expect(dyn.lastTouched).toBeGreaterThan(0);
    // 5..10 are now one component; the rest untouched and acyclic.
    expect(dyn.isCyclic(7)).toBe(true);
    expect(dyn.isCyclic(50)).toBe(false);
    expect(dyn.sameComponent(5, 10)).toBe(true);
    expect(dyn.sameComponent(5, 11)).toBe(false);
  });
});

describe("DynCondensation — cycle formation and split", () => {
  it("forming a cycle merges, deleting the back edge splits it", () => {
    const dyn = new DynCondensation<number>();
    dyn.addEdge(0, 1);
    dyn.addEdge(1, 2);
    expect(dyn.isCyclic(0)).toBe(false);
    dyn.addEdge(2, 0); // close the cycle
    expect(dyn.sameComponent(0, 2)).toBe(true);
    expect(dyn.isCyclic(1)).toBe(true);

    dyn.removeEdge(2, 0); // re-open
    expect(dyn.sameComponent(0, 2)).toBe(false);
    expect(dyn.isCyclic(0)).toBe(false);
    // order restored to a valid extension of 0→1→2
    expect(
      isLinearExtension(dyn, [
        [0, 1],
        [1, 2],
      ]),
    ).toBe(true);
  });

  it("self-loop is cyclic", () => {
    const dyn = new DynCondensation<number>();
    dyn.addEdge(0, 0);
    expect(dyn.isCyclic(0)).toBe(true);
  });
});
