// box.ts — reactive axis-aligned rectangle.
//
// Invertibles (`add`, `sub`, `scale`, `expand`) return `: this` and ride
// on `Cell#lens(fwd, bwd)`. Chained calls compose into a lens chain.

import { type Easing, type Tween, tween } from "../../animation";
import {
  Cell,
  cachedDerive,
  fieldLens,
  type Init,
  type Inner,
  isReadonly,
  type Lattice,
  lazy,
  type Read,
  reader,
  readNow,
  type Val,
  type Writable,
  type WritableBrand,
} from "../cell";
import type { Linear, Pack, TraitDict } from "../traits";
import { Bool } from "./bool";
import { Num, num } from "./num";
import { Vec } from "./vec";

type V = { x: number; y: number; w: number; h: number };

export const add = (a: V, b: V): V => ({ x: a.x + b.x, y: a.y + b.y, w: a.w + b.w, h: a.h + b.h });
export const sub = (a: V, b: V): V => ({ x: a.x - b.x, y: a.y - b.y, w: a.w - b.w, h: a.h - b.h });
export const scale = (a: V, k: number): V => ({ x: a.x * k, y: a.y * k, w: a.w * k, h: a.h * k });
export const lerp = (a: V, b: V, t: number): V => ({
  x: a.x + (b.x - a.x) * t,
  y: a.y + (b.y - a.y) * t,
  w: a.w + (b.w - a.w) * t,
  h: a.h + (b.h - a.h) * t,
});
export const equals = (a: V, b: V) =>
  a === b || (a.x === b.x && a.y === b.y && a.w === b.w && a.h === b.h);
/** L2 distance over the flat (x, y, w, h) representation. */
export const metric = (a: V, b: V) => Math.hypot(a.x - b.x, a.y - b.y, a.w - b.w, a.h - b.h);
export const expand = (b: V, n: number): V => ({
  x: b.x - n,
  y: b.y - n,
  w: b.w + 2 * n,
  h: b.h + 2 * n,
});
export const contains = (b: V, p: Inner<Vec>): boolean =>
  p.x >= b.x && p.x <= b.x + b.w && p.y >= b.y && p.y <= b.y + b.h;

/** Closest point inside `b` to `p`. Already-inside is identity; outside
 *  snaps to the nearest boundary point. `Box#contains`'s true-side bwd. */
export const clampToBox = (p: Inner<Vec>, b: V): Inner<Vec> => ({
  x: Math.max(b.x, Math.min(b.x + b.w, p.x)),
  y: Math.max(b.y, Math.min(b.y + b.h, p.y)),
});

/** Closest point strictly outside `b` to `p`, displaced past the nearest
 *  edge by `eps`. Already-outside is identity. `Box#contains`'s
 *  false-side bwd. */
export const ejectFromBox = (p: Inner<Vec>, b: V, eps = 1e-6): Inner<Vec> => {
  if (!contains(b, p)) return p;
  const dLeft = p.x - b.x;
  const dRight = b.x + b.w - p.x;
  const dTop = p.y - b.y;
  const dBot = b.y + b.h - p.y;
  const min = Math.min(dLeft, dRight, dTop, dBot);
  if (min === dLeft) return { x: b.x - eps, y: p.y };
  if (min === dRight) return { x: b.x + b.w + eps, y: p.y };
  if (min === dTop) return { x: p.x, y: b.y - eps };
  return { x: p.x, y: b.y + b.h + eps };
};

/** Bounding box around a set of boxes. */
export function union(...bs: V[]): V {
  if (bs.length === 0) return { x: 0, y: 0, w: 0, h: 0 };
  let xMin = bs[0].x,
    yMin = bs[0].y;
  let xMax = xMin + bs[0].w,
    yMax = yMin + bs[0].h;
  for (let i = 1; i < bs.length; i++) {
    const o = bs[i];
    if (o.x < xMin) xMin = o.x;
    if (o.y < yMin) yMin = o.y;
    if (o.x + o.w > xMax) xMax = o.x + o.w;
    if (o.y + o.h > yMax) yMax = o.y + o.h;
  }
  return { x: xMin, y: yMin, w: xMax - xMin, h: yMax - yMin };
}

