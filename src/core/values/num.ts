import { type Easing, type Tween, tween } from "../../animation";
import {
  Cell,
  type Init,
  lazy,
  reader,
  type Val,
  type Writable,
  type WritableBrand,
} from "../cell";
import type { Linear, Pack, TraitDict } from "../traits";
import { Bool } from "./bool";

type V = number;

export const add = (a: V, b: V) => a + b;
export const sub = (a: V, b: V) => a - b;
export const scale = (a: V, k: number) => a * k;
export const lerp = (a: V, b: V, t: number) => a + (b - a) * t;
export const metric = (a: V, b: V) => Math.abs(a - b);
export const equals = (a: V, b: V) => a === b;

const TAU = 2 * Math.PI;
/** Representative of `x + 2πk` nearest `s` (shortest-arc branch pick). */
const nearestTo = (s: V, x: V) => x + TAU * Math.round((s - x) / TAU);
/** Clamp to the sin/cos domain `[-1, 1]`. */
const unit = (t: V) => (t < -1 ? -1 : t > 1 ? 1 : t);

const linearImpl: Linear<V> = { add, sub, scale };
const packImpl: Pack<V> = {
  dim: 1,
  read: (v, a, o) => {
    a[o] = v;
  },
  write: (a, o) => a[o]!,
};

export class Num extends Cell<V> {
  static traits = {
    linear: linearImpl,
    lerp,
    metric,
    equals,
    pack: packImpl,
  } satisfies TraitDict<V>;
  declare readonly _t: typeof Num.traits;

  constructor(v: V = 0) {
    super(v, { equals });
  }

  add(b: Val<V>): this {
    const bf = reader(b);
    return this.lens(
      v => v + bf(),
      n => n - bf(),
    );
  }
  sub(b: Val<V>): this {
    const bf = reader(b);
    return this.lens(
      v => v - bf(),
      n => n + bf(),
    );
  }
  scale(k: Val<number>): this {
    const kf = reader(k);
    return this.lens(
      v => v * kf(),
      n => n / kf(),
    );
  }
  /** Affine map `v ↦ k·v + off`. Invertible when k ≠ 0. */
  affine(k: Val<number>, off: Val<number>): this {
    const kf = reader(k);
    const of = reader(off);
    return this.lens(
      v => v * kf() + of(),
      n => (n - of()) / kf(),
    );
  }

  /** Sine of `this` (radians). The inverse is multi-valued; a write picks the
   *  angle nearest the current value, so a drag stays on its branch. */
  sin(): this {
    return this.lens(
      v => Math.sin(v),
      (target, s) => {
        const p = Math.asin(unit(target));
        const a = nearestTo(s, p);
        const b = nearestTo(s, Math.PI - p);
        return Math.abs(a - s) <= Math.abs(b - s) ? a : b;
      },
    );
  }

  /** Natural exponential; inverts via log. */
  exp(): this {
    return this.lens(
      v => Math.exp(v),
      n => Math.log(n),
    );
  }

  /** Clamp to `[lo, hi]`. Lossy: a write outside the range reads back clamped. */
  clamp(lo: Val<V>, hi: Val<V>): this {
    const lf = reader(lo);
    const hf = reader(hi);
    const c = (v: V) => {
      const l = lf(),
        h = hf();
      return v < l ? l : v > h ? h : v;
    };
    // If the clamped write matches the current view, keep the source
    // (preserves an off-range source value).
    return this.lens(c, (v, s) => {
      const cv = c(v);
      return cv === c(s) ? s : cv;
    });
  }

  /** Snap reads and writes to the nearest multiple of `step` (lossy). */
  quantize(step: Val<number>): this {
    const sf = reader(step);
    const q = (v: V) => {
      const s = sf();
      return Math.round(v / s) * s;
    };
    // If the write snaps to the current bucket, keep the source
    // (preserves an off-grid remainder).
    return this.lens(q, (v, src) => {
      const qv = q(v);
      return qv === q(src) ? src : qv;
    });
  }

  /** Reads pass through; a write picks the value closest to the current one
   *  modulo `period`, so dragging an angle never jumps a full turn. */
  cyclic(period: Val<number>): this {
    const pf = reader(period);
    return this.lens(
      v => v,
      (v, s) => {
        const p = pf();
        const delta = v - s;
        return s + delta - p * Math.round(delta / p);
      },
    );
  }

  /** `this > t` as a Bool. Flipping it bumps the source across the
   *  threshold by `eps`. */
  greaterThan<T extends Num>(
    this: T,
    t: Val<V>,
    eps: Val<V> = 1e-6,
  ): T extends WritableBrand ? Writable<Bool> : Bool {
    const tf = reader(t);
    const ef = reader(eps);
    return Bool.lens(
      this,
      v => v > tf(),
      (target, current) => {
        const th = tf();
        if (target === current > th) return current;
        return target ? th + ef() : th - ef();
      },
    ) as never;
  }

  /** `this < t` as a Bool. */
  lessThan<T extends Num>(
    this: T,
    t: Val<V>,
    eps: Val<V> = 1e-6,
  ): T extends WritableBrand ? Writable<Bool> : Bool {
    const tf = reader(t);
    const ef = reader(eps);
    return Bool.lens(
      this,
      v => v < tf(),
      (target, current) => {
        const th = tf();
        if (target === current < th) return current;
        return target ? th - ef() : th + ef();
      },
    ) as never;
  }

  /** True when `round(this)` is divisible by `d`. A write snaps to the nearest
   *  multiple of `d` to make it divisible, or bumps by 1 to make it not. */
  divisibleBy<T extends Num>(this: T, d: Val<V>): T extends WritableBrand ? Writable<Bool> : Bool {
    const df = reader(d);
    return Bool.lens(
      this,
      v => Math.round(v) % df() === 0,
      (target, current) => {
        const dv = df();
        const r = Math.round(current);
        // ((a % b) + b) % b handles negative `r` cleanly.
        const mod = ((r % dv) + dv) % dv;
        const isDiv = mod === 0;
        if (target === isDiv) return current;
        if (target) {
          const down = r - mod;
          const up = r + (dv - mod);
          return Math.abs(current - down) <= Math.abs(current - up) ? down : up;
        }
        return r + 1;
      },
    ) as never;
  }

  /** True when even. */
  get isEven(): this extends WritableBrand ? Writable<Bool> : Bool {
    return lazy(this, "isEven", () => (this as Num).divisibleBy(2)) as never;
  }
  /** True when odd. */
  get isOdd(): this extends WritableBrand ? Writable<Bool> : Bool {
    return lazy(this, "isOdd", () => (this as Num).divisibleBy(2).not()) as never;
  }

  /** Tween-builder. */
  to(this: Writable<Num>, target: V, dur: Val<number>, ease?: Easing): Tween<V> {
    return tween(this, target, dur, ease);
  }
}

/** Writable `Num` from a literal (new cell) or existing writable (passed
 *  through). For read-only sources use `Num.derive`, or `Num.coerce` to lift
 *  any `Val<number>`. */
export function num(v: Init<Num> = 0): Writable<Num> {
  if (v instanceof Num) return v as Writable<Num>;
  return new Num(v) as Writable<Num>;
}
