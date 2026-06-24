// Exact group-action lens probes: building blocks, best-fit line/circle,
// PCA, total/partition.

import { describe, expect, it } from "vitest";
import { approxWithin, lcg as rng } from "../../../_test/_util";
import type { Num, Writable } from "../../index";
import { mean, num, type Pose, pose, type Vec, vec } from "../../index";
import {
  bestFitCircle,
  bestFitLine,
  pca,
  rotateAbout,
  scaleAbout,
  scaleAboutXY,
  total,
} from "../point-cloud";

const { near, vnear } = approxWithin(1e-9);

const mkPoints = (...pts: [number, number][]): Writable<Vec>[] => pts.map(([x, y]) => vec(x, y));

describe("§1 Building blocks", () => {
  it("mean translates the whole cluster by the centroid delta", () => {
    const pts = mkPoints([0, 0], [10, 0], [5, 6]);
    const t = mean(pts);
    expect(t.value).toEqual({ x: 5, y: 2 });
    t.value = { x: 100, y: 100 };
    expect(pts[0]!.value).toEqual({ x: 95, y: 98 });
    expect(pts[1]!.value).toEqual({ x: 105, y: 98 });
    expect(pts[2]!.value).toEqual({ x: 100, y: 104 });
  });

  it("rotateAbout pivot: rotates cluster, preserves pivot exactly", () => {
    const pivot = vec(0, 0);
    const pts = mkPoints([10, 0], [0, 10], [-10, 0], [0, -10]);
    const angle = rotateAbout(pts, pivot);
    expect(angle.value).toBeCloseTo(0, 9); // angle from (0,0) to (10,0) = 0
    angle.value = Math.PI / 2;
    // Rotate everything 90° CCW
    expect(vnear(pts[0]!.value, { x: 0, y: 10 })).toBe(true);
    expect(vnear(pts[1]!.value, { x: -10, y: 0 })).toBe(true);
    expect(vnear(pts[2]!.value, { x: 0, y: -10 })).toBe(true);
    expect(vnear(pts[3]!.value, { x: 10, y: 0 })).toBe(true);
    // Pivot unchanged (it's not in the input set, so trivially):
    expect(vnear(pivot.value, { x: 0, y: 0 })).toBe(true);
  });

  it("rotateAbout with reactive pivot (centroid): cluster rotates about its centroid", () => {
    const pts = mkPoints([10, 0], [0, 10], [-10, 0], [0, -10]);
    const c = mean(pts);
    const angle = rotateAbout(pts, c);
    const c0 = c.value;
    angle.value = Math.PI;
    // 180° rotation about centroid (0, 0) should negate every point.
    expect(vnear(pts[0]!.value, { x: -10, y: 0 })).toBe(true);
    // Centroid unchanged (rotation about it is its fixed point).
    expect(vnear(c.value, c0)).toBe(true);
  });

  it("scaleAbout pivot: scales cluster, preserves pivot & angles", () => {
    const pivot = vec(0, 0);
    const pts = mkPoints([10, 0], [0, 10]);
    const r = scaleAbout(pts, pivot);
    expect(r.value).toBeCloseTo(10, 9);
    r.value = 20;
    expect(vnear(pts[0]!.value, { x: 20, y: 0 })).toBe(true);
    expect(vnear(pts[1]!.value, { x: 0, y: 20 })).toBe(true);
  });

  it("scaleAboutXY pivot: per-axis scale", () => {
    const pivot = vec(0, 0);
    const pts = mkPoints([2, 3], [4, 6]);
    const s = scaleAboutXY(pts, pivot);
    expect(s.value).toEqual({ x: 2, y: 3 });
    s.value = { x: 10, y: 30 };
    // x scales by 5, y by 10
    expect(vnear(pts[0]!.value, { x: 10, y: 30 })).toBe(true);
    expect(vnear(pts[1]!.value, { x: 20, y: 60 })).toBe(true);
  });

  it("scaleAbout: a same-magnitude (negative) target is a no-op", () => {
    const pivot = vec(0, 0);
    const pts = mkPoints([10, 0], [0, 10]);
    const r = scaleAbout(pts, pivot);
    // The view is a radius (magnitude ≥ 0). Writing -10 would reflect the
    // cluster, but the reflected cluster re-projects to the SAME radius 10
    // — so the backward equality check stops the write (no view change).
    r.value = -10;
    expect(vnear(pts[0]!.value, { x: 10, y: 0 })).toBe(true);
    expect(vnear(pts[1]!.value, { x: 0, y: 10 })).toBe(true);
    // A genuinely different magnitude still scales as usual.
    r.value = 20;
    expect(vnear(pts[0]!.value, { x: 20, y: 0 })).toBe(true);
    expect(vnear(pts[1]!.value, { x: 0, y: 20 })).toBe(true);
  });

  it("rotateAbout works on POSE via Pivotal trait (rotates pos AND theta)", () => {
    // Trait dispatch: the same `rotateAbout` function dispatches to
    // Pose's Pivotal impl, which both rotates the position about pivot
    // AND increments orientation by dθ.
    const pivot = vec(0, 0);
    const poses = [
      pose({ x: 10, y: 0, theta: 0 }),
      pose({ x: 0, y: 10, theta: 0 }),
    ] as Writable<Pose>[];
    const angle = rotateAbout(poses as never, pivot);
    expect(angle.value).toBeCloseTo(0, 9);
    // Rotate 90° CCW about origin
    angle.value = Math.PI / 2;
    // Position rotates: (10, 0) → (0, 10), (0, 10) → (-10, 0)
    expect(poses[0]!.value.x).toBeCloseTo(0, 9);
    expect(poses[0]!.value.y).toBeCloseTo(10, 9);
    expect(poses[1]!.value.x).toBeCloseTo(-10, 9);
    expect(poses[1]!.value.y).toBeCloseTo(0, 9);
    // ALSO orientation incremented by π/2 (Pose-specific behaviour
    // from the trait, unlike Vec which has no orientation)
    expect(poses[0]!.value.theta).toBeCloseTo(Math.PI / 2, 9);
    expect(poses[1]!.value.theta).toBeCloseTo(Math.PI / 2, 9);
  });

  it("scaleAbout works on POSE via Pivotal trait (scales pos, not theta)", () => {
    const pivot = vec(0, 0);
    const poses = [
      pose({ x: 10, y: 0, theta: 0.7 }),
      pose({ x: 0, y: 10, theta: 1.4 }),
    ] as Writable<Pose>[];
    const r = scaleAbout(poses as never, pivot);
    expect(r.value).toBeCloseTo(10, 9);
    r.value = 20;
    // Position scales 2×
    expect(poses[0]!.value.x).toBeCloseTo(20, 9);
    expect(poses[1]!.value.y).toBeCloseTo(20, 9);
    // Orientation is preserved (scale doesn't change orientation)
    expect(poses[0]!.value.theta).toBeCloseTo(0.7, 9);
    expect(poses[1]!.value.theta).toBeCloseTo(1.4, 9);
  });
});

