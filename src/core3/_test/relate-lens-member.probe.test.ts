// Lens-as-member: a cell that is already a lens (`range(numA,numB)`, `.shift`)
// can join a relation and stay a FAITHFUL lens — upstream flows into the solve,
// and writes route back through the lens to its parents. (`base` is the cell's
// live writable channel, a clone of the lens, not a snapshot.)
//
// Under coordinate-pair Range, `equal` unifies endpoints field-wise; here the
// neighbours are chosen to agree, so what's under test is the LENS MECHANISM
// (upstream re-invalidation + back-routing), not span intersection.

import { describe, expect, it } from "vitest";
import { num, range, settle } from "../index";
import { equal } from "../relate";

describe("lens as relation member (faithful)", () => {
  it("source member tracks its assertion (control)", () => {
    const a = range(0, 100);
    const b = range(0, 100);
    equal(a, b);
    expect(a.value).toEqual({ lo: 0, hi: 100 });
    a.value = { lo: 20, hi: 50 };
    expect(a.value).toEqual({ lo: 20, hi: 50 });
  });

  it("a Range lens (shift) keeps its upstream link while a member", () => {
    const r = range(0, 100); // source
    const s = r.shift(10); // LENS: s = [10, 110]
    expect(s.value).toEqual({ lo: 10, hi: 110 });

    const other = range(10, 110); // agrees with s
    equal(s, other);
    expect(s.value).toEqual({ lo: 10, hi: 110 });

    // Move the lens's ORIGINAL parent: s-as-lens becomes [110,210]. Upstream
    // must flow into the solve and re-invalidate it.
    r.value = { lo: 100, hi: 200 };
    settle();
    expect(s.value).toEqual({ lo: 110, hi: 210 });
  });

  it("writing a lens member flows back to its parent", () => {
    const r = range(0, 100);
    const s = r.shift(10); // [10,110]; writing s ⇒ r = s − 10
    const other = range(10, 110);
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
    const unlink = equal(s, range(10, 110));
    expect(s.value).toEqual({ lo: 10, hi: 110 });
    unlink();
    settle();
    r.value = { lo: 0, hi: 5 }; // lens ⇒ [10,15]
    settle();
    expect(s.value).toEqual({ lo: 10, hi: 15 }); // lens-ness preserved
  });

  it("relating a lens to the cell it derives from resolves in-cycle (no crash)", () => {
    // p and p.shift(5) are now BOTH members, so the shift becomes a constraint
    // lens: equal says p = shifted, the lens says shifted = p + 5 → p = p + 5,
    // an honest contradiction. The solver shrugs (keeps each field's current
    // value) rather than throwing — the cycle through the lens is first-class.
    const p = range(0, 100);
    const shifted = p.shift(5);
    equal(p, shifted);
    expect(p.value).toEqual({ lo: 0, hi: 100 }); // standing assertion held
    expect(shifted.value).toEqual({ lo: 5, hi: 105 }); // frozen forward value
  });

  it("a consistent lens cycle settles to the lens relation", () => {
    // a = b (equal) and b = a.shift(0) (identity lens, both members) → a == b
    // is satisfiable; the constraint lens contributes no contradiction.
    const a = range(0, 100);
    const idA = a.shift(0); // identity shift; parent a is a co-member
    equal(a, idA);
    expect(a.value).toEqual({ lo: 0, hi: 100 });
    expect(idA.value).toEqual({ lo: 0, hi: 100 });
    a.value = { lo: 20, hi: 60 };
    settle();
    expect(idA.value).toEqual({ lo: 20, hi: 60 }); // tracks through the cycle

    // Writing the constraint-lens member flows back through the lens to its
    // parent (the backward transformer / base channel), then re-solves.
    idA.value = { lo: 30, hi: 70 };
    settle();
    expect(a.value).toEqual({ lo: 30, hi: 70 });
    expect(idA.value).toEqual({ lo: 30, hi: 70 });
  });

  it("unlinking a cycle-through-lens relaxes the lens back to plain tracking", () => {
    const a = range(0, 100);
    const idA = a.shift(0);
    const unlink = equal(a, idA);
    expect(idA.value).toEqual({ lo: 0, hi: 100 });
    unlink();
    settle();
    a.value = { lo: 7, hi: 9 };
    settle();
    expect(idA.value).toEqual({ lo: 7, hi: 9 }); // back to a normal lens of a
  });

  it("range(numA, numB) is a 2-parent lens — writes split to both parents", () => {
    const a = num(0);
    const b = num(100);
    const r = range(a, b); // LENS over [a,b] = [0,100]
    equal(r, range(0, 100));
    expect(r.value).toEqual({ lo: 0, hi: 100 });
    r.value = { lo: 30, hi: 40 };
    settle();
    expect([a.value, b.value]).toEqual([30, 40]); // split back to both sources
  });
});
