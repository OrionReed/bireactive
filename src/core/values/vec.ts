// vec.ts — reactive 2D point.
//
// Invertibles return `: this` and ride on `Cell#lens(fwd, bwd)`;
// chained calls compose into a lens chain. Field-lens getters use
// `fieldLens()` (propagates writability); `cachedDerive()` wraps RO views.

import { type Easing, type Tween, tween } from "../../animation";
import {
  Cell,
  cachedDerive,
  fieldLens,
  type Init,
  reader,
  readNow,
  SKIP,
  type Skip,
  type Val,
  type Writable,
} from "../cell";
import type { Linear, Pack, Pivotal, TraitDict } from "../traits";
import { Num, num } from "./num";

type V = { x: number; y: number };

export const add = (a: V, b: V): V => ({ x: a.x + b.x, y: a.y + b.y });
export const sub = (a: V, b: V): V => ({ x: a.x - b.x, y: a.y - b.y });
export const scale = (a: V, k: number): V => ({ x: a.x * k, y: a.y * k });
export const lerp = (a: V, b: V, t: number): V => ({
  x: a.x + (b.x - a.x) * t,
  y: a.y + (b.y - a.y) * t,
});
export const metric = (a: V, b: V) => Math.hypot(a.x - b.x, a.y - b.y);
export const equals = (a: V, b: V) => a === b || (a.x === b.x && a.y === b.y);
export const normalize = (v: V): V => {
  const m = Math.hypot(v.x, v.y);
  return m === 0 ? { x: 0, y: 0 } : { x: v.x / m, y: v.y / m };
};
export const perp = (v: V): V => ({ x: v.y, y: -v.x });
export const rotateAbout = (v: V, p: V, dθ: number): V => {
  const cos = Math.cos(dθ);
  const sin = Math.sin(dθ);
  const dx = v.x - p.x;
  const dy = v.y - p.y;
  return { x: p.x + cos * dx - sin * dy, y: p.y + sin * dx + cos * dy };
};
export const scaleAbout = (v: V, p: V, k: number): V => ({
  x: p.x + k * (v.x - p.x),
  y: p.y + k * (v.y - p.y),
});

const ORIGIN: V = { x: 0, y: 0 };

/** Tangent point on the circle (radius `r`, centre `c`) from external
 *  point `p`. `side: -1` picks the CCW tangent from `pc`, `+1` the CW
 *  (y-down screen coords flip the visual sense). Returns `c` if `p` is
 *  inside or on the circle. */
export function tangentPoint(p: V, c: V, r: number, side: 1 | -1 = -1): V {
  const dx = p.x - c.x;
  const dy = p.y - c.y;
  const d = Math.hypot(dx, dy);
  if (d <= r) return c;
  const baseAngle = Math.atan2(dy, dx);
  const offset = Math.acos(r / d);
  const a = baseAngle + side * offset;
  return { x: c.x + r * Math.cos(a), y: c.y + r * Math.sin(a) };
}

/** Wrap `x` to the half-open interval `(-π, π]`. */
const wrapToPi = (x: number): number => x - 2 * Math.PI * Math.round(x / (2 * Math.PI));

/** Representative of cyclic angle `target` closest to `current`
 *  (shortest-arc inverse). */
const nearestAngle = (target: number, current: number): number =>
  current + wrapToPi(target - current);

const linearImpl: Linear<V> = { add, sub, scale };
const packImpl: Pack<V> = {
  dim: 2,
  read: (v, a, o) => {
    a[o] = v.x;
    a[o + 1] = v.y;
  },
  write: (a, o) => ({ x: a[o]!, y: a[o + 1]! }),
};
const pivotalImpl: Pivotal<V> = { rotateAbout, scaleAbout };

export class Vec extends Cell<V> {
  static traits = {
    linear: linearImpl,
    lerp,
    metric,
    equals,
    pack: packImpl,
    pivotal: pivotalImpl,
  } satisfies TraitDict<V>;
  declare readonly _t: typeof Vec.traits;

  constructor(v: V = { x: 0, y: 0 }) {
    super(v, { equals });
  }