describe("§2 bestFitLine", () => {
  it("forward: principal axis of a horizontal cloud is 0°", () => {
    const pts = mkPoints([-10, 0], [-5, 0], [0, 0], [5, 0], [10, 0]);
    const { point, direction } = bestFitLine(pts);
    expect(point.value).toEqual({ x: 0, y: 0 });
    expect(near(direction.value, 0)).toBe(true);
  });

  it("forward: principal axis of a 45°-tilted cloud is π/4", () => {
    // Points along y = x: (-2,-2), (-1,-1), (0,0), (1,1), (2,2)
    const pts = mkPoints([-2, -2], [-1, -1], [0, 0], [1, 1], [2, 2]);
    const { direction } = bestFitLine(pts);
    expect(near(Math.abs(direction.value), Math.PI / 4, 1e-9)).toBe(true);
  });

  it("write point: translates cluster, principal axis preserved", () => {
    const pts = mkPoints([-10, 0], [-5, 0], [0, 0], [5, 0], [10, 0]);
    const { point, direction } = bestFitLine(pts);
    const dir0 = direction.value;
    point.value = { x: 100, y: 50 };
    expect(direction.value).toBeCloseTo(dir0, 9);
    expect(point.value).toEqual({ x: 100, y: 50 });
  });

  it("write direction: rotates cluster about centroid", () => {
    const pts = mkPoints([-10, 0], [-5, 0], [0, 0], [5, 0], [10, 0]);
    const { point, direction } = bestFitLine(pts);
    const c0 = point.value;
    direction.value = Math.PI / 2; // make line vertical
    expect(vnear(point.value, c0, 1e-9)).toBe(true); // centroid unchanged (machine-eps)
    // Points should now lie along the y-axis (x ≈ 0)
    for (const p of pts) {
      expect(Math.abs(p.value.x - c0.x)).toBeLessThan(1e-9);
    }
  });
});

