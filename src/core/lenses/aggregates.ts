// Numerical argmin lenses: one Newton step per write through a
// finite-differenced Jacobian, with Levenberg-Marquardt damping. `weights`
// controls which inputs absorb the residual (0 = frozen). For typed N→M
// outputs see `factor` (typed-factor.ts); for closed-form aggregates see
// `domain-aggregates.ts`.

import { SKIP, type Skip, type Writable } from "../cell";
import { Num } from "../values/num";
import { Vec } from "../values/vec";

export interface ArgminOpts {
  /** Finite-difference epsilon for the Jacobian. Default 1e-4. */
  eps?: number;
  /** Levenberg-Marquardt damping. Default `1e-6` for `argminNum`
   *  (Jacobian is always well-conditioned for linear constraints) and
   *  `1e-3` for `argminVec` (IK chains hit rank-deficient regimes at
   *  full extension). Larger → smaller, more stable updates; smaller
   *  → closer to pure pseudoinverse. */
  damping?: number;
}

/** Target-shaping for `argminVec`: project a write into the reachable
 *  workspace before the Jacobian step, sidestepping the rank-deficient
 *  swings at the boundary. For an N-link chain rooted at `R` with reach
 *  `L`, pass `clampToDisc(R, L)`. */
export interface ArgminVecOpts extends ArgminOpts {
  /** Pre-write hook: transform the requested target into one that's
   *  guaranteed solvable. Most useful as a workspace clamp. */
  clampTarget?: (
    target: { x: number; y: number },
    currentInputs: readonly number[],
  ) => { x: number; y: number };
}

/** Project `p` into the closed disc of radius `r` centred on `c` (points
 *  inside pass through). Use as `argminVec`'s `clampTarget` to fix IK
 *  explosion at maximum reach. */
export function clampToDisc(
  c: { x: number; y: number },
  r: number,
): (p: { x: number; y: number }) => { x: number; y: number } {
  return p => {
    const dx = p.x - c.x;
    const dy = p.y - c.y;
    const d = Math.hypot(dx, dy);
    if (d <= r) return p;
    const k = r / d;
    return { x: c.x + dx * k, y: c.y + dy * k };
  };
}

/** Scalar-output argmin lens: write does one Newton step against the FD
 *  Jacobian, distributing the residual by `weights`. For typed/multi-
 *  output cases use `factor()`; this M=1 path is kept for its hand-rolled
 *  inner loop. */
export function argminNum(
  inputs: readonly Num[],
  forward: (xs: readonly number[]) => number,
  weights: readonly number[],
  opts: ArgminOpts = {},
): Writable<Num> {
  if (weights.length !== inputs.length) {
    throw new Error("argminNum: weights/inputs length mismatch");
  }
  const eps = opts.eps ?? 1e-4;
  const damping = opts.damping ?? 1e-6;
  const n = inputs.length;
  // Pre-allocated to avoid per-write allocations.
  const J = new Array<number>(n);
  const out = new Array<number | Skip>(n);
  return Num.lens(
    inputs,
    vals => forward(vals),
    (target, vals) => {
      const xs = vals as number[];
      const y0 = forward(xs);
      const dy = target - y0;
      for (let i = 0; i < n; i++) {
        const saved = xs[i]!;
        xs[i] = saved + eps;
        J[i] = (forward(xs) - y0) / eps;
        xs[i] = saved;
      }
      let denom = damping;
      for (let i = 0; i < n; i++) denom += weights[i]! * J[i]! * J[i]!;
      const k = dy / denom;
      for (let i = 0; i < n; i++) {
        if (weights[i] === 0) {
          out[i] = SKIP;
        } else {
          out[i] = xs[i]! + weights[i]! * J[i]! * k;
        }
      }
      return out;
    },
  );
}

/** 2D-output argmin lens (scalar Num inputs, `{x, y}` forward). For IK
 *  arms, draggable points, handle projection. Kept for its hand-rolled
 *  2×2 inverse + `clampTarget` hook; see `factor()` for other M. */
export function argminVec(
  inputs: readonly Num[],
  forward: (xs: readonly number[]) => { x: number; y: number },
  weights: readonly number[],
  opts: ArgminVecOpts = {},
): Writable<Vec> {
  if (weights.length !== inputs.length) {
    throw new Error("argminVec: weights/inputs length mismatch");
  }
  const eps = opts.eps ?? 1e-4;
  const damping = opts.damping ?? 1e-3;
  const clamp = opts.clampTarget;
  const n = inputs.length;
  // Pre-allocated to avoid per-write allocations.
  const Jx = new Array<number>(n);
  const Jy = new Array<number>(n);
  const out = new Array<number | Skip>(n);
  return Vec.lens(
    inputs,
    vals => forward(vals),
    (rawTarget, vals) => {
      const xs = vals as number[];
      const target = clamp ? clamp(rawTarget, xs) : rawTarget;
      const y0 = forward(xs);
      const dx = target.x - y0.x;
      const dy = target.y - y0.y;
      for (let i = 0; i < n; i++) {
        const saved = xs[i]!;
        xs[i] = saved + eps;
        const ye = forward(xs);
        xs[i] = saved;
        Jx[i] = (ye.x - y0.x) / eps;
        Jy[i] = (ye.y - y0.y) / eps;
      }
      // J·W·Jᵀ is the 2×2 [a b; b c]. Add damping to the diagonal, invert.
      let a = damping;
      let b = 0;
      let c = damping;
      for (let i = 0; i < n; i++) {
        const w = weights[i]!;
        a += w * Jx[i]! * Jx[i]!;
        b += w * Jx[i]! * Jy[i]!;
        c += w * Jy[i]! * Jy[i]!;
      }
      const det = a * c - b * b;
      if (Math.abs(det) < 1e-14) {
        // Singular; leave inputs unchanged.
        for (let i = 0; i < n; i++) out[i] = SKIP;
        return out;
      }
      const invA = c / det;
      const invB = -b / det;
      const invC = a / det;
      const kx = invA * dx + invB * dy;
      const ky = invB * dx + invC * dy;
      for (let i = 0; i < n; i++) {
        const w = weights[i]!;
        if (w === 0) {
          out[i] = SKIP;
        } else {
          out[i] = xs[i]! + w * (Jx[i]! * kx + Jy[i]! * ky);
        }
      }
      return out;
    },
  );
}
