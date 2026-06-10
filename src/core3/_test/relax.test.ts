// Concrete equality-gated relaxation: cyclic regions solved as one unit by the
// write-driven drain, with no Component / lattice / overlay.

import { describe, expect, it } from "vitest";
import { type Cell, cell, effect, settle } from "../index";
import { constrain, equal } from "../relate";

// biome-ignore lint/suspicious/noExplicitAny: loosen Cell<number> for the propagator body
const u = (c: unknown): Cell<unknown> => c as any;

describe("relaxation: equal mirror", () => {
  it("mirrors on declaration and on later writes (both directions)", () => {
    const a = cell(1);
    const b = cell(2);
    equal(a, b);
    expect(b.value).toBe(1); // seeded on declare: b := a

    a.value = 5;
    expect(b.value).toBe(5);

    b.value = 9;
    expect(a.value).toBe(9);
  });

  it("disposes cleanly (no more coupling)", () => {
    const a = cell(1);
    const b = cell(1);
    const off = equal(a, b);
    a.value = 4;
    expect(b.value).toBe(4);
    off();
    a.value = 7;
    expect(b.value).toBe(4); // decoupled
  });
});

describe("relaxation: cyclic region solved as one unit", () => {
  it("an equal chain settles all members from a single write", () => {
    const a = cell(0);
    const b = cell(0);
    const c = cell(0);
    const d = cell(0);
    equal(a, b);
    equal(b, c);
    equal(c, d);

    a.value = 42;
    expect([a.value, b.value, c.value, d.value]).toEqual([42, 42, 42, 42]);

    d.value = 7; // write the far end — flows back through the ring
    expect([a.value, b.value, c.value, d.value]).toEqual([7, 7, 7, 7]);
  });

  it("a 2-cycle ring converges (equal both ways)", () => {
    const a = cell(1);
    const b = cell(1);
    equal(a, b);
    equal(b, a);
    a.value = 3;
    expect(b.value).toBe(3);
    b.value = 8;
    expect(a.value).toBe(8);
  });
});

describe("relaxation: directional propagator", () => {
  it("y = x + 10 follows x", () => {
    const x = cell(0);
    const y = cell(-1);
    constrain([u(x)], [u(y)], (read, write) => write(u(y), (read(u(x)) as number) + 10));
    expect(y.value).toBe(10); // seeded
    x.value = 5;
    expect(y.value).toBe(15);
  });

  it("a two-way offset relaxes from either side", () => {
    const x = cell(0);
    const y = cell(0);
    constrain([u(x)], [u(y)], (read, write) => write(u(y), (read(u(x)) as number) + 10));
    constrain([u(y)], [u(x)], (read, write) => write(u(x), (read(u(y)) as number) - 10));
    x.value = 5;
    expect([x.value, y.value]).toEqual([5, 15]);
    y.value = 100;
    expect([x.value, y.value]).toEqual([90, 100]);
  });
});

describe("relaxation: glitch-free effects over a region", () => {
  it("an effect on a member re-runs with the settled value", async () => {
    const a = cell(1);
    const b = cell(1);
    const c = cell(1);
    equal(a, b);
    equal(b, c);

    const seen: number[] = [];
    effect(() => {
      seen.push(c.value);
    });
    settle();
    expect(seen.at(-1)).toBe(1);

    a.value = 50;
    settle();
    expect(c.value).toBe(50);
    expect(seen.at(-1)).toBe(50);
  });
});

describe("relaxation: divergence guard", () => {
  it("throws on an over-constrained, non-converging cycle", () => {
    const x = cell(0);
    expect(() => {
      constrain([u(x)], [u(x)], (read, write) => write(u(x), (read(u(x)) as number) + 1));
    }).toThrow(/did not converge/);
  });
});
