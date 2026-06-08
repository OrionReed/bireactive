// The engine's REAL async scheduling, exercised through the actual
// `queueMicrotask` path rather than the synchronous `settle()` escape hatch.
// The value graph stays synchronous (read-back, lens laws), but terminal
// EFFECTS defer to a microtask — so N synchronous writes coalesce into one
// effect run, net-zero reverts never fire, and `settle()` is just a
// synchronous drain of the same queue.

import { describe, expect, it } from "vitest";
import { cell, derive, effect, Num, num, settle } from "../index";

/** Drain all pending microtasks. The engine schedules effects via
 *  `queueMicrotask`; a macrotask boundary guarantees they've all run. */
const tick = (): Promise<void> => new Promise(r => setTimeout(r, 0));

describe("microtask effects: coalescing", () => {
  it("N synchronous writes fire the effect once, with the final value", async () => {
    const a = cell(0);
    let runs = 0;
    let last = -1;
    effect(() => {
      last = a.value;
      runs++;
    });
    runs = 0;

    a.value = 1;
    a.value = 2;
    a.value = 3;
    expect(runs).toBe(0); // deferred — nothing has fired yet this tick

    await tick();
    expect(runs).toBe(1); // coalesced into a single run
    expect(last).toBe(3); // only the final value is observed
  });

  it("a net-zero revert in one tick never fires the effect", async () => {
    const a = cell(0);
    let runs = 0;
    effect(() => {
      void a.value;
      runs++;
    });
    runs = 0;

    a.value = 5;
    a.value = 0; // revert within the same synchronous run
    await tick();
    expect(runs).toBe(0); // a staged-then-reverted source commits no change
  });

  it("a diamond is glitch-free across the microtask boundary", async () => {
    const a = cell(0);
    const b1 = derive(() => a.value + 1);
    const b2 = derive(() => a.value * 10);
    const seen: Array<{ b1: number; b2: number }> = [];
    effect(() => {
      seen.push({ b1: b1.value, b2: b2.value });
    });
    seen.length = 0;

    a.value = 5;
    a.value = 10;
    await tick();
    expect(seen).toEqual([{ b1: 11, b2: 100 }]); // one consistent final snapshot
  });

  it("the value graph stays synchronous even while effects are deferred", () => {
    const a = cell(0);
    const doubled = derive(() => a.value * 2);
    a.value = 21;
    // No tick: the read-back and downstream computed are already settled.
    expect(a.value).toBe(21);
    expect(doubled.value).toBe(42);
  });
});

describe("microtask effects: settle() equivalence", () => {
  it("settle() yields the same observation as awaiting a tick", async () => {
    const a = cell(0);
    let last = -1;
    let runs = 0;
    effect(() => {
      last = a.value;
      runs++;
    });
    runs = 0;

    a.value = 1;
    a.value = 2;
    settle();
    expect(runs).toBe(1);
    expect(last).toBe(2);

    // Nothing remains queued, so a subsequent tick is a no-op.
    await tick();
    expect(runs).toBe(1);
  });
});

describe("microtask effects: termination", () => {
  it("a self-writing effect reaches a fixpoint within one drain", async () => {
    const b = cell(false);
    let fires = 0;
    const stop = effect(() => {
      fires++;
      if (fires < 1000 && b.value) b.value = false; // toggle off when on
    });
    b.value = true;
    await tick();
    expect(fires).toBeLessThan(1000); // converges; not bounded by the guard
    expect(b.value).toBe(false);
    stop();
  });
});

describe("microtask effects: stateful lens under coalescing", () => {
  it("monotonic-snap lens: sync writes resolve synchronously; effect coalesces", async () => {
    const src = num(0);
    // Complement stores the last written value; writes below it snap up.
    const snapped = Num.lens([src], {
      init: () => ({ last: 0 }),
      step: ([s]) => ({ last: s }),
      fwd: ([s]) => s,
      bwd: (t, _s, c) => {
        const next = t < c.last ? c.last : t;
        return { updates: [next], complement: { last: next } };
      },
    });
    let last = -1;
    let runs = 0;
    effect(() => {
      last = src.value;
      runs++;
    });
    runs = 0;

    snapped.value = 5; // src → 5
    snapped.value = 3; // below last(5): snapped up, src unchanged
    snapped.value = 8; // src → 8
    expect(src.value).toBe(8); // backward path is synchronous

    await tick();
    expect(runs).toBe(1); // downstream effect coalesced to one run
    expect(last).toBe(8); // with the final, complement-threaded value
  });
});
