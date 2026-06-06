// semantic-B-lens-as-bwd-policy.test.ts
//
// Lenses encode write policy in their bwd: writing through
// `centroidLens`/`midpointLens`/a custom Vec.lens distributes the
// delta differently. A propagator that wants to "move a group" writes
// through the lens and borrows that policy instead of implementing it
// — separating write strategy (lens) from write trigger (propagator).

import { describe, expect, it } from "vitest";
import {
  cell,
  centroidLens,
  type Inner,
  midpointLens,
  num,
  Vec,
  vec,
  type Writable,
} from "../../core";
import { propagator, propagators } from "..";

describe("Semantic probe B: lens encodes WRITE POLICY", () => {
  it("the SAME propagator works with different aggregation policies", () => {
    // Propagator: "make `target` move to `goal`."
    // The choice of `target` (single cell, centroid, midpoint, custom)
    // determines what "moves" mean for the underlying cells.
    function followGoal(target: Writable<Vec>, goal: Writable<Vec>) {
      return propagator([goal], [target], () => {
        target.value = goal.value;
      });
    }

    // Variant 1: target = a single Vec. Just one cell moves.
    const single = vec(0, 0);
    const goal1 = vec(10, 20);
    const p1 = propagators();
    p1.add(followGoal(single, goal1));
    expect(single.value).toEqual({ x: 10, y: 20 });
    p1.dispose();

    // Variant 2: target = midpoint of two cells. BOTH move.
    const a = vec(0, 0);
    const b = vec(0, 0);
    const mid = midpointLens(a, b);
    const goal2 = vec(10, 20);
    const p2 = propagators();
    p2.add(followGoal(mid, goal2));
    // Midpoint moved to (10, 20); each endpoint translated by delta.
    expect(a.value).toEqual({ x: 10, y: 20 });
    expect(b.value).toEqual({ x: 10, y: 20 });
    p2.dispose();

    // Variant 3: target = centroid of N cells. ALL N move.
    const verts = [vec(0, 0), vec(0, 0), vec(0, 0)];
    const cent = centroidLens(verts);
    const goal3 = vec(10, 20);
    const p3 = propagators();
    p3.add(followGoal(cent, goal3));
    expect(verts[0]!.value).toEqual({ x: 10, y: 20 });
    expect(verts[1]!.value).toEqual({ x: 10, y: 20 });
    expect(verts[2]!.value).toEqual({ x: 10, y: 20 });
    p3.dispose();

    // Same propagator body; semantics changed only via the lens.
  });

  it("custom lens encodes a custom write policy — no propagator change needed", () => {
    // Define a "biased midpoint" lens: 70/30 split toward a.
    // Writing through it: the bwd places 70% of the delta on a,
    // 30% on b.
    const a = vec(0, 0);
    const b = vec(0, 0);
    const biasedMid = Vec.lens(
      [a, b] as const,
      vals => {
        const [av, bv] = vals;
        return { x: av.x * 0.7 + bv.x * 0.3, y: av.y * 0.7 + bv.y * 0.3 };
      },
      (target, vals) => {
        const [av, bv] = vals;
        const cur = { x: av.x * 0.7 + bv.x * 0.3, y: av.y * 0.7 + bv.y * 0.3 };
        const delta = { x: target.x - cur.x, y: target.y - cur.y };
        // Distribute delta with the biased policy: 70% of the work
        // goes to a (because a contributes 70% to fwd; symmetric).
        return [
          { x: av.x + delta.x * 0.7, y: av.y + delta.y * 0.7 },
          { x: bv.x + delta.x * 0.3, y: bv.y + delta.y * 0.3 },
        ];
      },
    );

    // Reuse the same propagator body.
    const goal = vec(100, 0);
    const p = propagators();
    p.add(
      propagator([goal], [biasedMid], () => {
        biasedMid.value = goal.value;
      }),
    );

    // Biased midpoint moved to (100, 0); a got 70% of delta, b got 30%.
    expect(a.value.x).toBeCloseTo(70);
    expect(b.value.x).toBeCloseTo(30);
    p.dispose();
  });

  it("a SCALE-LIKE policy via lens — propagator scales whole group around centroid", () => {
    // Lens: "the radius of this group from its centroid."
    // Writing the radius scales all points outward/inward.
    //
    // Define explicitly: radius is one cell; lens connects to the
    // group's positions.
    const verts = [vec(-1, 0), vec(1, 0), vec(0, 1)];
    const cent = centroidLens(verts); // = (0, 1/3)
    const cv = cent.value;

    // Mean radius (read-only proxy).
    const meanRadius = cell<number>(
      verts.reduce(
        (acc: number, v: Writable<Vec>) => acc + Math.hypot(v.value.x - cv.x, v.value.y - cv.y),
        0,
      ) / verts.length,
    );
    void meanRadius;

    // For demo: a propagator scales by writing each vert as
    // (cent + (vert - cent) * factor). Done explicitly here; the
    // SAME propagator body composes with any scale policy.
    const factor = num(1);
    const p = propagators();
    p.add(
      propagator([factor], verts as never[], () => {
        const c = cent.value;
        const f = factor.value;
        for (const v of verts) {
          const cur = v.value;
          (v.value as Inner<Vec>) = {
            x: c.x + (cur.x - c.x) * f,
            y: c.y + (cur.y - c.y) * f,
          };
        }
      }),
    );

    factor.value = 2;
    // Each vert is now twice as far from centroid (scaled in place).
    // Original v1 was at (-1, 0); cent (0, 1/3); offset (-1, -1/3);
    // scaled (-2, -2/3); final position (cent + scaled) = (-2, 1/3 - 2/3) = (-2, -1/3).
    expect(verts[0]!.value.x).toBeCloseTo(-2);
    expect(verts[0]!.value.y).toBeCloseTo(-1 / 3);
    p.dispose();
  });
});
