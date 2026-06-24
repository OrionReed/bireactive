// Exact group-action lenses for point clouds. The backward pass applies a
// group element (translate / rotate / scale about a pivot) to the whole
// source set, so the fits below (bestFitLine, bestFitCircle, pca, procrustes)
// are exact and cross-channel invariant.

import {
  type Cell,
  Num,
  type Pivotal,
  type Read,
  SKIP,
  type Traits,
  Vec,
  type Writable,
} from "../index";
import { mean } from "./aggregates";
import { continuous, remember } from "./memory";

type V = { x: number; y: number };

// Pivotal trait lookup via the value class's `static traits.pivotal` slot.
// biome-ignore lint/suspicious/noExplicitAny: dynamic trait lookup
function pivotalOf<T>(input: Writable<any>): Pivotal<T> {
  // biome-ignore lint/suspicious/noExplicitAny: dynamic class lookup
  const Cls = (input as any).constructor as { traits?: { pivotal?: Pivotal<T> } };
  const p = Cls.traits?.pivotal;
  if (!p) {
    const name = (Cls as { name?: string }).name ?? "?";
    throw new Error(`point-cloud: ${name} has no traits.pivotal`);
  }
  return p;
}

/** Writable angle from `pivot` to `points[0]`; write rotates every input
 *  about `pivot` by (target − current) via its `Pivotal` trait (Vec rotates
 *  position, Pose also rotates orientation). `pivot` is reactive; pass
 *  `mean(points)` to rotate about the cluster's own centroid. */
export function rotateAbout<T extends { x: number; y: number }>(
  points: readonly Writable<Traits<T, "pivotal"> & Cell<T>>[],
  pivot: Read<V>,
): Writable<Num> {
  const K = points.length;
  if (K < 1) throw new Error("rotateAbout: need ≥ 1 point");
  const pv = pivotalOf<T>(points[0]!);
  return Num.lens(
    points as never,
    (vals: readonly T[]) => {
      const p = pivot.peek();
      return Math.atan2(vals[0]!.y - p.y, vals[0]!.x - p.x);
    },
    (target: number, vals: readonly T[]) => {
      const p = pivot.peek();
      const rx0 = vals[0]!.x - p.x;
      const ry0 = vals[0]!.y - p.y;
      if (rx0 * rx0 + ry0 * ry0 < 1e-24) {
        return vals.map(() => SKIP) as never;
      }
      const oldθ = Math.atan2(ry0, rx0);
      const dθ = target - oldθ;
      const out = new Array<T>(K);
      for (let i = 0; i < K; i++) out[i] = pv.rotateAbout(vals[i]!, p, dθ);
      return out as never;
    },
  );
}

/** Writable radial distance from pivot to `points[0]`; write scales every
 *  input radially about `pivot` (negative target reflects). The complement
 *  carries per-point offsets from the pivot, so a collapse onto it (radius
 *  ≈ 0) reinflates from the stored shape. Pose `theta` survives. */
