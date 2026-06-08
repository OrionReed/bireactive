// Cyclic relationships declared DIRECTLY — no network() handle, no solve()
// wrapper, no per-cell lattice wiring. A value class that declares a static
// `lattice` (Range, Box, Flags) can join a cycle; the relate layer resolves
// the lattice from the class only when the cell becomes a relation member.
// Reading a participant reflects the solved fixpoint; changing a plain input
// re-solves only the affected region.

import { describe, expect, it } from "vitest";
import { Box, box, Flags, flags, num, Range, range, type Writable } from "../index";
import { constrain, equal } from "../relate";

const NINF = Number.NEGATIVE_INFINITY;
const PINF = Number.POSITIVE_INFINITY;

/** A `Range` knowledge cell spanning `[lo, hi]` (default: the whole line). */
const span = (lo = NINF, hi = PINF) => range(lo, hi);

/** a + gap ≤ b, declared as two interval propagators over Range cells. */
function order(a: Writable<Range>, b: Writable<Range>, gap = 0): void {
  constrain([b], [a], (get, emit) => emit(a, { lo: NINF, hi: get(b).hi - gap }));
  constrain([a], [b], (get, emit) => emit(b, { lo: get(a).lo + gap, hi: PINF }));
}

describe("direct cyclic relationships", () => {
  it("equal(a,b) narrows both to the intersection — no wrapper", () => {
    const a = span(0, 50);
    const b = span(20, 100);
    equal(a, b);
    expect(a.value).toEqual({ lo: 20, hi: 50 });
    expect(b.value).toEqual({ lo: 20, hi: 50 });
  });

  it("a longest-path chain across non-sibling nodes", () => {
    const n = [span(0), span(0), span(0), span(0)];
    order(n[0]!, n[1]!, 1);
    order(n[1]!, n[2]!, 1);
    order(n[2]!, n[3]!, 1);
    order(n[0]!, n[3]!, 1); // skip edge — still correct longest path
    expect(n.map(c => Math.round(c.value.lo))).toEqual([0, 1, 2, 3]);
  });

  it("a plain input drives narrowing and re-solves on change (flex-shaped)", () => {
    // total width (plain input) split between two panes with min bands:
    //   p0 + p1 = total,  p0 ≥ 30,  p1 ≥ 30
    const total = num(100); // plain Num: no lattice → external input
    const p0 = span();
    const p1 = span();
    constrain([p1], [p0], (get, emit) => {
      const t = total.value;
      emit(p0, { lo: t - get(p1).hi, hi: t - get(p1).lo });
    });
    constrain([p0], [p1], (get, emit) => {
      const t = total.value;
      emit(p1, { lo: t - get(p0).hi, hi: t - get(p0).lo });
    });
    constrain([], [p0], (_g, emit) => emit(p0, { lo: 30, hi: PINF }));
    constrain([], [p1], (_g, emit) => emit(p1, { lo: 30, hi: PINF }));

    // total=100 → p0∈[30,70], p1∈[30,70]
    expect(p0.value).toEqual({ lo: 30, hi: 70 });

    // widen the input: panes relax (proves recompute-from-base, not stuck-narrow)
    total.value = 200;
    expect(p0.value).toEqual({ lo: 30, hi: 170 });
  });

  it("value-class views derive off the solved member", () => {
    const a = span(0, 100);
    const b = span(40, 60);
    equal(a, b);
    expect(a.value).toEqual({ lo: 40, hi: 60 });
    expect(a.width.value).toBe(20);
    expect(a.center.value).toBe(50);
  });
});

