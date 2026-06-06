// semantic-C-lens-as-residual.test.ts
//
// Lens chains as residual functions (witnesses of constraint
// violation); the propagator is the solver driving the residual to
// zero. Separates constraint definition (lens) from maintenance
// (propagator). Unlike AVBD `generic(cells, dim, fn)`, the residual
// is just a lens, so any reactive consumer can read it.

import { describe, expect, it } from "vitest";
import { num, vec } from "../../core";
import { propagator, propagators } from "..";

describe("Semantic probe C: lens-as-residual", () => {
  it("distance constraint via residual lens", () => {
    // Constraint: |a - b| should equal targetDist.
    // Residual: |a - b| - targetDist (nonzero = violation).
    // Solver: when residual is nonzero, project a (or b) along
    // the line a-b to make the distance correct.
    const a = vec(0, 0);
    const b = vec(10, 0);
    const targetDist = num(20);

    // Residual lens: how much we're off (signed magnitude).
    const residual = a.distance(b).sub(targetDist);

    // Solver: a propagator that watches the residual and, when
    // nonzero, projects b along (b - a) to fix it.
    const p = propagators();
    p.add(
      propagator([residual, a, targetDist], [b], () => {
        if (Math.abs(residual.value) < 1e-9) return;
        const dx = b.value.x - a.value.x;
        const dy = b.value.y - a.value.y;
        const cur = Math.hypot(dx, dy);
        if (cur < 1e-12) return;
        const k = targetDist.value / cur;
        (b.value as { x: number; y: number }) = {
          x: a.value.x + dx * k,
          y: a.value.y + dy * k,
        };
      }),
    );

    // Initial: |a-b| = 10, target = 20, residual = -10. Solver fires.
    expect(Math.hypot(b.value.x, b.value.y)).toBeCloseTo(20);
    expect(residual.value).toBeCloseTo(0);

    // Drag a — residual changes, solver fires.
    a.value = { x: 5, y: 5 };
    expect(Math.hypot(b.value.x - 5, b.value.y - 5)).toBeCloseTo(20);
    expect(residual.value).toBeCloseTo(0);

    // Change the target — residual changes, solver fires.
    targetDist.value = 5;
    expect(Math.hypot(b.value.x - 5, b.value.y - 5)).toBeCloseTo(5);

    p.dispose();
  });

  it("clamp constraint via lens-residual", () => {
    // Constraint: x ∈ [lo, hi]. Residual: how much x is outside.
    const x = num(50);
    const lo = num(0);
    const hi = num(100);

    // Residual lens: 0 if inside, signed-overshoot if outside.
    // We could express this as a derived computation.
    const overUpper = x.sub(hi); // > 0 if x > hi
    const underLower = lo.sub(x); // > 0 if x < lo

    const p = propagators();
    p.add(
      propagator([overUpper, underLower, hi, lo], [x], () => {
        if (overUpper.value > 0) x.value = hi.value;
        else if (underLower.value > 0) x.value = lo.value;
      }),
    );

    // 50 is inside; no fire.
    expect(x.value).toBe(50);

    // Push x above hi.
    x.value = 200;
    expect(x.value).toBe(100); // clamped to hi

    // Drag hi — if x > new hi, clamp.
    hi.value = 30;
    expect(x.value).toBe(30); // re-clamped

    p.dispose();
  });

  it("the residual is reactive — UI can SHOW the violation in real time", () => {
    // Because the residual is a signal (lens chain), other consumers
    // (UI labels, debug overlays, even other propagators) can read
    // it. The "constraint" is visible without privileged access.
    const a = num(2);
    const b = num(3);
    const expected = num(10);

    const sum = a.add(b); // lens
    const residual = sum.sub(expected); // lens — current violation

    // Anyone can read residual.value to see the current state.
    expect(residual.value).toBe(-5); // 2+3 - 10 = -5

    a.value = 8;
    expect(residual.value).toBe(1); // 8+3 - 10 = 1

    // No propagator yet — system is in violation. The residual
    // exposes this. A propagator could drive it to zero, OR a UI
    // could just SHOW the violation (e.g. "2 over budget!").
    expect(sum.value).toBe(11); // 8 + 3, still reactive without any solver
  });

  it("composing residuals: total constraint violation as a sum lens", () => {
    // Multi-constraint system. Each constraint has its own residual
    // lens. Total violation = sum of squared residuals.
    const x = num(5);
    const y = num(5);

    // Constraint 1: x = 10. Residual: x - 10.
    const r1 = x.sub(num(10));
    // Constraint 2: y = 0. Residual: y.
    const r2 = y.sub(num(0));

    // Total violation: r1² + r2² (a "loss function").
    const sqr1 = r1.scale(r1.value); // r1.value = -5, so this is r1 × -5

    expect(r1.value).toBe(-5);
    expect(r2.value).toBe(5);

    // A propagator could drive both to zero by writing x and y.
    // OR a SOLVER could read the total loss and gradient-descend.
    // The lens chain exposes the violation in a way that's
    // reactive — solvers can subscribe to it.
    expect(sqr1.value).toBe(25); // (-5) × -5 — squared residual as a lens
  });
});
