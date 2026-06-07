// Propagator network performance (monotone lattice core).

import "../_test/setup";
import { box } from "@bireactive/core";
import {
  add,
  allDifferent,
  type Interval,
  intervalCell,
  row,
  setCell,
  solver,
} from "@bireactive/propagators";
import { bench, group, run } from "mitata";

group("drag tick", () => {
  {
    const N = 100;
    const cells = Array.from({ length: N }, () => intervalCell(-1000, 1000));
    const p = solver();
    for (let i = 0; i < N - 2; i += 2) p.add(add(cells[i]!, cells[i + 1]!, cells[i + 2]!));
    let v = 0;
    bench("interval add chain N=100", () => {
      cells[1]!.value = [v, v] as Interval;
      v++;
    });
  }

  {
    const N = 100;
    const c = box(0, 0, 1000, 50);
    const items = Array.from({ length: N }, () => box());
    solver().add(
      row(
        c,
        items.map(b => ({ box: b, min: 4, max: 50, basis: 4 })),
        { gap: 4 },
      ),
    );
    let i = 0;
    bench("flex row N=100 with bounds", () => {
      c.w.value = 800 + (i++ % 1500);
    });
  }

  {
    const N = 1000;
    const c = box(0, 0, 8000, 50);
    const items = Array.from({ length: N }, () => box());
    solver().add(row(c, items, { gap: 2 }));
    let i = 0;
    bench("flex row N=1000", () => {
      c.w.value = 5000 + (i++ % 5000);
    });
  }
});

group("install / solve", () => {
  bench("sudoku 4x4 install + solve", () => {
    const all = () => setCell([1, 2, 3, 4]);
    const grid = [
      [all(), setCell([1, 2, 3, 4], [2]), all(), all()],
      [setCell([1, 2, 3, 4], [3]), all(), all(), setCell([1, 2, 3, 4], [4])],
      [all(), all(), setCell([1, 2, 3, 4], [1]), all()],
      [all(), all(), setCell([1, 2, 3, 4], [4]), all()],
    ];
    const p = solver();
    for (const r of grid) p.add(allDifferent(...r));
    for (let c = 0; c < 4; c++) p.add(allDifferent(...grid.map(r => r[c]!)));
    p.add(allDifferent(grid[0]![0]!, grid[0]![1]!, grid[1]![0]!, grid[1]![1]!));
    p.add(allDifferent(grid[0]![2]!, grid[0]![3]!, grid[1]![2]!, grid[1]![3]!));
    p.add(allDifferent(grid[2]![0]!, grid[2]![1]!, grid[3]![0]!, grid[3]![1]!));
    p.add(allDifferent(grid[2]![2]!, grid[2]![3]!, grid[3]![2]!, grid[3]![3]!));
    p.dispose();
  });

  bench("install 500-relation interval chain", () => {
    const N = 1000;
    const cells = Array.from({ length: N }, () => intervalCell(-1000, 1000));
    const p = solver();
    for (let i = 0; i < N - 2; i += 2) p.add(add(cells[i]!, cells[i + 1]!, cells[i + 2]!));
    p.dispose();
  });
});

await run({ format: "mitata" });
