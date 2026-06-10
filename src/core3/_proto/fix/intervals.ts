// intervals.ts — the spine on a TALL lattice (the real value-class shape).
//   run: npx vite-node src/core3/_proto/fix/intervals.ts
//
// Two checks:
//  (A) FUZZ vs naive on bounded-integer intervals (finite ⇒ exact lfp), using
//      genuine interval contractors (equality, shift, sum) — cyclic narrowing,
//      the Range/Num workload. Validates the spine reproduces the exact fixpoint.
//  (B) WIDENING demo: a real-valued contracting cycle whose exact fixpoint needs
//      INFINITELY many narrowing steps. Plain Kleene would spin forever; a
//      widening that snaps a still-moving bound terminates (with a sound
//      over-approximation), confirming the `widen` hook does its job.

import { type Lattice, Net, type Rule } from "./engine";

// ── (A) bounded-integer intervals ───────────────────────────────────
const R = 16; // every interval lives inside the box [-R, R]; outside ⇒ EMPTY.
type Iv = { lo: number; hi: number };
const FULL: Iv = { lo: -R, hi: R };
const EMPTY: Iv = { lo: R + 1, hi: -(R + 1) }; // the one canonical contradiction.
const isEmpty = (v: Iv): boolean => v.lo > v.hi;
// Canonicalize: anything inverted/out-of-box collapses to the single EMPTY, so
// values can never drift past the box (finite lattice ⇒ guaranteed termination).
const norm = (lo: number, hi: number): Iv => (lo > hi ? EMPTY : { lo, hi });
const clamp = (lo: number, hi: number): Iv => norm(Math.max(lo, -R), Math.min(hi, R));

const interval: Lattice<Iv> = {
  bottom: FULL,
  join: (a, b) => norm(Math.max(a.lo, b.lo), Math.min(a.hi, b.hi)), // intersection
  eq: (a, b) => (isEmpty(a) && isEmpty(b)) || (a.lo === b.lo && a.hi === b.hi),
};
const ivAdd = (a: Iv, b: Iv): Iv => clamp(a.lo + b.lo, a.hi + b.hi);
const ivSub = (a: Iv, b: Iv): Iv => clamp(a.lo - b.hi, a.hi - b.lo);
const ivShift = (a: Iv, k: number): Iv => clamp(a.lo + k, a.hi + k);

function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t ^= t + Math.imul(t ^ (t >>> 7), 61 | t);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// A network of interval cells with random contractors. Each constraint installs
// monotone rules on BOTH sides (the bidirectional propagator), so cycles abound.
type Con =
  | { k: "eq"; a: number; b: number }
  | { k: "shift"; a: number; b: number; d: number } // a = b + d
  | { k: "sum"; a: number; b: number; c: number }; // a = b + c

interface Spec {
  n: number;
  facts: Iv[];
  cons: Con[];
}

function genSpec(rnd: () => number): Spec {
  const n = 3 + Math.floor(rnd() * 8);
  const facts = Array.from({ length: n }, () => {
    if (rnd() < 0.5) return FULL;
    const lo = Math.floor(rnd() * (2 * R + 1)) - R;
    const hi = Math.floor(rnd() * (R - lo + 1)) + lo;
    return { lo, hi };
  });
  const cons: Con[] = [];
  const m = Math.floor(rnd() * (n * 1.5));
  for (let i = 0; i < m; i++) {
    const r = rnd();
    const a = Math.floor(rnd() * n);
    const b = Math.floor(rnd() * n);
    if (r < 0.5) cons.push({ k: "eq", a, b });
    else if (r < 0.8) cons.push({ k: "shift", a, b, d: Math.floor(rnd() * 9) - 4 });
    else cons.push({ k: "sum", a, b, c: Math.floor(rnd() * n) });
  }
  return { n, facts, cons };
}

/** From-scratch greatest-consistent-box fixpoint over ALL cells: monotone
 *  chaotic iteration that *accumulates* contractions (never resets to facts),
 *  exactly the contractor semantics. Finite lattice ⇒ terminates. This is the
 *  independent oracle — flat round-robin, no SCC structure — for the engine. */