  add(b: Val<V>): this {
    const bf = reader(b);
    return this.lens(
      v => {
        const o = bf();
        return { x: v.x + o.x, y: v.y + o.y };
      },
      n => {
        const o = bf();
        return { x: n.x - o.x, y: n.y - o.y };
      },
    );
  }
  sub(b: Val<V>): this {
    const bf = reader(b);
    return this.lens(
      v => {
        const o = bf();
        return { x: v.x - o.x, y: v.y - o.y };
      },
      n => {
        const o = bf();
        return { x: n.x + o.x, y: n.y + o.y };
      },
    );
  }
  /** Uniform scale by `k` about `pivot` (default origin). Inverse scales
   *  by `1/k`; exact bijection for `k ≠ 0`. */
  scale(k: Val<number>, pivot?: Val<V>): this {
    const kf = reader(k);
    const pf = pivot === undefined ? undefined : reader(pivot);
    return this.lens(
      v => {
        const k = kf();
        return pf ? scaleAbout(v, pf(), k) : { x: v.x * k, y: v.y * k };
      },
      n => {
        const k = kf();
        return pf ? scaleAbout(n, pf(), 1 / k) : { x: n.x / k, y: n.y / k };
      },
    );
  }
  /** Rotate by `angle` (radians) about `pivot` (default origin). Inverse
   *  rotates by `−angle`; exact bijection. */
  rotate(angle: Val<number>, pivot: Val<V> = ORIGIN): this {
    const af = reader(angle);
    const pf = reader(pivot);
    return this.lens(
      v => rotateAbout(v, pf(), af()),
      n => rotateAbout(n, pf(), -af()),
    );
  }
  offset(dx: Val<number>, dy: Val<number>): this {
    const xf = reader(dx);
    const yf = reader(dy);
    return this.lens(
      v => ({ x: v.x + xf(), y: v.y + yf() }),
      n => ({ x: n.x - xf(), y: n.y - yf() }),
    );
  }
  // Axis-aligned offset sugar — same fwd/bwd shape as offset.
  up(n: Val<number>): this {
    const f = reader(n);
    return this.lens(
      v => ({ x: v.x, y: v.y - f() }),
      o => ({ x: o.x, y: o.y + f() }),
    );
  }
  down(n: Val<number>): this {
    const f = reader(n);
    return this.lens(
      v => ({ x: v.x, y: v.y + f() }),
      o => ({ x: o.x, y: o.y - f() }),
    );
  }
  left(n: Val<number>): this {
    const f = reader(n);
    return this.lens(
      v => ({ x: v.x - f(), y: v.y }),
      o => ({ x: o.x + f(), y: o.y }),
    );
  }
  right(n: Val<number>): this {
    const f = reader(n);
    return this.lens(
      v => ({ x: v.x + f(), y: v.y }),
      o => ({ x: o.x - f(), y: o.y }),
    );
  }

  normalize(): Vec {
    return Vec.derive(() => normalize(this.value));
  }
  perp(): Vec {
    return Vec.derive(() => perp(this.value));
  }
  lerp(b: Val<V>, t: Val<number>): Vec {
    return Vec.derive(() => lerp(this.value, readNow(b), readNow(t)));
  }
  distance(other: Val<V>): Num {
    return Num.derive(this, v => metric(v, readNow(other)));
  }

  get x() {
    return fieldLens(this, "x", Num);
  }
  get y() {
    return fieldLens(this, "y", Num);
  }
  get magnitude() {
    return cachedDerive(this, "magnitude", Num, v => Math.hypot(v.x, v.y));
  }

  /** Tween-builder; `this: Writable<Vec>` gates the call to writable
   *  receivers. */
  to(this: Writable<Vec>, target: V, dur: Val<number>, ease?: Easing): Tween<V> {
    return tween(this, target, dur, ease);
  }
}

/** @internal — 2-input lens over two writable `Num`s; `vec()` delegates
 *  here after lifting literals. */
function axes(x: Writable<Num>, y: Writable<Num>): Writable<Vec> {
  // The view fully reconstructs both axes (1-arg bwd ⇒ no source read).
  return Vec.lens(
    [x, y] as const,
    ([xv, yv]) => ({ x: xv, y: yv }),
    v => [v.x, v.y],
  );
}

/** Writable `Vec` at `(x, y)`. Each axis is a literal `number` (lifted
 *  to a fresh seed) or an existing `Writable<Num>` (identity passthrough).
 *  RO sources are rejected at the type level — use `Vec.derive(...)` for
 *  reactive RO tracking, or `cell.value` to snapshot. Lock an axis with
 *  `Num.pin(c)`: `vec(slider, Num.pin(100))`. */
export function vec(x: Init<Num> = 0, y: Init<Num> = 0): Writable<Vec> {
  if (typeof x === "number" && typeof y === "number") {
    return new Vec({ x, y }) as Writable<Vec>;
  }
  return axes(num(x), num(y));
}

/** Policy for `polar`'s inverse — which inputs absorb a write:
 *
 *  - `rotate`    — c fixed; write r and a to land on target.
 *  - `translate` — r and a fixed; shift c by Δ.
 *  - `radial`    — c and a fixed; project the drag onto the ray.
 *  - `circular`  — c and r fixed; project the drag onto the circle. */
export type PolarPolicy = "rotate" | "translate" | "radial" | "circular";

/** Vec at polar offset from `center`: `center + (r·cos a, r·sin a)`.
 *  Bidirectional; each input is a literal (lifted to a fresh seed) or an
 *  existing writable cell. RO inputs are rejected at the type level.
 *  `policy` selects which inputs absorb writes; lock one with
 *  `Num.pin(c)`: `polar(c, Num.pin(100), a)`. */
export function polar(
  center: Init<Vec>,
  r: Init<Num>,
  a: Init<Num>,
  policy: PolarPolicy = "rotate",
): Writable<Vec> {
  // Lift literals; already-writable inputs pass through by identity.
  const cSig: Writable<Vec> = center instanceof Vec ? center : vec(center.x, center.y);
  const rSig: Writable<Num> = num(r);
  const aSig: Writable<Num> = num(a);

  const project = (c: V, rv: number, av: number): V => ({
    x: c.x + rv * Math.cos(av),
    y: c.y + rv * Math.sin(av),
  });

  // Cyclic-coordinate inverse: pick the angle closest to current, not
  // atan2's (-π, π] representative — otherwise an accumulated-revolution
  // angle jumps discontinuously, breaking lenses that read it directly.
  // Source-reading lens: each policy returns per-parent updates over
  // [center, r, a].
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
