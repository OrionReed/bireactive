// Property/fuzz: hammer the pull-driven relation engine against an
// INDEPENDENT oracle. With only `equal()` constraints, each connected
// component collapses to one SCC whose members all equal the intersection of
// their bases — a trivially-correct reference. Random graphs + random
// removals exercise merge, split, projection, and relax-to-base end to end,
// after every edit.

import { describe, expect, it } from "vitest";
import { effect, range, settle } from "../index";
import { constrain, equal } from "../relate";
import { mulberry32 } from "./_scc-util";

interface Iv {
  lo: number;
  hi: number;
}
const intersect = (xs: Iv[]): Iv => ({
  lo: Math.max(...xs.map(x => x.lo)),
  hi: Math.min(...xs.map(x => x.hi)),
});

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

function check(cells: Array<{ value: Iv }>, bases: Iv[], edges: Array<[number, number]>): void {
  const V = cells.length;
  const uf = new UF(V);
  for (const [i, j] of edges) uf.union(i, j);
  for (let i = 0; i < V; i++) {
    const members: number[] = [];
    for (let k = 0; k < V; k++) if (uf.find(k) === uf.find(i)) members.push(k);
    const want = members.length === 1 ? bases[i]! : intersect(members.map(k => bases[k]!));
    expect(cells[i]!.value).toEqual(want);
  }
}

describe("equal-graph fuzz vs intersection oracle", () => {
  it("random graphs solve to per-component intersection; removal re-relaxes", () => {
    for (let seed = 1; seed <= 300; seed++) {
      const rnd = mulberry32(seed * 2654435761);
      const V = 6;
      const bases: Iv[] = [];
      const cells: Array<{ value: Iv }> = [];
      for (let i = 0; i < V; i++) {
        const lo = Math.floor(rnd() * 50);
        const hi = lo + Math.floor(rnd() * 50);
        bases.push({ lo, hi });
        cells.push(range(lo, hi) as unknown as { value: Iv });
      }

      const edges: Array<[number, number]> = [];
      const disposers: Array<{ d: () => void; e: [number, number] }> = [];
      const E = Math.floor(rnd() * 9);
      for (let e = 0; e < E; e++) {
        const i = Math.floor(rnd() * V);
        const j = Math.floor(rnd() * V);
        if (i === j) continue;
        disposers.push({
          d: equal(cells[i] as never, cells[j] as never),
          e: [i, j],
        });
        edges.push([i, j]);
      }

      check(cells, bases, edges);

      // Randomly remove a subset and re-check after EACH removal (split path).
      const live = [...disposers];
      while (live.length > 0) {
        const idx = Math.floor(rnd() * live.length);
        const [removed] = live.splice(idx, 1);
        removed!.d();
        // recompute remaining edge set
        const remaining = live.map(x => x.e);
        check(cells, bases, remaining);
      }

      // all removed → every cell is its own base
      for (let i = 0; i < V; i++) expect(cells[i]!.value).toEqual(bases[i]!);
    }
  });
});

describe("effects + churn fuzz (push-notification path)", () => {
  it("each effect's observed value matches the oracle after every edit", () => {
    for (let seed = 1; seed <= 150; seed++) {
      const rnd = mulberry32(seed * 2246822519 + 13);
      const V = 5;
      const bases: Iv[] = [];
      const cells: Array<{ value: Iv }> = [];
      for (let i = 0; i < V; i++) {
        const lo = Math.floor(rnd() * 40);
        const hi = lo + Math.floor(rnd() * 40);
        bases.push({ lo, hi });
        cells.push(range(lo, hi) as unknown as { value: Iv });
      }

      // One effect per cell records the last value it OBSERVED (fires only
      // when its cell's solved value changes).
      const seen: Iv[] = new Array(V);
      const stops = cells.map((c, i) =>
        effect(() => {
          seen[i] = c.value;
        }),
      );

      const disp = new Map<string, () => void>();
      const edges: Array<[number, number]> = [];
      const oracleValue = (i: number): Iv => {
        const uf = new UF(V);
        for (const [x, y] of edges) uf.union(x, y);
        const members: number[] = [];
        for (let k = 0; k < V; k++) if (uf.find(k) === uf.find(i)) members.push(k);
        return members.length === 1 ? bases[i]! : intersect(members.map(k => bases[k]!));
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
        // effects defer to the microtask; drain them to observe synchronously
        settle();
        // every effect must have observed the current solved value
        for (let k = 0; k < V; k++) expect(seen[k]).toEqual(oracleValue(k));
      }
      for (const s of stops) s();
    }
  });
});

describe("longest-path order fuzz", () => {
  // a_k.lo ≥ a_{k-1}.lo + 1 along a chain ⇒ a_k.lo = k (from a_0.lo = 0).
  it("a chain of ≥-by-1 constraints yields the longest path", () => {
    for (let seed = 1; seed <= 50; seed++) {
      const rnd = mulberry32(seed * 40503 + 1);
      const N = 3 + Math.floor(rnd() * 6);
      const a = Array.from({ length: N }, () => range(0, Number.POSITIVE_INFINITY));
      for (let k = 1; k < N; k++) {
        const prev = a[k - 1]!;
        const cur = a[k]!;
        constrainGE(prev, cur, 1);
      }
      for (let k = 0; k < N; k++) expect(Math.round(a[k]!.value.lo)).toBe(k);
    }
  });
});

function constrainGE(
  prev: ReturnType<typeof range>,
  cur: ReturnType<typeof range>,
  gap: number,
): void {
  constrain([prev], [cur], (get, emit) =>
    emit(cur, { lo: get(prev).lo + gap, hi: Number.POSITIVE_INFINITY }),
  );
}
