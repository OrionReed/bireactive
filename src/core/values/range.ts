import { type Easing, type Tween, tween } from "../../animation";
import {
  Cell,
  cachedDerive,
  fieldLens,
  type Init,
  isReadonly,
  reader,
  readNow,
  SKIP,
  type Val,
  type Writable,
  type WritableBrand,
} from "../cell";
import type { Linear, Pack, TraitDict } from "../traits";
import { Bool } from "./bool";
import { Num, num } from "./num";

type V = { lo: number; hi: number };

export const add = (a: V, b: V): V => ({ lo: a.lo + b.lo, hi: a.hi + b.hi });
export const sub = (a: V, b: V): V => ({ lo: a.lo - b.lo, hi: a.hi - b.hi });
export const scale = (a: V, k: number): V => ({ lo: a.lo * k, hi: a.hi * k });
export const lerp = (a: V, b: V, t: number): V => ({
  lo: a.lo + (b.lo - a.lo) * t,
  hi: a.hi + (b.hi - a.hi) * t,
});
export const equals = (a: V, b: V) => a === b || (a.lo === b.lo && a.hi === b.hi);
/** Euclidean distance over (lo, hi). */
export const metric = (a: V, b: V) => Math.hypot(a.lo - b.lo, a.hi - b.hi);

export const width = (r: V) => r.hi - r.lo;
export const center = (r: V) => (r.lo + r.hi) / 2;
export const contains = (r: V, v: number) => v >= r.lo && v <= r.hi;
export const clamp = (r: V, v: number) => (v < r.lo ? r.lo : v > r.hi ? r.hi : v);

/** Closest value strictly outside `[lo, hi]`, displaced past the nearest
 *  endpoint by `eps`. */
export const eject = (r: V, v: number, eps = 1e-6) => {
  if (!contains(r, v)) return v;
  return v - r.lo <= r.hi - v ? r.lo - eps : r.hi + eps;
};

/** Sample at parameter `t`: `lo + t·(hi - lo)`. `t ∈ [0, 1]` stays
 *  inside the range; values outside extrapolate linearly. */
export const sample = (r: V, t: number) => r.lo + t * (r.hi - r.lo);

/** Inverse of `sample`: given a value, recover the `t` that would
 *  produce it. Degenerate (zero-width) ranges return 0. */
export const paramOf = (r: V, v: number) => {
  const w = r.hi - r.lo;
  return w === 0 ? 0 : (v - r.lo) / w;
};

const linearImpl: Linear<V> = { add, sub, scale };
const packImpl: Pack<V> = {
  dim: 2,
  read: (v, a, o) => {
    a[o] = v.lo;
    a[o + 1] = v.hi;
  },
  write: (a, o) => ({ lo: a[o]!, hi: a[o + 1]! }),
};

export class Range extends Cell<V> {
  static traits = {
    linear: linearImpl,
    lerp,
    metric,
    equals,
    pack: packImpl,
  } satisfies TraitDict<V>;
  declare readonly _t: typeof Range.traits;

  constructor(v: V = { lo: 0, hi: 1 }) {
    super(v, { equals });
  }

  /** Start endpoint. Writes preserve `hi` (start-knob semantics). */
  get lo() {
    return fieldLens(this, "lo", Num);
  }
  /** End endpoint. Writes preserve `lo` (end-knob semantics). */
  get hi() {
    return fieldLens(this, "hi", Num);
  }

  get width() {
    return cachedDerive(this, "width", Num, width);
  }
  /** Midpoint body-drag: reads the center; a write shifts the range so the
   *  center matches (width preserved). */
  get center(): Writable<Num> {
    return Num.lens(this, center, (c, src) => {
      const half = (src.hi - src.lo) / 2;
      return { lo: c - half, hi: c + half };
    });
  }

  /** Translate by `by`. */
  shift(by: Val<number>): this {
    const f = reader(by);
    return this.lens(
      v => ({ lo: v.lo + f(), hi: v.hi + f() }),
      n => ({ lo: n.lo - f(), hi: n.hi - f() }),
    );
  }
  /** Scale about the origin. Invertible when k ≠ 0. */
  scale(k: Val<number>): this {
    const kf = reader(k);
    return this.lens(
      v => {
        const k = kf();
        return { lo: v.lo * k, hi: v.hi * k };
      },
      n => {
        const k = kf();
        return { lo: n.lo / k, hi: n.hi / k };
      },
    );
  }

