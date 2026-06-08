// Deep, breadth-first SCC correctness — the condensation is load-bearing for
// the whole relation system, so this file questions every assumption:
//
//   • partition == mathematical SCC (mutual reachability), always;
//   • order() is a valid linear extension of the condensation DAG, always;
//   • internal structural invariants hold after ANY edit sequence
//     (union-find roots, members↔uf agreement, out/inc transpose, distinct
//     ordinals, total partition);
//   • drainDirty() is a SUPERSET of every node whose component membership
//     changed — the property relate's incremental rebuild depends on; if it
//     ever under-reports, relate would keep a stale solver group (silent
//     wrong answers);
//   • the incremental result is independent of EDIT ORDER (partition-wise);
//   • merges fully reverse on the matching removals (churn);
//   • self-loops, multi-edges, anti-parallel edges, reversed insertion;
//   • scale + stack-safety (deep chains, dense graphs);
//   • genericity over non-numeric node identities (object keys).

import { describe, expect, it } from "vitest";
import { condense, DynCondensation } from "../condense";
import { isLinearExtension, mulberry32, oraclePartition, sig } from "./_scc-util";

const S = (n: number): string => String(n);

// ── white-box internals (for structural invariant checks) ───────────
//
// One record per node: `parent` (union-find), `ord` (valid when root),
// lazy `out`/`inc`, and `members` (root-only; absent ⇒ singleton {self}).

interface Rec {
  parent: number;
  ord: number;
  out?: Set<number>;
  inc?: Set<number>;
  members?: Set<number>;
}
interface Internals {
  node: Map<number, Rec>;
}
const peek = (dc: DynCondensation<number>): Internals => dc as unknown as Internals;

/** Assert the full set of internal + observable invariants for `dc` given
 *  the node set and the current edge multiset. */
function checkInvariants(
  dc: DynCondensation<number>,
  nodes: readonly number[],
  edges: ReadonlyArray<readonly [number, number]>,
): void {
  const g = peek(dc);

  // members ↔ uf agreement, total + disjoint partition.
  const assigned = new Set<number>();
  for (const n of nodes) {
    const rep = dc.component(n);
    expect(g.node.get(rep)!.parent).toBe(rep); // rep is a union-find root
    expect(dc.membersOf(n).includes(n)).toBe(true);
    expect(assigned.has(n)).toBe(false); // exactly one component
    assigned.add(n);
  }
  expect(assigned.size).toBe(nodes.length);

  // Every root has a distinct ordinal.
  const ords = new Set<number>();
  for (const [n, rec] of g.node) {
    if (rec.parent !== n) continue; // roots only
    expect(ords.has(rec.ord)).toBe(false);
    ords.add(rec.ord);
  }

  // inc is the exact transpose of out.
  for (const [u, rec] of g.node)
    for (const v of rec.out ?? []) expect(g.node.get(v)!.inc?.has(u) ?? false).toBe(true);
  for (const [v, rec] of g.node)
    for (const u of rec.inc ?? []) expect(g.node.get(u)!.out?.has(v) ?? false).toBe(true);

  // order() sorted by ordinal → valid linear extension; partition == oracle.
  const order = dc.order();
  expect(isLinearExtension(order, edges)).toBe(true);
  expect(sig(order, S)).toBe(sig(oraclePartition(nodes, edges), S));
}

/** Membership signature of `n`'s component (sorted members). */
const compSig = (dc: DynCondensation<number>, n: number): string =>
  dc.membersOf(n).map(S).sort().join(",");

// ── 1. combined fuzz: oracle + invariants + dirty, add & remove ─────