export function scaleAbout<T extends { x: number; y: number }>(
  points: readonly Writable<Traits<T, "pivotal"> & Cell<T>>[],
  pivot: Read<V>,
): Writable<Num> {
  const K = points.length;
  if (K < 1) throw new Error("scaleAbout: need ≥ 1 point");
  // Eager lookup so an undeclared class fails at construction:
  pivotalOf<T>(points[0]!);

  // Complement: per-point offset from the pivot at the last non-degenerate
  // state. `step` refreshes each from the live source (keeping the last
  // good one for a collapsed point); `bwd` scales them to the target radius.
  type C = { devs: V[] };
  const refresh = (devs: V[], vals: readonly T[], p: V): V[] =>
    devs.map((d, i) => {
      const dx = vals[i]!.x - p.x;
      const dy = vals[i]!.y - p.y;
      return dx * dx + dy * dy > 1e-18 ? { x: dx, y: dy } : d;
    });

  // biome-ignore lint/suspicious/noExplicitAny: variance escape — spec is checked structurally
  return (Num as any).lens(points as unknown as readonly Writable<Cell<T>>[], {
    init: (vals: readonly T[]): C => {
      const p = pivot.peek();
      return { devs: vals.map(v => ({ x: v.x - p.x, y: v.y - p.y })) };
    },
    step: (vals: readonly T[], c: C): C => ({ devs: refresh(c.devs, vals, pivot.peek()) }),
    fwd: (vals: readonly T[]): number => {
      const p = pivot.peek();
      return Math.hypot(vals[0]!.x - p.x, vals[0]!.y - p.y);
    },
    bwd: (target: number, vals: readonly T[], c: C) => {
      const p = pivot.peek();
      // Lossy magnitude view: |−r| = r, so a same-magnitude target
      // re-projects to the current radius and is absorbed (sources put).
      const rNow = Math.hypot(vals[0]!.x - p.x, vals[0]!.y - p.y);
      if (Math.abs(target) === rNow) return { updates: vals.map(() => SKIP), complement: c };
      const d0 = c.devs[0]!;
      const r0 = Math.hypot(d0.x, d0.y);
      if (r0 < 1e-12) return { updates: vals.map(() => SKIP), complement: c };
      const k = target / r0;
      const out = vals.map((v, i) => ({
        ...v,
        x: p.x + k * c.devs[i]!.x,
        y: p.y + k * c.devs[i]!.y,
      }));
      return { updates: out, complement: c };
    },
  }) as Writable<Num>;
}

/** Per-axis scale about a pivot (Vec-specific). The complement carries
 *  per-point per-axis fractions of point 0's offset, so a per-axis collapse
 *  is recoverable. */
export function scaleAboutXY(points: readonly Writable<Vec>[], pivot: Read<V>): Writable<Vec> {
  const K = points.length;
  if (K < 1) throw new Error("scaleAboutXY: need ≥ 1 point");

  // Complement: per-point per-axis fraction of point 0's offset from the
  // pivot, refreshed per non-degenerate axis. `bwd` places point i at
  // `pivot + (fx_i·target.x, fy_i·target.y)`.
  type C = { fracs: V[] };
  const refresh = (fracs: V[], vals: readonly V[], p: V): V[] => {
    const ox = vals[0]!.x - p.x;
    const oy = vals[0]!.y - p.y;
    const okx = Math.abs(ox) > 1e-12;
    const oky = Math.abs(oy) > 1e-12;
    return fracs.map((f, i) => ({
      x: okx ? (vals[i]!.x - p.x) / ox : f.x,
      y: oky ? (vals[i]!.y - p.y) / oy : f.y,
    }));
  };

  return Vec.lens(points, {
    init: (vals: readonly V[]): C => {
      const p = pivot.peek();
      const ox = vals[0]!.x - p.x;
      const oy = vals[0]!.y - p.y;
      return {
        fracs: vals.map(v => ({
          x: Math.abs(ox) > 1e-12 ? (v.x - p.x) / ox : 0,
          y: Math.abs(oy) > 1e-12 ? (v.y - p.y) / oy : 0,
        })),
      };
    },
    step: (vals: readonly V[], c: C): C => ({ fracs: refresh(c.fracs, vals, pivot.peek()) }),
    fwd: (vals: readonly V[]): V => {
      const p = pivot.peek();
      return { x: vals[0]!.x - p.x, y: vals[0]!.y - p.y };
    },
    bwd: (target: V, _vals: readonly V[], c: C) => {
      const p = pivot.peek();
      const out = c.fracs.map(f => ({ x: p.x + f.x * target.x, y: p.y + f.y * target.y }));
      return { updates: out, complement: c };
    },
  });
}

/** Angle of the dominant eigenvector of symmetric 2×2 [[cxx,cxy],[cxy,cyy]]. */
function dominantAxisAngle(cxx: number, cxy: number, cyy: number): number {
  return 0.5 * Math.atan2(2 * cxy, cxx - cyy);
}

function covariance(
  points: readonly V[],
  cx: number,
  cy: number,
): { cxx: number; cxy: number; cyy: number } {
  const K = points.length;
  let cxx = 0;
  let cxy = 0;
  let cyy = 0;
  for (let i = 0; i < K; i++) {
    const dx = points[i]!.x - cx;
    const dy = points[i]!.y - cy;
    cxx += dx * dx;
    cxy += dx * dy;
    cyy += dy * dy;
  }
  return { cxx: cxx / K, cxy: cxy / K, cyy: cyy / K };
}