  /** Body-drag handle: reads `lo`; a write shifts the range so `lo` matches
   *  (width preserved). */
  get start(): Writable<Num> {
    return Num.lens(
      this,
      v => v.lo,
      (newLo, src) => ({ lo: newLo, hi: newLo + (src.hi - src.lo) }),
    );
  }

  /** RO sample at `t`. `t ∈ [0, 1]` stays inside; outside extrapolates. */
  sample(t: Val<number>): Num {
    return Num.derive(() => sample(this.value, readNow(t)));
  }
  /** Bidirectional `t ↔ value` slider. Read `lo + t·(hi - lo)`; write
   *  solves for `t` and updates `t` only, leaving `lo` / `hi` put. */
  slider(t: Writable<Num>): Writable<Num> {
    // `this as Range` pins the tuple element type; polymorphic `this` breaks
    // the mapped-tuple inference.
    return Num.lens(
      [this as Range, t] as const,
      ([r, tv]) => sample(r, tv),
      (v, [r]) => {
        const w = r.hi - r.lo;
        return [SKIP, w === 0 ? 0 : (v - r.lo) / w];
      },
    );
  }

  /** True when `v` is in `[lo, hi]`. A writable `Num` yields a `Writable<Bool>`:
   *  flipping it clamps `v` inside (`true`) or ejects it past the nearest
   *  endpoint (`false`). Literal/RO inputs yield a read-only `Bool`. */
  contains<P extends Val<number>>(v: P): P extends WritableBrand ? Writable<Bool> : Bool {
    if (v instanceof Num) {
      // RO Num has no backward path; only writable Nums accept write-back.
      if (!isReadonly(v)) {
        return Bool.lens(
          [this, v] as never,
          (vals: readonly [V, number]) => contains(vals[0], vals[1]),
          (target, vals) => {
            const [r, n] = vals as readonly [V, number];
            if (contains(r, n) === target) return [SKIP, SKIP] as never;
            return [SKIP, target ? clamp(r, n) : eject(r, n)] as never;
          },
        ) as never;
      }
    }
    return Bool.derive(() => contains(this.value, readNow(v))) as never;
  }
  /** Read-only clamp of `v` into `[lo, hi]`. */
  clampedRead(v: Val<number>): Num {
    return Num.derive(() => clamp(this.value, readNow(v)));
  }
  /** Inverse of `sample`: derive the `t` that would produce `v`. */
  paramOf(v: Val<number>): Num {
    return Num.derive(() => paramOf(this.value, readNow(v)));
  }

  /** Tween-builder. */
  to(this: Writable<Range>, target: V, dur: Val<number>, ease?: Easing): Tween<V> {
    return tween(this, target, dur, ease);
  }
}

/** Lens combining two writable `Num`s into a `Range`. */
function ends(lo: Writable<Num>, hi: Writable<Num>): Writable<Range> {
  return Range.lens(
    [lo, hi] as const,
    (vals): V => ({ lo: vals[0], hi: vals[1] }),
    (target: V) => [target.lo, target.hi] as never,
  );
}

/** Range over `[at, at + dur]`, backed by the live `at` and `dur` Nums. */
export function span(at: Writable<Num>, dur: Writable<Num>): Writable<Range> {
  return Range.lens(
    [at, dur] as const,
    (vals): V => ({ lo: vals[0], hi: vals[0] + vals[1] }),
    (target: V) => [target.lo, target.hi - target.lo] as never,
  );
}

/** Writable `Range` over `[lo, hi]`. Each endpoint is a literal (new cell) or
 *  existing writable (passed through); for read-only sources use `Range.derive`.
 *  Lock an endpoint with `Num.pin`. */
export function range(lo: Init<Num> = 0, hi: Init<Num> = 1): Writable<Range> {
  if (typeof lo === "number" && typeof hi === "number") {
    return new Range({ lo, hi }) as Writable<Range>;
  }
  return ends(num(lo), num(hi));
}
