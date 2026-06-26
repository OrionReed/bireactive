// Stateful-lens foundations: complement seed, forward-only refresh (in `get`),
// put recovering discarded info, and the trap case (scale-to-zero round trip
// recoverable because unit deviations live in the complement, not the source).

import { describe, expect, it } from "vitest";
import { cell, effect, lens, settle } from "../index";
import { Num, num } from "../values/num";
import { vec } from "../values/vec";

describe("stateful lens — single input, identity-ish", () => {
  it("seed complement is used for the first read", () => {
    const src = num(7);
    let seenComplement: number | null = null;
    const view = Num.lens(src, {
      complement: () => ({ v: -1 }),
      get: (s, c) => {
        seenComplement = c.v;
        return s;
      },
      put: t => t,
    });
    expect(view.value).toBe(7);
    expect(seenComplement).toBe(-1);
  });

  it("get refreshes the complement on each (dirtying) read", () => {
    const src = num(10);
    let calls = 0;
    const view = Num.lens(src, {
      complement: () => ({ v: 0 }),
      get: (s, c) => {
        calls += 1;
        c.v += 1;
        return s;
      },
      put: t => t,
    });
    view.value;
    view.value; // cached — no recompute
    view.value;
    src.value = 11; // dirties → next read recomputes
    view.value;
    expect(calls).toBeGreaterThanOrEqual(2);
  });

  it("put threads complement into write decisions", () => {
    // The complement stores the last write; subsequent writes use it to
    // "snap" non-monotonic writes upward.
    const src = num(0);
    const snapped = Num.lens(src, {
      complement: () => ({ last: 0 }),
      get: (s, c) => {
        c.last = s;
        return s;
      },
      put: (t, _s, c) => {
        const next = t < c.last ? c.last : t; // monotonic
        c.last = next;
        return next;
      },
    });
    snapped.value = 5;
    expect(src.value).toBe(5);
    snapped.value = 3;
    expect(src.value).toBe(5);
    snapped.value = 8;
    expect(src.value).toBe(8);
  });

  // The forward-only refresh (no version stamp) is sound only because the cache
  // runs `get` at most once per settled source: a path-dependent complement must
  // not double-advance across `peek`, repeated `.value`, or peek-then-value.
  it("refresh runs once per settled source — peek/value/repeat don't double-step", () => {
    const src = num(0);
    let steps = 0;
    // Accumulating (genuinely path-dependent) complement: each refresh counts.
    const view = Num.lens(src, {
      complement: () => ({ n: 0 }),
      get: (s, c) => {
        c.n += 1;
        steps += 1;
        return s;
      },
      put: t => t,
    });

    view.peek(); // first realize
    view.value; // cached
    view.peek(); // cached
    view.value; // cached
    expect(steps).toBe(1); // exactly one refresh for one settled source

    src.value = 1; // genuine move → one more refresh on next read
    view.peek();
    view.value;
    expect(steps).toBe(2);

    // An own back-write dirties the view; the next read re-runs `get`, which —
    // being idempotent on the (now settled) source — leaves the view consistent.
    view.value = 9;
    expect(src.value).toBe(9);
    expect(view.value).toBe(9);
  });
});

