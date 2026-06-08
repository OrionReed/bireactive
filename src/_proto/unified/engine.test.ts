// Probing the unified engine's semantics — especially the two questions
// the design conversation flagged: (1) is the BACKWARD fold (the old
// `merge()`) well-defined and order-independent? (2) do N-update CYCLES
// converge correctly? The discrete lattice answers conflicts with ⊥;
// the interval lattice answers them with intersection. Both are confluent.

import { describe, expect, it } from "vitest";
import {
  batch,
  type Cell,
  computed,
  effect,
  isContradiction,
  lastWaves,
  lens1,
  prop,
  reset,
  source,
} from "./engine";
import { type Interval, interval, point } from "./lattice";

// ── interval relation combinators (the propagator layer, on the engine) ──

const NINF = Number.NEGATIVE_INFINITY;
const PINF = Number.POSITIVE_INFINITY;

function ival(lo = NINF, hi = PINF): Cell<Interval> {
  return source<Interval>([lo, hi], interval);
}

/** a = b (both narrow to the intersection). */
function equalI(a: Cell<Interval>, b: Cell<Interval>): void {
  prop([a], [b], emit => () => emit(b, a.peek()));
  prop([b], [a], emit => () => emit(a, b.peek()));
}

/** a + gap ≤ b. */
function orderI(a: Cell<Interval>, b: Cell<Interval>, gap = 0): void {
  prop([b], [a], emit => () => emit(a, [NINF, b.peek()[1] - gap] as Interval));
  prop([a], [b], emit => () => emit(b, [a.peek()[0] + gap, PINF] as Interval));
}

describe("forward (signals degenerate case)", () => {
  it("computed tracks its inputs", () => {
    const a = source(2);
    const b = source(3);
    const sum = computed([a, b], ([x, y]) => x + y);
    expect(sum.value).toBe(5);
    a.value = 10;
    expect(sum.value).toBe(13);
  });

  it("effects re-run only when a dependency moves", () => {
    const a = source(1);
    const log: number[] = [];
    effect(() => log.push(a.value));
    a.value = 1; // no-op (discrete equals)
    a.value = 2;
    expect(log).toEqual([1, 2]);
  });
});

describe("backward (lens) — the bidirectional case", () => {
  it("writing a derived end resolves the source", () => {
    const celsius = source(20);
    const fahrenheit = lens1(
      celsius,
      c => (c * 9) / 5 + 32,
      f => ((f - 32) * 5) / 9,
    );
    expect(fahrenheit.value).toBe(68);
    fahrenheit.value = 212;
    expect(celsius.value).toBe(100);
    expect(fahrenheit.value).toBe(212);
  });

  it("a lens chain inverts step by step", () => {
    const p = source(10);
    const scaled = lens1(
      p,
      v => v * 2,
      t => t / 2,
    );
    const shifted = lens1(
      scaled,
      v => v + 5,
      t => t - 5,
    );
    expect(shifted.value).toBe(25);
    shifted.value = 5; // invert +5 then ×2
    expect(p.value).toBe(0);
  });
});

// ── THE CORE QUESTION: N backward writes into one source ──────────────