function naive(spec: Spec): Iv[] {
  const v = spec.facts.map(f => ({ ...f }));
  const meet = (i: number, x: Iv): void => {
    v[i] = interval.join(v[i]!, x);
  };
  for (;;) {
    const before = v.map(x => `${x.lo},${x.hi}`).join(";");
    for (const con of spec.cons) {
      if (con.k === "eq") {
        meet(con.a, v[con.b]!);
        meet(con.b, v[con.a]!);
      } else if (con.k === "shift") {
        meet(con.a, ivShift(v[con.b]!, con.d));
        meet(con.b, ivShift(v[con.a]!, -con.d));
      } else {
        meet(con.a, ivAdd(v[con.b]!, v[con.c]!));
        meet(con.b, ivSub(v[con.a]!, v[con.c]!));
        meet(con.c, ivSub(v[con.a]!, v[con.b]!));
      }
    }
    if (v.map(x => `${x.lo},${x.hi}`).join(";") === before) return v;
  }
}

function build(spec: Spec): { net: Net<Iv>; cells: ReturnType<Net<Iv>["cell"]>[] } {
  const net = new Net(interval);
  const cells = spec.facts.map(f => net.cell(f));
  const r = (t: number, fn: Rule<Iv>): void => net.rule(cells[t]!, fn);
  for (const con of spec.cons) {
    if (con.k === "eq") {
      r(con.a, get => get(cells[con.b]!));
      r(con.b, get => get(cells[con.a]!));
    } else if (con.k === "shift") {
      r(con.a, get => ivShift(get(cells[con.b]!), con.d));
      r(con.b, get => ivShift(get(cells[con.a]!), -con.d));
    } else {
      r(con.a, get => ivAdd(get(cells[con.b]!), get(cells[con.c]!)));
      r(con.b, get => ivSub(get(cells[con.a]!), get(cells[con.c]!)));
      r(con.c, get => ivSub(get(cells[con.a]!), get(cells[con.b]!)));
    }
  }
  return { net, cells };
}

let fails = 0;
const SEEDS = 3000;
for (let seed = 1; seed <= SEEDS && fails < 5; seed++) {
  const rnd = mulberry32(seed * 2654435761);
  const spec = genSpec(rnd);
  const want = naive(spec);
  const { net, cells } = build(spec);
  const order = [...cells.keys()].sort(() => rnd() - 0.5);
  for (const i of order) {
    const got = net.read(cells[i]!);
    if (!interval.eq(got, want[i]!)) {
      console.log(`FAIL seed=${seed} cell=${i} got=${JSON.stringify(got)} want=${JSON.stringify(want[i])}`);
      console.log(JSON.stringify(spec));
      fails++;
      break;
    }
  }
}
console.log(fails === 0 ? `(A) intervals ALL PASS (${SEEDS} seeds)` : `(A) ${fails} FAILURES`);

// ── (B) widening on an infinite-descent real-valued cycle ───────────
// x and y with: x ⊑ [y.lo, y.hi] shrunk 10% toward 0, y ⊑ [x.lo, x.hi] likewise.
// Exact narrowing converges to {0,0} only in the limit (infinitely many steps).
// A widening that, past a threshold, snaps a still-moving bound to its limit (0)
// terminates with the sound answer.
type Rv = { lo: number; hi: number };
const real: Lattice<Rv> = {
  bottom: { lo: -1e9, hi: 1e9 },
  join: (a, b) => ({ lo: Math.max(a.lo, b.lo), hi: Math.min(a.hi, b.hi) }),
  eq: (a, b) => Math.abs(a.lo - b.lo) < 1e-12 && Math.abs(a.hi - b.hi) < 1e-12,
  widen: (prev, next, iter) => {
    if (iter < 12) return next; // refine exactly for a while…
    // …then snap any bound still moving toward 0 to its limit (0).
    const lo = next.lo > prev.lo ? 0 : next.lo;
    const hi = next.hi < prev.hi ? 0 : next.hi;
    return { lo, hi };
  },
};
{
  const net = new Net(real);
  const x = net.cell({ lo: -100, hi: 100 });
  const y = net.cell({ lo: -100, hi: 100 });
  const shrink = (v: Rv): Rv => ({ lo: v.lo * 0.9, hi: v.hi * 0.9 });
  net.rule(x, get => shrink(get(y)));
  net.rule(y, get => shrink(get(x)));
  const t0 = performance.now();
  const rx = net.read(x);
  const ms = performance.now() - t0;
  console.log(`(B) widening cycle → x=${JSON.stringify(rx)} in ${ms.toFixed(2)}ms (terminated; sound ⊇ {0,0})`);
}