/** K points → {point: centroid, direction: principal-axis angle}. Writing
 *  `point` translates; writing `direction` rotates all about the centroid. */
export function bestFitLine(points: readonly Writable<Vec>[]): {
  point: Writable<Vec>;
  direction: Writable<Num>;
} {
  const K = points.length;
  if (K < 2) throw new Error("bestFitLine: need ≥ 2 points");

  const point = mean(points);

  // Axis angle is an eigenvector direction (defined up to sign), so the raw
  // atan2 jumps by π as the cloud rotates; `continuous` (period π) tracks the
  // last emitted angle to stay continuous, freezing on a collapsed cloud.
  // Centroid + dominant-axis raw angle; `degenerate` when covariance vanishes.
  const axisOf = (
    vals: readonly V[],
  ): { cx: number; cy: number; rawθ: number; degenerate: boolean } => {
    let sx = 0;
    let sy = 0;
    for (let i = 0; i < K; i++) {
      sx += vals[i]!.x;
      sy += vals[i]!.y;
    }
    const cx = sx / K;
    const cy = sy / K;
    const { cxx, cxy, cyy } = covariance(vals, cx, cy);
    if (cxx + cyy < 1e-18) return { cx, cy, rawθ: 0, degenerate: true };
    return { cx, cy, rawθ: dominantAxisAngle(cxx, cxy, cyy), degenerate: false };
  };

  const direction = continuous(points, {
    period: Math.PI,
    raw: (vals: readonly V[]) => {
      const { rawθ, degenerate } = axisOf(vals);
      return { value: rawθ, defined: !degenerate };
    },
    apply: (target: number, vals: readonly V[], current: number) => {
      const { cx, cy } = axisOf(vals);
      const dθ = target - current;
      const cos = Math.cos(dθ);
      const sin = Math.sin(dθ);
      const out = new Array<V>(K);
      for (let i = 0; i < K; i++) {
        const rx = vals[i]!.x - cx;
        const ry = vals[i]!.y - cy;
        out[i] = { x: cx + cos * rx - sin * ry, y: cy + sin * rx + cos * ry };
      }
      return out;
    },
  });

  return { point, direction };
}

/** K points → {center: centroid, radius: mean distance from center}. Writing
 *  `center` translates; writing `radius` scales all about the center. */
export function bestFitCircle(points: readonly Writable<Vec>[]): {
  center: Writable<Vec>;
  radius: Writable<Num>;
} {
  const K = points.length;
  if (K < 1) throw new Error("bestFitCircle: need ≥ 1 point");

  const center = mean(points);

  // Radius = mean distance from the centroid; writing it scales the cluster
  // about the centroid, and a collapse (mean → 0) reinflates the remembered
  // shape — exactly `remember`'s magnitude view, anchored at the centroid.
  const centroidOf = (vals: readonly V[]): V => {
    let sx = 0;
    let sy = 0;
    for (let i = 0; i < K; i++) {
      sx += vals[i]!.x;
      sy += vals[i]!.y;
    }
    return { x: sx / K, y: sy / K };
  };
  const meanRadius = (vals: readonly V[], c: V): number => {
    let sum = 0;
    for (let i = 0; i < K; i++) sum += Math.hypot(vals[i]!.x - c.x, vals[i]!.y - c.y);
    return sum / K;
  };

  const radius = remember(points, {
    anchor: (vals: readonly V[]) => centroidOf(vals),
    feature: (vals: readonly V[], c: V) => meanRadius(vals, c),
  });

  return { center, radius };
}

/** K points → {mean: centroid, rotation: dominant-eigenvector angle,
 *  majorLength/minorLength: per-axis std-devs (√λ)}. Each write is a single
 *  group action about the mean, so all pairs are cross-channel invariant. */
