// realistic-composition.test.ts — a "rigid bar with sliders" scene
// mixing lenses and propagators.
//
// Rule of thumb: derived values (midpoint, length, label text) are
// lenses; constraints on those values (length ∈ [50, 200], midpoint in
// viewport) are propagators writing back through the cells/lenses.

import { describe, expect, it } from "vitest";
import { midpointLens, vec } from "../../core";
import { Num } from "../../core/values/num";
import { propagator, propagators } from "..";

describe("Realistic: rigid bar with sliders", () => {
  it("the full scene, mixing lenses and propagators", () => {
    const A = vec(0, 50);
    const B = vec(100, 50);

    const mid = midpointLens(A, B);
    const length = Num.derive([A, B] as const, vals => {
      const [av, bv] = vals;
      return Math.hypot(bv.x - av.x, bv.y - av.y);
    });
    void length;

    expect(mid.value).toEqual({ x: 50, y: 50 });
    expect(length.value).toBe(100);

    const p = propagators();

    // Constraint 1: length ∈ [50, 200]. When violated, scale (B − A)
    // about the midpoint by writing A and B symmetrically (the
    // underlying cells, not the lens).
    p.add(
      propagator([length], [A, B], () => {
        const cur = length.value;
        if (cur >= 50 && cur <= 200) return;
        const target = Math.max(50, Math.min(200, cur));
        const m = mid.value; // lens read
        const factor = target / cur;
        A.value = {
          x: m.x + (A.value.x - m.x) * factor,
          y: m.y + (A.value.y - m.y) * factor,
        };
        B.value = {
          x: m.x + (B.value.x - m.x) * factor,
          y: m.y + (B.value.y - m.y) * factor,
        };
      }),
    );

    // Constraint 2: midpoint stays in viewport [0, 200] × [0, 100],
    // written through the midpoint lens (which distributes delta to A
    // and B, translating the bar).
    p.add(
      propagator([mid], [mid], () => {
        const m = mid.value;
        let x = m.x,
          y = m.y;
        if (x < 0) x = 0;
        if (x > 200) x = 200;
        if (y < 0) y = 0;
        if (y > 100) y = 100;
        if (x !== m.x || y !== m.y) mid.value = { x, y };
      }),
    );

    // Drag A way out: length explodes, constraint scales bar back.
    A.value = { x: -500, y: 50 };
    expect(length.value).toBeLessThanOrEqual(200);
    expect(length.value).toBeGreaterThanOrEqual(50);

    // Drag B until midpoint leaves the viewport: constraint pulls it
    // back, lens redistributes delta.
    B.value = { x: 1000, y: 1000 };
    expect(mid.value.x).toBeLessThanOrEqual(200);
    expect(mid.value.y).toBeLessThanOrEqual(100);

    p.dispose();
  });
});
