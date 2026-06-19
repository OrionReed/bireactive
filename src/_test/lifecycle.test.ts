// lifecycle.test.ts — disposal, dispose-fn idempotence, equals-skip,
// large-scale unwatch.

import { cell, effect, settle, vec } from "@bireactive/core";
import { describe, expect, it } from "vitest";

describe("lifecycle", () => {
  it("effect-mirror: dispose severs the binding", () => {
    const src = cell(0);
    const t = cell(0);
    const stop = effect(() => {
      t.value = src.value;
    });
    expect(src.subs !== undefined, "src has subs from effect").toBe(true);
    stop();
    expect(src.subs === undefined, "src.subs cleared after dispose").toBe(true);
  });

  it("effect after mirror disposed: no propagation", () => {
    const src = cell(0);
    const t = cell(0);
    const stop = effect(() => {
      t.value = src.value;
    });
    let observed = -1;
    const stopE = effect(() => {
      observed = t.value;
    });
    src.value = 10;
    settle();
    expect(observed, "effect observes through mirror").toBe(10);
    stop();
    src.value = 20;
    settle();
    expect(observed, "after dispose, no propagation").toBe(10);
    stopE();
  });

  it("dispose fn is idempotent", () => {
    const src = cell(0);
    const t = cell(0);
    const stop = effect(() => {
      t.value = src.value;
    });
    stop();
    let threw = false;
    try {
      stop();
    } catch {
      threw = true;
    }
    expect(threw, "safe to call stop twice").toBe(false);
  });

  it("equals trait: structural equality skips writes", () => {
    const v = vec(1, 2);
    let fires = 0;
    const stop = effect(() => {
      void v.value;
      fires++;
    });
    v.value = { x: 1, y: 2 };
    settle();
    expect(fires, "equals skips no-op write").toBe(1);
    v.value = { x: 1, y: 3 };
    settle();
    expect(fires, "real change fires").toBe(2);
    stop();
  });

  it("100 effect-mirrors on one source: clean unwatch leaves no subs", () => {
    const src = cell(0);
    const stops: Array<() => void> = [];
    for (let i = 0; i < 100; i++) {
      const t = cell(0);
      stops.push(
        effect(() => {
          t.value = src.value;
        }),
      );
    }
    let count = 0;
    for (let link = src.subs; link; link = link.nextSub) count++;
    expect(count, "src has 100 subs").toBe(100);
    for (const s of stops) s();
    count = 0;
    for (let link = src.subs; link; link = link.nextSub) count++;
    expect(count, "after disposing all: 0 subs").toBe(0);
  });
});
