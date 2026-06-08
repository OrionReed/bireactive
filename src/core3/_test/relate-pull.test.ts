// Pull-driven solving: an SCC is a generalized COMPUTED, so the fixpoint
// runs lazily on read, once per invalidation, in dependency order — and it
// inherits the engine's glitch-freedom (no stale re-runs across components).
// These tests pin those properties, which the old effect-push model lacked.

import { describe, expect, it } from "vitest";
import { effect, num, range, settle } from "../index";
import { constrain, equal } from "../relate";

describe("solving is lazy and demand-driven", () => {
  it("does not solve until a member is read", () => {
    let runs = 0;
    const a = range(0, 100);
    const b = range(40, 60);
    constrain([a], [b], (get, emit) => {
      runs++;
      emit(b, get(a));
    });
    constrain([b], [a], (get, emit) => {
      runs++;
      emit(a, get(b));
    });

    expect(runs).toBe(0); // declared, but nothing pulled it → no work

    expect(a.value).toEqual({ lo: 40, hi: 60 });
    const afterFirstRead = runs;
    expect(afterFirstRead).toBeGreaterThan(0);

    // Reading again with no input change reuses the memoized solve.
    void b.value;
    void a.value;
    expect(runs).toBe(afterFirstRead);
  });

  it("re-solves only after an input (base) write", () => {
    let runs = 0;
    const a = range(0, 100);
    const b = range(0, 100);
    constrain([a], [b], (get, emit) => {
      runs++;
      emit(b, get(a));
    });
    constrain([b], [a], (get, emit) => {
      runs++;
      emit(a, get(b));
    });
    void a.value;
    const settled = runs;

    // Writing a member writes its assertion and invalidates the region.
    a.value = { lo: 20, hi: 80 };
    expect(runs).toBe(settled); // not yet — nobody has read
    expect(a.value).toEqual({ lo: 20, hi: 80 });
    expect(runs).toBeGreaterThan(settled); // pulled → re-solved once
  });
});

describe("glitch-freedom across chained SCCs", () => {
  it("a downstream effect fires once per upstream change (no stale re-runs)", () => {
    // Two cycles A={a,b}, C={c,d}; C is narrowed by A's member `a`, so A is
    // strictly upstream of C in the condensation.
    const a = range(0, 100);
    const b = range(0, 100);
    equal(a, b); // SCC A

    const c = range(0, 100);
    const d = range(0, 100);
    equal(c, d); // SCC C
    // c ≥ a.lo  (reads a, an external to C) — makes A upstream of C
    constrain([a], [c], (get, emit) => emit(c, { lo: get(a).lo, hi: Number.POSITIVE_INFINITY }));

    let fires = 0;
    let seen = { lo: 0, hi: 0 };
    const stop = effect(() => {
      fires++;
      seen = c.value;
    });
    expect(fires).toBe(1); // initial run

    // One upstream change → exactly one downstream fire, with the FINAL
    // value (pull pulls A before C; never an intermediate/stale c).
    a.value = { lo: 30, hi: 100 };
    settle();
    expect(fires).toBe(2);
    expect(seen.lo).toBe(30);

    stop();
  });

  it("an unrelated external change does not re-solve a component", () => {
    let runs = 0;
    const a = range(0, 100);
    const b = range(0, 100);
    const unrelated = num(5);
    constrain([a], [b], (get, emit) => {
      runs++;
      emit(b, get(a));
    });
    constrain([b], [a], (get, emit) => {
      runs++;
      emit(a, get(b));
    });
    void a.value;
    const settled = runs;

    unrelated.value = 99; // touches nothing in the component
    void a.value;
    expect(runs).toBe(settled);
  });
});

describe("derived views track the solved member", () => {
  it("a value-class view re-pulls when the solve changes", () => {
    const a = range(0, 100);
    const b = range(40, 60);
    equal(a, b);
    expect(a.width.value).toBe(20); // [40,60]

    a.value = { lo: 45, hi: 100 }; // assert a ≥ 45 → meet → [45,60]
    expect(a.value).toEqual({ lo: 45, hi: 60 });
    expect(a.width.value).toBe(15);
  });
});
