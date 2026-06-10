// Kairo propagation suite, run via mitata. Three engines per group: upstream
// `reactively` (vendor.ts), our `reactively-fast` (core.ts), and `alien` as
// the ceiling. Each bench drives one full kairo `tick` per sample, with a
// 50-iter JIT pre-warm (house style, see _bench/anim.bench.ts).
//
//   node --expose-gc node_modules/.bin/vite-node src/reactively/_bench/kairo.bench.ts

import { bench, do_not_optimize, group, run } from "mitata";
import { alien, fast, type ReactiveFramework, vendor } from "./framework";
import { kairoCases } from "./kairo";

const engines: ReactiveFramework[] = [vendor, fast, alien];

for (const c of kairoCases) {
  group(c.name, () => {
    for (const rx of engines) {
      const tick = rx.withBuild(() => c.build(rx));
      for (let w = 0; w < 50; w++) tick();
      if ((globalThis as { gc?: () => void }).gc) (globalThis as { gc: () => void }).gc();
      bench(rx.name, () => do_not_optimize(tick()));
    }
  });
}

await run({ format: "mitata" });
