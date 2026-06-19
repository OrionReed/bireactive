// flex.test.ts — flexbox as interval propagation: fit, bounds, nesting,
// and infeasibility detection.

import { describe, expect, it } from "vitest";
import { box, cell, num } from "../../core";
import { col, row } from "../flex";
import { solve } from "../solver";

describe("row: fit + distribution", () => {
  it("three items grow to fill, evenly", () => {
    const c = box(0, 0, 300, 100);
    const items = [box(), box(), box()];
    const s = solve(row(c, items, { gap: 0 }));
    expect(items[0]!.w.value).toBeCloseTo(100);
    expect(items[1]!.x.value).toBeCloseTo(100);
    expect(items[2]!.x.value).toBeCloseTo(200);
    s.dispose();
  });

  it("gap and padding eat into content", () => {
    const c = box(0, 0, 320, 100);
    const items = [box(), box()];
    const s = solve(row(c, items, { gap: 20, padding: 10 }));
    // content = 320 - 20(pad) - 20(gap) = 280 → 140 each.
    expect(items[0]!.w.value).toBeCloseTo(140);
    expect(items[1]!.w.value).toBeCloseTo(140);
    expect(items[0]!.x.value).toBeCloseTo(10);
    expect(items[1]!.x.value).toBeCloseTo(170);
    s.dispose();
  });

  it("per-item max caps growth, leaving the rest to others", () => {
    const c = box(0, 0, 600, 100);
    const a = box();
    const b = box();
    const s = solve(
      row(
        c,
        [
          { box: a, max: 100, basis: 0 },
          { box: b, basis: 0 },
        ],
        { gap: 0 },
      ),
    );
    expect(a.w.value).toBeCloseTo(100);
    expect(b.w.value).toBeCloseTo(500);
    s.dispose();
  });

  it("grow weights split slack proportionally", () => {
    const c = box(0, 0, 300, 100);
    const a = box();
    const b = box();
    const s = solve(
      row(
        c,
        [
          { box: a, grow: 1, basis: 0 },
          { box: b, grow: 2, basis: 0 },
        ],
        { gap: 0 },
      ),
    );
    expect(a.w.value).toBeCloseTo(100);
    expect(b.w.value).toBeCloseTo(200);
    s.dispose();
  });
});

describe("row: feasibility", () => {
  it("flags infeasible when content < Σ min, and stays feasible otherwise", () => {
    const c = box(0, 0, 300, 100);
    const flag = cell(false);
    const items = [
      { box: box(), min: 120 },
      { box: box(), min: 120 },
      { box: box(), min: 120 },
    ];
    // Σmin = 360 > 300 → can't fit.
    const s = solve(row(c, items, { gap: 0, report: v => (flag.value = v) }));
    expect(flag.value).toBe(true);
    // Widen the container past Σmin → feasible.
    c.w.value = 400;
    expect(flag.value).toBe(false);
    s.dispose();
  });
});

describe("nested: col of rows composes through the reactive graph", () => {
  it("resizing the root re-runs inner rows", () => {
    const root = box(0, 0, 400, 200);
    const top = box();
    const bottom = box();
    const a = box();
    const b = box();
    const s = solve(col(root, [top, bottom], { gap: 0 }), row(top, [a, b], { gap: 0 }));
    // top fills width 400, height 100; a/b split 200 each.
    expect(top.w.value).toBeCloseTo(400);
    expect(a.w.value).toBeCloseTo(200);
    expect(b.w.value).toBeCloseTo(200);
    // Resize root → inner row re-runs.
    root.w.value = 600;
    expect(a.w.value).toBeCloseTo(300);
    expect(b.w.value).toBeCloseTo(300);
    s.dispose();
  });
});

describe("reactive gap", () => {
  it("dragging gap reflows positions", () => {
    const c = box(0, 0, 300, 100);
    const gap = num(0);
    const items = [box(), box()];
    const s = solve(row(c, items, { gap }));
    expect(items[1]!.x.value).toBeCloseTo(150);
    gap.value = 100;
    // content = 200 → 100 each; second starts at 100 + 100(gap) = 200.
    expect(items[0]!.w.value).toBeCloseTo(100);
    expect(items[1]!.x.value).toBeCloseTo(200);
    s.dispose();
  });
});
