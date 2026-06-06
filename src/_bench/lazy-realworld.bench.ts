// Steady-state cost of field-lens access on Vec / Box / memoised views: `lazy()`
// installs an own-property shadow so subsequent reads skip the prototype getter.

import "../_test/setup";
import { box, vec } from "@bireactive/core";
import { bench, do_not_optimize, group, run } from "mitata";

const N = 100_000;

group(`field-lens access (N=${N} reads/call, lazy steady state)`, () => {
  {
    const v = vec(3, 4);
    v.x;
    bench("Vec .x", () => {
      let s = 0;
      for (let i = 0; i < N; i++) s += v.x.value;
      do_not_optimize(s);
    });
  }

  {
    const v = vec(3, 4);
    v.x;
    v.y;
    bench("Vec .x + .y", () => {
      let s = 0;
      for (let i = 0; i < N; i++) s += v.x.value + v.y.value;
      do_not_optimize(s);
    });
  }

  {
    const b = box(0, 0, 100, 50);
    b.x;
    b.y;
    b.w;
    b.h;
    bench("Box .x + .y + .w + .h", () => {
      let s = 0;
      for (let i = 0; i < N; i++) s += b.x.value + b.y.value + b.w.value + b.h.value;
      do_not_optimize(s);
    });
  }

  {
    const v = vec(3, 4);
    v.magnitude;
    bench("Vec.magnitude (memoised derived)", () => {
      let s = 0;
      for (let i = 0; i < N; i++) s += v.magnitude.value;
      do_not_optimize(s);
    });
  }

  {
    const b = box(0, 0, 100, 50);
    b.center;
    bench("Box.center (memoised anchor)", () => {
      let s = 0;
      for (let i = 0; i < N; i++) s += b.center.value.x;
      do_not_optimize(s);
    });
  }

  bench("first .x on N fresh Vecs (cold install)", () => {
    const vs = new Array(N);
    for (let i = 0; i < N; i++) vs[i] = vec(i, i);
    let s = 0;
    for (let i = 0; i < N; i++) s += vs[i].x.value;
    do_not_optimize(s);
  });
});

await run({ format: "mitata" });
