// lattice-core.test.ts — the monotone substrate: merge, termination,
// order-independence, contradiction, and CSP narrowing.

import { describe, expect, it } from "vitest";
import { allDifferent } from "../csp";
import { type Interval, intervalCell, isContradiction, isTop, setCell } from "../lattice";
import { add, bound, equal, order, total } from "../numeric";
import { solve, solver } from "../solver";

const val = (c: { value: Interval }): Interval => c.value;

describe("interval narrowing", () => {
  it("add: two inputs bound the third", () => {
    const a = intervalCell(2, 4);
    const b = intervalCell(5, 7);
    const c = intervalCell();
    const s = solve(add(a, b, c));
    expect(val(c)).toEqual([7, 11]);
    s.dispose();
  });

  it("add: back-deduces an input from the output", () => {
    const a = intervalCell();
    const b = intervalCell(5, 7);
    const c = intervalCell(10, 12);
    const s = solve(add(a, b, c));
    expect(val(a)).toEqual([3, 7]);
    s.dispose();
  });

  it("multi-source merge: a cell narrowed by two relations meets both", () => {
    const a = intervalCell(0, 100);
    const b = intervalCell(0, 100);
    const c = intervalCell();
    const d = intervalCell(0, 50);
    const s = solve(add(a, b, c), equal(c, d));
    expect(val(c)).toEqual([0, 50]);
    expect(val(a)).toEqual([0, 50]);
    expect(val(b)).toEqual([0, 50]);
    s.dispose();
  });

  it("converges to an exact point via narrowing", () => {
    const a = intervalCell(0, 100);
    const b = intervalCell(0, 100);
    const c = intervalCell(0, 100);
    const s = solve(add(a, b, c), bound(c, 50, 50), bound(a, 20, 20));
    expect(val(b)).toEqual([30, 30]);
    s.dispose();
  });

  it("order narrows a≤b both ways", () => {
    const a = intervalCell(0, 100);
    const b = intervalCell(0, 100);
    const s = solve(bound(a, 40, 40), order(a, b, 10));
    // b ≥ a + 10 = 50.
    expect(val(b)).toEqual([50, 100]);
    s.dispose();
  });

  it("total: fourth part back-deduced from whole and three parts", () => {
    const parts = [intervalCell(3, 5), intervalCell(6, 7), intervalCell(4, 8), intervalCell()];
    const whole = intervalCell(20, 30);
    const s = solve(total(parts, whole));
    // others ∈ [13, 20]; part3 ∈ [20-20, 30-13] = [0, 17].
    expect(val(parts[3]!)[0]).toBeCloseTo(0);
    expect(val(parts[3]!)[1]).toBeCloseTo(17);
    s.dispose();
  });

  it("order-independence: declaration order doesn't change the fixpoint", () => {
    const build = (rev: boolean) => {
      const a = intervalCell(2, 4);
      const b = intervalCell(5, 7);
      const c = intervalCell(0, 100);
      const props = add(a, b, c);
      const s = solve(...(rev ? [...props].reverse() : props));
      return { a, b, c, s };
    };
    const f = build(false);
    const r = build(true);
    expect(val(f.a)).toEqual(val(r.a));
    expect(val(f.b)).toEqual(val(r.b));
    expect(val(f.c)).toEqual(val(r.c));
    f.s.dispose();
    r.s.dispose();
  });
});

describe("contradiction (no throw, just bottom)", () => {
  it("disjoint bounds collapse a cell to bottom and flag infeasible", () => {
    const x = intervalCell(0, 10);
    const s = solve(bound(x, 50, 100));
    expect(isContradiction(x)).toBe(true);
    expect(s.feasible).toBe(false);
    expect(s.contradictions()).toContain(x);
    s.dispose();
  });

  it("a feasible network reports feasible and no contradictions", () => {
    const a = intervalCell(0, 10);
    const b = intervalCell();
    const s = solve(equal(a, b));
    expect(s.feasible).toBe(true);
    expect(isTop(a)).toBe(false);
    s.dispose();
  });
});

describe("set narrowing (CSP)", () => {
  it("allDifferent eliminates a singleton from peers", () => {
    const a = setCell([1, 2, 3], [1]);
    const b = setCell([1, 2, 3]);
    const c = setCell([1, 2, 3]);
    const s = solve(allDifferent(a, b, c));
    expect(b.value.has(1)).toBe(false);
    expect(c.value.has(1)).toBe(false);
    s.dispose();
  });

  it("a 4x4 latin-square row/col solves by naked singles", () => {
    // 4 cells, all different, three pinned → fourth forced.
    const cells = [
      setCell([1, 2, 3, 4], [1]),
      setCell([1, 2, 3, 4], [2]),
      setCell([1, 2, 3, 4], [3]),
      setCell([1, 2, 3, 4]),
    ];
    const s = solve(allDifferent(...cells));
    expect([...cells[3]!.value]).toEqual([4]);
    s.dispose();
  });

  it("manual stepping advances narrowing waves", () => {
    const cells = [
      setCell([1, 2, 3, 4], [1]),
      setCell([1, 2, 3, 4], [2]),
      setCell([1, 2, 3, 4], [3]),
      setCell([1, 2, 3, 4]),
    ];
    const s = solver({ manual: true }).add(allDifferent(...cells));
    s.step(1);
    expect([...cells[3]!.value]).toEqual([4]);
    s.dispose();
  });
});