export function pca(points: readonly Writable<Vec>[]): {
  mean: Writable<Vec>;
  rotation: Writable<Num>;
  majorLength: Writable<Num>;
  minorLength: Writable<Num>;
} {
  const K = points.length;
  if (K < 2) throw new Error("pca: need ≥ 2 points");

  const meanCell = mean(points);

  // 2×2 symmetric eigendecomp → {θ, λ_major, λ_minor}; null when fully
  // collapsed (λ_major ≈ 0).
  const decompose = (
    vals: readonly V[],
  ): {
    cx: number;
    cy: number;
    θ: number;
    lambdaMajor: number;
    lambdaMinor: number;
  } | null => {
    let sx = 0;
    let sy = 0;
    for (let i = 0; i < K; i++) {
      sx += vals[i]!.x;
      sy += vals[i]!.y;
    }
    const cx = sx / K;
    const cy = sy / K;
    const { cxx, cxy, cyy } = covariance(vals, cx, cy);
    const tr = cxx + cyy;
    const disc = Math.sqrt((cxx - cyy) * (cxx - cyy) + 4 * cxy * cxy);
    const lambdaMajor = (tr + disc) / 2;
    const lambdaMinor = (tr - disc) / 2;
    if (lambdaMajor < 1e-24) return null;
    const θ = 0.5 * Math.atan2(2 * cxy, cxx - cyy);
    return { cx, cy, θ, lambdaMajor, lambdaMinor };
  };

  const rotation = Num.lens(
    points,
    (vals: readonly V[]) => decompose(vals)?.θ ?? 0,
    (target: number, vals: readonly V[]) => {
      const d = decompose(vals);
      if (!d) return vals.map((): typeof SKIP => SKIP);
      const dθ = target - d.θ;
      const cos = Math.cos(dθ);
      const sin = Math.sin(dθ);
      const out = new Array<V>(K);
      for (let i = 0; i < K; i++) {
        const rx = vals[i]!.x - d.cx;
        const ry = vals[i]!.y - d.cy;
        out[i] = { x: d.cx + cos * rx - sin * ry, y: d.cy + sin * rx + cos * ry };
      }
      return out;
    },
  );

  // Scale by k along axis (ux, uy): project each point onto (u, u_perp),
  // scale the u component, project back. Relative to mean.
  const scaleAlongAxis = (
    vals: readonly V[],
    cx: number,
    cy: number,
    ux: number,
    uy: number,
    k: number,
  ): V[] => {
    const vx = -uy;
    const vy = ux;
    const out = new Array<V>(K);
    for (let i = 0; i < K; i++) {
      const rx = vals[i]!.x - cx;
      const ry = vals[i]!.y - cy;
      const a = rx * ux + ry * uy;
      const b = rx * vx + ry * vy;
      const ap = a * k;
      out[i] = { x: cx + ap * ux + b * vx, y: cy + ap * uy + b * vy };
    }
    return out;
  };

  // majorLength / minorLength: complement carries the axis basis and
  // per-point projections (normalized by the std-devs) at the last
  // non-degenerate state, so an axis collapse (λ → 0) reinflates from the
  // stored geometry. Non-degenerate writes take the scaleAlongAxis fast path.
  const buildAxisLens = (which: "major" | "minor") => {
    type AxisC = {
      uX: number;
      uY: number; // unit axis of THIS lens
      vX: number;
      vY: number; // unit perpendicular axis
      lenThis: number; // last known √λ on THIS axis
      lenOther: number; // last known √λ on the other axis
      projThis: number[]; // dev·u / lenThis, per point
      projOther: number[]; // dev·v / lenOther, per point
    };

    // Decompose and rebuild the axis basis + normalized projections;
    // returns the prior complement when fully collapsed.
    const axisFrom = (
      d: NonNullable<ReturnType<typeof decompose>>,
      c: AxisC,
      vals: readonly V[],
    ): AxisC => {
      const ux = which === "major" ? Math.cos(d.θ) : -Math.sin(d.θ);
      const uy = which === "major" ? Math.sin(d.θ) : Math.cos(d.θ);
      const vx = -uy;
      const vy = ux;
      const lenThis = Math.sqrt(Math.max(0, which === "major" ? d.lambdaMajor : d.lambdaMinor));
      const lenOther = Math.sqrt(Math.max(0, which === "major" ? d.lambdaMinor : d.lambdaMajor));
      // Only refresh projections on axes that aren't collapsed.
      const invThis = lenThis > 1e-12 ? 1 / lenThis : null;
      const invOther = lenOther > 1e-12 ? 1 / lenOther : null;
      const projThis = c.projThis.slice();
      const projOther = c.projOther.slice();
      for (let i = 0; i < K; i++) {
        const dx = vals[i]!.x - d.cx;
        const dy = vals[i]!.y - d.cy;
        if (invThis !== null) projThis[i] = (dx * ux + dy * uy) * invThis;
        if (invOther !== null) projOther[i] = (dx * vx + dy * vy) * invOther;
      }
      return { uX: ux, uY: uy, vX: vx, vY: vy, lenThis, lenOther, projThis, projOther };
    };

    return Num.lens(points, {
      init: (vals: readonly V[]): AxisC => {
        const seed: AxisC = {
          uX: 1,
          uY: 0,
          vX: 0,
          vY: 1,
          lenThis: 0,
          lenOther: 0,
          projThis: vals.map(() => 0),
          projOther: vals.map(() => 0),
        };
        const d = decompose(vals);
        return d ? axisFrom(d, seed, vals) : seed;
      },
      step: (vals: readonly V[], c: AxisC): AxisC => {
        const d = decompose(vals);
        return d ? axisFrom(d, c, vals) : c;
      },
      fwd: (vals: readonly V[], c: AxisC): number => (decompose(vals) ? c.lenThis : 0),
      bwd: (target: number, vals: readonly V[], c: AxisC) => {
        const d = decompose(vals);
        if (d && c.lenThis > 1e-12) {
          // Lossy magnitude view: a same-magnitude target re-projects to
          // the current axis length and is absorbed (cluster left put).
          if (Math.abs(target) === c.lenThis)
            return { updates: vals.map((): typeof SKIP => SKIP), complement: c };
          // Non-degenerate fast path: scale current cluster along axis. The scale
          // sets the axis length to |target|, so the complement is consistent
          // without a post-write `step` (the engine no longer re-steps own writes).
          const k = target / c.lenThis;
          return {
            updates: scaleAlongAxis(vals, d.cx, d.cy, c.uX, c.uY, k),
            complement: { ...c, lenThis: Math.abs(target) },
          };
        }
        // Degenerate: reconstruct from complement. Centroid still
        // derivable from current source (mean translates always work).
        let sx = 0;
        let sy = 0;
        for (let i = 0; i < K; i++) {
          sx += vals[i]!.x;
          sy += vals[i]!.y;
        }
        const cx = sx / K;
        const cy = sy / K;
        const out = new Array<V>(K);
        for (let i = 0; i < K; i++) {
          const a = c.projThis[i]! * target;
          const b = c.projOther[i]! * c.lenOther;
          out[i] = { x: cx + a * c.uX + b * c.vX, y: cy + a * c.uY + b * c.vY };
        }
        return { updates: out, complement: { ...c, lenThis: Math.abs(target) } };
      },
    });
  };

  const majorLength = buildAxisLens("major");
  const minorLength = buildAxisLens("minor");

  return { mean: meanCell, rotation, majorLength, minorLength };
}

