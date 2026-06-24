// Read-only geometric readouts over `Cls.derive`: one-way derives whose inverse
// is under-determined (a point at parameter `t` pins the curve at one point, but
// the control points keep many DOF). For the writable bezier decomposition see
// `bezierGestalt` in `lenses/geometry`.

import type { Cell } from "./cell";
import { Vec } from "./values/vec";

type V = { x: number; y: number };

/** Quadratic Bézier point at parameter `t`. RO. */
export function bezier2(p0: Cell<V>, p1: Cell<V>, p2: Cell<V>, t: Cell<number>): Vec {
  return Vec.derive([p0, p1, p2, t] as const, vals => {
    const [a, b, c, tv] = vals;
    const u = 1 - tv;
    return {
      x: u * u * a.x + 2 * u * tv * b.x + tv * tv * c.x,
      y: u * u * a.y + 2 * u * tv * b.y + tv * tv * c.y,
    };
  });
}

/** Cubic Bézier point at parameter `t`. RO. */
export function bezier3(p0: Cell<V>, p1: Cell<V>, p2: Cell<V>, p3: Cell<V>, t: Cell<number>): Vec {
  return Vec.derive([p0, p1, p2, p3, t] as const, vals => {
    const [a, b, c, d, tv] = vals;
    const u = 1 - tv;
    const u2 = u * u;
    const t2 = tv * tv;
    return {
      x: u2 * u * a.x + 3 * u2 * tv * b.x + 3 * u * t2 * c.x + t2 * tv * d.x,
      y: u2 * u * a.y + 3 * u2 * tv * b.y + 3 * u * t2 * c.y + t2 * tv * d.y,
    };
  });
}