/** Perimeter point on a Box facing `toward`. Default `Shape.boundary`. */
export function edgeFrom(b: V, toward: Inner<Vec>): Inner<Vec> {
  const cx = b.x + b.w / 2;
  const cy = b.y + b.h / 2;
  const dx = toward.x - cx;
  const dy = toward.y - cy;
  if (dx === 0 && dy === 0) return { x: cx, y: cy };
  const k = Math.min(
    dx === 0 ? Number.POSITIVE_INFINITY : b.w / 2 / Math.abs(dx),
    dy === 0 ? Number.POSITIVE_INFINITY : b.h / 2 / Math.abs(dy),
  );
  return { x: cx + dx * k, y: cy + dy * k };
}

const linearImpl: Linear<V> = { add, sub, scale };
const packImpl: Pack<V> = {
  dim: 4,
  read: (v, a, o) => {
    a[o] = v.x;
    a[o + 1] = v.y;
    a[o + 2] = v.w;
    a[o + 3] = v.h;
  },
  write: (a, o) => ({ x: a[o]!, y: a[o + 1]!, w: a[o + 2]!, h: a[o + 3]! }),
};

const LAT_EPS = 1e-9;
/** ε-equality that also treats ±∞ === ±∞ as equal (so `top` compares equal
 *  to itself despite `∞ - ∞ = NaN`). */
const eqf = (a: number, b: number): boolean => a === b || Math.abs(a - b) <= LAT_EPS;

export class Box extends Cell<V> {
  static traits = {
    linear: linearImpl,
    lerp,
    metric,
    equals,
    pack: packImpl,
  } satisfies TraitDict<V>;
  declare readonly _t: typeof Box.traits;

  /** Rectangle-intersection lattice — a `Box` read as partial knowledge of
   *  a region. `meet` is overlap (max of left/top edges, min of right/bottom),
   *  `isBottom` is a degenerate (negative-extent) rect. `top` uses a finite
   *  left/top with infinite extent so `left + w` never evaluates to `NaN`.
   *  The relate layer picks this up when a `Box` joins a cyclic relation. */
  static lattice: Lattice<V> = {
    top: {
      x: -Number.MAX_VALUE,
      y: -Number.MAX_VALUE,
      w: Number.POSITIVE_INFINITY,
      h: Number.POSITIVE_INFINITY,
    },
    meet: (a, b) => {
      const x = Math.max(a.x, b.x);
      const y = Math.max(a.y, b.y);
      const right = Math.min(a.x + a.w, b.x + b.w);
      const bottom = Math.min(a.y + a.h, b.y + b.h);
      return { x, y, w: right - x, h: bottom - y };
    },
    equals: (a, b) =>
      eqf(a.x, b.x) && eqf(a.y, b.y) && eqf(a.w, b.w) && eqf(a.h, b.h),
    isBottom: a => a.w < -LAT_EPS || a.h < -LAT_EPS,
  };

  constructor(v: V = { x: 0, y: 0, w: 0, h: 0 }) {
    super(v, { equals });
  }

  add(b: Val<V>): this {
    const bf = reader(b);
    return this.lens(
      v => add(v, bf()),
      n => sub(n, bf()),
    );
  }
  sub(b: Val<V>): this {
    const bf = reader(b);
    return this.lens(
      v => sub(v, bf()),
      n => add(n, bf()),
    );
  }
  scale(k: Val<number>): this {
    const kf = reader(k);
    return this.lens(
      v => scale(v, kf()),
      n => scale(n, 1 / kf()),
    );
  }
  expand(n: Val<number>): this {
    const nf = reader(n);
    return this.lens(
      v => expand(v, nf()),
      o => expand(o, -nf()),
    );
  }

