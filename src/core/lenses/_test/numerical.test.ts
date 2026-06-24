// Generic factor/bundle lens probes: typed authoring, round-trip, approximate
// cross-channel invariance, analytical Jacobian, auto-converge, composition.

import { describe, expect, it } from "vitest";
import { approxWithin } from "../../../_test/_util";
import type { Writable } from "../../index";
import { fieldLens, Num, pose, Vec, vec } from "../../index";
import { bundle, factor, factorTuple } from "../numerical";

const { near, vnear } = approxWithin(1e-4);

const mkPoints = (...pts: [number, number][]): Writable<Vec>[] => pts.map(([x, y]) => vec(x, y));

function iter<T>(cell: Writable<{ value: T; peek(): T }>, target: T, n = 8): void {
  // Iterate writes to converge non-linear Newton-step bwds. Each back-write
  // is demand-gated, so the interleaved read is what resolves (steps) it —
  // a Newton iteration must observe each iterate.
  for (let i = 0; i < n; i++) {
    (cell as unknown as { value: T }).value = target;
    (cell as unknown as { peek(): T }).peek();
  }
}

type V = { x: number; y: number };

// A Procrustes-shaped factor (centroid/rotation/scale of a Vec cloud) built
// from the generic `factor` — the local stand-in the tests drive. The exact,
// closed-form equivalent lives in `point-cloud.ts` as `procrustes`.
function procFactor(points: readonly Writable<Vec>[]) {
  const K = points.length;
  const cx = (p: readonly V[]) => p.reduce((s, v) => s + v.x, 0) / K;
  const cy = (p: readonly V[]) => p.reduce((s, v) => s + v.y, 0) / K;
  return factor(
    points,
    {
      centroid: { Cls: Vec, fwd: (p: readonly V[]) => ({ x: cx(p), y: cy(p) }) },
      rotation: {
        Cls: Num,
        fwd: (p: readonly V[]) => Math.atan2(p[0]!.y - cy(p), p[0]!.x - cx(p)),
      },
      scale: { Cls: Num, fwd: (p: readonly V[]) => Math.hypot(p[0]!.x - cx(p), p[0]!.y - cy(p)) },
    },
    { damping: 1e-3 },
  );
}

describe("§1 Forward correctness", () => {
  it("factor: typed Vec input, Vec + Num outputs", () => {
    const pts = mkPoints([0, 0], [10, 0], [0, 6]);
    const { centroid, rotation, scale } = procFactor(pts);
    expect(centroid.value.x).toBeCloseTo(10 / 3, 9);
    expect(centroid.value.y).toBeCloseTo(2, 9);
    expect(rotation.value).toBeCloseTo(Math.atan2(-2, -10 / 3), 9);
    expect(scale.value).toBeCloseTo(Math.hypot(10 / 3, 2), 9);
  });

  it("bundle: Pose → {position, rotation}", () => {
    const p = pose({ x: 5, y: 10, theta: 0.7 });
    const { position, rotation } = bundle(p, {
      position: {
        Cls: Vec,
        fwd: (s: readonly { x: number; y: number; theta: number }[]) => ({
          x: s[0]!.x,
          y: s[0]!.y,
        }),
      },
      rotation: {
        Cls: Num,
        fwd: (s: readonly { x: number; y: number; theta: number }[]) => s[0]!.theta,
      },
    });
    expect(position.value).toEqual({ x: 5, y: 10 });
    expect(rotation.value).toBeCloseTo(0.7, 9);
  });
});

describe("§2 Round-trip identity (iterated)", () => {
  it("typed factor: Vec output round-trips after a few iters", () => {
    const pts = mkPoints([0, 0], [10, 0], [0, 6]);
    const { centroid } = procFactor(pts);
    iter(centroid, { x: 50, y: 30 });
    expect(centroid.value.x).toBeCloseTo(50, 2);
    expect(centroid.value.y).toBeCloseTo(30, 2);
  });

  it("typed factor: rotation channel converges in ~10 iters", () => {
    const pts = mkPoints([10, 0], [3, 4], [-2, 1]);
    const { rotation } = procFactor(pts);
    iter(rotation, Math.PI / 4, 10);
    expect(rotation.value).toBeCloseTo(Math.PI / 4, 2);
  });

  it("typed factor: scale channel converges", () => {
    const pts = mkPoints([10, 0], [3, 4], [-2, 1]);
    const { scale } = procFactor(pts);
    iter(scale, 20, 10);
    expect(scale.value).toBeCloseTo(20, 1);
  });

  it("bundle Pose: position write lands exact (linear)", () => {
    const p = pose({ x: 0, y: 0, theta: 0 });
    const { position } = bundle(p, {
      position: {
        Cls: Vec,
        fwd: (s: readonly { x: number; y: number; theta: number }[]) => ({
          x: s[0]!.x,
          y: s[0]!.y,
        }),
      },
      rotation: {
        Cls: Num,
        fwd: (s: readonly { x: number; y: number; theta: number }[]) => s[0]!.theta,
      },
    });
    iter(position, { x: 5, y: 7 });
    expect(position.value.x).toBeCloseTo(5, 2);
    expect(position.value.y).toBeCloseTo(7, 2);
  });
});

