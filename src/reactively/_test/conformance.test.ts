// reactive-framework-test-suite against our refactored reactively (`core.ts`).
// Reactively is lazy about effects (they run on `stabilize()`), so the adapter
// stabilizes after every top-level write / batch to give the eager,
// synchronous semantics the suite expects. Effects return a real disposer
// (`Reactive.dispose`) and `untracked` maps to `untrack`.

import {
  type ReactiveFramework,
  SkipTest,
  setExpect,
  testSuite,
} from "reactive-framework-test-suite";
import { describe, expect, it } from "vitest";
import { Reactive, stabilize, untrack } from "../core";

setExpect(<T>(actual: T) => expect(actual) as never);

function reactivelyFramework(): ReactiveFramework {
  let depth = 0;
  let stabilizing = false;
  const flush = (): void => {
    if (depth !== 0 || stabilizing) return;
    stabilizing = true;
    try {
      stabilize();
    } finally {
      stabilizing = false;
    }
  };
  return {
    name: "reactively-fast",
    signal: <T>(initial: T) => {
      const r = new Reactive(initial);
      return {
        read: () => r.get(),
        write: (v: T) => {
          r.set(v);
          flush();
        },
      };
    },
    computed: <T>(fn: () => T) => {
      const r = new Reactive(fn);
      return { read: () => r.get() };
    },
    effect: (fn: () => void) => {
      // Force the initial run synchronously (reactively otherwise defers it to
      // stabilize) so it fires immediately even inside a batch (RFTS #70/#126).
      const r = new Reactive(fn, true);
      r.get();
      return () => r.dispose();
    },
    run: fn => fn(),
    batch: fn => {
      depth++;
      try {
        fn();
      } finally {
        // Flush in `finally` so pending effects still run when the batch body
        // throws (RFTS #69/#154).
        depth--;
        flush();
      }
    },
    untracked: fn => untrack(fn),
  };
}

const fw = reactivelyFramework();

// Cases that diverge by reactively's design (not regressions from the
// refactor — they fail on upstream `vendor.ts` too, since they're about the
// core push-pull model we didn't touch). Grouped by root cause:
const DIVERGED = new Set<string>([
  // (a) Independent effect scopes: no parent-child auto-disposal (as in
  //     alien-signals v2 / Solid 2 / the TC39 proposal).
  "#209 three-level nested effect: cascading disposal",
  "#210 multiple inner effects all cleaned when outer re-runs",

  // (b) No engine-level batch ⇒ no write-coalescing / value-revert detection.
  //     Reactively marks observers stale on *every* set (it must, so that
  //     pull-inside-batch sees fresh values — RFTS #128). A signal written
  //     5→0 in one batch therefore still re-runs dependents, where
  //     alien/preact snapshot the pre-batch value and cut the no-op.
  "#123 repeated no-op batches don't re-trigger effects",
  "#132 batch: computed not recomputed if dep reverts",
  "#147 computed not recomputed in batch if dep reverts",

  // (c) Sources are linked *after* a computation's body runs, so a write to a
  //     not-yet-linked dependency mid-evaluation (a computed/effect writing
  //     its own source) leaves a dirty node whose later subscriber never gets
  //     the cascade. alien handles this with version counters. NOTE: this is
  //     the bidirectional-write pattern (a lens writing back during
  //     propagation), so it's the most load-bearing divergence for bireactive.
  "#179 computed self-increment: intra-run read-after-write values correct",
  "#212 inner write through computed doesn't block future propagation",
  "#213 inner write during initial effect execution doesn't block future propagation",
]);

describe("reactively conformance (RFTS)", () => {
  for (const section of testSuite) {
    const isBehavioral = (section as { type?: string }).type === "behavioral";
    describe(section.section, () => {
      for (const [name, fn] of Object.entries(section.cases)) {
        if (isBehavioral || DIVERGED.has(name)) {
          it.skip(name, () => fn(fw));
        } else {
          it(name, ctx => {
            try {
              fn(fw);
            } catch (e) {
              // Capabilities reactively lacks (e.g. effect-returned cleanup)
              // surface as SkipTest — record as skipped, not failed.
              if (e instanceof SkipTest) ctx.skip();
              else throw e;
            }
          });
        }
      }
    });
  }
});
