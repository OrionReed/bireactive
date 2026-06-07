// numeric.ts — the handful of interval atoms.
//
// Every relation here narrows interval cells via `merge` and nothing
// else, so each is monotone and the whole set composes into bigger
// relations that inherit termination and order-independence for free.
//
// These are the primitives layout and graph layering desugar to:
//   bound   — x ∈ [lo, hi]
//   equal   — a = b            (alignment)
//   order   — a + gap ≤ b      (spacing / ordering / packing / layering)
//   add     — a + b = c        (offsets, content sizes)
//   total   — Σ parts + slack = whole   (flex main axis, distribution)

import { type Interval, type LatticeCell, merge } from "./lattice";
import { type Propagator, propagator } from "./solver";

type I = LatticeCell<Interval>;

const ninf = Number.NEGATIVE_INFINITY;
const pinf = Number.POSITIVE_INFINITY;

/** `x ∈ [lo, hi]`. Self-applying, so a widening write gets re-narrowed. */
export function bound(x: I, lo: number, hi: number): Propagator {
  return propagator([x], [x], () => {
    merge(x, [lo, hi]);
  });
}

/** Pin `x` to a single value. */
export function fix(x: I, v: number): Propagator {
  return bound(x, v, v);
}

/** `a = b`. Each side narrows to the intersection, so order is irrelevant. */
export function equal(a: I, b: I): Propagator[] {
  return [
    propagator([a], [b], () => {
      merge(b, a.value);
    }),
    propagator([b], [a], () => {
      merge(a, b.value);
    }),
  ];
}

/** `a + gap ≤ b`. Narrows `a` from above and `b` from below. */
export function order(a: I, b: I, gap = 0): Propagator[] {
  return [
    propagator([b], [a], () => {
      merge(a, [ninf, b.value[1] - gap]);
    }),
    propagator([a], [b], () => {
      merge(b, [a.value[0] + gap, pinf]);
    }),
  ];
}

/** `a + b = c`. Three narrowers; any two bound the third. */
export function add(a: I, b: I, c: I): Propagator[] {
  return [
    propagator([a, b], [c], () => {
      merge(c, [a.value[0] + b.value[0], a.value[1] + b.value[1]]);
    }),
    propagator([a, c], [b], () => {
      merge(b, [c.value[0] - a.value[1], c.value[1] - a.value[0]]);
    }),
    propagator([b, c], [a], () => {
      merge(a, [c.value[0] - b.value[1], c.value[1] - b.value[0]]);
    }),
  ];
}

/** `Σ parts = whole`. N+1 narrowers: whole from the parts, and each part
 *  from whole minus the others. Order-independent. */
export function total(parts: readonly I[], whole: I): Propagator[] {
  if (parts.length === 0) return [];
  const props: Propagator[] = [
    propagator(parts, [whole], () => {
      let lo = 0;
      let hi = 0;
      for (const p of parts) {
        lo += p.value[0];
        hi += p.value[1];
      }
      merge(whole, [lo, hi]);
    }),
  ];
  for (let i = 0; i < parts.length; i++) {
    const target = parts[i]!;
    const others = parts.filter((_, j) => j !== i);
    props.push(
      propagator([whole, ...others], [target], () => {
        let oLo = 0;
        let oHi = 0;
        for (const o of others) {
          oLo += o.value[0];
          oHi += o.value[1];
        }
        merge(target, [whole.value[0] - oHi, whole.value[1] - oLo]);
      }),
    );
  }
  return props;
}
