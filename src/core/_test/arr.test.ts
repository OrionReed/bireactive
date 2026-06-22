// Arr — cells-as-elements collection: structural order, shared-cell views.
//
// Elements are the writable cells you hold; `cells` exposes a read-only
// surface (always safe — a `map` view without an inverse has RO elements),
// so these tests keep handles to the cells they write through.

import { describe, expect, it } from "vitest";
import { type Cell, cell, derive, effect, settle, type Writable } from "../cell";
import { type Arr, allPass, arr, is } from "../values/arr";
import { type Bool, bool } from "../values/bool";
import { type Str, str } from "../values/str";

const vals = <T>(a: Arr<T>): T[] => a.cells.map(c => c.value);

describe("arr() factory", () => {
  it("wraps plain values in cells and passes cells through", () => {
    const shared = cell(7);
    const a = arr<number>([1, 2, shared]);
    expect(vals(a)).toEqual([1, 2, 7]);
    expect(a.cells[2]).toBe(shared);
  });

  it("is empty by default", () => {
    expect(arr<number>().cells).toHaveLength(0);
  });

  it("exposes a reactive values snapshot and length", () => {
    const c0 = cell(1);
    const a = arr<number>([c0, cell(2), cell(3)]);
    expect(a.values.value).toEqual([1, 2, 3]);
    expect(a.length.value).toBe(3);
    c0.value = 10;
    expect(a.values.value).toEqual([10, 2, 3]);
  });
});

describe("structural edits", () => {
  it("push / insert return the element cell and place it", () => {
    const a = arr<string>(["a", "c"]);
    const b = a.insert("b", 1);
    expect(vals(a)).toEqual(["a", "b", "c"]);
    expect(b.value).toBe("b");
    a.push("d");
    expect(vals(a)).toEqual(["a", "b", "c", "d"]);
  });

  it("remove by reference and removeAt by position", () => {
    const a = arr<string>(["a", "b", "c"]);
    const b = a.cells[1]!;
    a.remove(b);
    expect(vals(a)).toEqual(["a", "c"]);
    a.removeAt(0);
    expect(vals(a)).toEqual(["c"]);
  });

  it("move splices the reference (no rank field)", () => {
    const a = arr<string>(["a", "b", "c", "d"]);
    const c = a.cells[2]!;
    a.move(c, 0);
    expect(vals(a)).toEqual(["c", "a", "b", "d"]);
    a.move(c, 3);
    expect(vals(a)).toEqual(["a", "b", "d", "c"]);
  });

  it("clear empties the base", () => {
    const a = arr<number>([1, 2, 3]);
    a.clear();
    expect(a.cells).toHaveLength(0);
  });

  it("element identity is stable across structural edits", () => {
    const a = arr<number>([1, 2, 3]);
    const c2 = a.cells[1]!;
    a.move(c2, 0);
    a.insert(9, 0);
    expect(a.cells.indexOf(c2)).toBe(1);
    expect(c2.value).toBe(2);
  });
});

describe("indexOf — writable position lens", () => {
  it("reads the current index", () => {
    const a = arr<string>(["a", "b", "c"]);
    expect(a.indexOf(a.cells[0]!).value).toBe(0);
    expect(a.indexOf(a.cells[2]!).value).toBe(2);
  });

  it("writing the index reorders structurally", () => {
    const a = arr<string>(["a", "b", "c"]);
    const ia = a.indexOf(a.cells[0]!);
    ia.value = 2;
    expect(vals(a)).toEqual(["b", "c", "a"]);
    expect(ia.value).toBe(2);
  });

  it("rounds and clamps an out-of-range / fractional target", () => {
    const a = arr<string>(["a", "b", "c"]);
    const c = a.cells[2]!;
    a.indexOf(c).value = -5; // clamps to 0
    expect(a.cells[0]).toBe(c);
    a.indexOf(c).value = 1.4; // rounds to 1
    expect(a.cells[1]).toBe(c);
  });

  it("is a no-op when the index is unchanged", () => {
    const a = arr<string>(["a", "b"]);
    const before = a.cells;
    a.indexOf(a.cells[1]!).value = 1;
    expect(a.cells).toBe(before); // same reference: no structural write
  });

  it("tracks reactively as the order changes", () => {
    const a = arr<string>(["a", "b", "c"]);
    const c = a.cells[2]!;
    const ic = a.indexOf(c);
    expect(ic.value).toBe(2);
    a.move(a.cells[0]!, 2); // a after c → [b, c, a]
    expect(ic.value).toBe(1);
  });
});