describe("SCC fuzz — invariants + oracle + dirty under add/remove", () => {
  it("holds across 200 random edit sequences", () => {
    for (let seed = 1; seed <= 200; seed++) {
      const rnd = mulberry32(seed * 2654435761);
      const V = 9;
      const nodes = Array.from({ length: V }, (_, i) => i);
      const dc = new DynCondensation<number>();
      for (const n of nodes) dc.addNode(n);
      dc.drainDirty(); // clear node-add noise (there is none, but be explicit)
      const edges = new Set<string>();

      for (let k = 0; k < 50; k++) {
        const u = Math.floor(rnd() * V);
        const v = Math.floor(rnd() * V);
        const key = `${u},${v}`;

        // snapshot component membership BEFORE the edit
        const before = new Map<number, string>();
        for (const n of nodes) before.set(n, compSig(dc, n));

        if (rnd() < 0.62) {
          if (!edges.has(key)) {
            edges.add(key);
            dc.addEdge(u, v);
          } else continue;
        } else if (edges.has(key)) {
          edges.delete(key);
          dc.removeEdge(u, v);
        } else continue;

        const dirty = dc.drainDirty();
        // DIRTY SUPERSET: every node whose membership changed must be flagged.
        for (const n of nodes) {
          if (before.get(n) !== compSig(dc, n)) {
            expect(dirty.has(n)).toBe(true);
          }
        }

        const edgeList = [...edges].map(s => s.split(",").map(Number) as [number, number]);
        checkInvariants(dc, nodes, edgeList);
      }
    }
  });
});

// ── 2. dirty-superset, focused ──────────────────────────────────────

describe("drainDirty() — superset of membership-changed nodes", () => {
  it("flags every node that joins a newly-formed SCC", () => {
    const dc = new DynCondensation<number>();
    for (const n of [0, 1, 2, 3]) dc.addNode(n);
    dc.addEdge(0, 1);
    dc.addEdge(1, 2);
    dc.addEdge(2, 3);
    dc.drainDirty();
    dc.addEdge(3, 0); // fuse {0,1,2,3}
    const dirty = dc.drainDirty();
    for (const n of [0, 1, 2, 3]) expect(dirty.has(n)).toBe(true);
  });

  it("flags every node that leaves an SCC on split", () => {
    const dc = new DynCondensation<number>();
    for (const n of [0, 1, 2]) dc.addNode(n);
    dc.addEdge(0, 1);
    dc.addEdge(1, 2);
    dc.addEdge(2, 0);
    dc.drainDirty();
    dc.removeEdge(2, 0); // split into singletons
    const dirty = dc.drainDirty();
    for (const n of [0, 1, 2]) expect(dirty.has(n)).toBe(true);
  });

  it("a back edge that relabels an unchanged neighbour still flags it", () => {
    // The window recondense can pick a new representative for a component
    // whose MEMBERSHIP didn't change; relate keys groups by rep, so those
    // nodes must be reported dirty too. (Whole-window dirty guarantees it.)
    const dc = new DynCondensation<number>();
    for (const n of [0, 1, 2, 3]) dc.addNode(n);
    dc.addEdge(0, 1); // {1} after {0}
    dc.addEdge(2, 3); // 2-cycle later
    dc.addEdge(3, 2);
    dc.drainDirty();
    // back edge from the later cycle into the earlier region → window covers all
    dc.addEdge(2, 0);
    const dirty = dc.drainDirty();
    // 0 and 1 are in the window even if their {membership} is unchanged.
    expect(dirty.has(0)).toBe(true);
  });
});

// ── 3. order-independence of the partition ──────────────────────────

describe("incremental partition is independent of edit order", () => {
  it("shuffled insertion orders all yield the batch partition", () => {
    for (let seed = 1; seed <= 60; seed++) {
      const rnd = mulberry32(seed * 40503 + 7);
      const V = 8;
      const nodes = Array.from({ length: V }, (_, i) => i);
      const target: Array<[number, number]> = [];
      const present = new Set<string>();
      const E = 12;
      while (target.length < E) {
        const u = Math.floor(rnd() * V);
        const v = Math.floor(rnd() * V);
        const k = `${u},${v}`;
        if (!present.has(k)) present.add(k), target.push([u, v]);
      }
      const want = sig(oraclePartition(nodes, target), S);

      for (let trial = 0; trial < 4; trial++) {
        const order = [...target];
        for (let i = order.length - 1; i > 0; i--) {
          const j = Math.floor(rnd() * (i + 1));
          [order[i], order[j]] = [order[j]!, order[i]!];
        }
        const dc = new DynCondensation<number>();
        for (const n of nodes) dc.addNode(n);
        for (const [u, v] of order) dc.addEdge(u, v);
        expect(sig(dc.order(), S)).toBe(want);
        expect(isLinearExtension(dc.order(), target)).toBe(true);
      }
    }
  });
});

