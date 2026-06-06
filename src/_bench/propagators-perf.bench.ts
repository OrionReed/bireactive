// Propagator network performance.

import "../_test/setup";
import { cell, num } from "@bireactive/core";
import {
  add,
  align,
  allDifferent,
  box,
  hstack,
  propagators,
  type SetCell,
} from "@bireactive/propagators";
import { bench, group, run } from "mitata";

const eqSet = (a: ReadonlySet<number>, b: ReadonlySet<number>): boolean => {
  if (a.size !== b.size) return false;
  for (const v of a) if (!b.has(v)) return false;
  return true;
};
const setCell = (init: Iterable<number>): SetCell<number> =>
  cell<ReadonlySet<number>>(new Set(init), { equals: eqSet });

group("propagator drag tick", () => {
  {
    const N = 100;
    const cells = Array.from({ length: N }, () => num(0));
    const p = propagators({ iterations: 200 });
    for (let i = 0; i < N - 2; i += 2) p.add(add(cells[i]!, cells[i + 1]!, cells[i + 2]!));
    let v = 0;
    bench("add chain N=100", () => {
      cells[1]!.value = v++;
    });
  }

  {
    const N = 100;
    const c = box(0, 0, 1000, 50);
    const items = Array.from({ length: N }, () => box());
    const p = propagators({ iterations: 100 });
    p.add(
      hstack(
        c,
        items.map(b => ({ box: b, min: 4, max: 50 })),
        { gap: 4 },
      ),
    );
    let i = 0;
    bench("hstack N=100 with bounds", () => {
      c.w.value = 800 + (i++ % 1500);
    });
  }

  {
    const N = 1000;
    const c = box(0, 0, 8000, 50);
    const items = Array.from({ length: N }, () => box());
    const p = propagators({ iterations: 100 });
    p.add(hstack(c, items, { gap: 2 }));
    let i = 0;
    bench("hstack N=1000", () => {
      c.w.value = 5000 + (i++ % 5000);
    });
  }

  {
    const N = 100;
    const cells = Array.from({ length: N }, () => num(0));
    const p = propagators({ iterations: 100 });
    p.add(align(...cells));
    let v = 0;
    bench("align N=100 (one→all)", () => {
      cells[0]!.value = v++;
    });
  }
});

group("propagator install / solve", () => {
  bench("sudoku 4x4 install + solve", () => {
    const all = (): SetCell<number> => setCell([1, 2, 3, 4]);
    const grid: SetCell<number>[][] = [
      [all(), setCell([2]), all(), all()],
      [setCell([3]), all(), all(), setCell([4])],
      [all(), all(), setCell([1]), all()],
      [all(), all(), setCell([4]), all()],
    ];
    const p = propagators({ iterations: 200 });
    for (const row of grid) p.add(allDifferent(...row));
    for (let c = 0; c < 4; c++) p.add(allDifferent(...grid.map(r => r[c]!)));
    p.add(allDifferent(grid[0]![0]!, grid[0]![1]!, grid[1]![0]!, grid[1]![1]!));
    p.add(allDifferent(grid[0]![2]!, grid[0]![3]!, grid[1]![2]!, grid[1]![3]!));
    p.add(allDifferent(grid[2]![0]!, grid[2]![1]!, grid[3]![0]!, grid[3]![1]!));
    p.add(allDifferent(grid[2]![2]!, grid[2]![3]!, grid[3]![2]!, grid[3]![3]!));
    p.dispose();
  });

  bench("install 1000-cell add chain", () => {
    const N = 1000;
    const cells = Array.from({ length: N }, () => num(0));
    const p = propagators({ iterations: 200 });
    for (let i = 0; i < N - 2; i += 2) p.add(add(cells[i]!, cells[i + 1]!, cells[i + 2]!));
    p.dispose();
  });
});

await run({ format: "mitata" });
