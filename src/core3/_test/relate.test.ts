// Cyclic relationships declared DIRECTLY — no network() handle, no solve()
// wrapper, no per-cell lattice wiring. A value class that declares a static
// `lattice` (Range, Box, Flags, Num, …) can join a cycle; the relate layer
// resolves the lattice from the class only when the cell becomes a member.
//
// Lattices are DOMAIN-FAITHFUL (knowledge K distinct from value T):
//   • Range = the (lo, hi) PAIR — each endpoint narrows as an independent
//     interval, so `equal` unifies agreeing endpoints field-wise and a
//     conflicting endpoint keeps its own value (NOT a span intersection).
//   • Box = componentwise x/y/w/h intervals (same field-wise story).
//   • Flags = bit-AND candidate sets (K = T).
//   • Num = [min,max] interval (a point seed narrows to a band; ordering
//     constraints like x ≥ 5 actually narrow); Bool = flat.
// Narrowing within a span is expressed with directed interval constraints.

import { describe, expect, it } from "vitest";
import { Box, box, Flags, flags, Num, Range, range } from "../index";
import { equal } from "../relate";

const NINF = Number.NEGATIVE_INFINITY;
const PINF = Number.POSITIVE_INFINITY;

// Interval-knowledge (K) helpers for the lattice-law checks.
const IV = { min: NINF, max: PINF };
const ge = (n: number) => ({ min: n, max: PINF });

const span = (lo = NINF, hi = PINF) => range(lo, hi);

describe("Range is the (lo,hi) pair — field-wise unification", () => {
  it("equal unifies an agreeing endpoint and leaves a conflicting one alone", () => {
    const a = span(10, 20);
    const b = span(10, 99); // lo agrees (10), hi conflicts
    equal(a, b);
    expect(a.value).toEqual({ lo: 10, hi: 20 }); // hi keeps its own
    expect(b.value).toEqual({ lo: 10, hi: 99 });
  });

  it("equal of identical ranges holds; fully-conflicting equal is a no-op", () => {
    const a = span(0, 50);
    const b = span(0, 50);
    equal(a, b);
    expect(a.value).toEqual({ lo: 0, hi: 50 });

    const c = span(0, 50);
    const d = span(20, 100); // both endpoints conflict → each keeps its own
    equal(c, d);
    expect(c.value).toEqual({ lo: 0, hi: 50 });
    expect(d.value).toEqual({ lo: 20, hi: 100 });
  });

  it("equal chains unify the field every member agrees on", () => {
    const a = span(5, 20);
    const b = span(5, 50);
    const c = span(5, 99); // all agree lo=5; his all conflict
    equal(a, b);
    equal(b, c);
    expect([a.value.lo, b.value.lo, c.value.lo]).toEqual([5, 5, 5]);
    expect([a.value.hi, b.value.hi, c.value.hi]).toEqual([20, 50, 99]);
  });

  it("derived value-class views track the solved member", () => {
    const a = span(10, 80);
    const b = span(10, 80);
    equal(a, b);
    expect(a.width.value).toBe(70);
    expect(a.center.value).toBe(45);
  });
});

describe("Box is componentwise x/y/w/h", () => {
  it("equal unifies agreeing fields, leaves conflicting ones alone", () => {
    const a = box(0, 0, 100, 50);
    const b = box(0, 99, 100, 50); // x,w,h agree; y conflicts
    equal(a, b);
    expect(a.value).toEqual({ x: 0, y: 0, w: 100, h: 50 });
    expect(b.value).toEqual({ x: 0, y: 99, w: 100, h: 50 });
  });
});

describe("Flags is bit-intersection finite-domain propagation", () => {
  it("equal() is the agreed candidate set", () => {
    const a = flags({ r: true, w: true, x: true }); // 0b111
    const b = flags({ r: true, w: false, x: true }); // 0b101
    equal(a, b);
    expect(a.value).toBe(0b101);
    expect(b.value).toBe(0b101);
    expect(a.flag("w").value).toBe(false);
    expect(a.flag("r").value).toBe(true);
  });
});

