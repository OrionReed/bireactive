// composition.test.ts — non-coloring property: existing signals
// (any class, any lens chain) work as propagator participants
// without modification.

import { describe, expect, it } from "vitest";
import { effect, mean, Num, num, Vec, vec } from "../../core";
import { add, eq, propagator, propagators } from "..";

describe("composition: non-coloring", () => {
  it("plain Num signals participate in propagators", () => {
    const a = num(2);
    const b = num(3);
    const c = num(0);
    const p = propagators();
    p.add(add(a, b, c));
    expect(c.value).toBe(5);
    p.dispose();
  });

  it("a lens-derived Num participates as a propagator output", () => {
    // The classic case: `a` is a real signal; `aPlus5` is a lens
    // that derives a + 5 with a writable bwd. Use BOTH in a propagator
    // network: add(aPlus5, b, c) means "(a+5) + b = c".
    // Should work — the lens IS a Writable<Num>, propagator just sees
    // it as a Num.
    const a = num(10);
    const aPlus5 = a.add(5); // Writable<Num> — lens
    const b = num(2);
    const c = num(0);

    const p = propagators();
    p.add(add(aPlus5, b, c));
    // a=10 → aPlus5=15; aPlus5 + b = c → c = 17.
    expect(aPlus5.value).toBe(15);
    expect(c.value).toBe(17);

    // Drag the underlying root: a=20 → aPlus5=25 → c=27.
    a.value = 20;
    expect(aPlus5.value).toBe(25);
    expect(c.value).toBe(27);

    // Drag the lens directly: aPlus5=100 → bwd writes a=95.
    // Then c = 100 + 2 = 102.
    aPlus5.value = 100;
    expect(a.value).toBe(95);
    expect(c.value).toBe(102);

    p.dispose();
  });

  it("a lens-derived Num back-deduces through the propagator network", () => {
    // add(a, b, c). Wrap a in a lens. Drag c; expect a (and via lens
    // the underlying root) to back-deduce.
    const aRoot = num(0);
    const a = aRoot.add(0); // identity-like lens, but a real lens
    const b = num(3);
    const c = num(0);

    const p = propagators();
    p.add(add(a, b, c));

    c.value = 50;
    // When all three cells are in a cycle, writing c=50 can't override
    // the network — the fixpoint converges to a different consistent
    // state (a+b=c, but not c=50). To lock c, add `constant(c, 50)` to
    // remove one direction. We assert only convergence + consistency.
    expect(a.value + b.value).toBe(c.value);
    // The lens correctly propagated whatever a converged to → aRoot.
    expect(aRoot.value).toBe(a.value);
    p.dispose();
  });

  it("a Vec cell's `.x` lens participates in a propagator", () => {
    // Demonstrates: a Vec's field-lens is just a Writable<Num>. The
    // propagator doesn't know it's a Vec field; it sees a Num.
    // Writes to vec.x via the propagator update vec.value's x.
    //
    // Important note about `eq` on initial fire: since eq is symmetric,
    // declaration order picks which side's value wins on the first
    // run. Here `eq(v.x, target)` runs `v.x → target` first, so on
    // initial fire target gets v.x's value (0). To start with target's
    // value mirroring into v.x, write target AFTER the network exists.
    const v = vec(0, 0);
    const target = num(0);

    const p = propagators();
    p.add(eq(v.x, target));

    target.value = 50;
    expect(v.value.x).toBe(50);

    target.value = 100;
    expect(v.value.x).toBe(100);
    expect(v.value.y).toBe(0); // y is untouched

    // Writing the vec directly: v.value = {x: 7, y: 9} updates v.x;
    // propagator notices, writes target = 7.
    v.value = { x: 7, y: 9 };
    expect(target.value).toBe(7);
    expect(v.value.y).toBe(9);
    p.dispose();
  });

  it("downstream effect sees propagator's writes through normal subscription", () => {
    const a = num(1);
    const b = num(2);
    const c = num(0);
    const observed: number[] = [];
    const stop = effect(() => {
      observed.push(c.value);
    });
    expect(observed).toEqual([0]);

    const p = propagators();
    p.add(add(a, b, c));
    // Initial run: c = 3. Effect sees the write, fires.
    expect(observed[observed.length - 1]).toBe(3);

    a.value = 10;
    // Network re-fires; c = 12. Effect sees it.
    expect(observed[observed.length - 1]).toBe(12);

    p.dispose();
    stop();
  });

  it("propagator over signals from different value classes (Num + Vec)", () => {
    // distance-style: read a Vec, write a Num. Custom propagator.
    const v = vec(3, 4);
    const dist = num(0);

    const p = propagators();
    p.add({
      reads: [v],
      writes: [dist],
      step: () => {
        const { x, y } = v.value;
        dist.value = Math.hypot(x, y);
      },
    });
    expect(dist.value).toBe(5);

    v.value = { x: 5, y: 12 };
    expect(dist.value).toBe(13);

    p.dispose();
  });

  it("two propagator networks on overlapping signals coexist", () => {
    // p1: a + b = c. p2: c * 2 = d. Independent networks observing the
    // same signal `c`. A change to a triggers p1 (which writes c);
    // p1's auto-batch flushes the queue; that flush wakes p2 (because
    // p2 subscribed to c via its own `network()`).
    const a = num(1);
    const b = num(2);
    const c = num(0);
    const d = num(0);

    const p1 = propagators();
    const p2 = propagators();
    p1.add(add(a, b, c));
    p2.add({
      reads: [c],
      writes: [d],
      step: () => {
        d.value = c.value * 2;
      },
    });
    // Initial: c = 3, d = 6.
    expect(c.value).toBe(3);
    expect(d.value).toBe(6);

    a.value = 7;
    expect(c.value).toBe(9);
    expect(d.value).toBe(18);

    p1.dispose();
    p2.dispose();
  });
});

