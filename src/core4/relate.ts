// relate.ts — bidirectional coupling on top of the propagator spine.
//
// A `bidir` is just two directional propagators that keep two cells in agreement
// (b = fwd(a) ∧ a = bwd(b)). Because each direction's write is equality-gated,
// a consistent pair settles after the back-edge reproduces the value already
// there — the same termination that lets cyclic layouts converge. Both ends stay
// writable: dragging either side pushes through to the other.
//
// `lens` is the common case where one end doesn't exist yet: it mints the coupled
// cell from `fwd(a)`. The result is a *writable* derived cell — not a read-only
// computed — so it can itself be constrained by further propagators.

import { type Cell, cell, type Propagator, propagator } from "./engine";

/** Couple two existing cells so b = fwd(a) and a = bwd(b) stay in sync.
 *  Returns the two directional propagators (dispose to break the coupling). */
export function bidir<A, B>(
  a: Cell<A>,
  b: Cell<B>,
  fwd: (a: A) => B,
  bwd: (b: B) => A,
): [Propagator, Propagator] {
  const ac = a as Cell<unknown>;
  const bc = b as Cell<unknown>;
  const fwdP = propagator([ac], () => b.set(fwd(a.peek())));
  const bwdP = propagator([bc], () => a.set(bwd(b.peek())));
  return [fwdP, bwdP];
}

/** A writable cell coupled to `a` through an invertible map. Both ends remain
 *  writable and independently constrainable. */
export function lens<A, B>(a: Cell<A>, fwd: (a: A) => B, bwd: (b: B) => A): Cell<B> {
  const b = cell(fwd(a.peek()));
  bidir(a, b, fwd, bwd);
  return b;
}