// Typed-factor invariance is best-effort: the LSQ minimises off-channel leakage
// but doesn't eliminate it; quantify it on a well-conditioned config.
describe("§3 Cross-channel invariance (approximate)", () => {
  it("typed Procrustes: writing centroid leaks rotation/scale slightly", () => {
    const pts = mkPoints([10, 0], [3, 4], [-2, 1]);
    const { centroid, rotation, scale } = procFactor(pts);
    const r0 = rotation.value;
    const s0 = scale.value;
    iter(centroid, { x: 100, y: 50 }, 5);
    const drot = Math.abs(rotation.value - r0);
    const dsc = Math.abs(scale.value - s0);
    expect(drot).toBeLessThan(0.2);
    expect(dsc).toBeLessThan(5);
  });

  it("bundle Pose with independent fields: position and rotation don't leak", () => {
    const p = pose({ x: 0, y: 0, theta: 0 });
    const { position, rotation } = bundle(p, {
      position: {
        Cls: Vec,
        fwd: (s: readonly { x: number; y: number; theta: number }[]) => ({
          x: s[0]!.x,
          y: s[0]!.y,
        }),
      },
      rotation: {
        Cls: Num,
        fwd: (s: readonly { x: number; y: number; theta: number }[]) => s[0]!.theta,
      },
    });
    const r0 = rotation.value;
    iter(position, { x: 50, y: 30 }, 3);
    expect(near(rotation.value, r0, 1e-3)).toBe(true);
    const pos1 = position.value;
    iter(rotation, 1.2, 3);
    expect(vnear(position.value, pos1, 1e-3)).toBe(true);
  });
});

describe("§4 bundle with coupled views", () => {
  it("Pose → {center, span} where span = sqrt(x²+y²) converges", () => {
    // Non-linear coupling: span = ||(x,y)||. The Jacobian path needs
    // iteration; it converges but with characteristic non-linear-Newton
    // overshoot patterns. Use a generous iteration budget to land.
    type P = { x: number; y: number; theta: number };
    const p = pose({ x: 3, y: 4, theta: 0 });
    const { center, span } = bundle(p, {
      center: { Cls: Vec, fwd: (s: readonly P[]) => ({ x: s[0]!.x, y: s[0]!.y }) },
      span: { Cls: Num, fwd: (s: readonly P[]) => Math.hypot(s[0]!.x, s[0]!.y) },
    });
    expect(span.value).toBeCloseTo(5, 9);
    iter(center, { x: 6, y: 8 }, 25);
    expect(center.value.x).toBeCloseTo(6, 0);
    expect(center.value.y).toBeCloseTo(8, 0);
    expect(span.value).toBeCloseTo(10, 0);
  });
});

// Each factor output is `Writable<Cls>`, so `.scale`/`.add`/`field()` etc. work.
describe("§5 Chaining factor outputs", () => {
  it("centroid (Vec) can be field-accessed (.x, .y)", () => {
    const pts = mkPoints([0, 0], [10, 0], [0, 6]);
    const { centroid } = procFactor(pts);
    expect(centroid.x.value).toBeCloseTo(10 / 3, 9);
    expect(centroid.y.value).toBeCloseTo(2, 9);
  });

  it("centroid.add(...) returns a composed lens that round-trips", () => {
    const pts = mkPoints([0, 0], [10, 0], [0, 6]);
    const { centroid } = procFactor(pts);
    const shifted = centroid.add({ x: 100, y: 100 });
    expect(shifted.value.x).toBeCloseTo(10 / 3 + 100, 6);
    expect(shifted.value.y).toBeCloseTo(2 + 100, 6);
    iter(shifted, { x: 150, y: 200 }, 5);
    expect(shifted.value.x).toBeCloseTo(150, 1);
    expect(shifted.value.y).toBeCloseTo(200, 1);
  });

  it("rotation.scale(2) returns a Writable<Num> that round-trips", () => {
    const pts = mkPoints([10, 0], [3, 4], [-2, 1]);
    const { rotation } = procFactor(pts);
    const doubled = rotation.scale(2);
    expect(doubled.value).toBeCloseTo(rotation.value * 2, 6);
    iter(doubled, 1.0, 10);
    expect(doubled.value).toBeCloseTo(1.0, 1);
    expect(rotation.value).toBeCloseTo(0.5, 1);
  });
});