describe("composition: typed cells without explicit Cell wrapper", () => {
  it("a Num cell IS a usable propagator cell — no Cell type needed", () => {
    // The whole point of non-coloring: I can take an existing Num
    // signal (e.g. one I'm already using elsewhere in my diagram)
    // and make it participate in a propagator network without
    // changing its type. No `cell(num(0), lattice)` ceremony.
    const x = num(5); // Writable<Num>
    const y = num(0);
    expect(x).toBeInstanceOf(Num);

    const p = propagators();
    p.add(eq(x, y));
    expect(y.value).toBe(5);
    expect(x).toBeInstanceOf(Num); // still a Num, no upgrade

    p.dispose();
  });

  it("Vec.lens-derived cell works as a propagator cell", () => {
    const root = vec(10, 20);
    // A custom Vec.lens: derive a vec offset by some constant.
    const offset = Vec.lens(
      root,
      v => ({ x: v.x + 1, y: v.y + 2 }),
      (newV, _v) => ({ x: newV.x - 1, y: newV.y - 2 }),
    );
    const targetX = num(0);

    const p = propagators();
    p.add(eq(offset.x, targetX));
    // root.x = 10 → offset.x = 11 → targetX = 11.
    expect(targetX.value).toBe(11);

    targetX.value = 100;
    // eq writes offset.x = 100, which back-propagates to root.x = 99.
    expect(root.value.x).toBe(99);
    expect(root.value.y).toBe(20); // y untouched

    p.dispose();
  });
});

// Lens × propagator routing guarantees. A reader propagator reading a lens
// must subscribe transitively to the lens's parents, and that cascade has to
// hold even when the parent is written by another propagator *within the same
// settle* (AUTO-EXPAND closes that freshness gap). The write direction and
// ordering behaviour is pinned here too.
describe("composition: lens × propagator routing", () => {
  it("in-fixpoint cascade: writer→parent→lens→reader settles in one fire", () => {
    const trigger = num(0);
    const a = num(0);
    const doubled = a.scale(2);
    const out = num(0);

    const p = propagators();
    p.add(
      propagator([trigger], [a], () => {
        a.value = trigger.value;
      }),
    );
    p.add(
      propagator([doubled], [out], () => {
        out.value = doubled.value;
      }),
    );

    trigger.value = 5;
    expect(a.value).toBe(5);
    expect(doubled.value).toBe(10);
    expect(out.value).toBe(10); // reader saw the in-fixpoint parent write
    p.dispose();
  });

  it("in-fixpoint cascade walks a multi-parent lens chain", () => {
    const trigger = num(0);
    const a = num(0);
    const b = num(3);
    const big = a.add(b).scale(2); // two parents: a and b
    const out = num(0);

    const p = propagators();
    p.add(
      propagator([trigger], [a], () => {
        a.value = trigger.value;
      }),
    );
    p.add(
      propagator([big], [out], () => {
        out.value = big.value;
      }),
    );

    trigger.value = 4;
    expect(out.value).toBe(14); // (4 + 3) * 2
    b.value = 5;
    expect(out.value).toBe(18); // (4 + 5) * 2 — the other parent is live too
    p.dispose();
  });

  it("propagator write through an N-parent centroid lens redistributes", () => {
    const verts = [vec(0, 0), vec(10, 0), vec(5, 10)];
    const cent = mean(verts);
    const target = vec(100, 100);

    const p = propagators();
    p.add(
      propagator([target], [cent], () => {
        cent.value = target.value;
      }),
    );

    // Initial centroid (5, 10/3); the delta to (100, 100) shifts every vert.
    expect(verts[0]!.value.x).toBeCloseTo(95);
    expect(verts[1]!.value.x).toBeCloseTo(105);
    expect(verts[2]!.value.x).toBeCloseTo(100);
    p.dispose();
  });

  it("two propagators writing one lens: the later-listed one wins per fire", () => {
    const verts = [vec(0, 0), vec(0, 0), vec(0, 0)];
    const cent = mean(verts);
    const target1 = vec(10, 0);
    const target2 = vec(0, 20);

    const p = propagators();
    p.add(
      propagator([target1], [cent], () => {
        cent.value = target1.value;
      }),
    );
    p.add(
      propagator([target2], [cent], () => {
        cent.value = target2.value;
      }),
    );

    expect(cent.value).toEqual({ x: 0, y: 20 }); // second writer runs later
    p.dispose();
  });

  it("disposing the network leaves the lens chain functional", () => {
    const a = num(0);
    const b = num(0);
    const sum = a.add(b);
    const out = num(0);

    const p = propagators();
    p.add(
      propagator([sum], [out], () => {
        out.value = sum.value;
      }),
    );
    a.value = 5;
    expect(out.value).toBe(5);

    p.dispose();
    a.value = 10;
    expect(sum.value).toBe(10); // the lens is its own cell, still computes
    expect(out.value).toBe(5); // the propagator stopped firing
  });

  it("bidirectional add overwrites the third cell on its initial fire", () => {
    // add(a, b, c) installs a forward (a+b→c) propagator that fires on
    // install, so a pre-set `c` is clobbered. Write the driver after install
    // if you need `c` respected.
    const a = num(0);
    const b = num(0);
    const c = num(7);

    const p = propagators();
    p.add(add(a, b, c));
    expect(c.value).toBe(0); // a + b = 0 overwrote the initial 7
    p.dispose();
  });
});
