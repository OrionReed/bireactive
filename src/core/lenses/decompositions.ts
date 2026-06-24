// Closed-form N→M lens decompositions (Vec/Num): N inputs → M coupled
// writable outputs where writing one preserves the readings of the others.
// Each backward pass is a hand-rolled group action about the centroid, so
// cross-channel invariance is exact. For the generic numerical escape hatch
// see `factor` in `typed-factor.ts`.

import { Num, SKIP, Vec, type Writable } from "../index";

/** (a, b) → {mean: (a+b)/2, diff: a−b}. Square linear iso; each write is the
 *  inverse change of basis, so mean and diff are cross-channel invariant. */
export function meanDiff(a: Num, b: Num): { mean: Writable<Num>; diff: Writable<Num> } {
  const mean = Num.lens(
    [a, b] as const,
    vals => (vals[0] + vals[1]) / 2,
    (target, vals) => {
      const d = vals[0] - vals[1];
      return [target + d / 2, target - d / 2];
    },
  );
  const diff = Num.lens(
    [a, b] as const,
    vals => vals[0] - vals[1],
    (target, vals) => {
      const m = (vals[0] + vals[1]) / 2;
      return [m + target / 2, m - target / 2];
    },
  );
  return { mean, diff };
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

  type V = { x: number; y: number };

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
  type V = { x: number; y: number };

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
