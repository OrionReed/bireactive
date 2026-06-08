// Lens-as-member: a cell that is already a lens (`range(numA,numB)`, `span`,
// `.shift`, `.scale`) can join a relation and stay a FAITHFUL lens — upstream
// flows into the solve, and writes route back through the lens to its parents.
// (Option B: `base` is the cell's live writable channel, not a snapshot.)

import { describe, expect, it } from "vitest";
import { num, range, settle } from "../index";
import { equal } from "../relate";

describe("lens as relation member (faithful)", () => {
  it("source member tracks its assertion (control)", () => {
    const a = range(0, 100);
    const b = range(20, 50);
    equal(a, b);
    expect(a.value).toEqual({ lo: 20, hi: 50 });
  });

  it("a Range lens (shift) keeps its upstream link while a member", () => {
    const r = range(0, 100); // source
    const s = r.shift(10); // LENS: s = [10, 110]
    expect(s.value).toEqual({ lo: 10, hi: 110 });

    const other = range(20, 200);
    equal(s, other); // s becomes a member; solve = [10,110] ∩ [20,200] = [20,110]
    expect(s.value).toEqual({ lo: 20, hi: 110 });

    // Move the lens's ORIGINAL parent: s-as-lens becomes [110,210]; intersect
    // with other [20,200] ⇒ [110,200]. Upstream must flow into the solve.
    r.value = { lo: 100, hi: 200 };
    settle();
    expect(s.value).toEqual({ lo: 110, hi: 200 });
  });

  it("writing a lens member flows back to its parent", () => {
    const r = range(0, 100);
    const s = r.shift(10); // [10,110]; writing s ⇒ r = s − 10
    const other = range(-1000, 1000);
    equal(s, other);
    expect(s.value).toEqual({ lo: 10, hi: 110 });

    s.value = { lo: 40, hi: 60 }; // assert s = [40,60]
    settle();
    expect(s.value).toEqual({ lo: 40, hi: 60 });
    expect(r.value).toEqual({ lo: 30, hi: 50 }); // flowed back through the shift
  });

  it("after leaving, the lens still tracks its parent", () => {
    const r = range(0, 100);
    const s = r.shift(10); // [10,110]
    const unlink = equal(s, range(20, 200));
    expect(s.value).toEqual({ lo: 20, hi: 110 });
    unlink();
    settle();
    r.value = { lo: 0, hi: 5 }; // lens ⇒ [10,15]
    settle();
    expect(s.value).toEqual({ lo: 10, hi: 15 }); // lens-ness preserved
  });

  it("relating a lens to the cell it derives from is a clear error, not a crash", () => {
    const p = range(0, 100);
    const shifted = p.shift(5); // shifted = fwd(p); relating it to p is a cycle through the lens
    equal(p, shifted);
    // The contradiction surfaces on read (lazy solve): a CLEAR domain error,
    // not the engine's internal "Cyclic computed".
    expect(() => p.value).toThrow(/relation cycle through a lens/);
  });

  it("range(numA, numB) is a 2-parent lens — writes split to both parents", () => {
    const a = num(0);
    const b = num(100);
    const r = range(a, b); // LENS over [a,b] = [0,100]
    equal(r, range(-1000, 1000));
    expect(r.value).toEqual({ lo: 0, hi: 100 });
    r.value = { lo: 30, hi: 40 };
    settle();
    expect([a.value, b.value]).toEqual([30, 40]); // split back to both sources
  });
});
