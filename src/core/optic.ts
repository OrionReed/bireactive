// Lenses as first-class values, independent of any `Cell`. An `Optic<A, B>` is a
// lens transform *unbound* — a `get`/`put` pair you compose, store, and apply to
// a source with `cell.through(optic)` (≡ `lens(cell, o.get, o.put)`). Composition
// is ordinary lens composition: `(f ∘ g).put(c, a) = f.put(g.put(c, f.get(a)),
// a)`, reconstructing the inner source from `a` each back-write. An `iso` is the
// lossless case whose `put` ignores the source (`readsSource = false`), so
// `through` can bind a cheaper 1-arg backward. No complement here — use
// `lens(parent, spec)` when you need one.
//
// The `Optic` type lives in cell.ts so that file stays import-free and its
// `Cell.through` can name it; this module is the constructor/algebra surface.

import type { Optic } from "./cell";

function make<A, B>(get: (a: A) => B, put: (b: B, a: A) => A, readsSource: boolean): Optic<A, B> {
  return {
    get,
    put,
    readsSource,
    through<C>(next: Optic<B, C>): Optic<A, C> {
      // Composed backward reconstructs the inner B from the outer A, so it always
      // reads the source regardless of either side's own `readsSource`.
      return make<A, C>(
        a => next.get(get(a)),
        (c, a) => put(next.put(c, get(a)), a),
        true,
      );
    },
  };
}

/** Build an optic from a forward and a backward. A 2-arg `put(b, a)` reads the
 *  source; a 1-arg `put(b)` reconstructs it (and is treated as an `iso`). */
export function optic<A, B>(get: (a: A) => B, put: (b: B, a: A) => A): Optic<A, B> {
  return make(get, put, put.length >= 2);
}

/** A lossless, source-independent optic (an isomorphism): `to`/`from` invert. */
export function iso<A, B>(to: (a: A) => B, from: (b: B) => A): Optic<A, B> {
  return make(to, b => from(b), false);
}

/** Field optic: project key `K`, putting back with a spread-replace. */
export function atKey<T, K extends keyof T>(key: K): Optic<T, T[K]> {
  return make(
    t => t[key],
    (v, t) => ({ ...t, [key]: v }),
    true,
  );
}

/** Compose optics left-to-right into one: `compose(a, b, c)` is `a` then `b` then
 *  `c`. Typed for up to three; falls back to `Optic<unknown, unknown>` beyond. */
export function compose<A, B>(a: Optic<A, B>): Optic<A, B>;
export function compose<A, B, C>(a: Optic<A, B>, b: Optic<B, C>): Optic<A, C>;
export function compose<A, B, C, D>(a: Optic<A, B>, b: Optic<B, C>, c: Optic<C, D>): Optic<A, D>;
export function compose(...optics: Optic<unknown, unknown>[]): Optic<unknown, unknown> {
  return optics.reduce((a, b) => a.through(b));
}
