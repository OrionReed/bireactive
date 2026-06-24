// Static writability: a write whose back-spine dead-ends at a read-only `derive`
// is structurally impossible. It used to throw partway through `markDown` — after
// splicing reverse edges and waking source cones — leaving the graph half-marked.
// It is now a `BF.WriteBlocked` bit, computed once at construction and checked atop
// `arm`, so the throw lands before any backward mutation (Class-1 atomicity): an
// illegal write touches nothing.

import { describe, expect, it } from "vitest";
import { cell, derive, effect, lens, settle } from "../cell";

// biome-ignore lint/suspicious/noExplicitAny: white-box reach into backward flags
const bflags = (c: unknown): number => (c as any).bflags as number;
const BF_BACK_MARKED = 0b011; // Dirty | Pending — set while a back-write is live
const BF_WRITE_BLOCKED = 0b100;

const mkLens = (p: unknown, k: number, b: number): { value: number } =>
  lens(
    p as never,
    ((x: number) => k * x + b) as never,
    ((t: number) => (t - b) / k) as never,
  ) as never;

describe("static writability", () => {
  it("throws writing through a lens whose sole parent is a read-only derive", () => {
    const src = cell(1);
    const ro = derive(src as never, ((x: number) => x + 1) as never); // read-only
    const view = mkLens(ro, 2, 0);
    expect(() => {
      view.value = 10;
    }).toThrow("Cannot write through to a computed");
    expect(bflags(view) & BF_WRITE_BLOCKED).toBeTruthy(); // statically flagged
  });

  it("propagates the block transitively up a lens chain over a derive", () => {
    const src = cell(1);
    const ro = derive(src as never, ((x: number) => x + 1) as never);
    const mid = mkLens(ro, 2, 0); // blocked: sole parent is read-only
    const top = mkLens(mid, 3, 1); // blocked: inherits via its writable-but-blocked parent
    expect(bflags(mid) & BF_WRITE_BLOCKED).toBeTruthy();
    expect(bflags(top) & BF_WRITE_BLOCKED).toBeTruthy();
    expect(() => {
      top.value = 5;
    }).toThrow("Cannot write through to a computed");
  });

  it("a split routes around a read-only parent and stays writable", () => {
    const a = cell(1);
    const b = cell(2);
    const ro = derive(a as never, ((x: number) => x * 10) as never);
    // 2 parents: one writable source, one read-only derive. Writing target into
    // the writable parent and SKIPping the read-only one is legal.
    const split = lens(
      [b, ro] as never,
      (([y]: number[]) => y) as never,
      ((t: number) => [t]) as never, // write parent 0 (b), short tuple SKIPs ro
    ) as unknown as { value: number };
    expect(bflags(split) & BF_WRITE_BLOCKED).toBeFalsy();
    split.value = 7;
    settle();
    expect(b.value).toBe(7);
  });

  it("is atomic: a blocked write touches no backward state and wakes nothing", () => {
    const src = cell(1);
    const ro = derive(src as never, ((x: number) => x + 1) as never);
    const blocked = mkLens(ro, 2, 0);
    const ok = mkLens(src, 5, 0); // valid co-writer through the same source

    let fires = 0;
    const stop = effect(() => {
      void (src as unknown as { value: number }).value;
      fires++;
    });
    settle();
    fires = 0;

    expect(() => {
      blocked.value = 99;
    }).toThrow();

    // Nothing marked, nothing woken: no stranded back-path, source intact, no fire.
    expect(bflags(blocked) & BF_BACK_MARKED).toBe(0);
    expect((src as unknown as { value: number }).value).toBe(1);
    settle();
    expect(fires).toBe(0);

    // Engine still works: the legal co-writer lands.
    ok.value = 20;
    settle();
    expect((src as unknown as { value: number }).value).toBe(4); // 20 / 5
    expect(fires).toBe(1);
    stop();
  });
});
