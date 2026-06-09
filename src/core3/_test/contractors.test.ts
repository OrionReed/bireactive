// Native interval contractors over FREE variables.
//
// A `Num` (interval lattice) carries its current value as a FACT by default, so
// an inequality that excludes it is a contradiction, not a narrowing (notes
// §7a): the contractors only validate consistency. Declaring a cell `free`
// drops the fact — the solver seeds it ⊤ and keeps its value only as the SOFT
// fallback (preferred value when underdetermined). Then `bound`/`order`/`add`/
// `total` actually narrow, and bands flow through Iso lens homomorphisms
// (`.scale`/`.add`/…) via the interval transformer in `liftToKSpace`.

import { describe, expect, it } from "vitest";
import { num } from "../index";
import { add, bound, free, order, total } from "../relate";

const PINF = Number.POSITIVE_INFINITY;

describe("interval contractors narrow free variables", () => {
  it("bound pulls a free var up to its floor, leaves a satisfying one", () => {
    const lo = num(0);
    free(lo);
    bound(lo, 3, 10);
    expect(lo.value).toBe(3); // base 0 below floor → pulled up

    const hi = num(8);
    free(hi);
    bound(hi, 3, 10);
    expect(hi.value).toBe(8); // base 8 inside band → kept (soft preference)
  });

  it("a FACT cell (not declared free) treats a conflicting bound as a no-op", () => {
    const x = num(0);
    bound(x, 3, 10); // 0 ∉ [3,10] → contradiction, not a narrow
    expect(x.value).toBe(0); // keeps its fact (§7a)
  });

  it("x ≥ 3 narrows through add without pinning anything", () => {
    const a = num(0);
    const b = num(0);
    const c = num(0);
    free(a);
    free(b);
    free(c);
    add(a, b, c); // a + b = c
    bound(a, 3, PINF); // a ≥ 3
    bound(b, 2, PINF); // b ≥ 2
    expect(a.value).toBe(3);
    expect(b.value).toBe(2);
    expect(c.value).toBe(5); // c ≥ 5, prefers base 0 → pulled to the floor 5
  });

  it("order propagates a bound across an anchored chain", () => {
    const xs = Array.from({ length: 5 }, () => num(0));
    for (const x of xs) free(x);
    bound(xs[0]!, 0, 0); // anchor the head
    for (let i = 0; i < xs.length - 1; i++) order(xs[i]!, xs[i + 1]!, 2); // +2 each hop
    expect(xs.map(x => x.value)).toEqual([0, 2, 4, 6, 8]);
  });

  it("a band flows through a .scale Iso lens (interval transformer)", () => {
    const a = num(0);
    free(a);
    const d = a.scale(2); // d = 2a (Iso homomorphism)
    bound(d, 0, 100); // couple a and d into one component
    bound(a, 3, 10); // a ∈ [3,10] ⇒ d ∈ [6,20]
    expect(a.value).toBe(3); // prefers base 0 → floor 3
    expect(d.value).toBe(6); // 2 · 3, narrowed through the lens band
  });

  it("total constrains a whole over its parts", () => {
    const p0 = num(0);
    const p1 = num(0);
    const whole = num(0);
    free(p0);
    free(p1);
    free(whole);
    total([p0, p1], whole);
    bound(whole, 10, 10); // fixed whole
    bound(p0, 4, PINF); // p0 ≥ 4
    expect(whole.value).toBe(10);
    expect(p0.value).toBe(4); // floored
    // p1 ≤ whole − p0.min = 6; prefers base 0 ⇒ stays 0 (band, not a point soln)
    expect(p1.value).toBeLessThanOrEqual(6);
  });
});
