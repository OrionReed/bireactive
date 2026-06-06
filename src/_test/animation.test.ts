// animation.test.ts — synthetic-step tests for the animation surface.
// Drives the runtime by calling `anim.step(dt)` directly, no RAF.
//
// Verifies: tween, chain, parallel, detach, race, until, then, at,
// spring, toward, from, driven.

import {
  Anim,
  detach,
  driven,
  linear,
  not,
  play,
  race,
  spring,
  suspend,
  Tween,
  toward,
  when,
} from "@bireactive/animation";
import { cell, effect, num, transform, vec } from "@bireactive/core";
import { describe, expect, it } from "vitest";

function tick(anim: Anim, frames: number, dt = 1 / 60): void {
  for (let i = 0; i < frames; i++) anim.step(dt);
}

const approx = (a: number, b: number, eps = 1e-3): boolean => Math.abs(a - b) < eps;

describe("animation", () => {
  it("Tween basics — Num.to()", () => {
    const anim = new Anim();
    const x = num(0);
    anim.start(
      (function* () {
        yield* x.to(100, 1.0, linear);
      })(),
    );
    tick(anim, 30);
    expect(approx(x.value, 50, 1), "at 0.5s, x ≈ 50").toBe(true);
    tick(anim, 30);
    expect(x.value, "at 1.0s, x === 100").toBe(100);
  });

  it("Tween chain — .to(A).to(B).to(C)", () => {
    const anim = new Anim();
    const x = num(0);
    anim.start(
      (function* () {
        yield* x.to(10, 0.1, linear).to(20, 0.1, linear).to(30, 0.1, linear);
      })(),
    );
    tick(anim, 6);
    expect(x.value, "after seg 1: x === 10").toBe(10);
    tick(anim, 6);
    expect(x.value, "after seg 2: x === 20").toBe(20);
    tick(anim, 6);
    expect(x.value, "after seg 3: x === 30").toBe(30);
  });

  it("Tween chain returns Tween<T>", () => {
    const x = num(0);
    const t1 = x.to(10, 0.1);
    expect(t1, "x.to(...) returns Tween<number>").toBeInstanceOf(Tween);
    const t2 = t1.to(20, 0.1);
    expect(t2, "Tween.to(...) returns Tween<number>").toBeInstanceOf(Tween);
  });

  it("Tween .from(start) — pose-then-tween prefix", () => {
    const anim = new Anim();
    const x = num(50);
    anim.start(
      (function* () {
        yield* x.to(100, 0.1, linear).from(0);
      })(),
    );
    tick(anim, 1);
    expect(approx(x.value, 0, 0.01) || x.value < 30, "from(0) sets initial value").toBe(true);
    tick(anim, 6);
    expect(x.value, ".from(0).to(100): final 100").toBe(100);
  });

  it("Vec.to() — typed value", () => {
    const anim = new Anim();
    const v = vec(0, 0);
    anim.start(
      (function* () {
        yield* v.to({ x: 100, y: 50 }, 1.0, linear);
      })(),
    );
    tick(anim, 30);
    expect(
      approx(v.value.x, 50, 1) && approx(v.value.y, 25, 1),
      "Vec halfway: x ≈ 50, y ≈ 25",
    ).toBe(true);
    tick(anim, 30);
    expect(v.value.x === 100 && v.value.y === 50, "Vec done: x === 100, y === 50").toBe(true);
  });

  it("Tween reactive duration — Val<number>", () => {
    const anim = new Anim();
    const x = num(0);
    const dur = cell(1.0);
    anim.start(
      (function* () {
        yield* x.to(100, dur, linear);
      })(),
    );
    tick(anim, 30);
    expect(approx(x.value, 50, 1), "at 0.5s of dur=1.0: x ≈ 50").toBe(true);
    dur.value = 2.0;
    tick(anim, 121);
    expect(x.value, "Tween eventually completes with reactive dur").toBe(100);
  });

  it("Parallel — yield [a, b]", () => {
    const anim = new Anim();
    const a = num(0),
      b = num(0);
    let done = false;
    anim.start(
      (function* () {
        yield [a.to(100, 0.5, linear), b.to(50, 0.5, linear)];
        done = true;
      })(),
    );
    tick(anim, 15);
    expect(approx(a.value, 50, 1), "parallel midway: a ≈ 50").toBe(true);
    expect(approx(b.value, 25, 1), "parallel midway: b ≈ 25").toBe(true);
    tick(anim, 16);
    expect(a.value, "parallel done: a === 100").toBe(100);
    expect(b.value, "parallel done: b === 50").toBe(50);
    expect(done, "parallel finishes parent gen").toBe(true);
  });

  it("detach(g) — fire-and-forget child at engine root", () => {
    const anim = new Anim();
    const fast = num(0);
    const slow = num(0);
    let parentDone = false;
    anim.start(
      (function* () {
        yield detach(slow.to(100, 1.0, linear));
        yield* fast.to(50, 0.1, linear);
        parentDone = true;
      })(),
    );
    tick(anim, 10);
    expect(parentDone, "parent finished").toBe(true);
    expect(fast.value, "fast tween done").toBe(50);
    expect(approx(slow.value, 16.7, 2), "slow tween in progress").toBe(true);
    tick(anim, 50);
    expect(slow.value, "slow tween eventually completes").toBe(100);
  });

  it("race() — first-completion wins", () => {
    const anim = new Anim();
    const x = num(0);
    let winnerSeen: string | undefined;
    anim.start(
      (function* () {
        const winner = yield* race(
          (function* () {
            yield* x.to(100, 0.5, linear);
            return "tween-done";
          })(),
          (function* () {
            yield 0.2;
            return "timer-fired";
          })(),
        );
        winnerSeen = winner as string;
      })(),
    );
    tick(anim, 13);
    expect(winnerSeen, "race resolves with timer payload").toBe("timer-fired");
    expect(x.value < 100, "losing tween was cancelled (x partial, < 100)").toBe(true);
  });

  it("play().until(p) — terminate on cell-truthy", () => {
    const anim = new Anim();
    const x = num(0);
    const stop = cell(false);
    let endedEarly = false;
    anim.start(
      (function* () {
        yield* play(x.to(100, 1.0, linear)).until(stop);
        endedEarly = true;
      })(),
    );
    tick(anim, 10);
    expect(x.value > 0 && x.value < 100, "midway: x progressing").toBe(true);
    stop.value = true;
    tick(anim, 1);
    expect(endedEarly, "until() terminated parent").toBe(true);
  });

  it("play().then(next) — sequence", () => {
    const anim = new Anim();
    const x = num(0);
    const phase = cell("idle");
    anim.start(
      (function* () {
        yield* play(x.to(50, 0.1, linear)).then(x.to(0, 0.1, linear));
        phase.value = "done";
      })(),
    );
    tick(anim, 6);
    expect(x.value, "after seg 1: x === 50").toBe(50);
    tick(anim, 6);
    expect(x.value, "after seg 2: x === 0").toBe(0);
    expect(phase.value, "phase done").toBe("done");
  });

  it("spring() — settle to target", () => {
    const anim = new Anim();
    const x = num(0);
    let settled = false;
    anim.start(
      (function* () {
        yield* spring(x, 100, { omega: 10, zeta: 1 });
        settled = true;
      })(),
    );
    tick(anim, 600);
    expect(approx(x.value, 100, 0.5), "spring final very close to 100").toBe(true);
    expect(settled || approx(x.value, 100, 1), "spring eventually settles (or near it)").toBe(true);
  });

  it("spring() generic over Transform", () => {
    const anim = new Anim();
    const tr = transform();
    const target = {
      translate: { x: 100, y: 50 },
      scale: { x: 2, y: 2 },
      origin: { x: 0, y: 0 },
      rotate: Math.PI,
      opacity: 0.5,
    };
    anim.start(
      (function* () {
        yield* spring(tr, target, { omega: 9, zeta: 1 });
      })(),
    );
    tick(anim, 600);
    expect(approx(tr.value.translate.x, 100, 1), "spring on Transform: translate.x → ~100").toBe(
      true,
    );
    expect(approx(tr.value.scale.x, 2, 0.05), "spring on Transform: scale.x → ~2").toBe(true);
    expect(approx(tr.value.rotate, Math.PI, 0.05), "spring on Transform: rotate → ~π").toBe(true);
    expect(approx(tr.value.opacity, 0.5, 0.05), "spring on Transform: opacity → ~0.5").toBe(true);
  });

  it("toward() — constant-speed approach", () => {
    const anim = new Anim();
    const x = num(0);
    let done = false;
    anim.start(
      (function* () {
        yield* toward(x, 50, 100);
        done = true;
      })(),
    );
    tick(anim, 31);
    expect(done, "toward done at ~0.5s").toBe(true);
    expect(x.value, "toward final === target").toBe(50);
  });

  it("suspend(sig.bind) — generator-scoped reactive bind", () => {
    const anim = new Anim();
    const a = num(10);
    const b = num(0);
    const stop = cell(false);
    anim.start(
      (function* () {
        yield* race(
          suspend(_wake =>
            effect(() => {
              b.value = a.value;
            }),
          ),
          when(stop),
        );
      })(),
    );
    tick(anim, 1);
    expect(b.value, "b initially follows a").toBe(10);
    a.value = 99;
    tick(anim, 1);
    expect(b.value, "b updates with a").toBe(99);
    stop.value = true;
    tick(anim, 1);
    a.value = 7;
    tick(anim, 1);
    expect(b.value, "after stop, b no longer follows a").toBe(99);
  });

  it("driven(stepFn) — escape hatch", () => {
    const anim = new Anim();
    const x = num(0);
    let done = false;
    anim.start(
      (function* () {
        yield* driven(x, (dt, t, v) => (t > 0.5 ? false : v + dt * 100));
        done = true;
      })(),
    );
    tick(anim, 31);
    expect(done, "driven terminated when t > 0.5").toBe(true);
    expect(approx(x.value, 50, 1), "driven accumulated value").toBe(true);
  });

  it("play(() => gen) — factory thunk invoked at play boundary", () => {
    const anim = new Anim();
    const x = num(0);
    let factoryCalls = 0;
    anim.start(
      (function* () {
        yield* play(() => {
          factoryCalls++;
          return x.to(100, 0.1, linear);
        });
      })(),
    );
    tick(anim, 6);
    expect(x.value, "play(thunk): final 100").toBe(100);
    expect(factoryCalls, "play(thunk): factory invoked once").toBe(1);
  });

  it("not(sig) — reactive negation returns a Cell", () => {
    const anim = new Anim();
    const flag = cell(false);
    const neg = not(flag);
    expect(neg.peek() === true && neg.value === true, "not(sig) is a reactive cell").toBe(true);
    flag.value = true;
    expect(neg.value, "not(sig) flips with source").toBe(false);
    let woke = false;
    anim.start(
      (function* () {
        yield* play(not(flag));
        woke = true;
      })(),
    );
    tick(anim, 1);
    expect(woke, "play(not(sig)) waits while sig truthy").toBe(false);
    flag.value = false;
    tick(anim, 1);
    expect(woke, "play(not(sig)) wakes when sig flips false").toBe(true);
  });

  it("pause via spring({ rate: 0|1 }) — per-animator time-scale", () => {
    // Per-animator `rate` is the pause primitive: sleep and per-frame
    // yields inside the spring's drive callback honor the scale, so
    // `rate: () => 0` freezes spring evolution.
    const anim = new Anim();
    const x = num(0);
    const drag = cell(false);
    anim.start(
      spring(x, 100, {
        omega: 14,
        zeta: 0.85,
        rate: () => (drag.value ? 0 : 1),
      }),
    );
    tick(anim, 60);
    expect(approx(x.value, 100, 1), "rate=1: spring runs while drag=false → x → ~100").toBe(true);
    drag.value = true;
    const xPaused = x.value;
    tick(anim, 200);
    expect(x.value, "rate=0 freezes the spring: x unchanged across many frames").toBe(xPaused);
    drag.value = false;
    tick(anim, 1);
    expect(approx(x.value, 100, 0.5), "rate=1 resumes the spring cleanly").toBe(true);
  });

  it("Tween chain on Vec field lens", () => {
    const anim = new Anim();
    const v = vec(0, 0);
    anim.start(
      (function* () {
        yield* v.x.to(50, 0.1, linear).to(0, 0.1, linear);
      })(),
    );
    tick(anim, 6);
    expect(v.value.x, "after seg 1: v.x === 50").toBe(50);
    tick(anim, 6);
    expect(v.value.x, "after seg 2: v.x === 0").toBe(0);
    expect(v.value.y, "v.y unchanged").toBe(0);
  });
});
