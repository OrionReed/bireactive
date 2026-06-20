// The drag algebra (`d`) is pure and reactive — testable without a DOM. These
// re-express Dragology's gallery as compositions of `d`, the breadth check that
// the general `Drag<M>` object (not "snap") is the right building block.

import { Vec } from "@bireactive/core";
import { describe, expect, it } from "vitest";
import { type Drag, d } from "../drag-spec";

type V = { x: number; y: number };
const P = (x: number, y: number) => new Vec({ x, y }) as unknown as Vec & { value: V };
const mixNum = (ms: readonly number[], ws: readonly number[]) =>
  ms.reduce((s, m, i) => s + m * ws[i]!, 0);
const mixVec = (ms: readonly V[], ws: readonly number[]): V => ({
  x: ms.reduce((s, m, i) => s + m.x * ws[i]!, 0),
  y: ms.reduce((s, m, i) => s + m.y * ws[i]!, 0),
});

describe("d.between — blends whole models in the hull, no snap", () => {
  it("a two-state switch interpolates its model; drop rests at the blend", () => {
    const pointer = P(0, 0);
    const sw = d.between(
      pointer,
      [
        d.fixed<number>(pointer, 0, () => ({ x: 0, y: 0 })),
        d.fixed<number>(pointer, 1, () => ({ x: 100, y: 0 })),
      ],
      mixNum,
    );
    pointer.value = { x: 50, y: 0 };
    expect(sw.preview.value).toBeCloseTo(0.5); // model interpolates — no lerpViews
    pointer.value = { x: 80, y: 0 };
    expect(sw.preview.value).toBeCloseTo(0.8);
    expect(sw.drop.value).toBeCloseTo(0.8); // rests where you let go
  });
});

describe("d.closest + d.withFloating — the Scrabble/beads reorder, paper-exact", () => {
  it("reaches the reinserted array for the nearest slot; the bead floats at the pointer", () => {
    const beads = ["A", "B", "C"];
    const slot = (i: number): V => ({ x: i * 100, y: 0 });
    const reinsert = (t: number) => {
      const a = beads.filter(x => x !== "B");
      a.splice(t, 0, "B");
      return a;
    };
    const pointer = P(0, 0);
    const states = beads.map((_, t) => reinsert(t));
    const locate = (arr: string[]) => slot(arr.indexOf("B"));
    const behavior: Drag<string[]> = d.withFloating(
      pointer,
      d.closest(states.map(st => d.fixed(pointer, st, locate))),
    );

    pointer.value = { x: 205, y: 0 };
    expect(behavior.drop.value).toEqual(["A", "C", "B"]);
    expect(behavior.at.value).toEqual({ x: 205, y: 0 }); // floats at pointer
    pointer.value = { x: 5, y: 0 };
    expect(behavior.drop.value).toEqual(["B", "A", "C"]);
  });
});

describe("d.vary — the dial/slider: the backward map is a LENS, not optimization", () => {
  it("reaches the pointer exactly along its manifold (gap = off-manifold residual)", () => {
    const c = { x: 0, y: 0 };
    const r = 100;
    const pointer = P(0, 0);
    const dial = d.vary<number>(
      pointer,
      p => Math.atan2(p.y - c.y, p.x - c.x),
      θ => ({ x: c.x + r * Math.cos(θ), y: c.y + r * Math.sin(θ) }),
    );
    pointer.value = { x: 70, y: 70 };
    expect(dial.drop.value).toBeCloseTo(Math.PI / 4);
    expect(dial.at.value.x).toBeCloseTo(r * Math.cos(Math.PI / 4)); // snapped onto the ring
    expect(dial.gap.value).toBeCloseTo(Math.abs(Math.hypot(70, 70) - r));
  });
});

describe("d.whenFar — snap into a port within R, else free-position (Lists in Lists)", () => {
  it("switches behaviour on distance — drop states differ", () => {
    const port = { x: 0, y: 0 };
    const pointer = P(0, 0);
    const snap = d.closest([d.fixed<string>(pointer, "snapped", () => port)]);
    const free = d.vary<string>(
      pointer,
      p => `free@${Math.round(p.x)},${Math.round(p.y)}`,
      () => pointer.value,
    );
    const behavior = d.whenFar(snap, free, 30);

    pointer.value = { x: 10, y: 10 };
    expect(behavior.drop.value).toBe("snapped");
    pointer.value = { x: 200, y: 50 };
    expect(behavior.drop.value).toBe("free@200,50");
  });
});

describe("d.closest of d.between — Animate Algebra: tracks picked by drag direction", () => {
  it("locks onto the track whose hull the pointer is nearest; preview interpolates", () => {
    const cur: V = { x: 0, y: 0 };
    const A: V = { x: 0, y: -100 };
    const B: V = { x: 100, y: 0 };
    const pointer = P(0, 0);
    const track = (dst: V) =>
      d.between<V>(pointer, [d.fixed(pointer, cur, m => m), d.fixed(pointer, dst, m => m)], mixVec);
    const behavior = d.closest([track(A), track(B)]);

    pointer.value = { x: 5, y: -60 }; // dragging up → track A
    expect(behavior.preview.value.y).toBeLessThan(0);
    expect(behavior.drop.value.x).toBeCloseTo(0);
    pointer.value = { x: 60, y: 5 }; // dragging right → track B
    expect(behavior.preview.value.x).toBeGreaterThan(0);
    expect(behavior.drop.value.y).toBeCloseTo(0);
  });
});

describe("d.onDrop — Nodes & Noodles: transform the committed model only", () => {
  it("runs a function on the drop state (create/destroy beyond repositional)", () => {
    const pointer = P(0, 0);
    const base = d.vary<{ attached: boolean }>(
      pointer,
      p => ({ attached: p.x < 50 }),
      () => pointer.value,
    );
    const behavior = d.onDrop(base, m =>
      m.attached ? m : ({ attached: false, removed: true } as never),
    );
    pointer.value = { x: 200, y: 0 };
    expect(behavior.drop.value).toEqual({ attached: false, removed: true });
  });
});