describe("stateful lens — multi-input scaling (the trap case)", () => {
  // Setup: N points around a centroid. View = scalar "spread" (mean
  // radial distance). The trap under plain lenses: setting spread = 0
  // collapses all points to the centroid, destroying directions; you
  // cannot recover them later by setting spread > 0.
  //
  // Stateful-lens fix: complement = unit deviation per point. `get`
  // refreshes the unit deviations whenever spread reads > 0; `put`
  // multiplies them by the new spread and adds the centroid back.

  type V = { x: number; y: number };
  type C = { units: V[]; centroid: V };

  const recompute = (positions: readonly V[], prev: C | undefined): C => {
    const n = positions.length;
    let cx = 0;
    let cy = 0;
    for (const p of positions) {
      cx += p.x;
      cy += p.y;
    }
    cx /= n;
    cy /= n;
    const units = positions.map((p, i) => {
      const dx = p.x - cx;
      const dy = p.y - cy;
      const r = Math.hypot(dx, dy);
      return r > 1e-9 ? { x: dx / r, y: dy / r } : (prev?.units[i] ?? { x: 0, y: 0 });
    });
    return { units, centroid: { x: cx, y: cy } };
  };

  const meanRadius = (positions: readonly V[], centroid: V): number => {
    let total = 0;
    for (const p of positions) total += Math.hypot(p.x - centroid.x, p.y - centroid.y);
    return total / positions.length;
  };

  const makeSpread = (pts: ReturnType<typeof vec>[]) =>
    Num.lens(pts, {
      complement: (positions: readonly V[]) => recompute(positions, undefined),
      get: (positions: readonly V[], c: C) => {
        Object.assign(c, recompute(positions, c));
        return meanRadius(positions, c.centroid);
      },
      put: (newSpread: number, positions: readonly V[], c: C) => {
        const k = Math.max(0, newSpread);
        return positions.map((_, i) => ({
          x: c.centroid.x + c.units[i]!.x * k,
          y: c.centroid.y + c.units[i]!.y * k,
        }));
      },
    });

  it("read recovers spread from positions", () => {
    const pts = [vec(0, 1), vec(0, -1), vec(1, 0), vec(-1, 0)];
    const spread = makeSpread(pts);
    expect(spread.value).toBeCloseTo(1, 9);
  });

  it("write to spread scales radially about centroid", () => {
    const pts = [vec(0, 2), vec(0, -2), vec(2, 0), vec(-2, 0)];
    const spread = makeSpread(pts);
    expect(spread.value).toBeCloseTo(2, 9); // realize complement
    spread.value = 5;
    expect(pts[0]!.value.y).toBeCloseTo(5, 9);
    expect(pts[1]!.value.y).toBeCloseTo(-5, 9);
    expect(pts[2]!.value.x).toBeCloseTo(5, 9);
    expect(pts[3]!.value.x).toBeCloseTo(-5, 9);
  });

  it("THE TRAP CASE: spread → 0 → 7 recovers original directions", () => {
    const pts = [vec(0, 2), vec(0, -2), vec(2, 0), vec(-2, 0)];
    const spread = makeSpread(pts);
    // Realize the complement so we capture directions BEFORE collapsing.
    expect(spread.value).toBeCloseTo(2, 9);

    spread.value = 0;
    // All points collapsed to centroid.
    for (const p of pts) {
      expect(p.value.x).toBeCloseTo(0, 9);
      expect(p.value.y).toBeCloseTo(0, 9);
    }
    expect(spread.value).toBeCloseTo(0, 9);

    // Now reinflate. With a plain lens, directions are gone forever.
    // With the complement, they come back.
    spread.value = 7;
    expect(pts[0]!.value.y).toBeCloseTo(7, 9);
    expect(pts[1]!.value.y).toBeCloseTo(-7, 9);
    expect(pts[2]!.value.x).toBeCloseTo(7, 9);
    expect(pts[3]!.value.x).toBeCloseTo(-7, 9);
  });

  it("write does NOT depend on epsilon — 0 is truly 0", () => {
    const pts = [vec(0, 3), vec(0, -3)];
    const spread = makeSpread(pts);
    expect(spread.value).toBeCloseTo(3, 9);
    spread.value = 0;
    // Strict zero, not eps. This is the semantic correctness point.
    expect(pts[0]!.value.x).toBe(0);
    expect(pts[0]!.value.y).toBe(0);
    expect(pts[1]!.value.x).toBe(0);
    expect(pts[1]!.value.y).toBe(0);
    expect(spread.value).toBe(0);
  });

  it("composition: scaling the spread by 1000 does NOT amplify an epsilon", () => {
    const pts = [vec(0, 3), vec(0, -3)];
    const spread = makeSpread(pts);
    expect(spread.value).toBeCloseTo(3, 9);
    spread.value = 0;
    // Chain a plain-lens .scale on top — if spread were epsilon,
    // 1000*epsilon would be a visible artefact. With true 0, the
    // chain stays at 0.
    const scaled = spread.scale(1000);
    expect(scaled.value).toBe(0);
  });
});

describe("backward pass is untracked", () => {
  it("writing a lens inside an effect does not subscribe to the lens's source", () => {
    // The effect reads `a` and writes `view` (whose source is `b`). The
    // back-write must run untracked: the effect should depend on `a`
    // ONLY — never pick up `b` through the backward walk. If it did, a
    // later edit to `b` would spuriously re-run the effect (and a write
    // back into `b` from within would self-trigger).
    const a = cell(0);
    const b = cell(100);
    const view = lens(
      [b] as const,
      ([bv]) => bv,
      v => [v],
    );

    let runs = 0;
    const stop = effect(() => {
      const av = a.value; // the ONLY intended dependency
      view.value = av; // backward write into `b` — must not create a dep
      runs++;
    });

    expect(runs).toBe(1);
    expect(b.peek()).toBe(0); // the effect's back-write landed

    // An external edit to the lens's source must NOT re-run the effect.
    b.value = 55;
    settle();
    expect(runs).toBe(1);

    // The real dependency still drives re-runs (and the back-write again).
    a.value = 7;
    settle();
    expect(runs).toBe(2);
    expect(b.peek()).toBe(7);

    stop();
  });
});

describe("same-view back-write short-circuits", () => {
  it("a write that re-projects to the current view leaves the complement intact", () => {
    // Monotonic snap: writing below the stored high-water mark re-projects
    // to the SAME view (the stored max), so the equality check stops it —
    // the source AND the complement are left untouched.
    const src = num(5);
    const snapped = Num.lens(src, {
      complement: () => ({ hi: 0 }),
      get: (s, c) => {
        if (s > c.hi) c.hi = s;
        return c.hi;
      },
      put: (t, _s, c) => {
        const hi = Math.max(t, c.hi);
        c.hi = hi;
        return hi;
      },
    });

    expect(snapped.value).toBe(5); // hi = 5
    snapped.value = 9;
    expect(src.peek()).toBe(9); // raised the mark
    snapped.value = 3; // below the mark → re-projects to 9 → no-op
    expect(src.peek()).toBe(9); // source untouched
    expect(snapped.value).toBe(9); // complement (hi) preserved
  });
});
