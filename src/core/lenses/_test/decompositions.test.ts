// Closed-form N→M decomposition probes (procrustes, bbox, meanDiff),
// grouped by property: forward, round-trip, cross-channel invariance,
// idempotence, composition, stability, conservation, edge cases.

import { describe, expect, it } from "vitest";
import { approxWithin, lcg as rng } from "../../../_test/_util";
import type { Writable } from "../../index";
import { num, type Vec, vec } from "../../index";
import { meanDiff } from "../aggregates";
import { bbox, procrustes } from "../point-cloud";

const { near, vnear } = approxWithin(1e-6);

const mkPoints = (...pts: [number, number][]): Writable<Vec>[] => pts.map(([x, y]) => vec(x, y));

describe("§1 Forward correctness", () => {
  it("meanDiff: M=2 read", () => {
    const a = num(10);
    const b = num(4);
    const { mean, diff } = meanDiff(a, b);
    expect(mean.value).toBe(7);
    expect(diff.value).toBe(6);
  });

  it("procrustes: centroid + rotation + scale of an L-shape", () => {
    const pts = mkPoints([0, 0], [10, 0], [0, 5]);
    const { centroid, rotation, scale } = procrustes(pts);
    // centroid = (10/3, 5/3)
    expect(centroid.value.x).toBeCloseTo(10 / 3, 10);
    expect(centroid.value.y).toBeCloseTo(5 / 3, 10);
    // point[0] − centroid = (-10/3, -5/3) → atan2(-5/3, -10/3)
    expect(rotation.value).toBeCloseTo(Math.atan2(-5 / 3, -10 / 3), 10);
    expect(scale.value).toBeCloseTo(Math.hypot(10 / 3, 5 / 3), 10);
  });

  it("bbox: 3-point bounding box", () => {
    const pts = mkPoints([0, 0], [10, 5], [4, 8]);
    const { center, size } = bbox(pts);
    expect(center.value).toEqual({ x: 5, y: 4 });
    expect(size.value).toEqual({ x: 10, y: 8 });
  });
});

// The basic Lens Law for an underdetermined N→M cell: write T, read = T.
describe("§2 Round-trip identity", () => {
  it("meanDiff: exact identity (closed-form)", () => {
    const a = num(3);
    const b = num(5);
    const { mean, diff } = meanDiff(a, b);
    mean.value = 50;
    expect(mean.value).toBe(50);
    diff.value = 4;
    expect(diff.value).toBe(4);
  });

  it("procrustes: each of 3 aspects round-trips exactly", () => {
    const pts = mkPoints([0, 0], [10, 0], [0, 5]);
    const { centroid, rotation, scale } = procrustes(pts);
    centroid.value = { x: 100, y: 50 };
    expect(vnear(centroid.value, { x: 100, y: 50 })).toBe(true);
    rotation.value = Math.PI / 3;
    expect(near(rotation.value, Math.PI / 3, 1e-9)).toBe(true);
    scale.value = 20;
    expect(near(scale.value, 20, 1e-9)).toBe(true);
  });

  it("bbox: round-trip on center & size", () => {
    const pts = mkPoints([0, 0], [10, 5], [4, 8]);
    const { center, size } = bbox(pts);
    center.value = { x: -3, y: -2 };
    expect(vnear(center.value, { x: -3, y: -2 })).toBe(true);
    size.value = { x: 20, y: 30 };
    expect(vnear(size.value, { x: 20, y: 30 })).toBe(true);
  });
});