describe("relations operate on several value classes", () => {
  it("Box: equal() narrows both to the overlapping rectangle", () => {
    const a = box(0, 0, 100, 100);
    const b = box(50, 50, 100, 100);
    equal(a, b);
    // overlap: x=50,y=50, right=min(100,150)=100, bottom=100 → 50×50
    expect(a.value).toEqual({ x: 50, y: 50, w: 50, h: 50 });
    expect(b.value).toEqual({ x: 50, y: 50, w: 50, h: 50 });
  });

  it("Box: three-way overlap solves as one SCC", () => {
    const a = box(0, 0, 100, 100);
    const b = box(20, 0, 100, 100);
    const c = box(40, 0, 100, 100);
    equal(a, b);
    equal(b, c);
    // common x-overlap is [40,100] → x=40,w=60; y full [0,100]
    expect(a.value).toEqual({ x: 40, y: 0, w: 60, h: 100 });
    expect(c.value).toEqual({ x: 40, y: 0, w: 60, h: 100 });
  });

  it("Flags: bit-intersection is finite-domain constraint propagation", () => {
    // each cell is a candidate SET of bits; equal() = the agreed candidates.
    const a = flags({ r: true, w: true, x: true }); // 0b111
    const b = flags({ r: true, w: false, x: true }); // 0b101
    equal(a, b);
    expect(a.value).toBe(0b101);
    expect(b.value).toBe(0b101);
    expect(a.flag("w").value).toBe(false);
    expect(a.flag("r").value).toBe(true);
  });
});

describe("incremental topology — join and split", () => {
  it("joining two cycles into one merges the SCCs (correct intersection)", () => {
    const a = span(0, 100);
    const b = span(10, 90);
    const c = span(20, 80);
    const d = span(30, 70);
    equal(a, b); // cycle {a,b} → [10,90]
    equal(c, d); // cycle {c,d} → [30,70]
    expect(a.value).toEqual({ lo: 10, hi: 90 });
    expect(c.value).toEqual({ lo: 30, hi: 70 });

    // Link them: now {a,b,c,d} is ONE SCC → common intersection.
    equal(b, c);
    expect(a.value).toEqual({ lo: 30, hi: 70 });
    expect(d.value).toEqual({ lo: 30, hi: 70 });
  });

  it("removing the linking relation splits the SCC and relaxes (correct)", () => {
    const a = span(0, 100);
    const b = span(10, 90);
    const c = span(20, 80);
    const d = span(30, 70);
    equal(a, b);
    equal(c, d);
    const unlink = equal(b, c); // one big SCC → all [30,70]
    expect(a.value).toEqual({ lo: 30, hi: 70 });

    unlink(); // split back into {a,b} and {c,d}; each relaxes to its own
    expect(a.value).toEqual({ lo: 10, hi: 90 });
    expect(d.value).toEqual({ lo: 30, hi: 70 });
  });

  it("removing the last relation on a cell relaxes it to its base", () => {
    const a = span(0, 100);
    const b = span(40, 60);
    const unlink = equal(a, b);
    expect(a.value).toEqual({ lo: 40, hi: 60 });
    unlink();
    expect(a.value).toEqual({ lo: 0, hi: 100 }); // back to its standing assertion
  });
});

// Keep the value-class statics honest: lattice laws hold.
describe("lattice laws (value-class statics)", () => {
  it("Range.lattice meet is intersection; Box.lattice meet is overlap", () => {
    expect(Range.lattice.meet({ lo: 0, hi: 10 }, { lo: 5, hi: 20 })).toEqual({ lo: 5, hi: 10 });
    expect(Range.lattice.isBottom({ lo: 10, hi: 0 })).toBe(true);
    expect(Box.lattice.meet({ x: 0, y: 0, w: 10, h: 10 }, { x: 5, y: 5, w: 10, h: 10 })).toEqual({
      x: 5,
      y: 5,
      w: 5,
      h: 5,
    });
  });

  it("Flags.lattice meet is bitwise AND with all-ones top", () => {
    expect(Flags.lattice.meet(0b111, 0b101)).toBe(0b101);
    expect(Flags.lattice.meet(Flags.lattice.top, 0b011)).toBe(0b011);
    expect(Flags.lattice.isBottom(0)).toBe(true);
  });
});
