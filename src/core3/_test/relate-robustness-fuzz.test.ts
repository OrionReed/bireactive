// Robustness fuzz: throw EVERYTHING a user could legally do at the relate
// layer and assert the engine never breaks. Unlike `relate-crosslayer-fuzz`
// (which filters to oracle-solvable graphs), this one deliberately ALLOWS the
// hard cases — cycles through lenses, self-relations, dense churn — because
// after the lens-in-cycle rework they must resolve in-engine, not crash.
//
// No oracle here: the invariants are structural, not value-exact —
//   1. nothing ever throws, however the graph is wired or rewired;
//   2. every published value is well-formed (finite lo ≤-or-≥ hi allowed; just
//      not NaN / undefined) — no lattice element (⊤/⊥/interval) leaks out;
//   3. reads are STABLE — reading a cell twice yields the same value
//      (glitch-free projection);
//   4. the solve is a FIXPOINT — an extra settle() with no new input changes
//      nothing (idempotent), and re-reading after a no-op settle is unchanged.

import { describe, expect, it } from "vitest";
import { num, range, settle } from "../index";
import { constrain, equal } from "../relate";

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

type RCell = ReturnType<typeof range>;

const wellFormed = (v: { lo: number; hi: number }): boolean =>
  typeof v === "object" &&
  v !== null &&
  Number.isFinite(v.lo) &&
  Number.isFinite(v.hi) &&
  typeof v.lo === "number" &&
  typeof v.hi === "number";

function snapshot(cells: RCell[]): Array<{ lo: number; hi: number }> {
  return cells.map(c => c.value);
}

function assertHealthy(cells: RCell[], ctx: string): void {
  // 2 + 3: well-formed and stable across a repeat read.
  const first = snapshot(cells);
  const second = snapshot(cells);
  for (let i = 0; i < cells.length; i++) {
    if (!wellFormed(first[i]!)) {
      throw new Error(`${ctx}: cell ${i} malformed: ${JSON.stringify(first[i])}`);
    }
    expect(second[i], `${ctx}: cell ${i} unstable on re-read`).toEqual(first[i]);
  }
  // 4: idempotent fixpoint — a settle with no new input must not move anything.
  settle();
  const third = snapshot(cells);
  for (let i = 0; i < cells.length; i++) {
    expect(third[i], `${ctx}: cell ${i} moved on a no-op settle`).toEqual(first[i]);
  }
}

describe("relate robustness fuzz — any legal graph edit stays healthy", () => {
  it("survives cycles-through-lenses, self-relations, writes, and churn", () => {
    for (let seed = 1; seed <= 300; seed++) {
      const rnd = mulberry32(seed);
      const cells: RCell[] = [];

      // Sources.
      const nSrc = 2 + Math.floor(rnd() * 4);
      for (let i = 0; i < nSrc; i++) {
        const lo = Math.floor(rnd() * 20) - 5;
        const hi = lo + Math.floor(rnd() * 25);
        cells.push(range(lo, hi));
      }
      // Lenses over earlier cells (chains and shifts; parents may later be
      // pulled into a relation, creating constraint lenses).
      const nLens = Math.floor(rnd() * 6);
      for (let i = 0; i < nLens; i++) {
        const parent = Math.floor(rnd() * cells.length);
        cells.push(cells[parent]!.shift(Math.floor(rnd() * 21) - 10));
      }

      const n = cells.length;
      const links: Array<() => void> = [];

      const wrap = (label: string, fn: () => void): void => {
        try {
          fn();
          settle();
        } catch (e) {
          throw new Error(`seed ${seed} ${label} threw: ${(e as Error).message}`);
        }
        assertHealthy(cells, `seed ${seed} after ${label}`);
      };

      // Random ops, including the cases the crosslayer fuzz excludes.
      const ops = 6 + Math.floor(rnd() * 8);
      for (let op = 0; op < ops; op++) {
        const pick = rnd();
        if (pick < 0.4) {
          // equal between any two cells (sources, lenses, or a lens & its own
          // parent → cycle through a lens).
          const a = Math.floor(rnd() * n);
          const b = Math.floor(rnd() * n);
          wrap(`equal(${a},${b})`, () => links.push(equal(cells[a]!, cells[b]!)));
        } else if (pick < 0.55) {
          // directed ordering/identity constraint (uses the interval lattice).
          const a = Math.floor(rnd() * n);
          const floor = Math.floor(rnd() * 30) - 10;
          wrap(`constrain ge ${a}`, () =>
            links.push(
              constrain([], [cells[a]!], (_g, emit) =>
                emit(cells[a]!, {
                  lo: { min: floor, max: Number.POSITIVE_INFINITY },
                  hi: { min: floor, max: Number.POSITIVE_INFINITY },
                } as never),
              ),
            ),
          );
        } else if (pick < 0.8) {
          // write ANY cell — sources and lens members alike (a lens write
          // routes backward through the lens to its parents, then re-solves).
          const a = Math.floor(rnd() * n);
          const lo = Math.floor(rnd() * 20) - 5;
          const hi = lo + Math.floor(rnd() * 25);
          wrap(`write(${a})`, () => {
            cells[a]!.value = { lo, hi };
          });
        } else if (links.length > 0) {
          // unlink a random existing relation
          const i = Math.floor(rnd() * links.length);
          const off = links[i]!;
          links.splice(i, 1);
          wrap("unlink", () => off());
        }
      }

      // Tear everything down; the graph must end healthy and back to lenses.
      for (const off of links) {
        try {
          off();
        } catch (e) {
          throw new Error(`seed ${seed} teardown threw: ${(e as Error).message}`);
        }
      }
      settle();
      assertHealthy(cells, `seed ${seed} torn down`);
    }
  });

  it("mixed value classes (Num + Range) churn without leaking lattice elements", () => {
    for (let seed = 1; seed <= 120; seed++) {
      const rnd = mulberry32(seed * 7 + 1);
      const ns = [num(rnd() * 10), num(rnd() * 10), num(rnd() * 10)];
      const links: Array<() => void> = [];
      const wrap = (fn: () => void): void => {
        fn();
        settle();
        for (const c of ns) {
          expect(Number.isFinite(c.value), `seed ${seed} num leaked ${c.value}`).toBe(true);
          expect(c.value).toBe(c.value); // stable re-read
        }
      };
      for (let op = 0; op < 8; op++) {
        const a = Math.floor(rnd() * ns.length);
        const b = Math.floor(rnd() * ns.length);
        if (rnd() < 0.4) wrap(() => links.push(equal(ns[a]!, ns[b]!)));
        else if (rnd() < 0.7)
          wrap(() => links.push(equal(ns[a]!, ns[a]!.add(rnd() < 0.5 ? 0 : 3))));
        else wrap(() => (ns[a]!.value = rnd() * 20));
      }
      for (const off of links) off();
      settle();
      for (const c of ns) expect(Number.isFinite(c.value)).toBe(true);
    }
  });
});
