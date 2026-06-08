// Cross-layer fuzz: random DAGs of Range SOURCES + chained `shift` LENSES, with
// random `equal` relations imposed on arbitrary subsets (sources AND lenses).
// Checked against an INDEPENDENT brute-force fixpoint oracle — a different
// algorithm than the engine's incremental-SCC + pull-driven solve — so a match
// is real cross-validation, not a tautology. Integer arithmetic throughout
// keeps the oracle exact (no float drift).
//
// Semantics under test (the cross-layer contract):
//   • A lens member's standing assertion is fwd(parent) — LIVE, so narrowing a
//     parent flows down into the lens member's solve.
//   • equal-group value = meet of all members' assertions; every member reads
//     back that meet. A member's value ⊑ its assertion (narrowing only).
//   • Solving narrows the PROJECTION; it does NOT write back to the parent
//     (only explicit writes do). The oracle encodes exactly this.

import { describe, it } from "vitest";
import { range, settle } from "../index";
import { equal } from "../relate";

type RCell = ReturnType<typeof range>; // Writable<Range>

function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t ^= t + Math.imul(t ^ (t >>> 7), 61 | t);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

type V = { lo: number; hi: number };
const meet = (a: V, b: V): V => ({ lo: Math.max(a.lo, b.lo), hi: Math.min(a.hi, b.hi) });
const shiftV = (v: V, k: number): V => ({ lo: v.lo + k, hi: v.hi + k });
const TOP: V = { lo: Number.NEGATIVE_INFINITY, hi: Number.POSITIVE_INFINITY };
const close = (x: number, y: number) => x === y || Math.abs(x - y) <= 1e-6;
const eqV = (a: V, b: V) => close(a.lo, b.lo) && close(a.hi, b.hi);

interface Node {
  kind: "source" | "shift";
  parent: number; // -1 for sources
  off: number; // shift offset (sources: 0)
}

/** Union-find over active equal-edges → group representatives. */
function groupsOf(n: number, edges: Array<[number, number]>): number[] {
  const uf = Array.from({ length: n }, (_, i) => i);
  const find = (x: number): number => {
    while (uf[x] !== x) x = uf[x] = uf[uf[x]!]!;
    return x;
  };
  for (const [a, b] of edges) uf[find(a)] = find(b);
  return uf.map((_, i) => find(i));
}

/** Brute-force fixpoint: independent reference for the engine's solve. */
function oracle(nodes: Node[], asserted: V[], edges: Array<[number, number]>): V[] {
  const n = nodes.length;
  const rep = groupsOf(n, edges);
  const member = new Array<boolean>(n).fill(false);
  for (const [a, b] of edges) {
    member[a] = true;
    member[b] = true;
  }
  const byRep = new Map<number, number[]>();
  for (let i = 0; i < n; i++) {
    const r = rep[i]!;
    (byRep.get(r) ?? byRep.set(r, []).get(r)!).push(i);
  }

  const solved = new Array<V>(n).fill(TOP);
  for (let iter = 0; iter < 100_000; iter++) {
    // assertion(i): source → its asserted span; lens → fwd(solved(parent))
    const assertion = nodes.map((nd, i) =>
      nd.kind === "source" ? asserted[i]! : shiftV(solved[nd.parent!]!, nd.off),
    );
    const next = new Array<V>(n);
    for (let i = 0; i < n; i++) {
      if (!member[i]) {
        next[i] = assertion[i]!;
      } else {
        let v = TOP;
        for (const g of byRep.get(rep[i]!)!) if (member[g]) v = meet(v, assertion[g]!);
        next[i] = v;
      }
    }
    let changed = false;
    for (let i = 0; i < n; i++) if (!eqV(next[i]!, solved[i]!)) changed = true;
    for (let i = 0; i < n; i++) solved[i] = next[i]!;
    if (!changed) break;
  }
  return solved;
}

function buildGraph(rnd: () => number) {
  const nSources = 2 + Math.floor(rnd() * 5); // 2..6
  const nLens = Math.floor(rnd() * 7); // 0..6
  const nodes: Node[] = [];
  const cells: RCell[] = [];
  const asserted: V[] = [];

  for (let i = 0; i < nSources; i++) {
    const lo = Math.floor(rnd() * 20);
    const hi = lo + Math.floor(rnd() * 30);
    nodes.push({ kind: "source", parent: -1, off: 0 });
    cells.push(range(lo, hi));
    asserted.push({ lo, hi });
  }
  for (let i = 0; i < nLens; i++) {
    const parent = Math.floor(rnd() * nodes.length); // any earlier node (DAG)
    const off = Math.floor(rnd() * 21) - 10; // -10..10
    nodes.push({ kind: "shift", parent, off });
    cells.push(cells[parent]!.shift(off));
    asserted.push({ lo: 0, hi: 0 }); // unused for lenses
  }
  return { nodes, cells, asserted };
}