// ── 4. churn: merges fully reverse ──────────────────────────────────

describe("churn — merge then un-merge returns to the exact partition", () => {
  it("removing the same edges restores the prior partition (fuzz)", () => {
    for (let seed = 1; seed <= 50; seed++) {
      const rnd = mulberry32(seed * 99991);
      const V = 7;
      const nodes = Array.from({ length: V }, (_, i) => i);
      const dc = new DynCondensation<number>();
      for (const n of nodes) dc.addNode(n);

      // base graph
      const base: Array<[number, number]> = [];
      const present = new Set<string>();
      for (let i = 0; i < 6; i++) {
        const u = Math.floor(rnd() * V);
        const v = Math.floor(rnd() * V);
        const k = `${u},${v}`;
        if (!present.has(k)) present.add(k), base.push([u, v]), dc.addEdge(u, v);
      }
      const baseSig = sig(dc.order(), S);

      // add a churn batch, then remove it
      const churn: Array<[number, number]> = [];
      for (let i = 0; i < 6; i++) {
        const u = Math.floor(rnd() * V);
        const v = Math.floor(rnd() * V);
        const k = `${u},${v}`;
        if (!present.has(k)) present.add(k), churn.push([u, v]), dc.addEdge(u, v);
      }
      for (const [u, v] of churn) {
        dc.removeEdge(u, v);
        present.delete(`${u},${v}`);
      }
      expect(sig(dc.order(), S)).toBe(baseSig);
      expect(sig(dc.order(), S)).toBe(sig(oraclePartition(nodes, base), S));
    }
  });
});

// ── 5. self-loops, multi-edges, anti-parallel ───────────────────────

describe("degenerate edges", () => {
  it("self-loop makes a singleton cyclic; removing it clears that", () => {
    const dc = new DynCondensation<number>();
    dc.addEdge(0, 0);
    expect(dc.isCyclic(0)).toBe(true);
    expect(dc.membersOf(0)).toEqual([0]);
    dc.removeEdge(0, 0);
    expect(dc.isCyclic(0)).toBe(false);
  });

  it("duplicate addEdge is idempotent (partition + structure)", () => {
    const dc = new DynCondensation<number>();
    for (const n of [0, 1]) dc.addNode(n);
    dc.addEdge(0, 1);
    dc.addEdge(0, 1);
    dc.addEdge(0, 1);
    checkInvariants(dc, [0, 1], [[0, 1]]);
  });

  it("batch condense ignores duplicate edges", () => {
    const once = condense(
      [0, 1, 2],
      [
        [0, 1],
        [1, 2],
        [2, 0],
      ],
    );
    const dup = condense(
      [0, 1, 2],
      [
        [0, 1],
        [0, 1],
        [1, 2],
        [2, 0],
        [2, 0],
      ],
    );
    expect(sig(once.order, S)).toBe(sig(dup.order, S));
  });

  it("anti-parallel edges form a 2-cycle", () => {
    const dc = new DynCondensation<number>();
    dc.addEdge(0, 1);
    dc.addEdge(1, 0);
    expect(dc.sameComponent(0, 1)).toBe(true);
    checkInvariants(
      dc,
      [0, 1],
      [
        [0, 1],
        [1, 0],
      ],
    );
  });
});

// ── 6. reversed insertion order (back edges that are actually acyclic) ─

describe("nodes inserted out of topological order", () => {
  it("an acyclic edge against insertion order is reordered, not fused", () => {
    const dc = new DynCondensation<number>();
    dc.addNode(2);
    dc.addNode(1);
    dc.addNode(0); // ordinals: 2<1<0 — reverse of dataflow
    dc.addEdge(0, 1);
    dc.addEdge(1, 2); // 0→1→2 acyclic but "backward" by ordinal
    expect(dc.sameComponent(0, 1)).toBe(false);
    expect(dc.sameComponent(1, 2)).toBe(false);
    expect(dc.order().map(c => c[0])).toEqual([0, 1, 2]); // correctly reordered
    checkInvariants(
      dc,
      [0, 1, 2],
      [
        [0, 1],
        [1, 2],
      ],
    );
  });
});

