// Lenses as first-class values, independent of any `Cell`. An `Optic<S, V>` is a
// lens transform *unbound* — a `get`/`put` pair you store and apply to a source
// with `cell.lens(optic)` / `lens(source, optic)`. Chain several by passing them to
// one `lens(source, a, b, …)` call; the binder folds the chain by re-binding (its
// `put` reconstructs the inner source on each back-write). An `iso` is the lossless
// case whose `put` ignores the source (a 1-arg `put`). These constructors build the
// *pure* (complement-free) optics; complement-carrying optics are plain objects with
// a `complement` seed (see the Optic type and the stateful-lens header in cell.ts).
//
// `optic.ts` imports only *types* from `cell.ts`, so `cell.ts` can apply optics by
// re-binding without importing this module (no cycle).

import type { Optic } from "./cell";

/** Build an optic from a forward and a backward. A 2-arg `put(b, a)` reads the
 *  source; a 1-arg `put(b)` reconstructs it (and is treated as an `iso`). */
export function optic<A, B>(get: (a: A) => B, put: (b: B, a: A) => A): Optic<A, B> {
  return { get, put: put as Optic<A, B>["put"] };
}

/** A lossless, source-independent optic (an isomorphism): `to`/`from` invert. */
export function iso<A, B>(to: (a: A) => B, from: (b: B) => A): Optic<A, B> {
  return { get: to, put: ((b: B) => from(b)) as Optic<A, B>["put"] };
}

/** Field optic: project key `K`, putting back with a spread-replace. */
export function atKey<T, K extends keyof T>(key: K): Optic<T, T[K]> {
  return {
    get: (t: T) => t[key],
    put: ((v: T[K], t: T) => ({ ...t, [key]: v })) as Optic<T, T[K]>["put"],
  };
}
