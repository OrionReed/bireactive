// core4.test.ts — validate the v0 thesis: one engine, acyclic pull + cyclic
// equality-gated relaxation, with bidir/lens and layout on top.

import { describe, expect, it, vi } from "vitest";
import { batch, cell, derive, effect, propagator, settle } from "../engine";
import { above, type Box, beside, box } from "../layout";
import { bidir, lens } from "../relate";

describe("acyclic pull core", () => {
  it("derive is lazy + memoized", () => {
    const a = cell(1);
    const b = cell(2);
    const calls = vi.fn();
    const sum = derive(() => {
      calls();
      return a.get() + b.get();
    });
    expect(calls).toHaveBeenCalledTimes(0); // lazy: not computed until read
    expect(sum.peek()).toBe(3);
    expect(sum.peek()).toBe(3);
    expect(calls).toHaveBeenCalledTimes(1); // memoized
    a.set(10);
    expect(sum.peek()).toBe(12);
    expect(calls).toHaveBeenCalledTimes(2);
  });

  it("effects run on microtask, see settled values (glitch-free)", async () => {
    const a = cell(1);
    const seen: number[] = [];
    effect(() => {
      seen.push(a.get());
    });
    expect(seen).toEqual([1]); // initial run is synchronous
    a.set(2);
    a.set(3);
    a.set(4);
    expect(seen).toEqual([1]); // not yet — batched to microtask
    await Promise.resolve();
    expect(seen).toEqual([1, 4]); // one re-run, final value only
  });

  it("settle() flushes effects synchronously", () => {
    const a = cell(1);
    const seen: number[] = [];
    effect(() => seen.push(a.get()));
    a.set(5);
    settle();
    expect(seen).toEqual([1, 5]);
  });
});

describe("propagator relaxation", () => {
  it("consistent cycle settles (equality-gated)", () => {
    const a = cell(0);
    const b = cell(0);
    // b = a + 1 ∧ a = b - 1  (consistent)
    propagator([a as never], () => b.set(a.peek() + 1));
    propagator([b as never], () => a.set(b.peek() - 1));
    expect(b.peek()).toBe(1);
    a.set(10);
    expect(b.peek()).toBe(11);
    expect(a.peek()).toBe(10);
    b.set(20);
    expect(a.peek()).toBe(19);
  });

  it("inconsistent cycle throws (cap)", () => {
    const a = cell(0);
    const b = cell(0);
    // b = a + 1 ∧ a = b + 1  (no fixpoint → diverges)
    propagator([a as never], () => b.set(a.peek() + 1));
    expect(() => propagator([b as never], () => a.set(b.peek() + 1))).toThrow(/did not converge/);
  });

  it("n-ary propagator narrows (distance-style)", () => {
    const ax = cell(0);
    const bx = cell(3);
    const dist = cell(0);
    // dist = |bx - ax|  (one-directional read of two cells)
    propagator([ax as never, bx as never], () => dist.set(Math.abs(bx.peek() - ax.peek())));
    expect(dist.peek()).toBe(3);
    bx.set(7);
    expect(dist.peek()).toBe(7);
    ax.set(2);
    expect(dist.peek()).toBe(5);
  });
});

describe("bidir / lens", () => {
  it("bidir keeps two cells in sync, both ends writable", () => {
    const a = cell(10);
    const b = cell(0);
    bidir(
      a,
      b,
      x => x + 5,
      y => y - 5,
    );
    expect(b.peek()).toBe(15); // initialised from a
    a.set(100);
    expect(b.peek()).toBe(105);
    b.set(0);
    expect(a.peek()).toBe(-5); // backward drives a
  });

  it("lens mints a writable coupled cell that composes with propagators", () => {
    const a = cell(1);
    const b = lens(
      a,
      x => x + 5,
      y => y - 5,
    ); // b = a.right(5)
    expect(b.peek()).toBe(6);

    // Constrain b further: c mirrors b doubled.
    const c = cell(0);
    propagator([b as never], () => c.set(b.peek() * 2));
    expect(c.peek()).toBe(12);

    a.set(10);
    expect(b.peek()).toBe(15);
    expect(c.peek()).toBe(30);

    b.set(0); // writing the lens drives a backward
    expect(a.peek()).toBe(-5);
    expect(c.peek()).toBe(0);
  });
});

describe("layout: drag any part", () => {
  const rowOfThree = (): { a: Box; b: Box; c: Box } => {
    const a = box(0, 0, 20, 10);
    const b = box(0, 0, 20, 10);
    const c = box(0, 0, 20, 10);
    batch(() => {
      beside(a, b, 5); // b right of a, gap 5
      beside(b, c, 5); // c right of b, gap 5
    });
    return { a, b, c };
  };

  it("initial arrangement is rigid", () => {
    const { a, b, c } = rowOfThree();
    expect(a.x.peek()).toBe(0);
    expect(b.x.peek()).toBe(25); // 0 + 20 + 5
    expect(c.x.peek()).toBe(50); // 25 + 20 + 5
  });

  it("dragging the middle box shifts the whole row", () => {
    const { a, b, c } = rowOfThree();
    b.x.set(125); // drag middle by +100
    expect(a.x.peek()).toBe(100);
    expect(c.x.peek()).toBe(150);
  });

  it("dragging the first box shifts the whole row", () => {
    const { a, b, c } = rowOfThree();
    a.x.set(-30);
    expect(b.x.peek()).toBe(-5);
    expect(c.x.peek()).toBe(20);
  });

  it("vertical drag keeps tops aligned", () => {
    const { a, b, c } = rowOfThree();
    b.y.set(40);
    expect(a.y.peek()).toBe(40);
    expect(c.y.peek()).toBe(40);
  });

  it("above stacks and drags rigidly", () => {
    const a = box(0, 0, 20, 10);
    const b = box(0, 0, 20, 10);
    above(a, b, 5); // b below a, gap 5
    expect(b.y.peek()).toBe(15); // 0 + 10 + 5
    b.y.set(115);
    expect(a.y.peek()).toBe(100);
  });

  it("over-constrained arrangement throws honestly", () => {
    const a = box(0, 0, 20, 10);
    const b = box(0, 0, 20, 10);
    beside(a, b, 5); // b.x = a.x + 25
    // Also force b directly to the LEFT of a — contradictory with beside.
    expect(() => propagator([a.x as never], () => b.x.set(a.x.peek() - 25))).toThrow(
      /did not converge/,
    );
  });
});