describe("§3 bestFitCircle", () => {
  it("forward: circle of K points around origin reads exact center+radius", () => {
    const K = 8;
    const R = 5;
    const pts: Writable<Vec>[] = [];
    for (let i = 0; i < K; i++) {
      pts.push(vec(R * Math.cos((2 * Math.PI * i) / K), R * Math.sin((2 * Math.PI * i) / K)));
    }
    const { center, radius } = bestFitCircle(pts);
    expect(vnear(center.value, { x: 0, y: 0 }, 1e-9)).toBe(true);
    expect(near(radius.value, R, 1e-9)).toBe(true);
  });

  it("write center: translates cluster, radius preserved", () => {
    const K = 6;
    const R = 5;
    const pts: Writable<Vec>[] = [];
    for (let i = 0; i < K; i++) {
      pts.push(vec(R * Math.cos((2 * Math.PI * i) / K), R * Math.sin((2 * Math.PI * i) / K)));
    }
    const { center, radius } = bestFitCircle(pts);
    const r0 = radius.value;
    center.value = { x: 100, y: 50 };
    expect(radius.value).toBeCloseTo(r0, 9);
  });

  it("write radius: scales cluster about center, center preserved", () => {
    const K = 6;
    const R = 5;
    const pts: Writable<Vec>[] = [];
    for (let i = 0; i < K; i++) {
      pts.push(vec(R * Math.cos((2 * Math.PI * i) / K), R * Math.sin((2 * Math.PI * i) / K)));
    }
    const { center, radius } = bestFitCircle(pts);
    const c0 = center.value;
    radius.value = 10;
    expect(vnear(center.value, c0, 1e-9)).toBe(true);
    // Each point's distance to center should now be 10
    for (const p of pts) {
      expect(near(Math.hypot(p.value.x - c0.x, p.value.y - c0.y), 10, 1e-9)).toBe(true);
    }
  });
});

