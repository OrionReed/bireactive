import { type Cell, type Init, type Read, SKIP, type Skip, type Writable } from "../cell";
import { Num, num } from "../values/num";
import { nearestAngle, Vec, vec } from "../values/vec";
import { remember } from "./memory";
import { rotateAbout } from "./point-cloud";

type V = { x: number; y: number };

/** Distance between two Vecs; writing scales them symmetrically about
 *  their midpoint (collapse to 0 reinflates the last direction). */
export function distance(a: Writable<Vec>, b: Writable<Vec>): Writable<Num> {
  const points = [a, b] as readonly Writable<Vec>[];
  return remember(points, {
    anchor: (vals: readonly V[]) => ({
      x: (vals[0]!.x + vals[1]!.x) / 2,
      y: (vals[0]!.y + vals[1]!.y) / 2,
    }),
    feature: (vals: readonly V[]) => Math.hypot(vals[0]!.x - vals[1]!.x, vals[0]!.y - vals[1]!.y),
  });
}

/** Angle from `a` to `b`, in radians; writing rotates `b` about `a`
 *  (a fixed, separation preserved). */
export function angle(a: Read<V>, b: Writable<Vec>): Writable<Num> {
  return rotateAbout([b], a);
}

/** Reflect `point` across the line through `axisStart`/`axisEnd`. Writes
 *  the reflected position back to `point` (axis unchanged); reflection is
 *  involutive, so the same formula reads and writes. */
export function reflection(point: Cell<V>, axisStart: Cell<V>, axisEnd: Cell<V>): Writable<Vec> {
  const reflect = (p: V, a: V, b: V): V => {
    const dx = b.x - a.x;
    const dy = b.y - a.y;
    const len2 = dx * dx + dy * dy;
    if (len2 === 0) return p;
    const t = ((p.x - a.x) * dx + (p.y - a.y) * dy) / len2;
    const projX = a.x + t * dx;
    const projY = a.y + t * dy;
    return { x: 2 * projX - p.x, y: 2 * projY - p.y };
  };
  return Vec.lens(
    [point, axisStart, axisEnd] as const,
    vals => reflect(vals[0], vals[1], vals[2]),
    (target, vals) => [reflect(target, vals[1], vals[2]), SKIP, SKIP] as never,
  );
}

/** Lerp between two Vecs at parameter `t`. Writing the interpolated point
 *  shifts both endpoints rigidly (preserving t). */
export function vecLerp(a: Cell<V>, b: Cell<V>, t: Cell<number>): Writable<Vec> {
  return Vec.lens(
    [a, b, t] as const,
    vals => {
      const [av, bv, tv] = vals;
      return { x: av.x + (bv.x - av.x) * tv, y: av.y + (bv.y - av.y) * tv };
    },
    (target, vals) => {
      const [av, bv, tv] = vals;
      const dx = target.x - (av.x + (bv.x - av.x) * tv);
      const dy = target.y - (av.y + (bv.y - av.y) * tv);
      return [{ x: av.x + dx, y: av.y + dy }, { x: bv.x + dx, y: bv.y + dy }, SKIP];
    },
  );
}

/** Sum of two nums; writing the sum splits the delta equally between
 *  a and b (the "pulley" conservation pattern). */
export function pulleySum(a: Num, b: Num): Writable<Num> {
  return Num.lens(
    [a, b] as const,
    vals => vals[0] + vals[1],
    (target, vals) => {
      const [av, bv] = vals;
      const cur = av + bv;
      const delta = target - cur;
      return [av + delta / 2, bv + delta / 2];
    },
  );
}

/** Difference of two nums: `a - b`. Writing the difference shifts
 *  both inputs symmetrically by ±half-delta. */
export function diff(a: Num, b: Num): Writable<Num> {
  return Num.lens(
    [a, b] as const,
    vals => vals[0] - vals[1],
    (target, vals) => {
      const [av, bv] = vals;
      const cur = av - bv;
      const delta = target - cur;
      return [av + delta / 2, bv - delta / 2];
    },
  );
}

/** Policy for `polar`'s inverse — which inputs absorb a write:
 *
 *  - `rotate`    — c fixed; write r and a to land on target.
 *  - `translate` — r and a fixed; shift c by Δ.
 *  - `radial`    — c and a fixed; project the drag onto the ray.
 *  - `circular`  — c and r fixed; project the drag onto the circle. */
