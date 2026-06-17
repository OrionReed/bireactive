// Value-level lens-law checkers for the schema kit, expressed as fast-check
// properties so a violation shrinks to a minimal repro. These run against the
// pure `VLens` core (the complement is threaded explicitly), which is where
// the laws actually live; the cell `Step` is just a lifting of it.
//
//   GetPut : bwd(fwd(s)) leaves the source unchanged (write back the read).
//   PutGet : fwd(bwd(v)) == v               (read what you wrote).
//   PutPut : bwd(v2) after bwd(v1) == bwd(v2)   (last write wins on source).

import fc from "fast-check";
import type { Obj, VLens } from "../lens";

/** Structural equality: objects compared by key-set (order-insensitive),
 *  arrays elementwise, everything else by `Object.is`. */
export function deepEqual(a: unknown, b: unknown): boolean {
  if (Object.is(a, b)) return true;
  if (Array.isArray(a) || Array.isArray(b)) {
    if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length) return false;
    return a.every((x, i) => deepEqual(x, b[i]));
  }
  if (a && b && typeof a === "object" && typeof b === "object") {
    const ka = Object.keys(a as Obj);
    const kb = Object.keys(b as Obj);
    if (ka.length !== kb.length) return false;
    return ka.every(k => k in (b as Obj) && deepEqual((a as Obj)[k], (b as Obj)[k]));
  }
  return false;
}

const J = (x: unknown) => JSON.stringify(x);

export interface VLawOpts {
  trials?: number;
  sourceEq?: (a: Obj, b: Obj) => boolean;
  viewEq?: (a: Obj, b: Obj) => boolean;
}

function eqs(o: VLawOpts) {
  return {
    sourceEq: o.sourceEq ?? deepEqual,
    viewEq: o.viewEq ?? deepEqual,
    trials: o.trials ?? 200,
  };
}

/** GetPut: writing back the read is a no-op on the source. */
export function getPutV<C>(
  lens: VLens<Obj, Obj, C>,
  src: fc.Arbitrary<Obj>,
  o: VLawOpts = {},
): void {
  const { sourceEq, trials } = eqs(o);
  fc.assert(
    fc.property(src, s => {
      const c = lens.init(s);
      const v = lens.fwd(s, c);
      const r = lens.bwd(v, s, c);
      if (!sourceEq(r.s, s)) throw new Error(`GetPut: ${J(s)} → ${J(r.s)} (view ${J(v)})`);
    }),
    { numRuns: trials },
  );
}

/** PutGet: reading after a write returns the written view. */
export function putGetV<C>(
  lens: VLens<Obj, Obj, C>,
  src: fc.Arbitrary<Obj>,
  view: fc.Arbitrary<Obj>,
  o: VLawOpts = {},
): void {
  const { viewEq, trials } = eqs(o);
  fc.assert(
    fc.property(src, view, (s, w) => {
      const c = lens.init(s);
      const r = lens.bwd(w, s, c);
      const back = lens.fwd(r.s, r.c);
      if (!viewEq(back, w)) throw new Error(`PutGet: wrote ${J(w)}, read ${J(back)}`);
    }),
    { numRuns: trials },
  );
}

/** PutPut: the last of two writes wins on the source. */
export function putPutV<C>(
  lens: VLens<Obj, Obj, C>,
  src: fc.Arbitrary<Obj>,
  view: fc.Arbitrary<Obj>,
  o: VLawOpts = {},
): void {
  const { sourceEq, trials } = eqs(o);
  fc.assert(
    fc.property(src, view, view, (s, w1, w2) => {
      const c = lens.init(s);
      const r1 = lens.bwd(w1, s, c);
      const r12 = lens.bwd(w2, r1.s, r1.c);
      const r2 = lens.bwd(w2, s, c);
      if (!sourceEq(r12.s, r2.s)) throw new Error(`PutPut: ${J(r12.s)} vs ${J(r2.s)}`);
    }),
    { numRuns: trials },
  );
}

/** All three (very-well-behaved). */
export function veryWellBehavedV<C>(
  lens: VLens<Obj, Obj, C>,
  src: fc.Arbitrary<Obj>,
  view: fc.Arbitrary<Obj>,
  o: VLawOpts = {},
): void {
  getPutV(lens, src, o);
  putGetV(lens, src, view, o);
  putPutV(lens, src, view, o);
}
