// Lightweight A/B bench: time-boxed manual timing (no mitata warmup blowup),
// so the SAME file runs fast in both the HEAD and the `main` worktree and the
// numbers line up. Forward shapes run on bireactive vs alien vs preact (the
// "degenerate forward tax"); backward + extended shapes run on bireactive (the
// only adapter that writes backward). Extended shapes use the engine-agnostic
// raw `lens`/`cell` API so they exercise whichever engine the checkout ships.
//
//   node --expose-gc node_modules/.bin/vite-node src/core/_test/suite/bench/compare.ts

import { type Cell, cell, lens } from "@bireactive/core";
import { bireactive } from "../adapters/bireactive";
import { alien, preact } from "../adapters/forward";
import type { ForwardReactive, Reactive, Source, View } from "../adapters/types";
import {
  bwdChain,
  bwdChainBlind,
  bwdChainsPartial,
  bwdCoalesce,
  bwdFan,
  dragFan,
  fwdChain,
  fwdFan,
  type Tick,
} from "./workloads";

const gc = (globalThis as { gc?: () => void }).gc;

// Time-box: warm ~40ms, then measure ~200ms; report ns per tick.
function nsPerOp(tick: Tick): number {
  let i = 0;
  let acc = 0;
  const warmEnd = performance.now() + 40;
  while (performance.now() < warmEnd) acc += tick(i++);
  gc?.();
  let calls = 0;
  const t0 = process.hrtime.bigint();
  const measEnd = performance.now() + 200;
  while (performance.now() < measEnd) {
    acc += tick(i++);
    calls++;
  }
  const t1 = process.hrtime.bigint();
  if (acc === Number.POSITIVE_INFINITY) console.log(acc); // defeat DCE
  return Number(t1 - t0) / calls;
}

const fmt = (n: number) =>
  Number.isNaN(n) ? "n/a" : n < 1000 ? `${n.toFixed(1)} ns` : `${(n / 1000).toFixed(2)} µs`;
const safe = (tick: () => Tick): number => {
  try {
    return nsPerOp(tick());
  } catch {
    return Number.NaN;
  }
};

function rowForward(label: string, mk: (rx: ForwardReactive) => Tick): void {
  const b = safe(() => mk(bireactive));
  const a = safe(() => mk(alien));
  const p = safe(() => mk(preact));
  console.log(
    `  ${label.padEnd(34)} bireactive ${fmt(b).padStart(9)}   alien ${fmt(a).padStart(9)}   preact ${fmt(p).padStart(9)}   (tax ×${(b / a).toFixed(2)})`,
  );
}

function rowBwd(label: string, mk: (rx: Reactive) => Tick): void {
  console.log(`  ${label.padEnd(34)} bireactive ${fmt(safe(() => mk(bireactive))).padStart(9)}`);
}

function rowRaw(label: string, mk: () => Tick): void {
  console.log(`  ${label.padEnd(34)} bireactive ${fmt(safe(mk)).padStart(9)}`);
}

// ── extended shapes (engine-agnostic raw API) ─────────────────────────────
const setV = (c: Cell<number>, v: number) => ((c as { value: number }).value = v);
const getV = (c: Cell<number>) => c.value as number;

/** Shared-source diamond: one source feeds two halves of a fan-in view; write
 *  the view, read the source — exercises overlapping back-writes on one source. */
function diamond(): Tick {
  const s0 = cell(0) as unknown as Cell<number>;
  const s1 = cell(0) as unknown as Cell<number>;
  const left = lens(
    s0 as never,
    ((x: number) => x) as never,
    ((t: number) => t) as never,
  ) as unknown as Cell<number>;
  const view = lens(
    [left, s0, s1] as never, // s0 appears twice (direct + via left) → diamond
    ((v: number[]) => v[0]! + v[1]! + v[2]!) as never,
    ((t: number) => [t / 3, t / 3, t / 3]) as never,
  ) as unknown as Cell<number>;
  return i => {
    setV(view, i);
    return getV(s1);
  };
}

/** Stateful "stash" chain of depth D: write the top, read the source. */
function statefulStashChain(depth: number): Tick {
  let cur = cell(0) as unknown as Cell<number>;
  const src = cur;
  for (let d = 0; d < depth; d++) {
    cur = lens(
      [cur] as never,
      {
        init: () => 0,
        step: (_s: number[], c: number) => c,
        fwd: ([s]: number[], c: number) => s + c,
        bwd: (t: number, [_s]: number[], c: number) => ({ updates: [t - c], complement: c }),
      } as never,
    ) as unknown as Cell<number>;
  }
  const top = cur;
  return i => {
    setV(top, i);
    return getV(src);
  };
}

/** `width` lens contributors into one merge; write each, read the merged source. */
function mergeFan(width: number): Tick {
  const root = cell(0) as unknown as Cell<number> & { merge(): Cell<number> };
  const m = (root as unknown as { merge: () => Cell<number> }).merge();
  const arms = Array.from(
    { length: width },
    (_u, k) =>
      lens(
        m as never,
        ((x: number) => x + k) as never,
        ((t: number) => t - k) as never,
      ) as unknown as Cell<number>,
  );
  return i => {
    for (let k = 0; k < width; k++) setV(arms[k]!, i + k);
    return getV(root as unknown as Cell<number>);
  };
}

/** Mixed churn: a forward observer reads while a view is written every tick. */
function rwChurn(depth: number): Tick {
  let cur = cell(0) as unknown as Cell<number>;
  const src = cur;
  for (let d = 0; d < depth; d++)
    cur = lens(
      cur as never,
      ((x: number) => x + 1) as never,
      ((t: number) => t - 1) as never,
    ) as unknown as Cell<number>;
  const top = cur;
  return i => {
    setV(top, i);
    return getV(top) + getV(src);
  };
}

console.log(`\n=== forward (degenerate tax) ===`);
rowForward("forward chain (depth 50)", rx => fwdChain(rx, 50));
rowForward("forward fan-in (width 50)", rx => fwdFan(rx, 50));

console.log(`\n=== backward (bireactive only) ===`);
rowBwd("bwd chain depth 50 (write+read)", rx => bwdChain(rx, 50));
rowBwd("bwd fan width 50 (write+read)", rx => bwdFan(rx, 50));
rowBwd("bwd chain blind (unobserved)", rx => bwdChainBlind(rx, 50));
rowBwd("bwd coalesce 10 writes / read", rx => bwdCoalesce(rx, 50, 10));
rowBwd("bwd 20 chains, read 1 (partial)", rx => bwdChainsPartial(rx, 20, 50));
rowBwd("drag fan width 16 (live observer)", rx => dragFan(rx, 16));

console.log(`\n=== extended shapes ===`);
rowRaw("shared-source diamond", () => diamond());
rowRaw("stateful stash chain (depth 20)", () => statefulStashChain(20));
rowRaw("merge fan (width 16)", () => mergeFan(16));
rowRaw("rw churn chain depth 50", () => rwChurn(50));

void (null as unknown as [Source<number>, View<number>]);