// For LINEAR forwards, an analytical Jacobian eliminates FD overhead AND FD eps
// drift — machine-exact at damping=0.
describe("§6 Analytical Jacobian precision", () => {
  it("linear centroid: analytical-J factor with damping=0 is machine-exact", () => {
    const K = 5;
    const pts: Writable<Vec>[] = [];
    for (let i = 0; i < K; i++) pts.push(vec(i, i * 2));
    const invK = 1 / K;
    const rowCx: number[] = [];
    const rowCy: number[] = [];
    for (let i = 0; i < K; i++) {
      rowCx.push(invK, 0);
      rowCy.push(0, invK);
    }
    const fwd = (p: readonly V[]): V => ({
      x: p.reduce((s, v) => s + v.x, 0) / K,
      y: p.reduce((s, v) => s + v.y, 0) / K,
    });
    // damping=0 → exact LSQ solve when well-conditioned.
    const { centroid: cExact } = factor(
      pts,
      { centroid: { Cls: Vec, fwd, jacobian: () => [rowCx, rowCy] } },
      { damping: 0 },
    );
    // FD path (default eps=1e-5) → ~5e-5 error.
    const ptsC = pts.map(p => vec(p.value.x, p.value.y));
    const { centroid: cFD } = factor(ptsC, { centroid: { Cls: Vec, fwd } });
    cExact.value = { x: 100, y: 50 };
    cFD.value = { x: 100, y: 50 };
    expect(Math.abs(cExact.value.x - 100)).toBeLessThan(1e-12); // machine eps
    expect(Math.abs(cFD.value.x - 100)).toBeLessThan(1e-3); // FD eps drift
  });
});

// converge:true loops the single-Newton-step setter until the reading is within
// tol — 1 iter for linear forwards, 3-25 for non-linear depending on geometry.
describe("§7 Auto-converge", () => {
  it("centroid write with converge:true lands exactly (linear)", () => {
    const K = 3;
    const pts: Writable<Vec>[] = [vec(0, 0), vec(10, 0), vec(5, 7)];
    const { centroid } = factor(
      pts,
      {
        centroid: {
          Cls: Vec,
          fwd: (p: readonly V[]) => ({
            x: (p[0]!.x + p[1]!.x + p[2]!.x) / K,
            y: (p[0]!.y + p[1]!.y + p[2]!.y) / K,
          }),
        },
      },
      { converge: true },
    );
    centroid.value = { x: 100, y: 50 };
    expect(centroid.value.x).toBeCloseTo(100, 3);
    expect(centroid.value.y).toBeCloseTo(50, 3);
  });

  it("Procrustes-style rotation with converge:true lands non-linearly", () => {
    const pts = mkPoints([10, 0], [3, 4], [-2, 1]);
    const cx = (p: readonly V[]) => (p[0]!.x + p[1]!.x + p[2]!.x) / 3;
    const cy = (p: readonly V[]) => (p[0]!.y + p[1]!.y + p[2]!.y) / 3;
    const { rotation } = factor(
      pts,
      {
        centroid: { Cls: Vec, fwd: (p: readonly V[]) => ({ x: cx(p), y: cy(p) }) },
        rotation: {
          Cls: Num,
          fwd: (p: readonly V[]) => Math.atan2(p[0]!.y - cy(p), p[0]!.x - cx(p)),
        },
        scale: {
          Cls: Num,
          fwd: (p: readonly V[]) => Math.hypot(p[0]!.x - cx(p), p[0]!.y - cy(p)),
        },
      },
      { converge: true, damping: 1e-3, maxIters: 20 },
    );
    rotation.value = 1.0;
    expect(rotation.value).toBeCloseTo(1.0, 2);
    rotation.value = -0.5;
    expect(rotation.value).toBeCloseTo(-0.5, 2);
  });
});

