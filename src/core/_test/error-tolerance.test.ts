// Error-tolerance contract: user code (a getter, a `put`, a `fold`, a `step`, an
// effect body) may throw, and the engine must never be left broken. The guarantees:
//   - the user's own error surfaces unchanged (transparent, not swallowed/wrapped);
//   - the failed unit is dropped, the rest of the graph stays consistent;
//   - global engine state recovers, so unrelated graphs and later ops still work;
//   - a throwing effect doesn't strand its sibling effects (run-all locality).
//
// These pin behavior the redesign relies on ("the engine can never be broken by
// user code throwing, and errors are somewhat local and reported nicely").

import { describe, expect, it } from "vitest";
import { cell, derive, effect, lens, settle } from "../cell";

type V = { value: number };
const idLens = (p: unknown, fwd: (x: number) => number, bwd: (t: number) => number): V =>
  lens(p as never, fwd as never, bwd as never) as never;

describe("error tolerance", () => {
  it("a throwing put surfaces its own error and drops the write", () => {
    const s = cell(0) as unknown as V;
    const bad = idLens(
      s,
      x => x,
      () => {
        throw new Error("boom-put");
      },
    );
    expect(() => {
      bad.value = 5;
      void (s as V).value; // pull → resolve → put throws
    }).toThrow("boom-put");
    // Write dropped, source untouched, re-reads stable (no re-throw, no corruption).
    expect((s as V).value).toBe(0);
    expect((s as V).value).toBe(0);
  });

  it("recovers fully: an unrelated graph works after a put throws", () => {
    const s = cell(0) as unknown as V;
    const bad = idLens(
      s,
      x => x,
      () => {
        throw new Error("boom");
      },
    );
    try {
      bad.value = 1;
      void (s as V).value;
    } catch {}

    const other = cell(100) as unknown as V;
    const ov = idLens(
      other,
      x => x * 2,
      t => t / 2,
    );
    ov.value = 20;
    settle();
    expect((other as V).value).toBe(10); // engine state recovered cleanly
  });

  it("a throwing forward getter recovers and re-reads deterministically", () => {
    const s = cell(1) as unknown as V;
    let explode = true;
    const d = derive(
      s as never,
      ((x: number) => {
        if (explode) throw new Error("boom-getter");
        return x * 2;
      }) as never,
    ) as unknown as V;

    expect(() => void d.value).toThrow("boom-getter");
    // The engine isn't wedged: fix the input condition and it recomputes cleanly.
    explode = false;
    (s as V).value = 5;
    expect(d.value).toBe(10);
  });

  it("a throwing co-writer doesn't lose an already-committed co-writer", () => {
    const s = cell(0) as unknown as V;
    const good = idLens(
      s,
      x => x,
      t => t + 1,
    );
    const bad = idLens(
      s,
      x => x,
      () => {
        throw new Error("boom-co");
      },
    );
    const e1 = effect(() => void good.value);
    const e2 = effect(() => void bad.value);
    settle();

    good.value = 10; // resolves first → commits s = 11
    bad.value = 20; // throws on resolve
    expect(() => settle()).toThrow("boom-co");
    expect((s as V).value).toBe(11); // good co-writer landed; not rolled back
    e1();
    e2();
  });

  it("a throwing effect body does not strand sibling effects", () => {
    const s = cell(0) as unknown as V;
    const ran: string[] = [];
    const stops = [
      effect(() => {
        void (s as V).value;
        ran.push("a");
      }),
      effect(() => {
        const v = (s as V).value;
        ran.push("b");
        if (v !== 0) throw new Error("boom-effect"); // not on the initial run
      }),
      effect(() => {
        void (s as V).value;
        ran.push("c");
      }),
    ];
    settle();
    ran.length = 0;

    (s as V).value = 1;
    expect(() => settle()).toThrow("boom-effect"); // error still surfaces
    // All three bodies ran despite the middle one throwing (locality).
    expect(ran.sort()).toEqual(["a", "b", "c"]);

    // Engine recovered: a later write fires everyone again.
    ran.length = 0;
    (s as V).value = 2;
    try {
      settle();
    } catch {}
    expect(ran.sort()).toEqual(["a", "b", "c"]);
    for (const stop of stops) stop();
  });

  it("a throwing merge fold drops the fold and recovers", () => {
    const s = cell(0);
    const m = (s as unknown as { merge: (f: (vs: number[]) => number) => V }).merge(() => {
      throw new Error("boom-fold");
    });
    expect(() => {
      m.value = 7;
      void (s as unknown as V).value; // pull → resolve → fold throws
    }).toThrow("boom-fold");
    // Unrelated write still works.
    const s2 = cell(3) as unknown as V;
    const v2 = idLens(
      s2,
      x => x,
      t => t,
    );
    v2.value = 9;
    settle();
    expect((s2 as V).value).toBe(9);
  });
});