export type PolarPolicy = "rotate" | "translate" | "radial" | "circular";

/** Vec at a polar offset from `center`: `center + (r·cos a, r·sin a)`. Each
 *  input is a literal (new cell) or existing writable (passed through); for
 *  read-only sources use `Vec.derive`. `policy` selects which inputs absorb
 *  writes; lock one with `Num.pin`: `polar(c, Num.pin(100), a)`. */
export function polar(
  center: Init<Vec>,
  r: Init<Num>,
  a: Init<Num>,
  policy: PolarPolicy = "rotate",
): Writable<Vec> {
  const cSig: Writable<Vec> = center instanceof Vec ? center : vec(center.x, center.y);
  const rSig: Writable<Num> = num(r);
  const aSig: Writable<Num> = num(a);

  const project = (c: V, rv: number, av: number): V => ({
    x: c.x + rv * Math.cos(av),
    y: c.y + rv * Math.sin(av),
  });

  // Pick the angle nearest current, not atan2's (-π, π] value, so an
  // accumulated-revolution angle doesn't jump.
  type Updates = readonly [V | Skip, number | Skip, number | Skip];
  let bwd: (p: V, vals: readonly [V, number, number]) => Updates;
  switch (policy) {
    case "rotate":
      bwd = (p, [cv, , av]) => {
        const dx = p.x - cv.x;
        const dy = p.y - cv.y;
        return [SKIP, Math.hypot(dx, dy), nearestAngle(Math.atan2(dy, dx), av)];
      };
      break;
    case "translate":
      bwd = (p, [cv, rv, av]) => {
        const f = project(cv, rv, av);
        return [{ x: cv.x + (p.x - f.x), y: cv.y + (p.y - f.y) }, SKIP, SKIP];
      };
      break;
    case "radial":
      bwd = (p, [cv, , av]) => {
        const dx = p.x - cv.x;
        const dy = p.y - cv.y;
        return [SKIP, dx * Math.cos(av) + dy * Math.sin(av), SKIP];
      };
      break;
    case "circular":
      bwd = (p, [cv, , av]) => [SKIP, SKIP, nearestAngle(Math.atan2(p.y - cv.y, p.x - cv.x), av)];
      break;
  }
  return Vec.lens([cSig, rSig, aSig] as const, ([c, rv, av]) => project(c, rv, av), bwd);
}

/** Cubic Bezier (p0..p3) → {start, end, startTangent, endTangent}. Moving an
 *  endpoint carries its control point (tangent preserved); writing a tangent
 *  moves only its control point. Square linear iso — all pairs invariant. */
export function bezierGestalt(
  p0: Writable<Vec>,
  p1: Writable<Vec>,
  p2: Writable<Vec>,
  p3: Writable<Vec>,
): {
  start: Writable<Vec>;
  end: Writable<Vec>;
  startTangent: Writable<Vec>;
  endTangent: Writable<Vec>;
} {
  const start = Vec.lens(
    [p0, p1] as const,
    (vals: readonly V[]) => vals[0]!,
    (target: V, vals: readonly V[]) => {
      const dx = target.x - vals[0]!.x;
      const dy = target.y - vals[0]!.y;
      return [target, { x: vals[1]!.x + dx, y: vals[1]!.y + dy }] as never;
    },
  );

  const end = Vec.lens(
    [p2, p3] as const,
    (vals: readonly V[]) => vals[1]!,
    (target: V, vals: readonly V[]) => {
      const dx = target.x - vals[1]!.x;
      const dy = target.y - vals[1]!.y;
      return [{ x: vals[0]!.x + dx, y: vals[0]!.y + dy }, target] as never;
    },
  );

  const startTangent = Vec.lens(
    [p0, p1] as const,
    (vals: readonly V[]) => ({ x: vals[1]!.x - vals[0]!.x, y: vals[1]!.y - vals[0]!.y }),
    (target: V, vals: readonly V[]) =>
      [SKIP, { x: vals[0]!.x + target.x, y: vals[0]!.y + target.y }] as never,
  );

  const endTangent = Vec.lens(
    [p2, p3] as const,
    (vals: readonly V[]) => ({ x: vals[1]!.x - vals[0]!.x, y: vals[1]!.y - vals[0]!.y }),
    (target: V, vals: readonly V[]) =>
      [{ x: vals[1]!.x - target.x, y: vals[1]!.y - target.y }, SKIP] as never,
  );

  return { start, end, startTangent, endTangent };
}
