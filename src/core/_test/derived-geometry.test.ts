// derived-geometry.test.ts — read-only bezier samplers.

import { describe, expect, it } from "vitest";
import { bezier2, bezier3, cell, vec } from "../index";

describe("bezier2 / bezier3", () => {
  it("quadratic at t=0.5 = midpoint of (p0p1, p1p2) midpoints", () => {
    const p0 = vec(0, 0);
    const p1 = vec(10, 10);
    const p2 = vec(20, 0);
    const t = cell(0.5);
    const b = bezier2(p0, p1, p2, t);
    expect(b.value).toEqual({ x: 10, y: 5 });
  });

  it("cubic endpoints at t=0 and t=1", () => {
    const p0 = vec(0, 0);
    const p1 = vec(1, 5);
    const p2 = vec(9, 5);
    const p3 = vec(10, 0);
    const t = cell(0);
    const b = bezier3(p0, p1, p2, p3, t);
    expect(b.value).toEqual({ x: 0, y: 0 });
    t.value = 1;
    expect(b.value).toEqual({ x: 10, y: 0 });
    t.value = 0.5;
    // Symmetric curve: b(0.5).y should be max
    expect(b.value.x).toBe(5);
    expect(b.value.y).toBeCloseTo(3.75);
  });
});