describe("reverse diamond — N contributions fold via the cell's lattice", () => {
  // Source S, two views A and B. Write BOTH in one settle. What happens
  // to S? This is exactly what backward `merge()` was groping at.

  it("discrete source: agreeing views commit, conflicting views are ⊥", () => {
    const s = source(0);
    const plus10 = lens1(
      s,
      v => v + 10,
      t => t - 10,
    );
    const plus20 = lens1(
      s,
      v => v + 20,
      t => t - 20,
    );

    // Agree: A wants s=5, B wants s=5 → commit.
    batch(() => {
      plus10.value = 15; // s := 5
      plus20.value = 25; // s := 5
    });
    expect(s.value).toBe(5);
    expect(isContradiction(s)).toBe(false);

    // Conflict: A wants s=5, B wants s=99 → ⊥, NOT last-write-wins.
    batch(() => {
      plus10.value = 15; // s := 5
      plus20.value = 119; // s := 99
    });
    expect(isContradiction(s)).toBe(true);
  });

  it("discrete conflict is ORDER-INDEPENDENT (both orders → ⊥)", () => {
    const make = () => {
      const s = source(0);
      const a = lens1(
        s,
        v => v,
        t => t,
      );
      const b = lens1(
        s,
        v => v,
        t => t,
      );
      return { s, a, b };
    };

    const x = make();
    batch(() => {
      x.a.value = 1;
      x.b.value = 2;
    });

    const y = make();
    batch(() => {
      y.b.value = 2; // reversed order
      y.a.value = 1;
    });

    expect(isContradiction(x.s)).toBe(true);
    expect(isContradiction(y.s)).toBe(true); // same verdict either way
  });

  it("interval source: two views narrow it from both sides (intersection)", () => {
    // The multitouch-shaped case: two constraints on one value that
    // DON'T conflict — they refine. A discrete cell can't express this;
    // a lattice cell folds them into an intersection.
    const s = ival(0, 100);
    // View "at least 30": writing it lower-bounds s.
    const atLeast = lens1<Interval, number>(
      s,
      v => v[0],
      (t, _v) => [t, PINF] as Interval,
    );
    // View "at most 70": writing it upper-bounds s.
    const atMost = lens1<Interval, number>(
      s,
      v => v[1],
      (t, _v) => [NINF, t] as Interval,
    );

    batch(() => {
      atLeast.value = 30;
      atMost.value = 70;
    });
    expect(s.value).toEqual([30, 70]);
    expect(isContradiction(s)).toBe(false);

    // Order-independent: reverse the writes, same intersection.
    const s2 = ival(0, 100);
    const lo = lens1<Interval, number>(
      s2,
      v => v[0],
      t => [t, PINF] as Interval,
    );
    const hi = lens1<Interval, number>(
      s2,
      v => v[1],
      t => [NINF, t] as Interval,
    );
    batch(() => {
      hi.value = 70;
      lo.value = 30;
    });
    expect(s2.value).toEqual([30, 70]);
  });
});

// ── THE OTHER CORE QUESTION: cycles with N updates ────────────────────

describe("cycles — N updates converge by lattice height", () => {
  it("a 2-cycle (a = b) converges to the intersection", () => {
    const a = ival(0, 50);
    const b = ival(20, 100);
    equalI(a, b);
    expect(a.value).toEqual([20, 50]);
    expect(b.value).toEqual([20, 50]);
  });

  it("longest-path ranking via an order-constraint chain (DAG fixpoint)", () => {
    // n0 → n1 → n2 → n3, plus a skip n0 → n3. Layers = longest path.
    const n = [ival(0), ival(0), ival(0), ival(0)];
    orderI(n[0]!, n[1]!, 1);
    orderI(n[1]!, n[2]!, 1);
    orderI(n[2]!, n[3]!, 1);
    orderI(n[0]!, n[3]!, 1);
    const layer = (c: Cell<Interval>) => Math.round(c.peek()[0]);
    expect(n.map(layer)).toEqual([0, 1, 2, 3]);
  });

  it("convergence is order-independent: shuffle constraint install order", () => {
    const build = (order: number[]) => {
      const c = [ival(0, 100), ival(0, 100), ival(0, 100)];
      const edges: Array<[number, number]> = [
        [0, 1],
        [1, 2],
      ];
      for (const i of order) equalI(c[edges[i]![0]]!, c[edges[i]![1]]!);
      // narrow the ends
      c[0]!.value = [10, 100];
      c[2]!.value = [0, 40];
      return c.map(x => x.value);
    };
    expect(build([0, 1])).toEqual(build([1, 0]));
  });

  it("an over-constrained cycle collapses to ⊥, not an oscillation", () => {
    const a = ival(0, 10);
    const b = ival(20, 30);
    equalI(a, b); // [0,10] ∩ [20,30] = empty
    expect(isContradiction(a)).toBe(true);
    expect(lastWaves).toBeLessThan(10); // terminated fast, didn't spin
  });
});

// ── warm-start vs reset (the staleness subtlety) ──────────────────────

describe("monotone warm-start", () => {
  it("narrowing persists across settles; reset clears it", () => {
    const s = ival(0, 100);
    s.value = [10, 90];
    expect(s.value).toEqual([10, 90]);
    s.value = [20, 80]; // narrows further (monotone)
    expect(s.value).toEqual([20, 80]);
    reset(s);
    expect(point(s.value)).toBeUndefined(); // back to top
    s.value = [5, 95];
    expect(s.value).toEqual([5, 95]);
  });
});
