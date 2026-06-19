// engine.test.ts — engine semantics specific to bireactive's impl.
//
// RFTS (suite/conformance/forward.test.ts) covers the algorithm-level
// correctness; this file tests our additions:
//   - peek() honors Dirty
//   - Constructor takes plain T (binding via the `bind` free fn)
//   - bind(target, source) — the binding API
//   - isCell brand: prototype-based, not structural
//   - readNow() unwraps reactives without footgunning plain {value: …}

import { Cell, cell, derive, effect, isCell, Num, readNow, SKIP, settle } from "@bireactive/core";
import { describe, expect, it } from "vitest";

describe("engine", () => {
  it("peek() honors Dirty flag", () => {
    const s = cell(0);
    let effectVal = -1;
    const stop = effect(() => {
      effectVal = s.value;
    });
    s.value = 42;
    settle();
    expect(s.peek(), "peek after write returns new value").toBe(42);
    expect(effectVal, "effect saw new value").toBe(42);
    stop();
  });

  it("Constructor: plain T only", () => {
    const s = new Cell(7);
    expect(s.value, "plain init").toBe(7);
  });

  it("effect-driven mirror — auto-updates with disposer", () => {
    const a = cell(2);
    const s = cell(0);
    const stop = effect(() => {
      s.value = a.value * 10;
    });
    expect(s.value, "initial computed via effect").toBe(20);
    a.value = 5;
    settle();
    expect(s.value, "auto-updates on a change").toBe(50);
    stop();
    a.value = 99;
    settle();
    expect(s.value, "after dispose, no update").toBe(50);
  });

  it("effect mirror with cell source", () => {
    const src = cell(100);
    const t = cell(0);
    const stop = effect(() => {
      t.value = src.value;
    });
    expect(t.value, "initial sync").toBe(100);
    src.value = 200;
    settle();
    expect(t.value, "auto-updates").toBe(200);
    t.value = 999;
    expect(t.value, "manual write takes effect").toBe(999);
    src.value = 50;
    settle();
    expect(t.value, "next src change overwrites manual").toBe(50);
    stop();
  });

  it("isCell brand: branded prototypes, not structural .value", () => {
    expect(isCell(cell(0)), "isCell(cell)").toBe(true);
    expect(isCell(derive(() => 0)), "isCell(computed)").toBe(true);
    expect(
      isCell(
        Num.lens(
          [cell(0)] as const,
          ([n]) => n,
          () => [SKIP] as const,
        ),
      ),
      "isCell(lens)",
    ).toBe(true);
    expect(isCell({ value: 5 }), "isCell(plain {value: 5})").toBe(false);
    expect(isCell({ value: 5, name: "a" }), "isCell(plain {value: 5, name: 'a'})").toBe(false);
    expect(isCell(5), "isCell(number)").toBe(false);
    expect(
      isCell(() => 5),
      "isCell(fn)",
    ).toBe(false);
    expect(isCell(null), "isCell(null)").toBe(false);
  });

  it("readNow() unwraps via brand, not structural shape", () => {
    expect(readNow(5), "readNow(5)").toBe(5);
    expect(readNow(cell(15)), "readNow(cell(15))").toBe(15);
    const plainT = { value: 5, name: "alice" };
    expect(readNow(plainT as never), "plain T with .value is preserved").toBe(plainT);
  });
});
