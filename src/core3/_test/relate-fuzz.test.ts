// Property/fuzz: hammer the pull-driven relation engine against an
// INDEPENDENT oracle. `Flags` (bit-AND candidate sets) is the narrowing
// lattice — with only `equal()` constraints, each connected component
// collapses to one SCC whose members all equal the bit-AND of their bases, a
// trivially-correct reference. Random graphs + random removals exercise
// merge, split, projection, and relax-to-base end to end, after every edit.

import { describe, expect, it } from "vitest";
import { effect, Flags, settle } from "../index";
import { equal } from "../relate";
import { mulberry32 } from "./_scc-util";

const F = ["b0", "b1", "b2", "b3"] as const;
const fl = (m: number) => new Flags([...F], m);
const andAll = (xs: number[]): number => xs.reduce((a, b) => a & b, -1);

class UF {
  p: number[];
  constructor(n: number) {
    this.p = Array.from({ length: n }, (_, i) => i);
  }
  find(x: number): number {
    while (this.p[x] !== x) x = this.p[x] = this.p[this.p[x]!]!;
    return x;
  }
  union(a: number, b: number): void {
    this.p[this.find(a)] = this.find(b);
  }
}

function check(
  cells: Array<{ value: number }>,
  bases: number[],
  edges: Array<[number, number]>,
): void {
  const V = cells.length;
  const uf = new UF(V);
  for (const [i, j] of edges) uf.union(i, j);
  for (let i = 0; i < V; i++) {
    const members: number[] = [];
    for (let k = 0; k < V; k++) if (uf.find(k) === uf.find(i)) members.push(k);
    const want = members.length === 1 ? bases[i]! : andAll(members.map(k => bases[k]!));
    expect(cells[i]!.value).toBe(want);
  }
}

describe("equal-graph fuzz vs bit-AND oracle", () => {
  it("random graphs solve to per-component bit-AND; removal re-relaxes", () => {
    for (let seed = 1; seed <= 300; seed++) {
      const rnd = mulberry32(seed * 2654435761);
      const V = 6;
      const bases: number[] = [];
      const cells: Array<{ value: number }> = [];
      for (let i = 0; i < V; i++) {
        const m = Math.floor(rnd() * 16);
        bases.push(m);
        cells.push(fl(m) as unknown as { value: number });
      }

      const edges: Array<[number, number]> = [];
      const disposers: Array<{ d: () => void; e: [number, number] }> = [];
      const E = Math.floor(rnd() * 9);
      for (let e = 0; e < E; e++) {
        const i = Math.floor(rnd() * V);
        const j = Math.floor(rnd() * V);
        if (i === j) continue;
        disposers.push({ d: equal(cells[i] as never, cells[j] as never), e: [i, j] });
        edges.push([i, j]);
      }

      check(cells, bases, edges);

      // Randomly remove a subset and re-check after EACH removal (split path).
      const live = [...disposers];
      while (live.length > 0) {
        const idx = Math.floor(rnd() * live.length);
        const [removed] = live.splice(idx, 1);
        removed!.d();
        check(
          cells,
          bases,
          live.map(x => x.e),
        );
      }

      // all removed → every cell is its own base
      for (let i = 0; i < V; i++) expect(cells[i]!.value).toBe(bases[i]!);
    }
  });
});

describe("effects + churn fuzz (push-notification path)", () => {
  it("each effect's observed value matches the oracle after every edit", () => {
    for (let seed = 1; seed <= 150; seed++) {
      const rnd = mulberry32(seed * 2246822519 + 13);
      const V = 5;
      const bases: number[] = [];
      const cells: Array<{ value: number }> = [];
      for (let i = 0; i < V; i++) {
        const m = Math.floor(rnd() * 16);
        bases.push(m);
        cells.push(fl(m) as unknown as { value: number });
      }

      const seen: number[] = new Array(V);
      const stops = cells.map((c, i) =>
        effect(() => {
          seen[i] = c.value;
        }),
      );

      const disp = new Map<string, () => void>();
      const edges: Array<[number, number]> = [];
      const oracleValue = (i: number): number => {
        const uf = new UF(V);
        for (const [x, y] of edges) uf.union(x, y);
        const members: number[] = [];
        for (let k = 0; k < V; k++) if (uf.find(k) === uf.find(i)) members.push(k);
        return members.length === 1 ? bases[i]! : andAll(members.map(k => bases[k]!));
      };

      for (let op = 0; op < 14; op++) {
        const i = Math.floor(rnd() * V);
        const j = Math.floor(rnd() * V);
        if (i !== j) {
          const key = i < j ? `${i},${j}` : `${j},${i}`;
          const existing = disp.get(key);
          if (existing === undefined) {
            disp.set(key, equal(cells[i] as never, cells[j] as never));
            edges.push([i, j]);
          } else {
            existing();
            disp.delete(key);
            const at = edges.findIndex(([x, y]) => (x === i && y === j) || (x === j && y === i));
            if (at >= 0) edges.splice(at, 1);
          }
        }
        settle(); // effects defer to the microtask; drain to observe synchronously
        for (let k = 0; k < V; k++) expect(seen[k]).toBe(oracleValue(k));
      }
      for (const s of stops) s();
    }
  });
});