describe("incremental topology — join and split (Flags)", () => {
  const F = ["b0", "b1", "b2", "b3"] as const;
  const fl = (m: number) => new Flags([...F], m);

  it("joining two cycles into one merges the SCCs (bit-AND of all)", () => {
    const a = fl(0b1111);
    const b = fl(0b0111);
    const c = fl(0b1110);
    const d = fl(0b1011);
    equal(a, b); // {a,b} → 0b0111
    equal(c, d); // {c,d} → 0b1010
    expect(a.value).toBe(0b0111);
    expect(c.value).toBe(0b1010);

    equal(b, c); // one SCC {a,b,c,d} → AND of all = 0b0010
    expect(a.value).toBe(0b0010);
    expect(d.value).toBe(0b0010);
  });

  it("removing the linking relation splits the SCC and relaxes", () => {
    const a = fl(0b1111);
    const b = fl(0b0111);
    const c = fl(0b1110);
    const d = fl(0b1011);
    equal(a, b);
    equal(c, d);
    const unlink = equal(b, c);
    expect(a.value).toBe(0b0010);

    unlink(); // split back into {a,b} and {c,d}
    expect(a.value).toBe(0b0111);
    expect(d.value).toBe(0b1010);
  });

  it("removing the last relation on a cell relaxes it to its base", () => {
    const a = fl(0b1111);
    const b = fl(0b0101);
    const unlink = equal(a, b);
    expect(a.value).toBe(0b0101);
    unlink();
    expect(a.value).toBe(0b1111); // back to its standing assertion
  });
});

// Keep the value-class statics honest: lattice laws hold (over KNOWLEDGE K).
describe("lattice laws (value-class statics)", () => {
  it("Range.lattice meets endpoint intervals componentwise", () => {
    const L = Range.lattice;
    const a = L.abstract({ lo: 0, hi: 10 });
    const b = L.abstract({ lo: 0, hi: 20 });
    const m = L.meet(a, b); // lo agrees (point 0), hi conflicts (empty)
    expect(L.isBottom(m)).toBe(true); // a conflicting field ⇒ bottom
    expect(L.concretize(m, { lo: 0, hi: 10 })).toEqual({ lo: 0, hi: 10 });
    // a genuine interval narrow on lo
    const lo5 = L.meet(L.top, { lo: { min: 5, max: PINF }, hi: IV });
    expect(L.concretize(lo5, { lo: 0, hi: 10 })).toEqual({ lo: 5, hi: 10 });
  });

  it("Box.lattice is componentwise intervals", () => {
    const L = Box.lattice;
    const k = L.meet(L.top, { x: ge(5), y: IV, w: IV, h: IV });
    expect(L.concretize(k, { x: 0, y: 0, w: 10, h: 10 })).toEqual({ x: 5, y: 0, w: 10, h: 10 });
  });

  it("Flags.lattice meet is bitwise AND with all-ones top", () => {
    expect(Flags.lattice.meet(0b111, 0b101)).toBe(0b101);
    expect(Flags.lattice.meet(Flags.lattice.top, 0b011)).toBe(0b011);
    expect(Flags.lattice.isBottom(0)).toBe(true);
  });

  it("Num.lattice is an interval — points conflict, bands narrow", () => {
    const L = Num.lattice;
    expect(L.isBottom(L.meet(L.abstract(3), L.abstract(5)))).toBe(true); // 3 ≠ 5
    expect(L.concretize(L.meet(L.abstract(3), L.abstract(3)), 9)).toBe(3); // pinned
    expect(L.concretize(L.top, 9)).toBe(9); // unknown ⇒ current value
    // x ≥ 5 narrows: a current value below the floor is pulled up, above is kept.
    expect(L.concretize(ge(5), 0)).toBe(5);
    expect(L.concretize(ge(5), 8)).toBe(8);
    expect(L.pinned(L.abstract(7))).toBe(7);
    expect(L.pinned(ge(5))).toBeUndefined(); // a band isn't pinned
  });

  it("interval widening makes an endlessly-narrowing chain terminate", () => {
    const L = Num.lattice;
    // A rule that halves the upper bound toward 0 forever; widening snaps the
    // sub-ε tail so the fixpoint is reached (no iteration cap, no hang).
    let k = L.abstract(0);
    k = { min: 0, max: 1 } as typeof k;
    let prev = k;
    let steps = 0;
    // Emulate the solver's widening descent on one field.
    for (; steps < 1000; steps++) {
      const next = L.meet(prev, { min: 0, max: (prev as { max: number }).max / 2 } as typeof k);
      const widened = L.widen ? L.widen(prev, next) : next;
      if (L.equals(prev, widened)) break;
      prev = widened;
    }
    expect(steps).toBeLessThan(1000); // converged, did not run away
  });
});
