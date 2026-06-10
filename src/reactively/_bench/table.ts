// Clean comparative harness: median µs per kairo case per engine, plus the
// recompute count (computed-fn invocations) so we can catch over-computation
// that asserts alone would miss. Mirrors the upstream harness's warmup +
// fastest-of-N timing, but prints a single legible table instead of mitata's
// GC-inflated histograms.
//
//   node --expose-gc node_modules/.bin/vite-node src/reactively/_bench/table.ts

import { alien, fast, type ReactiveFramework, vendor } from "./framework";
import { type Case, kairoCases } from "./kairo";

const engines: ReactiveFramework[] = [vendor, fast, alien];
const SAMPLES = 12;
const INNER = 200;

function gc(): void {
  const g = (globalThis as { gc?: () => void }).gc;
  if (g) {
    g();
    g();
  }
}

/** Wrap an engine so every computed fn invocation is counted. */
function counting(rx: ReactiveFramework): { rx: ReactiveFramework; reads: () => number } {
  let n = 0;
  const wrapped: ReactiveFramework = {
    ...rx,
    computed: <T>(fn: () => T) =>
      rx.computed(() => {
        n++;
        return fn();
      }),
  };
  return { rx: wrapped, reads: () => n };
}

function median(xs: number[]): number {
  const s = [...xs].sort((a, b) => a - b);
  return s[s.length >> 1];
}

interface Row {
  engine: string;
  us: number;
  reads: number;
}

function measure(c: Case, rx: ReactiveFramework): Row {
  const { rx: counted, reads } = counting(rx);
  const tick = counted.withBuild(() => c.build(counted));
  for (let i = 0; i < 50; i++) tick(); // warmup
  const readsBefore = reads();
  gc();
  const times: number[] = [];
  for (let s = 0; s < SAMPLES; s++) {
    const t0 = performance.now();
    for (let i = 0; i < INNER; i++) tick();
    times.push((performance.now() - t0) / INNER);
  }
  const readsPerTick = (reads() - readsBefore) / (SAMPLES * INNER);
  return { engine: rx.name, us: median(times) * 1000, reads: Math.round(readsPerTick) };
}

const pad = (s: string, n: number) => s.padEnd(n);
const padl = (s: string, n: number) => s.padStart(n);

console.log(
  pad("case", 22) +
    pad("engine", 18) +
    padl("µs/tick", 12) +
    padl("vs alien", 12) +
    padl("recomputes", 14),
);
console.log("-".repeat(78));

// geomean of each engine's ratio-to-alien across all cases (a single
// "overall vs alien" number, robust to per-case scale).
const ratioProduct: Record<string, number> = {};
let caseCount = 0;

for (const c of kairoCases) {
  const rows = engines.map(rx => measure(c, rx));
  const alienUs = rows.find(r => r.engine === "alien")!.us;
  for (const r of rows) {
    const ratio = r.us / alienUs;
    ratioProduct[r.engine] = (ratioProduct[r.engine] ?? 1) * ratio;
    console.log(
      pad(c.name, 22) +
        pad(r.engine, 18) +
        padl(r.us.toFixed(2), 12) +
        padl(`${ratio.toFixed(2)}x`, 12) +
        padl(String(r.reads), 14),
    );
  }
  console.log("-".repeat(78));
  caseCount++;
}

console.log("geomean vs alien (lower = faster, 1.00 = alien):");
for (const rx of engines) {
  const geo = ratioProduct[rx.name] ** (1 / caseCount);
  console.log(`  ${pad(rx.name, 18)} ${geo.toFixed(3)}x`);
}