// ── 7. scale + stack-safety ─────────────────────────────────────────

describe("scale and stack-safety", () => {
  it("a 20k-deep chain condenses without recursion blowup (batch + dyn)", () => {
    const N = 20_000;
    const nodes = Array.from({ length: N }, (_, i) => i);
    const edges: Array<[number, number]> = [];
    for (let i = 0; i < N - 1; i++) edges.push([i, i + 1]);

    const c = condense(nodes, edges);
    expect(c.order.length).toBe(N); // all singletons
    expect(c.order[0]).toEqual([0]);

    const dc = new DynCondensation<number>();
    let touched = 0;
    for (const [u, v] of edges) {
      dc.addEdge(u, v);
      touched += dc.lastTouched;
    }
    expect(touched).toBe(0); // pure forward growth, no recondensation
    expect(dc.order().length).toBe(N);
  });

  it("a 5k-deep single cycle is one SCC (batch + dyn)", () => {
    const N = 5_000;
    const nodes = Array.from({ length: N }, (_, i) => i);
    const edges: Array<[number, number]> = [];
    for (let i = 0; i < N; i++) edges.push([i, (i + 1) % N]);
    const c = condense(nodes, edges);
    expect(c.order.length).toBe(1);
    expect(c.order[0]!.length).toBe(N);

    const dc = new DynCondensation<number>();
    for (const [u, v] of edges) dc.addEdge(u, v);
    expect(dc.order().length).toBe(1);
    expect(dc.membersOf(0).length).toBe(N);
  });

  it("dense random graph: dyn matches batch + invariants", () => {
    const rnd = mulberry32(123456);
    const V = 40;
    const nodes = Array.from({ length: V }, (_, i) => i);
    const dc = new DynCondensation<number>();
    for (const n of nodes) dc.addNode(n);
    const edges: Array<[number, number]> = [];
    const present = new Set<string>();
    for (let k = 0; k < 300; k++) {
      const u = Math.floor(rnd() * V);
      const v = Math.floor(rnd() * V);
      const key = `${u},${v}`;
      if (present.has(key)) continue;
      present.add(key);
      edges.push([u, v]);
      dc.addEdge(u, v);
    }
    checkInvariants(dc, nodes, edges);
  });
});

// ── 8. genericity: non-numeric node identities ──────────────────────

describe("generic over node identity (object keys)", () => {
  it("object-identity nodes partition correctly", () => {
    type N = { id: string };
    const a: N = { id: "a" };
    const b: N = { id: "b" };
    const c: N = { id: "c" };
    const dc = new DynCondensation<N>();
    dc.addEdge(a, b);
    dc.addEdge(b, a); // {a,b}
    dc.addEdge(b, c); // {a,b} → {c}
    expect(dc.sameComponent(a, b)).toBe(true);
    expect(dc.sameComponent(a, c)).toBe(false);
    expect(new Set(dc.membersOf(a))).toEqual(new Set([a, b]));
    const order = dc.order();
    // {a,b} must precede {c}
    const idxOf = (n: N) => order.findIndex(comp => comp.includes(n));
    expect(idxOf(a)).toBeLessThan(idxOf(c));
  });
});

// ── 9. batch determinism ────────────────────────────────────────────

describe("batch condense is deterministic", () => {
  it("identical input → identical order across runs", () => {
    const nodes = [0, 1, 2, 3, 4];
    const edges: Array<[number, number]> = [
      [0, 1],
      [1, 2],
      [2, 0],
      [2, 3],
      [3, 4],
    ];
    const a = condense(nodes, edges);
    const b = condense(nodes, edges);
    expect(a.order).toEqual(b.order);
    expect(a.cyclic).toEqual(b.cyclic);
  });
});
