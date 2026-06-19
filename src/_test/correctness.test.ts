// correctness.test.ts — guards against four bugs found in review:
//   1.1  Computed swallows getter errors → must rethrow + retry
//   1.2  Computed re-eval ignores `equals` trait → derived chains over-fire
//   1.3  Cyclic Computed silently returns undefined → must throw
//   4.2  vec(reactiveX, reactiveY) glitches without batching

import {
  batch,
  cell,
  derive,
  effect,
  type Inner,
  num,
  settle,
  type Vec,
  vec,
} from "@bireactive/core";
import { describe, expect, it } from "vitest";

describe("correctness", () => {
  it("1.1 Computed rethrows getter errors + retries", () => {
    const a = cell(0);
    let shouldThrow = true;
    const c = derive(() => {
      if (shouldThrow) throw new Error("boom");
      return a.value * 2;
    });
    let caught: unknown;
    try {
      void c.value;
    } catch (e) {
      caught = e;
    }
    expect((caught as Error).message, "first read rethrows").toBe("boom");
    let caught2: unknown;
    try {
      void c.value;
    } catch (e) {
      caught2 = e;
    }
    expect((caught2 as Error).message, "second read retries (rethrows again)").toBe("boom");
    shouldThrow = false;
    a.value = 5;
    expect(c.value, "recovers when cause goes away").toBe(10);
  });

  it("1.2 Computed honors equals trait", () => {
    const v = vec(1, 2);
    const doubled = v.scale(2);
    const tripled = doubled.scale(1);
    let runs = 0;
    effect(() => {
      void tripled.value;
      runs++;
    });
    const initial = runs;
    expect(initial, "initial run").toBe(1);
    v.value = { x: 1, y: 2 };
    settle();
    expect(runs, "structurally-equal write does not re-fire downstream").toBe(initial);
    v.value = { x: 5, y: 5 };
    settle();
    expect(runs, "real change fires").toBe(initial + 1);
  });

  it("per-instance equals via CellOptions", () => {
    const s = cell(0, { equals: (a, b) => Math.abs(a - b) < 0.01 });
    let runs = 0;
    effect(() => {
      void s.value;
      runs++;
    });
    expect(runs, "baseline run").toBe(1);
    s.value = 0.005;
    settle();
    expect(runs, "epsilon-equal write skipped").toBe(1);
    s.value = 0.5;
    settle();
    expect(runs, "real change fires").toBe(2);
  });

  it("1.3 Cyclic computed throws RangeError", () => {
    let c: { value: number };
    c = derive(() => c.value + 1) as never;
    let threw: unknown;
    try {
      void c.value;
    } catch (e) {
      threw = e;
    }
    expect(threw, "direct cycle throws").toBeInstanceOf(RangeError);
    expect((threw as Error).message, "error message mentions cycle").toMatch(/[Cc]yclic/);

    let a: { value: number }, b: { value: number };
    a = derive(() => b.value + 1) as never;
    b = derive(() => a.value + 1) as never;
    let threw2: unknown;
    try {
      void a.value;
    } catch (e) {
      threw2 = e;
    }
    expect(threw2, "transitive cycle throws").toBeInstanceOf(RangeError);
  });

  it("4.2 vec(reactiveX, reactiveY) glitch-free under batch", () => {
    const rx = num(10);
    const ry = num(20);
    const v = vec(rx, ry);
    const seen: Inner<Vec>[] = [];
    effect(() => {
      seen.push({ ...v.value });
    });
    expect(v.value.x === 10 && v.value.y === 20, "initial value").toBe(true);
    seen.length = 0;
    batch(() => {
      rx.value = 100;
      ry.value = 200;
    });
    expect(seen.length, "batched update yields one final value").toBe(1);
    expect(seen[0]?.x === 100 && seen[0]?.y === 200, "final value is consistent").toBe(true);
  });
});
