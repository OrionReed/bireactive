// geometry.test.ts — geometric lens primitives over N-input lenses.

import { describe, expect, it } from "vitest";
import { cell, num, vec } from "../index";
import { clampedMean } from "../lenses/aggregates";
import { angle, diff, distance, pulleySum, reflection, vecLerp } from "../lenses/geometry";

const vnear = (a: { x: number; y: number }, b: { x: number; y: number }): boolean =>
  Math.hypot(a.x - b.x, a.y - b.y) < 1e-9;

describe("distance", () => {
  it("computes Euclidean distance", () => {
    const a = vec(0, 0);
    const b = vec(3, 4);
    const d = distance(a, b);
    expect(d.value).toBe(5);
    a.value = { x: 1, y: 1 };
    expect(d.value).toBeCloseTo(Math.hypot(2, 3));
  });

  it("writing scales both points symmetrically about their midpoint", () => {
    const a = vec(0, 0);
    const b = vec(10, 0);
    const d = distance(a, b);
    expect(d.value).toBe(10);
    d.value = 20; // midpoint (5,0) fixed; each point moves to keep |a-b| = 20
    expect(vnear(a.value, { x: -5, y: 0 })).toBe(true);
    expect(vnear(b.value, { x: 15, y: 0 })).toBe(true);
    expect(d.value).toBeCloseTo(20);
  });

  it("collapse to 0 then back reinflates the remembered direction", () => {
    const a = vec(0, 0);
    const b = vec(8, 6); // distance 10, direction (0.8, 0.6)
    const d = distance(a, b);
    d.value = 0; // collapse onto midpoint (4, 3)
    expect(vnear(a.value, { x: 4, y: 3 })).toBe(true);
    expect(vnear(b.value, { x: 4, y: 3 })).toBe(true);
    d.value = 10; // reinflate along the stored direction
    expect(vnear(a.value, { x: 0, y: 0 })).toBe(true);
    expect(vnear(b.value, { x: 8, y: 6 })).toBe(true);
  });
});

describe("angle", () => {
  it("computes atan2 between two points", () => {
    const a = vec(0, 0);
    const b = vec(1, 0);
    const ang = angle(a, b);
    expect(ang.value).toBe(0);
    b.value = { x: 0, y: 1 };
    expect(ang.value).toBeCloseTo(Math.PI / 2);
  });

  it("writing rotates b about a (a fixed, separation preserved)", () => {
    const a = vec(0, 0);
    const b = vec(10, 0);
    const ang = angle(a, b);
    expect(ang.value).toBeCloseTo(0);
    ang.value = Math.PI / 2; // rotate b 90° CCW about a
    expect(vnear(a.value, { x: 0, y: 0 })).toBe(true);
    expect(vnear(b.value, { x: 0, y: 10 })).toBe(true);
    expect(ang.value).toBeCloseTo(Math.PI / 2);
  });
});

describe("reflection", () => {
  it("reflects a point across a horizontal axis", () => {
    const p = vec(2, 5);
    const a = vec(0, 0);
    const b = vec(10, 0); // horizontal x-axis
    const r = reflection(p, a, b);
    expect(r.value).toEqual({ x: 2, y: -5 });
  });

  it("writes propagate back through the involution to `point`", () => {
    const p = vec(2, 5);
    const a = vec(0, 0);
    const b = vec(10, 0);
    const r = reflection(p, a, b);
    expect(r.value).toEqual({ x: 2, y: -5 });
    // Drag the reflected point: write back through the (involutive)
    // bwd. Original point updates; axis untouched.
    r.value = { x: 7, y: -3 };
    expect(p.value).toEqual({ x: 7, y: 3 });
    expect(a.value).toEqual({ x: 0, y: 0 });
    expect(b.value).toEqual({ x: 10, y: 0 });
    // Forward read reflects again — should match what we wrote.
    expect(r.value).toEqual({ x: 7, y: -3 });
  });
});

describe("vecLerp", () => {
  it("read: linear interpolation between two vecs", () => {
    const a = vec(0, 0);
    const b = vec(10, 20);
    const t = cell(0.5);
    const m = vecLerp(a, b, t);
    expect(m.value).toEqual({ x: 5, y: 10 });
    t.value = 0.25;
    expect(m.value).toEqual({ x: 2.5, y: 5 });
  });

  it("write: drag the interpolated point shifts both endpoints", () => {
    const a = vec(0, 0);
    const b = vec(10, 20);
    const t = cell(0.5);
    const m = vecLerp(a, b, t);
    (m as unknown as { value: { x: number; y: number } }).value = { x: 100, y: 100 };
    // Both endpoints shifted by (95, 90).
    expect(a.value).toEqual({ x: 95, y: 90 });
    expect(b.value).toEqual({ x: 105, y: 110 });
    expect(t.value).toBe(0.5); // t unchanged
  });
});

describe("pulleySum", () => {
  it("sum of two nums with redistribution on write", () => {
    const a = num(3);
    const b = num(7);
    const s = pulleySum(a, b);
    expect(s.value).toBe(10);
    s.value = 20; // delta = +10, half each
    expect(a.value).toBe(8);
    expect(b.value).toBe(12);
    expect(s.value).toBe(20);
  });
});

describe("diff", () => {
  it("a - b with anti-symmetric writeback", () => {
    const a = num(10);
    const b = num(3);
    const d = diff(a, b);
    expect(d.value).toBe(7);
    d.value = 11; // delta = +4, a += 2, b -= 2
    expect(a.value).toBe(12);
    expect(b.value).toBe(1);
    expect(d.value).toBe(11);
  });
});

describe("clampedMean", () => {
  it("read clamps the mean", () => {
    const a = num(50);
    const b = num(50);
    const m = clampedMean([a, b], 0, 10);
    expect(m.value).toBe(10);
  });

  it("write clamps then distributes", () => {
    const a = num(0);
    const b = num(0);
    const m = clampedMean([a, b], 0, 10);
    m.value = 100; // clamped to 10 first
    expect(a.value).toBe(10);
    expect(b.value).toBe(10);
    m.value = -50;
    expect(a.value).toBe(0);
    expect(b.value).toBe(0);
  });
});
