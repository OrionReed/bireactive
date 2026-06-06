// Per-fire cost of `network`.

import "../_test/setup";
import { batch, cell, network } from "@bireactive/core";
import { bench, do_not_optimize, group, run } from "mitata";

group("network per-fire", () => {
  {
    const a = cell(0);
    const handle = network([a], () => {});
    bench("flush, 1 dep, no change", () => do_not_optimize(handle.flush()));
  }

  {
    const sigs = Array.from({ length: 100 }, (_, i) => cell(i));
    network(sigs, () => {});
    let i = 0;
    bench("100 deps, 1 change/fire", () => {
      sigs[i]!.value = sigs[i]!.peek() + 1;
      i = (i + 1) % 100;
    });
  }

  {
    const sigs = Array.from({ length: 1000 }, (_, i) => cell(i));
    network(sigs, () => {});
    let bursts = 0;
    bench("1000 deps, 10 changes/fire (batched)", () => {
      const offset = bursts * 10;
      bursts = (bursts + 1) % 100;
      batch(() => {
        for (let k = 0; k < 10; k++) {
          sigs[(offset + k) % 1000]!.value = sigs[(offset + k) % 1000]!.peek() + 1;
        }
      });
    });
  }

  {
    const a = cell(0);
    const handle = network([a], () => {}, { manual: true });
    bench("manual flush, 1 dep, no change", () => do_not_optimize(handle.flush()));
  }

  {
    const sigs = Array.from({ length: 100 }, (_, i) => cell(i));
    network(sigs, () => {
      let sum = 0;
      for (const s of sigs) sum += s.value;
      do_not_optimize(sum);
    });
    let i = 0;
    bench("100 deps, auto-fire + sum-read", () => {
      sigs[i]!.value = sigs[i]!.peek() + 1;
      i = (i + 1) % 100;
    });
  }
});

await run({ format: "mitata" });
