// (A) inverse-memo probe — isolates the backward early-cutoff win.
//
// A source-reading 1→1 lens with a deliberately non-trivial `put` is
// back-written repeatedly. Two drives:
//   • stable   — same target every iter (memo HITS: `put` skipped under A)
//   • changing — fresh target every iter (memo MISSES: `put` always runs)
//
// Two engines side by side (independent graphs, no shared identity):
//   • baseline — the unmodified `src/core` engine
//   • A        — the `protosrc/core` engine with the BwdSpec memo
//
// Expectation: baseline stable ≈ baseline changing (always runs `put`);
// A changing ≈ baseline changing; A stable ≪ everything (cutoff engages).

import { bench, do_not_optimize, group } from "mitata";
import { cell as cellB, lens as lensB } from "../../../../../src/core/index";
import { cell as cellA, lens as lensA } from "../../../index";

// Non-trivial, pure inverse: cost lives in `put` so a memo hit is visible.
function heavy(t: number): number {
  let a = 0;
  for (let i = 0; i < 400; i++) a += Math.sin(t + i) * Math.cos(t - i);
  return t + a * 1e-12;
}

function mkDrive(
  cellFn: typeof cellA,
  lensFn: typeof lensA,
  changing: boolean,
): () => number {
  const src = cellFn(0);
  const view = lensFn(
    src as never,
    ((s: number) => s) as never,
    ((t: number, _s: number) => heavy(t)) as never,
  ) as { value: number };
  return () => {
    let acc = 0;
    for (let i = 0; i < 1000; i++) {
      view.value = changing ? i : 7;
      acc += src.value;
    }
    return acc;
  };
}

function reg(name: string, drive: () => number): void {
  for (let w = 0; w < 200; w++) do_not_optimize(drive());
  if ((globalThis as { gc?: () => void }).gc) (globalThis as { gc: () => void }).gc();
  bench(name, () => do_not_optimize(drive()));
}

group("(A) memo: source-reading back-write, stable target", () => {
  reg("baseline", mkDrive(cellB as never, lensB as never, false));
  reg("A", mkDrive(cellA, lensA, false));
});

group("(A) memo: source-reading back-write, changing target", () => {
  reg("baseline", mkDrive(cellB as never, lensB as never, true));
  reg("A", mkDrive(cellA, lensA, true));
});