describe("filter view", () => {
  it("shares element cells and re-derives on value change", () => {
    const c0 = cell(1);
    const a = arr<number>([c0, cell(2), cell(3), cell(4)]);
    const evens = a.filter(c => c.value % 2 === 0);
    expect(vals(evens)).toEqual([2, 4]);
    c0.value = 6; // 1 → 6, now even
    expect(vals(evens)).toEqual([6, 2, 4]);
  });

  it("editing through the view writes the shared cell", () => {
    const c1 = cell(2);
    const a = arr<number>([cell(1), c1, cell(3), cell(4)]);
    const evens = a.filter(c => c.value % 2 === 0);
    expect(evens.cells[0]).toBe(c1); // same cell, shared
    c1.value = 20;
    expect(a.cells[1]!.value).toBe(20);
  });

  it("insert adds to the base and asserts the predicate", () => {
    const a = arr<number>([2, 4]);
    const evens = Object.assign((c: Cell<number>) => c.value % 2 === 0, {
      assert: (c: Cell<number>) => {
        if (c.value % 2 !== 0) (c as Writable<Cell<number>>).value = c.value + 1;
      },
    });
    const view = a.filter(evens);
    const e = view.insert(7);
    expect(e.value).toBe(8); // asserted to even
    expect(vals(a)).toContain(8);
    expect(vals(view)).toContain(8);
  });

  it("remove through the view removes from the base", () => {
    const a = arr<number>([1, 2, 3, 4]);
    const evens = a.filter(c => c.value % 2 === 0);
    evens.remove(evens.cells[0]!); // the cell holding 2
    expect(vals(a)).toEqual([1, 3, 4]);
  });
});

describe("sortBy view", () => {
  it("orders by key and re-sorts on change", () => {
    const c1 = cell({ n: 1 });
    const a = arr<{ n: number }>([cell({ n: 3 }), c1, cell({ n: 2 })]);
    const byN = a.sortBy(c => c.value.n);
    expect(byN.cells.map(c => c.value.n)).toEqual([1, 2, 3]);
    c1.value = { n: 9 }; // was 1, now 9
    expect(byN.cells.map(c => c.value.n)).toEqual([2, 3, 9]);
  });

  it("shares cells with the base", () => {
    const a = arr<number>([3, 1, 2]);
    const sorted = a.sortBy(c => c.value);
    expect(sorted.cells[0]).toBe(a.cells[1]); // the cell holding 1
  });
});

describe("map view", () => {
  it("projects element values read-only without an inverse", () => {
    const c0 = cell(1);
    const a = arr<number>([c0, cell(2), cell(3)]);
    const doubled = a.map(n => n * 2);
    expect(vals(doubled)).toEqual([2, 4, 6]);
    c0.value = 5;
    expect(vals(doubled)).toEqual([10, 4, 6]);
  });

  it("is writable with an inverse and writes back to the source cell", () => {
    const a = arr<number>([1, 2, 3]);
    const doubled = a.map(
      n => n * 2,
      u => u / 2,
    );
    (doubled.cells[1] as Writable<Cell<number>>).value = 100;
    expect(a.cells[1]!.value).toBe(50);
  });

  it("keeps mapped-element identity stable across re-derives", () => {
    const c0 = cell(1);
    const a = arr<number>([c0, cell(2), cell(3)]);
    const doubled = a.map(n => n * 2);
    const m1 = doubled.cells[1];
    c0.value = 9; // forces the map getter to re-run
    expect(doubled.cells[1]).toBe(m1);
  });

  it("remove through a map view removes the source element", () => {
    const a = arr<number>([1, 2, 3]);
    const doubled = a.map(n => n * 2);
    doubled.remove(doubled.cells[1]!);
    expect(vals(a)).toEqual([1, 3]);
  });
});

// A record-of-cells element (the kanban shape): the Arr holds `Cell<Task>`
// wrappers, and group/filter key on the inner writable fields.
interface Task {
  id: string;
  status: Writable<Str>;
  assignee: Writable<Str>;
  done: Writable<Bool>;
}

let taskN = 0;
const task = (status: string, assignee: string, done = false): Cell<Task> =>
  cell<Task>({
    id: `t${++taskN}`,
    status: str(status),
    assignee: str(assignee),
    done: bool(done),
  });

const STATUSES = ["todo", "doing", "done"];

