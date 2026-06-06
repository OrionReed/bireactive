// hooks.test.ts — watched/unwatched lifecycle hooks.

import { Cell, derive, effect } from "@bireactive/core";
import { describe, expect, it } from "vitest";

describe("hooks", () => {
  it("watched fires on first subscriber", () => {
    let watchedCount = 0;
    const s = new Cell(0, {
      watched: () => {
        watchedCount++;
      },
    });
    expect(watchedCount, "not watched yet").toBe(0);
    const stop = effect(() => {
      void s.value;
    });
    expect(watchedCount, "first effect → watched fired").toBe(1);
    const stop2 = effect(() => {
      void s.value;
    });
    expect(watchedCount, "second effect → no extra fire").toBe(1);
    stop();
    stop2();
  });

  it("unwatched fires on last subscriber detach", () => {
    let unwatchedCount = 0;
    const s = new Cell(0, {
      unwatched: () => {
        unwatchedCount++;
      },
    });
    const stop1 = effect(() => {
      void s.value;
    });
    const stop2 = effect(() => {
      void s.value;
    });
    expect(unwatchedCount, "no unwatched yet").toBe(0);
    stop1();
    expect(unwatchedCount, "one subscriber left, no fire").toBe(0);
    stop2();
    expect(unwatchedCount, "last subscriber gone → unwatched fired").toBe(1);
  });

  it("watched/unwatched cycle on add/remove/re-add", () => {
    let watched = 0,
      unwatched = 0;
    const s = new Cell(0, {
      watched: () => {
        watched++;
      },
      unwatched: () => {
        unwatched++;
      },
    });
    const e1 = effect(() => {
      void s.value;
    });
    expect(watched === 1 && unwatched === 0, "watched=1, unwatched=0").toBe(true);
    e1();
    expect(watched === 1 && unwatched === 1, "watched=1, unwatched=1").toBe(true);
    const e2 = effect(() => {
      void s.value;
    });
    expect(watched === 2 && unwatched === 1, "re-watched (watched=2)").toBe(true);
    e2();
    expect(watched === 2 && unwatched === 2, "re-unwatched (unwatched=2)").toBe(true);
  });

  it("hook fires for computed → cell too", () => {
    let watched = 0;
    const s = new Cell(0, {
      watched: () => {
        watched++;
      },
    });
    const c = derive(() => s.value * 2);
    expect(watched, "computed doesn't read yet, no watched").toBe(0);
    const stop = effect(() => {
      void c.value;
    });
    expect(watched, "effect subscribes to computed which subscribes to s").toBe(1);
    stop();
  });
});