  lerp(b: Val<V>, t: Val<number>): Box {
    return Box.derive(() => lerp(this.value, readNow(b), readNow(t)));
  }
  /** Membership predicate. Conditional return type: a writable `Vec`
   *  yields `Writable<Bool>` and flipping the view moves the source —
   *  `true` clamps to the nearest in-box point, `false` ejects past the
   *  nearest edge by `eps`. Literal / RO inputs yield a bare RO `Bool`. */
  contains<P extends Val<Inner<Vec>>>(p: P): P extends WritableBrand ? Writable<Bool> : Bool {
    if (p instanceof Vec) {
      // A read-only Vec has no backward path → RO branch; sources and
      // writable lenses accept write-back.
      if (!isReadonly(p)) {
        // `.bind(Bool)` + cast steps past the generic overloads, whose
        // mapped-tuple inference over the full class types otherwise blows
        // the instantiation depth.
        const mk = Bool.lens.bind(Bool) as unknown as (
          parents: readonly [Read<V>, Read<Inner<Vec>>],
          fwd: (vals: readonly [V, Inner<Vec>]) => boolean,
          bwd: (target: boolean, vals: readonly [V, Inner<Vec>]) => readonly [V?, Inner<Vec>?],
        ) => Writable<Bool>;
        return mk(
          [this, p],
          vals => contains(vals[0], vals[1]),
          (target, vals) => {
            const [b, v] = vals;
            if (contains(b, v) === target) return [undefined, undefined];
            return [undefined, target ? clampToBox(v, b) : ejectFromBox(v, b)];
          },
        ) as never;
      }
    }
    return Bool.derive(() => contains(this.value, readNow<Inner<Vec>>(p))) as never;
  }

  get x() {
    return fieldLens(this, "x", Num);
  }
  get y() {
    return fieldLens(this, "y", Num);
  }
  get w() {
    return fieldLens(this, "w", Num);
  }
  get h() {
    return fieldLens(this, "h", Num);
  }
  get area() {
    return cachedDerive(this, "area", Num, b => b.w * b.h);
  }

  /** Vec at parametric (u, v) within `[0,1]²`. Not memoised (arbitrary
   *  pairs would leak a cache entry each) — use the named edge getters
   *  (`.center`, `.top`, …) for stable identity. */
  at(u: number, v: number): Vec {
    return Vec.derive(this, b => ({ x: b.x + u * b.w, y: b.y + v * b.h }));
  }
  // Named edges — RO views over `at(u, v)`, memoised under stable keys
  // so subscribers always see the same Vec. `lazy()` directly since
  // `at()` already returns a Vec.
  get center(): Vec {
    return lazy(this, "center", () => this.at(0.5, 0.5));
  }
  get top(): Vec {
    return lazy(this, "top", () => this.at(0.5, 0));
  }
  get bottom(): Vec {
    return lazy(this, "bottom", () => this.at(0.5, 1));
  }
  get left(): Vec {
    return lazy(this, "left", () => this.at(0, 0.5));
  }
  get right(): Vec {
    return lazy(this, "right", () => this.at(1, 0.5));
  }

  /** Tween-builder, implied by the lerp trait. */
  to(this: Writable<Box>, target: V, dur: Val<number>, ease?: Easing): Tween<V> {
    return tween(this, target, dur, ease);
  }
}

/** Writable `Box` at `(x, y, w, h)`. Each component is a literal `number`
 *  (lifted to a fresh seed) or an existing `Writable<Num>` (identity
 *  passthrough). RO sources are rejected at the type level — use
 *  `Box.derive(...)` for reactive RO tracking, or `cell.value` to
 *  snapshot. Lock a component with `Num.pin(c)`. */
export function box(
  x: Init<Num> = 0,
  y: Init<Num> = 0,
  w: Init<Num> = 0,
  h: Init<Num> = 0,
): Writable<Box> {
  if (
    typeof x === "number" &&
    typeof y === "number" &&
    typeof w === "number" &&
    typeof h === "number"
  ) {
    return new Box({ x, y, w, h }) as Writable<Box>;
  }
  const xN = num(x);
  const yN = num(y);
  const wN = num(w);
  const hN = num(h);
  // The view fully reconstructs all 4 axes (1-arg bwd ⇒ no source read).
  return Box.lens(
    [xN, yN, wN, hN] as const,
    ([bx, by, bw, bh]) => ({ x: bx, y: by, w: bw, h: bh }),
    v => [v.x, v.y, v.w, v.h],
  );
}