describe("§8 Pinned inputs via weights", () => {
  it("inputWeights = 0 freezes specific input scalars", () => {
    const pts = mkPoints([10, 0], [0, 0], [0, 0]);
    // pts has 3 Vecs = 6 flat scalars. Weights: pin index 0 (pts[0].x).
    const weights = [0, 1, 1, 1, 1, 1];
    const { centroid } = factor(
      pts,
      {
        centroid: {
          Cls: Vec,
          fwd: (p: readonly V[]) => ({
            x: (p[0]!.x + p[1]!.x + p[2]!.x) / 3,
            y: (p[0]!.y + p[1]!.y + p[2]!.y) / 3,
          }),
        },
      },
      { inputWeights: weights, damping: 0 },
    );
    iter(centroid, { x: 100, y: 50 }, 5);
    expect(pts[0]!.value.x).toBe(10); // pinned
    expect(centroid.value.x).toBeCloseTo(100, 1);
    expect(centroid.value.y).toBeCloseTo(50, 1);
  });
});

describe("§9 Composition: factor-of-factor & composed-lens inputs", () => {
  it("centroid of one factor feeds into another factor", () => {
    const A = mkPoints([0, 0], [10, 0], [5, 10]);
    const { centroid: cA } = procFactor(A);
    expect(cA.value).toEqual({ x: 5, y: 10 / 3 });

    const extra = vec(20, 20);
    const { centroid: cMeta } = factor([cA, extra] as never, {
      centroid: {
        Cls: Vec,
        fwd: (pts: readonly V[]) => ({
          x: (pts[0]!.x + pts[1]!.x) / 2,
          y: (pts[0]!.y + pts[1]!.y) / 2,
        }),
      },
    });
    expect(cMeta.value.x).toBeCloseTo((5 + 20) / 2, 9);
    expect(cMeta.value.y).toBeCloseTo((10 / 3 + 20) / 2, 9);

    iter(cMeta, { x: 50, y: 50 }, 5);
    expect(cMeta.value.x).toBeCloseTo(50, 1);
    expect(cMeta.value.y).toBeCloseTo(50, 1);
  });

  it("inputs that are themselves field lenses still work", () => {
    const p = pose({ x: 3, y: 7, theta: 1.0 });
    const px = fieldLens(p, "x", Num);
    const py = fieldLens(p, "y", Num);
    const { sum } = factor(
      [px, py] as never,
      {
        sum: {
          Cls: Num,
          fwd: (nums: readonly number[]) => nums[0]! + nums[1]!,
          jacobian: () => [[1, 1]],
        },
      },
      { damping: 0 },
    );
    expect(sum.value).toBeCloseTo(10, 9);
    sum.value = 30;
    // δ = 20, N = 2 → min-norm splits the delta evenly: px 3→13, py 7→17.
    expect(p.value.x).toBeCloseTo(13, 9);
    expect(p.value.y).toBeCloseTo(17, 9);
    expect(p.value.theta).toBeCloseTo(1.0, 9);
  });
});

// Same engine, tuple I/O: TS infers tuple types and runtime semantics match
// the named API.
describe("§10 Positional API (factorTuple)", () => {
  it("destructures with correct types and matching values", () => {
    const pts = mkPoints([0, 0], [10, 0], [0, 6]);
    const cx = (p: readonly V[]) => (p[0]!.x + p[1]!.x + p[2]!.x) / 3;
    const cy = (p: readonly V[]) => (p[0]!.y + p[1]!.y + p[2]!.y) / 3;
    const [centroid, rotation, scale] = factorTuple(pts, [
      { Cls: Vec, fwd: (p: readonly V[]) => ({ x: cx(p), y: cy(p) }) },
      { Cls: Num, fwd: (p: readonly V[]) => Math.atan2(p[0]!.y - cy(p), p[0]!.x - cx(p)) },
      { Cls: Num, fwd: (p: readonly V[]) => Math.hypot(p[0]!.x - cx(p), p[0]!.y - cy(p)) },
    ]);
    expect(centroid.value.x).toBeCloseTo(10 / 3, 9);
    expect(rotation.value).toBeCloseTo(Math.atan2(-2, -10 / 3), 9);
    expect(scale.value).toBeCloseTo(Math.hypot(10 / 3, 2), 9);

    iter(centroid, { x: 50, y: 50 });
    expect(centroid.value.x).toBeCloseTo(50, 2);
    expect(centroid.value.y).toBeCloseTo(50, 2);
  });
});
