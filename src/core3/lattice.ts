// lattice.ts — domain-faithful knowledge lattices and the combinators value
// classes build them from.
//
// A `Lattice<T, K>` separates the cell's VALUE type `T` from the KNOWLEDGE
// type `K` used inside a cyclic solve. `K` carries partial information (an
// interval, a per-field product, a flat known/unknown/conflict); the solver
// folds contributions by `meet`, and at the component boundary `concretize`
// collapses `K` back to a concrete `T` — falling back to the cell's current
// value when underdetermined, so no lattice element ever leaks into the DAG
// (the "underdetermined = current value" rule). `abstract` lifts a concrete
// seed/input into `K`.
//
// Faithfulness lever: pick `K` so the field lenses you care about are
// homomorphisms. A scalar uses `flat` (known or not). A pair/record uses
// `tuple`, so each field narrows independently and `.field` projects cleanly.
// A coordinate that admits ordered narrowing (an endpoint, an extent) uses
// `interval`.

import type { Lattice } from "./cell";

// ── flat: ⊥ (unknown) / value / ⊤ (conflict) ────────────────────────
// `top` is the no-information identity for `meet`; `BOT` is contradiction.
// The concrete value rides bare (no wrapper) — distinct from both sentinels.
export const TOP: unique symbol = Symbol("⊤");
export const BOT: unique symbol = Symbol("⊥");
export type Flat<T> = T | typeof TOP | typeof BOT;

/** Flat lattice over `T`: any two distinct concretes conflict. The universal
 *  default — sound (if coarse) for any value class. */
export function flat<T>(eq: (a: T, b: T) => boolean = Object.is): Lattice<T, Flat<T>> {
  const isVal = (x: Flat<T>): x is T => x !== TOP && x !== BOT;
  return {
    top: TOP,
    meet: (a, b) => {
      if (a === TOP) return b;
      if (b === TOP) return a;
      if (a === BOT || b === BOT) return BOT;
      return eq(a, b) ? a : BOT;
    },
    equals: (a, b) => a === b || (isVal(a) && isVal(b) && eq(a, b)),
    isBottom: a => a === BOT,
    abstract: v => v,
    concretize: (k, fallback) => (isVal(k) ? k : fallback),
    pinned: k => (isVal(k) ? k : undefined),
  };
}

// ── interval: ordered scalar knowledge [min, max] ───────────────────
export interface Iv {
  readonly min: number;
  readonly max: number;
}

/** How small a narrowing step a real interval may take before `widen` snaps
 *  it shut — the post-fixpoint tolerance that makes an infinite descending
 *  chain (an endlessly-halving bound) terminate soundly. Only consulted once
 *  a solve is slow enough to start widening; exact, fast-converging solves
 *  never see it. */
const WIDEN_EPS = 1e-6;

/** Interval lattice over a real coordinate: `T = number`, `K = [min,max]`.
 *  `meet` is intersection; a concrete abstracts to a point; `concretize`
 *  yields the point when pinned, else the current value clamped into the
 *  surviving interval (it moves only if it must). Infinite height (a bound
 *  can narrow forever), so it carries a `widen` accelerator. */
export const interval: Lattice<number, Iv> = {
  top: { min: Number.NEGATIVE_INFINITY, max: Number.POSITIVE_INFINITY },
  meet: (a, b) => ({ min: Math.max(a.min, b.min), max: Math.min(a.max, b.max) }),
  equals: (a, b) => a.min === b.min && a.max === b.max,
  isBottom: a => a.min > a.max,
  abstract: v => ({ min: v, max: v }),
  concretize: (k, fallback) => {
    if (k.min > k.max) return fallback; // ⊥ (over-constrained) → keep current
    if (k.min === k.max) return k.min; // pinned
    return Math.max(k.min, Math.min(k.max, fallback)); // underdetermined: move only if forced
  },
  pinned: k => (k.min === k.max && Number.isFinite(k.min) ? k.min : undefined),
  // Narrowing raises `min` / lowers `max`. A bound still inching by less than
  // WIDEN_EPS is frozen at its previous position — a finite, sound stop for an
  // otherwise-infinite descent. Bounds taking real steps are left exact, so
  // they reach their (finite-valued) limit in finitely many waves regardless.
  widen: (prev, next) => {
    let { min, max } = next;
    if (min > prev.min && min - prev.min < WIDEN_EPS) min = prev.min;
    if (max < prev.max && prev.max - max < WIDEN_EPS) max = prev.max;
    return min === next.min && max === next.max ? next : { min, max };
  },
};

// ── tuple: componentwise product over named fields ──────────────────
// biome-ignore lint/suspicious/noExplicitAny: heterogeneous sub-lattices
type AnyLat = Lattice<any, any>;

/** Product lattice over a record `T`: each field carries its own sub-lattice,
 *  `meet`/`equals`/`isBottom`/`abstract`/`concretize` run field-wise. Makes a
 *  field lens a homomorphism (it projects to one component). `K` is the record
 *  of per-field knowledge. */
export function tuple<T extends Record<string, unknown>>(
  subs: {
    [K in keyof T]: Lattice<T[K], unknown>;
  },
): Lattice<T, Record<keyof T, unknown>> {
  const keys = Object.keys(subs) as (keyof T)[];
  const sub = (k: keyof T): AnyLat => subs[k] as AnyLat;
  // Carry `widen` only if some field needs it; a product of finite-height
  // fields stays finite-height and omits it (no global cap, no acceleration).
  const widens = keys.some(k => sub(k).widen !== undefined);
  return {
    top: Object.fromEntries(keys.map(k => [k, sub(k).top])) as Record<keyof T, unknown>,
    meet: (a, b) =>
      Object.fromEntries(keys.map(k => [k, sub(k).meet(a[k], b[k])])) as Record<keyof T, unknown>,
    equals: (a, b) => keys.every(k => sub(k).equals(a[k], b[k])),
    isBottom: a => keys.some(k => sub(k).isBottom(a[k])),
    abstract: v =>
      Object.fromEntries(keys.map(k => [k, sub(k).abstract(v[k])])) as Record<keyof T, unknown>,
    concretize: (k, fallback) =>
      Object.fromEntries(keys.map(key => [key, sub(key).concretize(k[key], fallback[key])])) as T,
    pinned: k => {
      const out = {} as T;
      for (const key of keys) {
        const v = sub(key).pinned(k[key]);
        if (v === undefined) return undefined;
        out[key] = v as T[keyof T];
      }
      return out;
    },
    widen: widens
      ? (prev, next) =>
          Object.fromEntries(
            keys.map(key => {
              const s = sub(key);
              return [key, s.widen ? s.widen(prev[key], next[key]) : next[key]];
            }),
          ) as Record<keyof T, unknown>
      : undefined,
  };
}
