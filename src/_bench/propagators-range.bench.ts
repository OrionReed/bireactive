// Interval-cell vs exact-cell propagation.

import "../_test/setup";
import { num } from "@bireactive/core";
import {
  add as adder,
  intervalAdder,
  propagators,
  type Range,
  rangeCell,
} from "@bireactive/propagators";
import { bench, group, run } from "mitata";

group("range vs exact drag tick", () => {
  {
    const N = 100;
    const cells = Array.from({ length: N }, () => num(0));
    const p = propagators({ iterations: 200 });
    for (let i = 0; i < N - 2; i += 2) p.add(adder(cells[i]!, cells[i + 1]!, cells[i + 2]!));
    let v = 0;
    bench("EXACT adder chain N=100", () => {
      cells[1]!.value = v++;
    });
  }

  {
    const N = 100;
    const cells = Array.from({ length: N }, () => rangeCell(-1000, 1000));
    const p = propagators({ iterations: 200 });
    for (let i = 0; i < N - 2; i += 2)
      p.add(intervalAdder(cells[i]!, cells[i + 1]!, cells[i + 2]!));
    let v = 0;
    bench("INTERVAL adder chain N=100", () => {
      cells[1]!.value = [v, v] as Range;
      v++;
    });
  }
});

group("interval narrowing", () => {
  bench("INTERVAL progressive narrowing (25 writes over N=50 chain)", () => {
    const N = 50;
    const cells = Array.from({ length: N }, () => rangeCell(-1000, 1000));
    const p = propagators({ iterations: 500 });
    for (let i = 0; i < N - 2; i += 2)
      p.add(intervalAdder(cells[i]!, cells[i + 1]!, cells[i + 2]!));
    for (let i = 0; i < N; i += 2) cells[i]!.value = [i, i] as Range;
    p.dispose();
  });
});

await run({ format: "mitata" });