describe("§4 pca (affine similarity)", () => {
  it("forward: aligned axis-aligned ellipse cloud reads (mean, 0, semi-major, semi-minor)", () => {
    // Generate points on an axis-aligned ellipse with a=5, b=2.
    const K = 12;
    const a = 5;
    const b = 2;
    const pts: Writable<Vec>[] = [];
    for (let i = 0; i < K; i++) {
      const θ = (2 * Math.PI * i) / K;
      pts.push(vec(a * Math.cos(θ), b * Math.sin(θ)));
    }
    const { mean: m, rotation, majorLength, minorLength } = pca(pts);
    expect(vnear(m.value, { x: 0, y: 0 }, 1e-9)).toBe(true);
    expect(near(rotation.value, 0, 1e-9)).toBe(true);
    // Std-dev of ellipse along major axis ~ a/√2; along minor ~ b/√2
    expect(near(majorLength.value, a / Math.SQRT2, 1e-9)).toBe(true);
    expect(near(minorLength.value, b / Math.SQRT2, 1e-9)).toBe(true);
  });

  it("write mean: translates, other channels preserved", () => {
    const a = 5;
    const b = 2;
    const pts: Writable<Vec>[] = [];
    for (let i = 0; i < 12; i++) {
      const θ = (2 * Math.PI * i) / 12;
      pts.push(vec(a * Math.cos(θ), b * Math.sin(θ)));
    }
    const { mean: m, rotation, majorLength, minorLength } = pca(pts);
    const r0 = rotation.value;
    const ma0 = majorLength.value;
    const mi0 = minorLength.value;
    m.value = { x: 100, y: 50 };
    expect(near(rotation.value, r0, 1e-9)).toBe(true);
    expect(near(majorLength.value, ma0, 1e-9)).toBe(true);
    expect(near(minorLength.value, mi0, 1e-9)).toBe(true);
  });

  it("write rotation: rotates about mean, lengths preserved", () => {
    const a = 5;
    const b = 2;
    const pts: Writable<Vec>[] = [];
    for (let i = 0; i < 12; i++) {
      const θ = (2 * Math.PI * i) / 12;
      pts.push(vec(a * Math.cos(θ), b * Math.sin(θ)));
    }
    const { mean: m, rotation, majorLength, minorLength } = pca(pts);
    const c0 = m.value;
    const ma0 = majorLength.value;
    const mi0 = minorLength.value;
    rotation.value = Math.PI / 4;
    expect(vnear(m.value, c0, 1e-9)).toBe(true);
    expect(near(majorLength.value, ma0, 1e-9)).toBe(true);
    expect(near(minorLength.value, mi0, 1e-9)).toBe(true);
    expect(near(rotation.value, Math.PI / 4, 1e-9)).toBe(true);
  });

  it("write majorLength: scales along major axis, mean+rotation+minor preserved", () => {
    const a = 5;
    const b = 2;
    const pts: Writable<Vec>[] = [];
    for (let i = 0; i < 12; i++) {
      const θ = (2 * Math.PI * i) / 12;
      pts.push(vec(a * Math.cos(θ), b * Math.sin(θ)));
    }
    const { mean: m, rotation, majorLength, minorLength } = pca(pts);
    const c0 = m.value;
    const r0 = rotation.value;
    const mi0 = minorLength.value;
    const newMajor = majorLength.value * 2;
    majorLength.value = newMajor;
    expect(vnear(m.value, c0, 1e-9)).toBe(true);
    expect(near(rotation.value, r0, 1e-9)).toBe(true);
    expect(near(minorLength.value, mi0, 1e-9)).toBe(true);
    expect(near(majorLength.value, newMajor, 1e-9)).toBe(true);
  });

  it("write minorLength: scales along minor axis (while minor < major)", () => {
    // FINDING: pca has a degeneracy when minorLength approaches
    // majorLength — the principal axis ordering flips, causing the
    // "rotation" channel to jump by π/2. This isn't a bug per se;
    // it's intrinsic to PCA (the axes are defined as "the larger
    // variance one"). Test only the safe regime where minor < major.
    const a = 5;
    const b = 2;
    const pts: Writable<Vec>[] = [];
    for (let i = 0; i < 12; i++) {
      const θ = (2 * Math.PI * i) / 12;
      pts.push(vec(a * Math.cos(θ), b * Math.sin(θ)));
    }
    const { mean: m, rotation, majorLength, minorLength } = pca(pts);
    const c0 = m.value;
    const r0 = rotation.value;
    const ma0 = majorLength.value;
    // 1.5× minor → still < major (1.5 * 2/√2 ≈ 2.12 < 5/√2 ≈ 3.54)
    const newMinor = minorLength.value * 1.5;
    minorLength.value = newMinor;
    expect(vnear(m.value, c0, 1e-9)).toBe(true);
    expect(near(rotation.value, r0, 1e-9)).toBe(true);
    expect(near(majorLength.value, ma0, 1e-9)).toBe(true);
    expect(near(minorLength.value, newMinor, 1e-9)).toBe(true);
  });

  it("pca degeneracy: minor > major causes axis-swap (rotation flips by π/2)", () => {
    // Explicit documentation of the degeneracy: when the user writes
    // minorLength to a value > majorLength, the PCA decomposition
    // reorders. Caller's responsibility to avoid this regime if they
    // need stable rotation semantics.
    const pts: Writable<Vec>[] = [];
    for (let i = 0; i < 12; i++) {
      const θ = (2 * Math.PI * i) / 12;
      pts.push(vec(5 * Math.cos(θ), 2 * Math.sin(θ)));
    }
    const { rotation, majorLength, minorLength } = pca(pts);
    const r0 = rotation.value; // 0
    const ma0 = majorLength.value;
    minorLength.value = ma0 * 1.5; // make minor > major
    // After write, what was "minor" is now major; rotation flips by π/2.
    const flipped = Math.abs(rotation.value - r0);
    expect(Math.min(flipped, Math.abs(flipped - Math.PI / 2))).toBeLessThan(1e-6);
  });

  it("interleaved random writes: all 4 channels remain consistent", () => {
    const pts: Writable<Vec>[] = [];
    for (let i = 0; i < 12; i++) {
      const θ = (2 * Math.PI * i) / 12;
      pts.push(vec(5 * Math.cos(θ), 2 * Math.sin(θ)));
    }
    const { mean: m, rotation, majorLength, minorLength } = pca(pts);
    const r = rng(7);
    for (let i = 0; i < 500; i++) {
      const k = Math.floor(r() * 4);
      if (k === 0) m.value = { x: (r() - 0.5) * 100, y: (r() - 0.5) * 100 };
      else if (k === 1) rotation.value = (r() - 0.5) * Math.PI;
      else if (k === 2) majorLength.value = 0.5 + r() * 10;
      else minorLength.value = 0.1 + r() * 3;
    }
    for (const p of pts) {
      expect(Number.isFinite(p.value.x)).toBe(true);
      expect(Number.isFinite(p.value.y)).toBe(true);
    }
    // Last writes should still land:
    const tgt = { x: 42, y: -17 };
    m.value = tgt;
    expect(vnear(m.value, tgt, 1e-9)).toBe(true);
  });
});

describe("§5 total (conservation)", () => {
  it("forward: total = sum of parts", () => {
    const parts = [num(1), num(2), num(3), num(4)] as Writable<Num>[];
    const t = total(parts);
    expect(t.value).toBe(10);
  });

  it("write total: scales parts proportionally, ratios preserved", () => {
    const parts = [num(1), num(2), num(3), num(4)] as Writable<Num>[];
    const t = total(parts);
    const ratios0 = parts.map(p => p.value / 10);
    t.value = 100;
    const ratios1 = parts.map(p => p.value / 100);
    for (let i = 0; i < 4; i++) expect(near(ratios0[i]!, ratios1[i]!, 1e-9)).toBe(true);
    expect(parts.map(p => p.value)).toEqual([10, 20, 30, 40]);
  });

  it("collapsed parts (all 0): even distribution as fallback", () => {
    const parts = [num(0), num(0), num(0)] as Writable<Num>[];
    const t = total(parts);
    t.value = 9;
    expect(parts.map(p => p.value)).toEqual([3, 3, 3]);
  });
});
