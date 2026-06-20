// snap.test.ts — hull weights + sticky nearest-index.

import { describe, expect, it } from "vitest";
import type { Writable } from "../../cell";
import type { Vec } from "../../values/vec";
import { vec } from "../../values/vec";
import { hullWeights, nearestIndex } from "../snap";

const at = (x: number, y: number) => vec(x, y);

describe("hullWeights — convex-hull barycentric", () => {
  it("K=1 is the point itself", () => {
    expect(hullWeights({ x: 5, y: 5 }, [{ x: 0, y: 0 }])).toEqual([1]);
  });

  it("K=2 projects onto the segment, clamped", () => {
    const p0 = { x: 0, y: 0 };
    const p1 = { x: 10, y: 0 };
    expect(hullWeights({ x: 5, y: 3 }, [p0, p1])).toEqual([0.5, 0.5]);
    // past p1 → fully on p1
    expect(hullWeights({ x: 20, y: 0 }, [p0, p1])).toEqual([0, 1]);
    // before p0 → fully on p0
    expect(hullWeights({ x: -5, y: 0 }, [p0, p1])).toEqual([1, 0]);
  });

  it("K=3 centroid is uniform; weights sum to 1 and stay non-negative", () => {
    const tri = [
      { x: 0, y: 0 },
      { x: 6, y: 0 },
      { x: 0, y: 6 },
    ];
    const c = hullWeights({ x: 2, y: 2 }, tri);
    expect(c[0]! + c[1]! + c[2]!).toBeCloseTo(1, 6);
    for (const w of c) expect(w).toBeGreaterThanOrEqual(-1e-9);
    // outside the triangle → clamped to the hull, still a valid simplex
    const out = hullWeights({ x: -10, y: -10 }, tri);
    expect(out[0]! + out[1]! + out[2]!).toBeCloseTo(1, 6);
    for (const w of out) expect(w).toBeGreaterThanOrEqual(-1e-9);
  });

  it("K>3 Frank–Wolfe lands inside the hull and sums to 1", () => {
    const quad = [
      { x: 0, y: 0 },
      { x: 10, y: 0 },
      { x: 10, y: 10 },
      { x: 0, y: 10 },
    ];
    const w = hullWeights({ x: 5, y: 5 }, quad);
    expect(w.reduce((a, b) => a + b, 0)).toBeCloseTo(1, 4);
    for (const x of w) expect(x).toBeGreaterThanOrEqual(-1e-6);
  });
});

describe("nearestIndex — discrete selection", () => {
  it("picks the nearest candidate", () => {
    const p = vec(0, 0) as Writable<Vec>;
    const cands = [at(0, 0), at(100, 0), at(0, 100)];
    const idx = nearestIndex(p, cands);
    expect(idx.value).toBe(0);
    p.value = { x: 90, y: 5 };
    expect(idx.value).toBe(1);
    p.value = { x: 5, y: 90 };
    expect(idx.value).toBe(2);
  });

  it("hysteresis keeps the current pick until a rival wins by the margin", () => {
    const p = vec(40, 0) as Writable<Vec>;
    const cands = [at(0, 0), at(100, 0)];
    const idx = nearestIndex(p, cands, { sticky: 30 });
    expect(idx.value).toBe(0);
    // Cross the midpoint (x=50) but stay within the sticky margin: hold 0.
    p.value = { x: 58, y: 0 };
    expect(idx.value).toBe(0);
    // Move well past: now 1 wins by > 30.
    p.value = { x: 90, y: 0 };
    expect(idx.value).toBe(1);
  });
});
