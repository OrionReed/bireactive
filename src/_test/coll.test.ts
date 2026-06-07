// Coll — writable structural lenses; backward composition of move/insert.

import { describe, expect, it } from "vitest";
import { allPass, coll, is } from "../coll";
import { bool, type Bool, num, type Num, str, type Str, type Writable } from "../core";

interface Item {
  id: string;
  status: Writable<Str>;
  assignee: Writable<Str>;
  rank: Writable<Num>;
  done: Writable<Bool>;
}

let n = 0;
const item = (status: string, assignee: string, rank: number, done = false): Item => ({
  id: `i${++n}`,
  status: str(status),
  assignee: str(assignee),
  rank: num(rank),
  done: bool(done),
});

const STATUSES = ["todo", "doing", "done"];
const tasks = (items: Item[]) => coll(items, i => i.id);

describe("groupBy.move", () => {
  it("writes the group key field", () => {
    const a = item("todo", "ada", 1);
    const board = tasks([a]).groupBy(i => i.status, { order: STATUSES });
    board.move(a, "doing");
    expect(a.status.value).toBe("doing");
  });

  it("writes the order field between drop neighbours", () => {
    const a = item("doing", "ada", 1);
    const b = item("doing", "ada", 2);
    const c = item("todo", "ada", 9);
    const board = tasks([a, b, c]).groupBy(i => i.status, {
      order: STATUSES,
      sort: i => i.rank,
    });
    // drop c into "doing" between a (rank 1) and b (rank 2) → rank 1.5
    board.move(c, "doing", 1);
    expect(c.status.value).toBe("doing");
    expect(c.rank.value).toBeGreaterThan(1);
    expect(c.rank.value).toBeLessThan(2);
  });

  it("re-derives membership after a move", () => {
    const a = item("todo", "ada", 1);
    const board = tasks([a]).groupBy(i => i.status, { order: STATUSES });
    const doing = () => board.value.find(g => g.key === "doing")?.items ?? [];
    expect(doing()).toHaveLength(0);
    board.move(a, "doing");
    expect(doing()).toEqual([a]);
  });
});

describe("backward composition across a chain", () => {
  it("one move asserts the filter, sets the group, and writes the rank", () => {
    const a = item("todo", "linus", 5, false);
    const board = tasks([a])
      .filter(allPass(is<Item, string>(i => i.assignee, "ada"), is<Item, boolean>(i => i.done, false)))
      .groupBy(i => i.status, { order: STATUSES, sort: i => i.rank });

    board.move(a, "doing", 0);

    expect(a.assignee.value).toBe("ada"); // filter "mine" asserted
    expect(a.done.value).toBe(false); // filter "active" asserted
    expect(a.status.value).toBe("doing"); // group key
    expect(a.rank.value).toBe(0); // empty target group
  });
});

describe("filter.insert / source edits", () => {
  it("insert adds to the source and asserts the predicate", () => {
    const src = tasks([]);
    const mine = src.filter(is<Item, string>(i => i.assignee, "ada")).groupBy(i => i.status, {
      order: STATUSES,
    });
    const fresh = item("todo", "nobody", 0);
    mine.insert(fresh, "todo");
    expect(src.items).toContain(fresh);
    expect(fresh.assignee.value).toBe("ada");
    expect(fresh.status.value).toBe("todo");
  });

  it("remove deletes from the source through the chain", () => {
    const a = item("todo", "ada", 1);
    const src = tasks([a]);
    const mine = src.filter(is<Item, string>(i => i.assignee, "ada"));
    mine.remove(a);
    expect(src.items).not.toContain(a);
  });
});

describe("sortBy.move", () => {
  it("reorders by writing the rank field", () => {
    const a = item("todo", "ada", 1);
    const b = item("todo", "ada", 2);
    const c = item("todo", "ada", 3);
    const view = tasks([a, b, c]).sortBy(i => i.rank);
    expect(view.items).toEqual([a, b, c]);
    // move c to the front
    view.move(c, 0);
    expect(c.rank.value).toBeLessThan(1);
    expect(view.items[0]).toBe(c);
  });
});
