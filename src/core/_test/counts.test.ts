// Counts-first baselines. These pin the *minimal* work for canonical shapes so the
// upcoming unification has a calculable target: a refactor must not raise these. We
// assert the high-signal, stable metrics — user-callback invocations (put/fold/step)
// and recomputes — not the incidental visit counts that are an implementation detail.

import { describe, expect, it } from "vitest";
import { withCounts } from "../_counts";
import { cell, derive, lens, settle } from "../cell";

type V = { value: number };
const idLens = (p: unknown, k: number, b: number): V =>
  lens(
    p as never,
    ((x: number) => k * x + b) as never,
    ((t: number) => (t - b) / k) as never,
  ) as never;

describe("counts: minimal-work baselines", () => {
  it("a 1→1 lens chain write invokes exactly one put per lens, nothing else", () => {
    const D = 4;
    const s = cell(0);
    let p: unknown = s;
    for (let i = 0; i < D; i++) p = idLens(p, 1, 1);
    const top = p as V;

    const { counts } = withCounts(() => {
      top.value = 10;
      void (s as unknown as V).value; // pull the source → resolve the back-write
    });
    expect(counts.arm).toBe(1);
    expect(counts.armBlocked).toBe(0);
    expect(counts.put).toBe(D); // one backward callback per lens — the minimum
    expect(counts.fold).toBe(0);
    expect(counts.step).toBe(0);
    expect(counts.markDownVisit).toBe(D + 1); // D lenses + the source
  });

  it("a blocked write does no work beyond the rejection", () => {
    const s = cell(0);
    const ro = derive(s as never, ((x: number) => x + 1) as never);
    const blocked = idLens(ro, 1, 0);

    const { counts } = withCounts(() => {
      try {
        blocked.value = 5;
      } catch {}
    });
    expect(counts.armBlocked).toBe(1);
    expect(counts.arm).toBe(0);
    expect(counts.put).toBe(0);
    expect(counts.markDownVisit).toBe(0); // threw before descending
    expect(counts.linkChild).toBe(0);
  });

  it("re-reading a clean derived recomputes zero times", () => {
    const s = cell(2);
    const d = derive(s as never, ((x: number) => x * 3) as never) as unknown as V;
    void d.value;
    settle();

    const { counts } = withCounts(() => {
      void d.value;
      void d.value;
      void d.value;
    });
    expect(counts.recompute).toBe(0);
  });

  it("a merge folds exactly once per resolve", () => {
    const s = cell(0);
    const m = (s as unknown as { merge: () => V }).merge();

    const { counts } = withCounts(() => {
      m.value = 9;
      void (s as unknown as V).value; // pull → resolve
    });
    expect(counts.fold).toBe(1);
    expect(counts.put).toBe(0); // a merge has no put; it folds then writes its parent
  });

  it("a pure own back-write puts once and does not step", () => {
    const s = cell(1);
    const st = lens(
      s as never,
      {
        init: () => 0,
        step: (_s: number, c: number) => c,
        fwd: (v: number) => v,
        bwd: (t: number) => ({ update: t, complement: 0 }),
      } as never,
    ) as unknown as V;
    void st.value; // realize forward before measuring the backward path
    settle();

    const { counts } = withCounts(() => {
      st.value = 7;
      void (s as unknown as V).value; // pull → resolve
    });
    expect(counts.put).toBe(1);
    // No step: the source hasn't moved since the last sync (version stamp matches),
    // so `bwd`'s complement is committed directly — provenance says "own write".
    expect(counts.step).toBe(0);
  });

  it("an external source change steps the complement once on the next read", () => {
    const s = cell(1);
    const st = lens(
      s as never,
      {
        init: (v: number) => v,
        fwd: (v: number, c: number) => v + c,
        bwd: (t: number) => ({ update: t, complement: 0 }),
      } as never,
    ) as unknown as V;
    void st.value; // sync stamp to s.version
    settle();

    const { counts } = withCounts(() => {
      (s as unknown as V).value = 9; // outside change → bumps s.version
      void st.value; // read: version moved → step (default init) once
    });
    expect(counts.step).toBe(1);
  });
});