/** Is the relation graph SOLVABLE by the pull model? Contract equal-groups,
 *  then the quotient graph of lens-parent dependencies (group(m) → group(its
 *  parent)) must be acyclic — including self-loops. A cycle there is a
 *  "relation cycle through a lens", which the engine rejects by design (the
 *  fold can't see lens transfer-functions) and which the oracle can't model. */
function solvable(nodes: Node[], edges: Array<[number, number]>): boolean {
  const n = nodes.length;
  const rep = groupsOf(n, edges);
  const adj = new Map<number, Set<number>>();
  for (let i = 0; i < n; i++) {
    if (nodes[i]!.kind !== "shift") continue;
    const a = rep[i]!;
    const b = rep[nodes[i]!.parent]!;
    if (a === b) return false; // self-loop: lens & parent in one group
    (adj.get(a) ?? adj.set(a, new Set()).get(a)!).add(b);
  }
  const color = new Map<number, number>(); // 0 white, 1 gray, 2 black
  const acyclic = (u: number): boolean => {
    color.set(u, 1);
    for (const v of adj.get(u) ?? []) {
      const c = color.get(v) ?? 0;
      if (c === 1) return false;
      if (c === 0 && !acyclic(v)) return false;
    }
    color.set(u, 2);
    return true;
  };
  for (const u of adj.keys()) if ((color.get(u) ?? 0) === 0 && !acyclic(u)) return false;
  return true;
}

/** Random equal-edges kept only while the graph stays solvable (no relation
 *  cycle through a lens — that degenerate case is tested separately). */
function randomEdges(rnd: () => number, nodes: Node[]): Array<[number, number]> {
  const n = nodes.length;
  const edges: Array<[number, number]> = [];
  const k = 1 + Math.floor(rnd() * n);
  for (let e = 0; e < k; e++) {
    const a = Math.floor(rnd() * n);
    let b = Math.floor(rnd() * n);
    if (a === b) b = (b + 1) % n;
    if (solvable(nodes, [...edges, [a, b]])) edges.push([a, b]);
  }
  return edges;
}

function checkMatch(cells: RCell[], want: V[], ctx: string) {
  for (let i = 0; i < cells.length; i++) {
    const got = cells[i]!.value;
    if (!eqV(got, want[i]!)) {
      throw new Error(
        `${ctx}: cell ${i} = ${JSON.stringify(got)} but oracle = ${JSON.stringify(want[i])}`,
      );
    }
  }
}

describe("cross-layer fuzz: Range DAGs (sources + shift lenses) × equal-relations", () => {
  it("converged values match the brute-force oracle across writes & unlinks", () => {
    for (let seed = 1; seed <= 400; seed++) {
      const rnd = mulberry32(seed);
      const { nodes, cells, asserted } = buildGraph(rnd);
      const n = nodes.length;

      const active = randomEdges(rnd, nodes);
      const unlinks: Array<{ a: number; b: number; off: () => void }> = [];
      for (const [a, b] of active) {
        unlinks.push({ a, b, off: equal(cells[a]!, cells[b]!) });
      }
      try {
        settle();
        for (let i = 0; i < cells.length; i++) void cells[i]!.value;
      } catch (e) {
        throw new Error(
          `seed ${seed} threw: ${(e as Error).message}\nnodes=${JSON.stringify(nodes)}\nedges=${JSON.stringify(active)}`,
        );
      }
      checkMatch(cells, oracle(nodes, asserted, active), `seed ${seed} initial`);

      // Random source writes (route through base / re-solve).
      for (let round = 0; round < 4; round++) {
        const srcIdx = Math.floor(rnd() * n);
        if (nodes[srcIdx]!.kind !== "source") continue;
        const lo = Math.floor(rnd() * 20);
        const hi = lo + Math.floor(rnd() * 30);
        cells[srcIdx]!.value = { lo, hi };
        asserted[srcIdx] = { lo, hi };
        settle();
        checkMatch(
          cells,
          oracle(nodes, asserted, active),
          `seed ${seed} write#${round} cell ${srcIdx}`,
        );
      }

      // Random unlinks → groups shrink, orphans relax to base.
      for (const u of unlinks) {
        if (rnd() < 0.5) continue;
        u.off();
        const idx = active.findIndex(([a, b]) => a === u.a && b === u.b);
        if (idx >= 0) active.splice(idx, 1);
        settle();
        checkMatch(cells, oracle(nodes, asserted, active), `seed ${seed} unlink ${u.a}-${u.b}`);
      }
    }
  });
});
