// layout.test.ts — rigid Box-relational combinators.

import { describe, expect, it } from "vitest";
import { num } from "../../core";
import { attach, box, centerInside, follow, grid, inset, lockSize, pinEdge, solve } from "..";
import { row } from "../flex";

describe("grid", () => {
  it("2x2 grid", () => {
    const c = box(0, 0, 200, 200);
    const items = [box(), box(), box(), box()];
    const s = solve(grid(c, items, { cols: 2, gap: 0 }));
    expect(items[0]!.w.value).toBe(100);
    expect(items[0]!.h.value).toBe(100);
    expect(items[1]!.x.value).toBe(100);
    expect(items[2]!.y.value).toBe(100);
    expect(items[3]!.x.value).toBe(100);
    expect(items[3]!.y.value).toBe(100);
    s.dispose();
  });

  it("grid with gaps + padding", () => {
    const c = box(0, 0, 220, 220);
    const items = [box(), box(), box(), box()];
    const s = solve(grid(c, items, { cols: 2, gap: 10, padding: 5 }));
    expect(items[0]!.w.value).toBe(100);
    expect(items[0]!.x.value).toBe(5);
    expect(items[1]!.x.value).toBe(115);
    s.dispose();
  });
});

describe("inset", () => {
  it("inner fills outer minus padding", () => {
    const outer = box(10, 20, 300, 200);
    const inner = box();
    const s = solve(inset(outer, inner, { padding: 16 }));
    expect(inner.x.value).toBe(26);
    expect(inner.w.value).toBe(268);
    outer.w.value = 600;
    expect(inner.w.value).toBe(568);
    s.dispose();
  });
});

describe("attach", () => {
  it("sidebar.left = panel.right + gap, bidirectional", () => {
    const panel = box(0, 0, 200, 100);
    const sidebar = box(0, 0, 50, 100);
    const s = solve(attach(panel, sidebar, "right", "left", { gap: 8 }));
    expect(sidebar.x.value).toBe(208);
    panel.w.value = 300;
    expect(sidebar.x.value).toBe(308);
    s.dispose();
  });
});

describe("centerInside", () => {
  it("inner centered in outer", () => {
    const outer = box(0, 0, 200, 100);
    const inner = box(0, 0, 60, 40);
    const s = solve(centerInside(outer, inner));
    expect(inner.x.value).toBe(70);
    expect(inner.y.value).toBe(30);
    outer.w.value = 400;
    expect(inner.x.value).toBe(170);
    s.dispose();
  });
});

describe("pinEdge", () => {
  it("pin right edge to viewport width", () => {
    const b = box(50, 0, 100, 50);
    const viewportW = num(300);
    const s = solve(pinEdge(b, "right", viewportW));
    expect(b.w.value).toBe(250);
    viewportW.value = 500;
    expect(b.w.value).toBe(450);
    s.dispose();
  });
});

describe("lockSize", () => {
  it("bounces external writes back", () => {
    const b = box(0, 0, 100, 50);
    const s = solve(lockSize(b, "w", 200));
    expect(b.w.value).toBe(200);
    b.w.value = 100;
    expect(b.w.value).toBe(200);
    s.dispose();
  });
});

describe("follow", () => {
  it("follower mirrors leader", () => {
    const lead = box(10, 20, 100, 50);
    const fol = box();
    const s = solve(follow(lead, fol));
    expect(fol.x.value).toBe(10);
    lead.x.value = 100;
    expect(fol.x.value).toBe(100);
    s.dispose();
  });
});

describe("composition: inset + flex row", () => {
  it("window → padded content → 3 stretched panes", () => {
    const window = box(0, 0, 1024, 768);
    const content = box();
    const panes = [box(), box(), box()];
    const s = solve(
      inset(window, content, { padding: 24 }),
      row(content, panes, { gap: 12, align: "stretch" }),
    );
    expect(content.w.value).toBe(976);
    expect(panes[0]!.w.value).toBeCloseTo((976 - 24) / 3);
    expect(panes[0]!.h.value).toBe(720);
    window.w.value = 1280;
    expect(content.w.value).toBe(1232);
    expect(panes[0]!.w.value).toBeCloseTo((1232 - 24) / 3);
    s.dispose();
  });
});
