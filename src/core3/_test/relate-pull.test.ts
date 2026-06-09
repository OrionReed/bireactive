// Pull-driven solving: an SCC is a generalized COMPUTED, so the fixpoint
// runs lazily on read, once per invalidation, in dependency order — and it
// inherits the engine's glitch-freedom (no stale re-runs across components).
// These tests pin those properties, which the old effect-push model lacked.
//
// `Flags` (bit-AND candidate sets) is used as the narrowing lattice: it
// genuinely narrows between two concretes, so a re-solve is observable.

import { describe, expect, it } from "vitest";
import { effect, Flags, num, settle } from "../index";
import { assert, constrain, equal } from "../relate";

const F = ["b0", "b1", "b2", "b3"] as const;
const fl = (m: number) => new Flags([...F], m);

describe("solving is lazy and demand-driven", () => {
  it("does not solve until a member is read", () => {
    let runs = 0;
    const a = fl(0b1111);
    const b = fl(0b0101);
    constrain([a], [b], (get, emit) => {
      runs++;
      emit(b, get(a));
    });
    constrain([b], [a], (get, emit) => {
      runs++;
      emit(a, get(b));
    });

    expect(runs).toBe(0); // declared, but nothing pulled it → no work

    expect(a.value).toBe(0b0101); // AND of bases
    const afterFirstRead = runs;
    expect(afterFirstRead).toBeGreaterThan(0);

    void b.value; // re-read with no input change → reuse memoized solve
    void a.value;
    expect(runs).toBe(afterFirstRead);
  });

  it("re-solves only after an input (base) write", () => {
    let runs = 0;
    const a = fl(0b1111);
    const b = fl(0b1111);
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

    a.value = 0b0011; // write a member → writes its assertion, invalidates region
    expect(runs).toBe(settled); // not yet — nobody has read
    expect(a.value).toBe(0b0011);
    expect(runs).toBeGreaterThan(settled); // pulled → re-solved once
  });
});

describe("glitch-freedom across chained SCCs", () => {
  it("a downstream effect fires once per upstream change (no stale re-runs)", () => {
    // Two cycles A={a,b}, C={c,d}; C is narrowed by A's member `a`, so A is
    // strictly upstream of C in the condensation.
    const a = fl(0b1111);
    const b = fl(0b1111);
    equal(a, b); // SCC A

    const c = fl(0b1111);
    const d = fl(0b1111);
    equal(c, d); // SCC C
    constrain([a], [c], (get, emit) => emit(c, get(a))); // c := c ⊓ a → A upstream

    let fires = 0;
    let seen = 0;
    const stop = effect(() => {
      fires++;
      seen = c.value;
    });
    expect(fires).toBe(1); // initial run

    a.value = 0b0011; // one upstream change → exactly one downstream fire
    settle();
    expect(fires).toBe(2);
    expect(seen).toBe(0b0011); // FINAL value (A pulled before C; never stale)

    stop();
  });

  it("an unrelated external change does not re-solve a component", () => {
    let runs = 0;
    const a = fl(0b1111);
    const b = fl(0b1111);
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

  it("a re-solve that leaves a member's output unchanged doesn't fire its effect", () => {
    // Per-member OUTPUT dirtiness: the Component re-solves as a unit, but each
    // member projection prunes on `_equals`, so a watched member whose solved
    // slot is unchanged never notifies — even though the SCC re-ran.
    const a = fl(0b0111);
    const b = fl(0b0011);
    equal(a, b); // SCC {a,b}: meet → a = b = 0b0011

    let fires = 0;
    const stop = effect(() => {
      fires++;
      void b.value;
    });
    expect(fires).toBe(1); // initial run
    expect(b.value).toBe(0b0011);

    // Re-assert `a` to a SUPERSET of b's standing mask: the meet with b's base
    // (0b0011) is still 0b0011, so neither member's output moves.
    assert(a, 0b1011);
    settle();
    expect(b.value).toBe(0b0011); // unchanged
    expect(fires).toBe(1); // output stable → no re-fire despite the re-solve

    // A re-assert that genuinely narrows the meet DOES fire.
    assert(a, 0b0001);
    settle();
    expect(b.value).toBe(0b0001);
    expect(fires).toBe(2);

    stop();
  });
});

describe("derived views track the solved member", () => {
  it("a value-class view re-pulls when the solve changes", () => {
    const a = fl(0b1111);
    const b = fl(0b1111);
    equal(a, b);
    expect(a.flag("b1").value).toBe(true); // 0b1111

    a.value = 0b1101; // assert a without bit1 → solved 0b1101
    expect(a.value).toBe(0b1101);
    expect(a.flag("b1").value).toBe(false);
  });
});
