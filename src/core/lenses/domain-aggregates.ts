// Closed-form aggregate lenses driven by the Linear/Metric traits, so `mean`,
// `spread`, `mix` work for any conforming class (Vec, Color, Pose, Range,
// Box, …). Plus a couple of fixed-shape decompositions (Bezier, time series).

import {
  type Cell,
  type Linear,
  type Metric,
  Num,
  type Read,
  reader,
  SKIP,
  type Traits,
  type Val,
  Vec,
  type Writable,
} from "../index";
import { remember } from "./memory";

/** Equal-weight mean (writable of `inputs[0]`'s class); writes distribute
 *  the delta evenly. Class inferred from the first input; needs `linear`. */
// biome-ignore lint/suspicious/noExplicitAny: variance escape
export function mean<S extends Traits<any, "linear">>(inputs: readonly Writable<S>[]): Writable<S> {
  if (inputs.length === 0) throw new Error("mean: need ≥ 1 input");
  // biome-ignore lint/suspicious/noExplicitAny: dynamic class lookup
  const Cls = (inputs[0] as any).constructor as new (...args: never[]) => Cell<any>;
  // biome-ignore lint/suspicious/noExplicitAny: dynamic trait lookup
  const lin = (Cls as any).traits?.linear as Linear<any> | undefined;
  if (!lin) throw new Error(`mean: ${(Cls as { name?: string }).name ?? "?"} has no traits.linear`);
  const n = inputs.length;
  const inv = 1 / n;
  // biome-ignore lint/suspicious/noExplicitAny: variance escape on Cls.lens
  return (Cls as any).lens(
    inputs,
    // biome-ignore lint/suspicious/noExplicitAny: variance escape
    (vals: any) => {
      let acc = vals[0];
      for (let i = 1; i < n; i++) acc = lin.add(acc, vals[i]);
      return lin.scale(acc, inv);
    },
    // biome-ignore lint/suspicious/noExplicitAny: variance escape
    (target: any, vals: any) => {
      let cur = vals[0];
      for (let i = 1; i < n; i++) cur = lin.add(cur, vals[i]);
      cur = lin.scale(cur, inv);
      const delta = lin.sub(target, cur);
      const out: unknown[] = new Array(n);
      for (let i = 0; i < n; i++) out[i] = lin.add(vals[i], delta);
      return out;
    },
  );
}

/** Weighted blend of K branches over any `Linear` type: reads the normalized
 *  weighted sum `Σ wᵢ·aᵢ`, writes the minimum-norm delta back into the
 *  branches (zero-weight branches untouched). Weights are read-only reactive
 *  controls — a one-hot is `select`, a `(1−t, t)` edge is `crossfade`. */
// biome-ignore lint/suspicious/noExplicitAny: variance escape
export function mix<S extends Traits<any, "linear">>(
  weights: readonly Val<number>[],
  branches: readonly Writable<S>[],
): Writable<S> {
  const K = branches.length;
  if (K < 1) throw new Error("mix: need ≥ 1 branch");
  if (weights.length !== K) throw new Error("mix: weights/branches length mismatch");
  // biome-ignore lint/suspicious/noExplicitAny: dynamic class lookup
  const Cls = (branches[0] as any).constructor as new (...args: never[]) => Cell<any>;
  // biome-ignore lint/suspicious/noExplicitAny: dynamic trait lookup
  const lin = (Cls as any).traits?.linear as Linear<any> | undefined;
  if (!lin) throw new Error(`mix: ${(Cls as { name?: string }).name ?? "?"} has no traits.linear`);
  const wf = weights.map(w => reader(w));

  // Normalized weights + Σw². Degenerate (all-zero) weights fall back to
  // uniform so the read stays defined.
  const readW = (): { w: number[]; sumSq: number } => {
    const raw = wf.map(f => f());
    let sum = 0;
    for (const x of raw) sum += x;
    const w = Math.abs(sum) > 1e-12 ? raw.map(x => x / sum) : raw.map(() => 1 / K);
    let sumSq = 0;
    for (const x of w) sumSq += x * x;
    return { w, sumSq };
  };

  // biome-ignore lint/suspicious/noExplicitAny: variance escape on Cls.lens
  const combine = (vals: any[], w: number[]) => {
    let acc = lin.scale(vals[0], w[0]);
    for (let i = 1; i < K; i++) acc = lin.add(acc, lin.scale(vals[i], w[i]));
    return acc;
  };

  // biome-ignore lint/suspicious/noExplicitAny: variance escape on Cls.lens
  return (Cls as any).lens(
    branches,
    // biome-ignore lint/suspicious/noExplicitAny: variance escape
    (vals: any) => combine(vals, readW().w),
    // biome-ignore lint/suspicious/noExplicitAny: variance escape
    (target: any, vals: any) => {
      const { w, sumSq } = readW();
      const delta = lin.sub(target, combine(vals, w));
      if (sumSq < 1e-12) return vals.map(() => SKIP);
      const inv = 1 / sumSq;
      return vals.map((v: unknown, i: number) =>
        w[i] === 0 ? SKIP : lin.add(v, lin.scale(delta, w[i]! * inv)),
      );
    },
  );
}

/** Two-branch router (mix simplex *vertex*): reads the live branch, writes
 *  flow entirely to it, the other is left put. Flipping `cond` snaps the
 *  output to the other branch's stored value. */