/** Writable total over K parts; write scales all parts proportionally,
 *  preserving their ratios. A collapse to zero reinflates the stored ratios,
 *  seeded uniform so an all-zero start splits evenly. */
export function total(parts: readonly Writable<Num>[]): Writable<Num> {
  const K = parts.length;
  if (K < 1) throw new Error("total: need ≥ 1 part");
  return remember(parts, {
    anchor: () => 0,
    feature: (vals: readonly number[]) => {
      let s = 0;
      for (let i = 0; i < K; i++) s += vals[i]!;
      return s;
    },
    magnitude: false,
    seed: () => parts.map(() => 1 / K),
  });
}

/** K Vecs → {centroid, rotation (angle of point[0] about centroid), scale
 *  (its distance from centroid)}. Each write is a closed-form transform about
 *  the centroid (translate / rotate / scale), so the three are cross-channel
 *  invariant. A collapsed cluster makes rotation singular and scale a no-op. */
export function procrustes(points: readonly Writable<Vec>[]): {
  centroid: Writable<Vec>;
  rotation: Writable<Num>;
  scale: Writable<Num>;
} {
  const K = points.length;
  if (K < 2) throw new Error("procrustes: need ≥ 2 points");

  const centroid = Vec.lens(
    points,
    (vals: readonly V[]) => {
      let sx = 0;
      let sy = 0;
      for (let i = 0; i < K; i++) {
        sx += vals[i]!.x;
        sy += vals[i]!.y;
      }
      return { x: sx / K, y: sy / K };
    },
    (target: V, vals: readonly V[]) => {
      let sx = 0;
      let sy = 0;
      for (let i = 0; i < K; i++) {
        sx += vals[i]!.x;
        sy += vals[i]!.y;
      }
      const dx = target.x - sx / K;
      const dy = target.y - sy / K;
      const out = new Array<V>(K);
      for (let i = 0; i < K; i++) out[i] = { x: vals[i]!.x + dx, y: vals[i]!.y + dy };
      return out;
    },
  );

  const rotation = Num.lens(
    points,
    (vals: readonly V[]) => {
      let sx = 0;
      let sy = 0;
      for (let i = 0; i < K; i++) {
        sx += vals[i]!.x;
        sy += vals[i]!.y;
      }
      const cx = sx / K;
      const cy = sy / K;
      return Math.atan2(vals[0]!.y - cy, vals[0]!.x - cx);
    },
    (target: number, vals: readonly V[]) => {
      let sx = 0;
      let sy = 0;
      for (let i = 0; i < K; i++) {
        sx += vals[i]!.x;
        sy += vals[i]!.y;
      }
      const cx = sx / K;
      const cy = sy / K;
      const rx0 = vals[0]!.x - cx;
      const ry0 = vals[0]!.y - cy;
      if (rx0 * rx0 + ry0 * ry0 < 1e-24) {
        // Collapsed cluster; no angle to rotate from.
        return vals.map((): typeof SKIP => SKIP);
      }
      const oldθ = Math.atan2(ry0, rx0);
      const dθ = target - oldθ;
      const cos = Math.cos(dθ);
      const sin = Math.sin(dθ);
      const out = new Array<V>(K);
      for (let i = 0; i < K; i++) {
        const rx = vals[i]!.x - cx;
        const ry = vals[i]!.y - cy;
        out[i] = { x: cx + cos * rx - sin * ry, y: cy + sin * rx + cos * ry };
      }
      return out;
    },
  );

  // Complement: per-point deviations from the centroid at the last
  // non-degenerate state. View is point 0's radius; writing T places each
  // point at `centroid + (T/|dev_0|) * dev_i`, so a collapse to the
  // centroid recovers from the stored shape. `step` refreshes each offset
  // (keeping the last good one for a collapsed point).
  type C = { devs: V[] };
  const centroidOf = (vals: readonly V[]): V => {
    let sx = 0;
    let sy = 0;
    for (let i = 0; i < K; i++) {
      sx += vals[i]!.x;
      sy += vals[i]!.y;
    }
    return { x: sx / K, y: sy / K };
  };
  const refreshDevs = (devs: V[], vals: readonly V[]): V[] => {
    const c = centroidOf(vals);
    return devs.map((d, i) => {
      const dx = vals[i]!.x - c.x;
      const dy = vals[i]!.y - c.y;
      return dx * dx + dy * dy > 1e-18 ? { x: dx, y: dy } : d;
    });
  };

  const scale = Num.lens(points, {
    init: (vals: readonly V[]): C => {
      const c = centroidOf(vals);
      return { devs: vals.map(v => ({ x: v.x - c.x, y: v.y - c.y })) };
    },
    step: (vals: readonly V[], c: C): C => ({ devs: refreshDevs(c.devs, vals) }),
    fwd: (vals: readonly V[]): number => {
      const c = centroidOf(vals);
      return Math.hypot(vals[0]!.x - c.x, vals[0]!.y - c.y);
    },
    bwd: (target: number, vals: readonly V[], c: C) => {
      const cen = centroidOf(vals);
      const d0 = c.devs[0]!;
      const r0 = Math.hypot(d0.x, d0.y);
      if (r0 < 1e-12) return { updates: vals.map((): typeof SKIP => SKIP), complement: c };
      const k = target / r0;
      const out = c.devs.map(d => ({ x: cen.x + k * d.x, y: cen.y + k * d.y }));
      return { updates: out, complement: c };
    },
  });

  return { centroid, rotation, scale };
}