// THE defining property of N→M lenses: writing one of the M outputs must not
// change the OTHER readings.
describe("§3 Cross-channel invariance", () => {
  it("meanDiff: write mean, diff unchanged (and vice versa)", () => {
    const a = num(3);
    const b = num(7);
    const { mean, diff } = meanDiff(a, b);
    const d0 = diff.value;
    mean.value = 100;
    expect(diff.value).toBe(d0);
    const m1 = mean.value;
    diff.value = 50;
    expect(mean.value).toBe(m1);
  });

  it("procrustes: write centroid → rotation & scale unchanged", () => {
    const pts = mkPoints([5, 0], [3, 4], [-2, 1]);
    const { centroid, rotation, scale } = procrustes(pts);
    const r0 = rotation.value;
    const s0 = scale.value;
    centroid.value = { x: 100, y: -50 };
    expect(near(rotation.value, r0)).toBe(true);
    expect(near(scale.value, s0)).toBe(true);
  });

  it("procrustes: write rotation → centroid & scale unchanged", () => {
    const pts = mkPoints([5, 0], [3, 4], [-2, 1]);
    const { centroid, rotation, scale } = procrustes(pts);
    const c0 = centroid.value;
    const s0 = scale.value;
    rotation.value = 1.234;
    expect(vnear(centroid.value, c0, 1e-9)).toBe(true);
    expect(near(scale.value, s0, 1e-9)).toBe(true);
  });

  it("procrustes: write scale → centroid & rotation unchanged", () => {
    const pts = mkPoints([5, 0], [3, 4], [-2, 1]);
    const { centroid, rotation, scale } = procrustes(pts);
    const c0 = centroid.value;
    const r0 = rotation.value;
    scale.value = 17;
    expect(vnear(centroid.value, c0, 1e-9)).toBe(true);
    expect(near(rotation.value, r0, 1e-9)).toBe(true);
  });

  it("bbox: write center → size unchanged", () => {
    const pts = mkPoints([0, 0], [10, 5], [4, 8]);
    const { center, size } = bbox(pts);
    const s0 = size.value;
    center.value = { x: -99, y: 42 };
    expect(vnear(size.value, s0)).toBe(true);
  });

  it("bbox: write size → center unchanged", () => {
    const pts = mkPoints([0, 0], [10, 5], [4, 8]);
    const { center, size } = bbox(pts);
    const c0 = center.value;
    size.value = { x: 100, y: 7 };
    expect(vnear(center.value, c0)).toBe(true);
  });
});

// `s.value = T; s.value = T` should be a no-op on the second write.
describe("§4 Idempotence", () => {
  it("procrustes (closed-form): exact idempotence", () => {
    const pts = mkPoints([5, 0], [3, 4], [-2, 1]);
    const { rotation } = procrustes(pts);
    rotation.value = 1.0;
    const snapshot = pts.map(p => p.value);
    rotation.value = 1.0; // again
    for (let i = 0; i < pts.length; i++) {
      expect(vnear(pts[i]!.value, snapshot[i]!, 1e-12)).toBe(true);
    }
  });

  it("bbox: exact idempotence", () => {
    const pts = mkPoints([0, 0], [10, 5], [4, 8]);
    const { size } = bbox(pts);
    size.value = { x: 50, y: 60 };
    const snapshot = pts.map(p => p.value);
    size.value = { x: 50, y: 60 };
    for (let i = 0; i < pts.length; i++) {
      expect(vnear(pts[i]!.value, snapshot[i]!, 1e-12)).toBe(true);
    }
  });
});