// biome-ignore lint/suspicious/noExplicitAny: variance escape
export function select<S extends Traits<any, "linear">>(
  cond: Read<boolean>,
  whenFalse: Writable<S>,
  whenTrue: Writable<S>,
): Writable<S> {
  return mix(
    [Num.derive(() => (cond.value ? 0 : 1)), Num.derive(() => (cond.value ? 1 : 0))],
    [whenFalse, whenTrue],
  );
}

/** Two-branch crossfade (mix simplex *edge*): `lerp(a, b, t)`. Writing
 *  keeps `t` fixed and splits the delta by influence. */
// biome-ignore lint/suspicious/noExplicitAny: variance escape
export function crossfade<S extends Traits<any, "linear">>(
  t: Read<number>,
  a: Writable<S>,
  b: Writable<S>,
): Writable<S> {
  return mix([Num.derive(() => 1 - t.value), Num.derive(() => t.value)], [a, b]);
}

/** Mean distance from the centroid (needs `Linear` + `Metric`); write scales
 *  the cluster's deviations so the new mean matches. The complement carries
 *  normalized deviations, so a collapse (spread → 0) reinflates the shape. */
export function spread<
  T extends NonNullable<unknown>,
  S extends Cell<T> & Traits<T, "linear" | "metric">,
>(inputs: readonly Writable<S>[]): Writable<Num> {
  const K = inputs.length;
  if (K < 1) throw new Error("spread: need ≥ 1 input");
  // biome-ignore lint/suspicious/noExplicitAny: dynamic class lookup
  const Cls = (inputs[0] as any).constructor as {
    traits?: { linear?: Linear<T>; metric?: Metric<T> };
  };
  const lin = Cls.traits?.linear;
  const met = Cls.traits?.metric;
  if (!lin || !met) {
    throw new Error(`spread: ${(Cls as { name?: string }).name ?? "?"} needs Linear + Metric`);
  }
  const inv = 1 / K;

  const centroid = (vals: readonly T[]): T => {
    let acc = vals[0]!;
    for (let i = 1; i < K; i++) acc = lin.add(acc, vals[i]!);
    return lin.scale(acc, inv);
  };
  const meanSpread = (vals: readonly T[], ctr: T): number => {
    let total = 0;
    for (let i = 0; i < K; i++) total += met(vals[i]!, ctr);
    return total * inv;
  };

  // Mean metric-distance from the centroid is a magnitude `remember`:
  // writing it scales the cluster's deviations about the centroid, and a
  // collapse (spread → 0) reinflates the remembered shape.
  return remember(inputs, {
    anchor: (vals: readonly T[]) => centroid(vals),
    feature: (vals: readonly T[], ctr: T) => meanSpread(vals, ctr),
  });
}

/** Mean/spread decomposition: K values → {mean, spread}, i.e. centroid +
 *  uniform scale about it. `mean` ∘ `spread`; works for any
 *  Linear + Metric class (palettes, point clouds, poses, …). */
export function meanSpread<
  T extends NonNullable<unknown>,
  S extends Cell<T> & Traits<T, "linear" | "metric">,
>(colors: readonly Writable<S>[]): { mean: Writable<S>; spread: Writable<Num> } {
  return {
    mean: mean(colors),
    spread: spread(colors as never),
  };
}

type V = { x: number; y: number };

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

/** Num values as (i, valueᵢ) samples → {mean, slope}. Writing `mean` shifts
 *  all values; writing `slope` (least-squares) tilts them about the mean.
 *  Each preserves the other's reading. */
export function timeSeries(values: readonly Writable<Num>[]): {
  mean: Writable<Num>;
  slope: Writable<Num>;
} {
  const N = values.length;
  if (N < 2) throw new Error("timeSeries: need ≥ 2 values");

  const mean = Num.lens(
    values,
    (vals: readonly number[]) => {
      let s = 0;
      for (let i = 0; i < N; i++) s += vals[i]!;
      return s / N;
    },
    (target: number, vals: readonly number[]) => {
      let s = 0;
      for (let i = 0; i < N; i++) s += vals[i]!;
      const cur = s / N;
      const delta = target - cur;
      return vals.map(v => v + delta);
    },
  );

  // Least-squares slope = Σ (i − idxMean)(v − mean) / Σ (i − idxMean)²,
  // idxMean = (N−1)/2 constant. Write tilts about the mean:
  // value_i = mean + (i − idxMean)·s.
  const idxMean = (N - 1) / 2;
  let denomSlope = 0;
  for (let i = 0; i < N; i++) {
    const di = i - idxMean;
    denomSlope += di * di;
  }

  const slope = Num.lens(
    values,
    (vals: readonly number[]) => {
      let valMean = 0;
      for (let i = 0; i < N; i++) valMean += vals[i]!;
      valMean /= N;
      let num = 0;
      for (let i = 0; i < N; i++) num += (i - idxMean) * (vals[i]! - valMean);
      return num / denomSlope;
    },
    (target: number, vals: readonly number[]) => {
      let valMean = 0;
      for (let i = 0; i < N; i++) valMean += vals[i]!;
      valMean /= N;
      return vals.map((_, i) => valMean + (i - idxMean) * target);
    },
  );

  return { mean, slope };
}
