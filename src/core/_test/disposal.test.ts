// Backward-edge disposal: a long-lived parent must not pin transient views.
//
// The reverse edge a view registers on its parent (a `LensLink` in the parent's
// `childEdges` up-list) used to be permanent — a source accumulated an edge to
// every view ever written through it, even after those views were disposed, an
// unbounded leak under churn (e.g. transient lenses created per frame). It is now
// released when the view is unwatched, mirroring forward `unlink` clearing a
// subscriber from `subs`. A later arm re-links.

import { describe, expect, it } from "vitest";
import { cell, effect, lens, settle } from "../cell";

// biome-ignore lint/suspicious/noExplicitAny: white-box reach into the edge list
const childCount = (c: unknown): number => {
  let n = 0;
  for (let e = (c as any).childEdges; e !== undefined; e = e.nextChild) n++;
  return n;
};

describe("backward-edge disposal", () => {
  it("releases the parent's childEdges when its views are unwatched", () => {
    const src = cell(0);
    const stops: Array<() => void> = [];
    for (let i = 0; i < 20; i++) {
      const v = lens(
        src as never,
        ((x: number) => x + i) as never,
        ((t: number) => t - i) as never,
      ) as unknown as { value: number };
      stops.push(effect(() => void v.value)); // observe so unwatch fires on dispose
      v.value = i; // arm → markDown links this view onto src.childEdges
      settle();
    }
    expect(childCount(src)).toBe(20); // one retained edge per written-through view

    for (const stop of stops) stop();
    expect(childCount(src)).toBe(0); // all released — no unbounded accumulation
  });

  it("re-links and round-trips after a disposed view is written again", () => {
    const src = cell(10) as unknown as { value: number };
    const v = lens(
      src as never,
      ((x: number) => x * 2) as never,
      ((t: number) => t / 2) as never,
    ) as unknown as { value: number };

    const stop = effect(() => void v.value);
    v.value = 8; // arm → links
    settle();
    expect(childCount(src)).toBe(1);
    expect(src.value).toBe(4); // PutGet: 8/2

    stop(); // unwatch → edge released
    expect(childCount(src)).toBe(0);

    // Re-observe and write again: the edge must re-link and the write land.
    const stop2 = effect(() => void v.value);
    v.value = 20;
    settle();
    expect(childCount(src)).toBe(1);
    expect(src.value).toBe(10); // 20/2
    stop2();
    expect(childCount(src)).toBe(0);
  });

  it("each disposed view drops only its own edge, leaving co-writers intact", () => {
    const src = cell(0);
    const mk = (k: number) => {
      const v = lens(
        src as never,
        ((x: number) => x + k) as never,
        ((t: number) => t - k) as never,
      ) as unknown as { value: number };
      const stop = effect(() => void v.value);
      v.value = k;
      settle();
      return stop;
    };
    const a = mk(1);
    const b = mk(2);
    const c = mk(3);
    expect(childCount(src)).toBe(3);
    b(); // dispose the middle co-writer
    expect(childCount(src)).toBe(2);
    a();
    c();
    expect(childCount(src)).toBe(0);
  });
});