// translate+rotate, translate+scale, rotate+scale (all about centroid) commute
// by geometry — all three should commute for procrustes.
describe("§5 Composition / commutation", () => {
  it("procrustes: translate ∘ rotate ≡ rotate ∘ translate", () => {
    const pts1 = mkPoints([5, 0], [3, 4], [-2, 1]);
    const pl1 = procrustes(pts1);
    pl1.centroid.value = { x: 100, y: 50 };
    pl1.rotation.value = 1.2;
    const final1 = pts1.map(p => p.value);

    const pts2 = mkPoints([5, 0], [3, 4], [-2, 1]);
    const pl2 = procrustes(pts2);
    pl2.rotation.value = 1.2;
    pl2.centroid.value = { x: 100, y: 50 };
    const final2 = pts2.map(p => p.value);

    for (let i = 0; i < pts1.length; i++) {
      expect(vnear(final1[i]!, final2[i]!, 1e-9)).toBe(true);
    }
  });

  it("procrustes: rotate ∘ scale ≡ scale ∘ rotate", () => {
    const pts1 = mkPoints([5, 0], [3, 4], [-2, 1]);
    const pl1 = procrustes(pts1);
    pl1.rotation.value = 0.7;
    pl1.scale.value = 12;
    const final1 = pts1.map(p => p.value);

    const pts2 = mkPoints([5, 0], [3, 4], [-2, 1]);
    const pl2 = procrustes(pts2);
    pl2.scale.value = 12;
    pl2.rotation.value = 0.7;
    const final2 = pts2.map(p => p.value);

    for (let i = 0; i < pts1.length; i++) {
      expect(vnear(final1[i]!, final2[i]!, 1e-9)).toBe(true);
    }
  });

  it("bbox: center ∘ size ≡ size ∘ center", () => {
    const ptsA = mkPoints([0, 0], [10, 5], [4, 8]);
    const a = bbox(ptsA);
    a.center.value = { x: 50, y: 50 };
    a.size.value = { x: 30, y: 40 };
    const fa = ptsA.map(p => p.value);

    const ptsB = mkPoints([0, 0], [10, 5], [4, 8]);
    const b = bbox(ptsB);
    b.size.value = { x: 30, y: 40 };
    b.center.value = { x: 50, y: 50 };
    const fb = ptsB.map(p => p.value);

    for (let i = 0; i < ptsA.length; i++) {
      expect(vnear(fa[i]!, fb[i]!, 1e-9)).toBe(true);
    }
  });
});

// 1000 random writes shouldn't drift to ∞/NaN/singular: closed-form is strictly
// stable.
describe("§6 Long-run stability", () => {
  it("procrustes: 1000 random writes — no drift, finite, on-target", () => {
    const pts = mkPoints([5, 0], [3, 4], [-2, 1]);
    const { centroid, rotation, scale } = procrustes(pts);
    const r = rng(42);
    for (let i = 0; i < 1000; i++) {
      const k = Math.floor(r() * 3);
      if (k === 0) centroid.value = { x: (r() - 0.5) * 200, y: (r() - 0.5) * 200 };
      else if (k === 1) rotation.value = (r() - 0.5) * Math.PI * 4;
      else scale.value = 1 + r() * 50;
    }
    for (const p of pts) {
      expect(Number.isFinite(p.value.x)).toBe(true);
      expect(Number.isFinite(p.value.y)).toBe(true);
    }
    // Last write should still land exactly:
    scale.value = 17;
    expect(near(scale.value, 17, 1e-9)).toBe(true);
  });

  it("bbox: 1000 random writes — stable", () => {
    const pts = mkPoints([0, 0], [10, 5], [4, 8]);
    const { center, size } = bbox(pts);
    const r = rng(7);
    for (let i = 0; i < 1000; i++) {
      if (r() < 0.5) center.value = { x: (r() - 0.5) * 200, y: (r() - 0.5) * 200 };
      else size.value = { x: 1 + r() * 100, y: 1 + r() * 100 };
    }
    for (const p of pts) {
      expect(Number.isFinite(p.value.x)).toBe(true);
      expect(Number.isFinite(p.value.y)).toBe(true);
    }
  });
});

