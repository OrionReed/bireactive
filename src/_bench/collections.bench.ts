// Arr collection throughput: structural reorder, filter re-derive, and the
// grouped `move`. Order is the reference list itself, so a reorder is one
// splice with no per-element rank to write or run out of — these numbers are
// the cost of that single structural decision at scale.

import "../_test/setup";
import { arr, type Cell, cell, is, type Str, str, type Writable } from "@bireactive/core";
import { bench, do_not_optimize, group, run } from "mitata";

const STATUSES = ["todo", "doing", "done"];

const range = (n: number): number[] => Array.from({ length: n }, (_, i) => i);

for (const N of [100, 1000]) {
  group(`Arr structural reorder (N=${N})`, () => {
    {
      // One lens, held across the drag (as md-reorder does), alternating ends.
      const a = arr<number>(range(N));
      const idx = a.indexOf(a.cells[a.cells.length - 1]!);
      let k = 0;
      bench("indexOf lens write (held, alternating ends)", () => {
        idx.value = ++k % 2 === 0 ? 0 : N - 1;
        do_not_optimize(idx.peek());
      });
    }
    {
      const a = arr<number>(range(N));
      bench("moveBefore(first, null) (move to end)", () => {
        a.moveBefore(a.cells[0]!, null);
        do_not_optimize(a.cells[a.cells.length - 1]);
      });
    }
  });

  group(`Arr filter re-derive (N=${N})`, () => {
    const cells = range(N).map(i => cell(i));
    const a = arr<number>(cells);
    const evens = a.filter(c => c.value % 2 === 0);
    evens.values.value;
    const toggle = cells[0]!;
    bench("element flips parity → filter re-derives", () => {
      toggle.value = toggle.peek() + 1;
      do_not_optimize(evens.values.value.length);
    });
  });

  group(`Arr.groupBy move (N=${N})`, () => {
    interface T {
      status: Writable<Str>;
    }
    const cells = range(N).map(i => cell<T>({ status: str(STATUSES[i % 3]!) }));
    const a = arr<T>(cells);
    const board = a.groupBy(c => c.value.status, { order: STATUSES });
    board.value;
    let k = 0;
    const mover = cells[0] as Cell<T>;
    bench("move(e, key, 0) — write field + splice base", () => {
      board.move(mover, STATUSES[++k % 3]!, 0);
      do_not_optimize(board.value.length);
    });
  });
}

// `is` keeps the bench honest: an assertable predicate is the same surface the
// kanban filters on; touch it so the import is exercised, not tree-shaken.
do_not_optimize(is<{ status: Writable<Str> }, string>(c => c.value.status, "todo"));

await run({ format: "mitata" });
