// `cell.merge(fold)` — N backward contributors folded into one source, the
// fold handed every live push at once (order-independent). Mirrors the folds
// the `md-merge` demo drives (intersection, last-writer-wins, tri-state bus,
// log-odds sum) plus the minimality contract: the fold runs once per settle,
// never per contributor write, and not at all while unobserved.

import { describe, expect, it, vi } from "vitest";
import { batch, type Cell, cell, derive, effect, settle } from "../index";

/** Fold N reactive `proposals` into one source via `cell.merge(fold)`,
 *  re-asserting every contributor each settle so the fold sees the full
 *  set (the `md-merge` pattern). `fold` gathers every live push at once;
 *  omitted, the merge is last-writer-wins. Returns the folded source. */
function mergeOf<T>(
  init: T,
  fold: ((values: readonly T[]) => T) | undefined,
  proposals: readonly Cell<T>[],
  equals?: (a: T, b: T) => boolean,
): Cell<T> {
  const target = cell<T>(init, equals ? { equals } : undefined);
  const m = target.merge(fold) as unknown as {
    lens: (f: (v: T) => T, b: (n: T) => T) => Cell<T>;
  };
  const ports = proposals.map(() =>
    m.lens(
      (v: T) => v,
      (n: T) => n,
    ),
  ) as unknown as {
    value: T;
  }[];
  effect(() => {
    const vals = proposals.map(p => p.value);
    batch(() => {
      ports.forEach((port, i) => {
        port.value = vals[i]!;
      });
    });
  });
  return target;
}

type Iv = { lo: number; hi: number };

describe("cell.merge — fold policies", () => {
  it("intersection (idempotent meet): folds to the overlap", () => {
    const a = cell(0);
    const b = cell(0);
    const c = cell(0);
    const HALF = 5;
    const iv = (k: Cell<number>): Cell<Iv> =>
      derive([k] as const, ([x]) => ({ lo: x - HALF, hi: x + HALF }));
    const meet = mergeOf<Iv>(
      { lo: -1e9, hi: 1e9 },
      vals =>
        vals.reduce((x, y) => ({ lo: Math.max(x.lo, y.lo), hi: Math.min(x.hi, y.hi) }), {
          lo: -1e9,
          hi: 1e9,
        }),
      [iv(a), iv(b), iv(c)],
      (x, y) => x.lo === y.lo && x.hi === y.hi,
    );
    a.value = 0;
    b.value = 2;
    c.value = 4;
    settle();
    // [-5,5] ∩ [-3,7] ∩ [-1,9] = [-1,5]
    expect(meet.value).toEqual({ lo: -1, hi: 5 });
  });

  it("last-writer-wins: max by logical clock", () => {
    const props = [0, 1, 2].map(i => cell({ ts: i, v: i * 10, who: i }));
    const reg = mergeOf(
      { ts: -1, v: 0, who: -1 },
      vals => vals.reduce((x, y) => (y.ts > x.ts ? y : x)),
      props,
      (x, y) => x.ts === y.ts,
    );
    expect(reg.value.who).toBe(2); // highest ts wins
    props[0]!.value = { ts: 9, v: 99, who: 0 };
    settle();
    expect(reg.value.who).toBe(0);
    expect(reg.value.v).toBe(99);
  });

  it("log-odds sum (with inverse): evidence adds", () => {
    const e = [0, 1, 2].map(() => cell(0));
    const sum = mergeOf<number>(0, vals => vals.reduce((x, y) => x + y, 0), e);
    e[0]!.value = 1;
    e[1]!.value = 2;
    e[2]!.value = -0.5;
    settle();
    expect(sum.value).toBeCloseTo(2.5, 9);
  });

  it("order-independent: fold result is the same regardless of write order", () => {
    const mk = () => [0, 1, 2].map(() => cell(0));
    const fold = (vals: readonly number[]) => vals.reduce((x, y) => x + y, 0);
    const a = mk();
    const sa = mergeOf(0, fold, a);
    a[0]!.value = 3;
    a[2]!.value = 7;
    a[1]!.value = 5;
    settle();
    const b = mk();
    const sb = mergeOf(0, fold, b);
    b[2]!.value = 7;
    b[1]!.value = 5;
    b[0]!.value = 3;
    settle();
    expect(sa.value).toBe(sb.value);
    expect(sa.value).toBe(15);
  });
});

describe("cell.merge — minimality", () => {
  it("folds once per settle, not once per contributor write", () => {
    const combine = vi.fn((a: number, b: number) => a + b);
    const props = [0, 1, 2].map(() => cell(0));
    const sum = mergeOf(0, vals => vals.reduce(combine, 0), props);
    void sum.value; // settle initial
    combine.mockClear();
    // One batched settle that moves all three contributors.
    batch(() => {
      props[0]!.value = 1;
      props[1]!.value = 2;
      props[2]!.value = 3;
    });
    const folded = sum.value;
    expect(folded).toBe(6);
    // The fold is a single pass over the 3 live contributors (3 combines),
    // not re-folded per contributor write (which would be far more).
    expect(combine.mock.calls.length).toBeLessThanOrEqual(3);
  });
});