// The bwd policy implies specific input invariants (conservation laws).
describe("§7 Conservation laws", () => {
  it("procrustes centroid-write: pairwise distances preserved", () => {
    const pts = mkPoints([5, 0], [3, 4], [-2, 1]);
    const dists0 = [
      Math.hypot(pts[1]!.value.x - pts[0]!.value.x, pts[1]!.value.y - pts[0]!.value.y),
      Math.hypot(pts[2]!.value.x - pts[0]!.value.x, pts[2]!.value.y - pts[0]!.value.y),
      Math.hypot(pts[2]!.value.x - pts[1]!.value.x, pts[2]!.value.y - pts[1]!.value.y),
    ];
    const { centroid } = procrustes(pts);
    centroid.value = { x: 100, y: 50 };
    const dists1 = [
      Math.hypot(pts[1]!.value.x - pts[0]!.value.x, pts[1]!.value.y - pts[0]!.value.y),
      Math.hypot(pts[2]!.value.x - pts[0]!.value.x, pts[2]!.value.y - pts[0]!.value.y),
      Math.hypot(pts[2]!.value.x - pts[1]!.value.x, pts[2]!.value.y - pts[1]!.value.y),
    ];
    for (let i = 0; i < 3; i++) expect(near(dists1[i]!, dists0[i]!, 1e-9)).toBe(true);
  });

  it("procrustes rotation-write: pairwise distances preserved", () => {
    const pts = mkPoints([5, 0], [3, 4], [-2, 1]);
    const d0 = Math.hypot(pts[1]!.value.x - pts[0]!.value.x, pts[1]!.value.y - pts[0]!.value.y);
    procrustes(pts).rotation.value = 0.9;
    const d1 = Math.hypot(pts[1]!.value.x - pts[0]!.value.x, pts[1]!.value.y - pts[0]!.value.y);
    expect(near(d0, d1, 1e-9)).toBe(true);
  });

  it("procrustes scale-write: pairwise distance ratios preserved", () => {
    const pts = mkPoints([5, 0], [3, 4], [-2, 1]);
    const d01_0 = Math.hypot(pts[1]!.value.x - pts[0]!.value.x, pts[1]!.value.y - pts[0]!.value.y);
    const d02_0 = Math.hypot(pts[2]!.value.x - pts[0]!.value.x, pts[2]!.value.y - pts[0]!.value.y);
    const ratio0 = d01_0 / d02_0;
    procrustes(pts).scale.value = 20;
    const d01_1 = Math.hypot(pts[1]!.value.x - pts[0]!.value.x, pts[1]!.value.y - pts[0]!.value.y);
    const d02_1 = Math.hypot(pts[2]!.value.x - pts[0]!.value.x, pts[2]!.value.y - pts[0]!.value.y);
    expect(near(d01_1 / d02_1, ratio0, 1e-9)).toBe(true);
  });

  it("meanDiff: mean-write preserves diff; diff-write preserves sum", () => {
    const a = num(3);
    const b = num(5);
    const { mean, diff } = meanDiff(a, b);
    const d0 = a.value - b.value;
    mean.value = 100;
    expect(near(a.value - b.value, d0)).toBe(true);
    const s0 = a.value + b.value;
    diff.value = 7;
    expect(near(a.value + b.value, s0)).toBe(true);
  });
});

describe("§8 Edge cases", () => {
  it("procrustes: K=1 throws", () => {
    expect(() => procrustes([vec(0, 0)])).toThrow(/≥ 2 points/);
  });

  it("procrustes: collapsed cluster, scale-write is a no-op", () => {
    const pts = mkPoints([5, 5], [5, 5], [5, 5]);
    const { scale } = procrustes(pts);
    scale.value = 100;
    for (const p of pts) {
      expect(vnear(p.value, { x: 5, y: 5 })).toBe(true);
    }
  });

  it("procrustes: collapsed cluster, rotation-write is a no-op", () => {
    const pts = mkPoints([5, 5], [5, 5], [5, 5]);
    const { rotation } = procrustes(pts);
    rotation.value = 1.0;
    for (const p of pts) {
      expect(vnear(p.value, { x: 5, y: 5 })).toBe(true);
    }
  });

  it("bbox: collinear-on-x points → sx=0 → size.x write is no-op", () => {
    const pts = mkPoints([5, 0], [5, 5], [5, 10]);
    const { size } = bbox(pts);
    size.value = { x: 50, y: 100 };
    // x-axis is degenerate, untouched
    for (const p of pts) expect(p.value.x).toBe(5);
    // y-axis was 10 → scaled to 100 (k = 10) about center (cy=5)
    expect(pts[0]!.value.y).toBeCloseTo(-45, 6);
    expect(pts[1]!.value.y).toBeCloseTo(5, 6);
    expect(pts[2]!.value.y).toBeCloseTo(55, 6);
  });
});