describe("groupBy view", () => {
  it("buckets by the key field, seeding empty groups in `order`", () => {
    const t1 = task("todo", "ada");
    const t2 = task("doing", "ada");
    const board = arr<Task>([t1, t2]).groupBy(c => c.value.status, { order: STATUSES });
    const g = board.value;
    expect(g.map(x => x.key)).toEqual(["todo", "doing", "done"]);
    expect(g[0]!.items.cells).toEqual([t1]);
    expect(g[1]!.items.cells).toEqual([t2]);
    expect(g[2]!.items.cells).toEqual([]);
  });

  it("move writes the group key field and re-derives membership", () => {
    const t = task("todo", "ada");
    const board = arr<Task>([t]).groupBy(c => c.value.status, { order: STATUSES });
    const doing = () => board.value.find(g => g.key === "doing")?.items.cells ?? [];
    expect(doing()).toHaveLength(0);
    board.move(t, "doing");
    expect(t.value.status.value).toBe("doing");
    expect(doing()).toEqual([t]);
  });

  it("move places at an index within the target group (structural splice)", () => {
    const a = task("doing", "ada");
    const b = task("doing", "ada");
    const c = task("todo", "ada");
    const board = arr<Task>([a, b, c]).groupBy(x => x.value.status, { order: STATUSES });
    // drop c into "doing" between a and b → index 1
    board.move(c, "doing", 1);
    expect(c.value.status.value).toBe("doing");
    expect(board.value.find(g => g.key === "doing")!.items.cells).toEqual([a, c, b]);
  });

  it("a grouped sub-Arr keeps stable identity across re-buckets", () => {
    const t = task("todo", "ada");
    const board = arr<Task>([t]).groupBy(c => c.value.status, { order: STATUSES });
    const todoFirst = board.value.find(g => g.key === "todo")!.items;
    board.move(t, "doing");
    const todoAgain = board.value.find(g => g.key === "todo")!.items;
    expect(todoAgain).toBe(todoFirst);
  });

  it("one move asserts the filter, sets the group, and positions (backward chain)", () => {
    const t = task("todo", "linus", false);
    const board = arr<Task>([t])
      .filter(
        allPass(
          is<Task, string>(c => c.value.assignee, "ada"),
          is<Task, boolean>(c => c.value.done, false),
        ),
      )
      .groupBy(c => c.value.status, { order: STATUSES });
    board.move(t, "doing", 0);
    expect(t.value.assignee.value).toBe("ada"); // filter "mine" asserted
    expect(t.value.done.value).toBe(false); // filter "active" asserted
    expect(t.value.status.value).toBe("doing"); // group key
  });

  it("insert through a filtered group adds to the base and asserts", () => {
    const list = arr<Task>([]);
    const mine = list
      .filter(is<Task, string>(c => c.value.assignee, "ada"))
      .groupBy(c => c.value.status, { order: STATUSES });
    const fresh = task("todo", "nobody");
    mine.insert(fresh, "todo");
    expect(list.cells).toContain(fresh);
    expect(fresh.value.assignee.value).toBe("ada");
    expect(fresh.value.status.value).toBe("todo");
  });

  it("remove through the group deletes from the base", () => {
    const t = task("todo", "ada");
    const list = arr<Task>([t]);
    list.groupBy(c => c.value.status, { order: STATUSES }).remove(t);
    expect(list.cells).not.toContain(t);
  });

  it("an effect fires when an element changes its group", () => {
    const t = task("todo", "ada");
    const board = arr<Task>([t]).groupBy(c => c.value.status, { order: STATUSES });
    let counts: number[] = [];
    const dispose = effect(() => {
      counts = board.value.map(g => g.items.cells.length);
    });
    expect(counts).toEqual([1, 0, 0]);
    board.move(t, "done");
    settle();
    expect(counts).toEqual([0, 0, 1]);
    dispose();
  });
});

describe("is / allPass cell predicates", () => {
  it("is(field, value) reads and asserts the field", () => {
    const t = task("todo", "linus");
    const p = is<Task, string>(c => c.value.assignee, "ada");
    expect(p(t)).toBe(false);
    p.assert?.(t);
    expect(t.value.assignee.value).toBe("ada");
    expect(p(t)).toBe(true);
  });

  it("allPass conjoins and asserts every clause", () => {
    const t = task("todo", "linus", true);
    const p = allPass(
      is<Task, string>(c => c.value.status, "doing"),
      is<Task, boolean>(c => c.value.done, false),
    );
    expect(p(t)).toBe(false);
    p.assert?.(t);
    expect(t.value.status.value).toBe("doing");
    expect(t.value.done.value).toBe(false);
    expect(p(t)).toBe(true);
  });
});

describe("composition and reactivity", () => {
  it("filter ▶ sortBy chains and delegates remove to the base", () => {
    const a = arr<number>([5, 2, 8, 1, 4]);
    const view = a.filter(c => c.value % 2 === 0).sortBy(c => c.value);
    expect(vals(view)).toEqual([2, 4, 8]);
    view.remove(view.cells[0]!); // removes the cell holding 2
    expect(vals(a)).toEqual([5, 8, 1, 4]);
  });

  it("an effect fires on structural and value changes", () => {
    const c0 = cell(1);
    const a = arr<number>([c0, cell(2)]);
    const sum = derive(a, cs => cs.reduce((s, c) => s + c.value, 0));
    let seen = 0;
    let fires = 0;
    const dispose = effect(() => {
      seen = sum.value;
      fires++;
    });
    fires = 0;
    a.push(3);
    settle();
    expect(seen).toBe(6);
    c0.value = 10;
    settle();
    expect(seen).toBe(15);
    expect(fires).toBe(2);
    dispose();
  });
});