/** K Vecs → {center, size} of the axis-aligned bounding box. Writing `center`
 *  translates; writing `size` scales all about the center per-axis. Degenerate
 *  axes (size = 0) write as no-ops; negative size reflects. */
export function bbox(points: readonly Writable<Vec>[]): {
  center: Writable<Vec>;
  size: Writable<Vec>;
} {
  const K = points.length;
  if (K < 1) throw new Error("bbox: need ≥ 1 point");

  const computeBox = (vals: readonly V[]): { cx: number; cy: number; sx: number; sy: number } => {
    let minX = Number.POSITIVE_INFINITY;
    let minY = Number.POSITIVE_INFINITY;
    let maxX = Number.NEGATIVE_INFINITY;
    let maxY = Number.NEGATIVE_INFINITY;
    for (let i = 0; i < K; i++) {
      const x = vals[i]!.x;
      const y = vals[i]!.y;
      if (x < minX) minX = x;
      if (x > maxX) maxX = x;
      if (y < minY) minY = y;
      if (y > maxY) maxY = y;
    }
    return {
      cx: (minX + maxX) / 2,
      cy: (minY + maxY) / 2,
      sx: maxX - minX,
      sy: maxY - minY,
    };
  };

  const center = Vec.lens(
    points,
    (vals: readonly V[]) => {
      const b = computeBox(vals);
      return { x: b.cx, y: b.cy };
    },
    (target: V, vals: readonly V[]) => {
      const b = computeBox(vals);
      const dx = target.x - b.cx;
      const dy = target.y - b.cy;
      const out = new Array<V>(K);
      for (let i = 0; i < K; i++) out[i] = { x: vals[i]!.x + dx, y: vals[i]!.y + dy };
      return out;
    },
  );

  // Complement: per-point fractions of the bbox half-size at the last
  // non-degenerate state. A `size` write places points at
  // `center + frac_i * (target/2)`, surviving a per-axis collapse to a
  // line. `step` refreshes component-wise on non-degenerate axes.
  type C = { fracs: V[] };
  const refreshFracs = (fracs: V[], vals: readonly V[]): V[] => {
    const b = computeBox(vals);
    const hx = b.sx > 1e-12 ? b.sx / 2 : 0;
    const hy = b.sy > 1e-12 ? b.sy / 2 : 0;
    return fracs.map((f, i) => ({
      x: hx > 0 ? (vals[i]!.x - b.cx) / hx : f.x,
      y: hy > 0 ? (vals[i]!.y - b.cy) / hy : f.y,
    }));
  };

  const size = Vec.lens(points, {
    init: (vals: readonly V[]): C => {
      const b = computeBox(vals);
      const halfX0 = b.sx > 1e-12 ? b.sx / 2 : 1;
      const halfY0 = b.sy > 1e-12 ? b.sy / 2 : 1;
      return {
        fracs: vals.map(v => ({
          x: b.sx > 1e-12 ? (v.x - b.cx) / halfX0 : 0,
          y: b.sy > 1e-12 ? (v.y - b.cy) / halfY0 : 0,
        })),
      };
    },
    step: (vals: readonly V[], c: C): C => ({ fracs: refreshFracs(c.fracs, vals) }),
    fwd: (vals: readonly V[]): V => {
      const b = computeBox(vals);
      return { x: b.sx, y: b.sy };
    },
    bwd: (target: V, vals: readonly V[], c: C) => {
      const b = computeBox(vals);
      const halfTx = target.x / 2;
      const halfTy = target.y / 2;
      const out = c.fracs.map(f => ({ x: b.cx + f.x * halfTx, y: b.cy + f.y * halfTy }));
      return { updates: out, complement: c };
    },
  });

  return { center, size };
}
