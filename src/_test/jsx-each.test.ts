// Keyed list rendering (`each` from the JSX runtime). No DOM here: a fake parent
// captures `replaceChildren`, and items render to plain sentinels. These pin the
// reconciliation contract — stable identity, reorder-in-place, dispose-on-leave,
// and isolation (an item's own reactivity must not retrigger the whole list).

import { describe, expect, it } from "vitest";
import { batch, type Cell, cell, effect, type Writable } from "../core/cell";
import { each, onCleanup } from "../jsx-runtime";

type Item = { id: string };

function fakeParent() {
  return {
    children: [] as unknown[],
    replaceCount: 0,
    get childNodes() {
      return this.children;
    },
    replaceChildren(...nodes: unknown[]) {
      this.children = nodes;
      this.replaceCount++;
    },
  };
}

describe("each (keyed list rendering)", () => {
  it("renders one node per key and reorders existing nodes in place", () => {
    const items = cell<Item[]>([{ id: "a" }, { id: "b" }]);
    const parent = fakeParent();
    const made: string[] = [];
    each(
      parent as unknown as Element,
      items,
      it => it.id,
      it => {
        made.push(it.id);
        return { tag: it.id } as unknown as Node;
      },
    );

    expect(made).toEqual(["a", "b"]);
    const [nodeA, nodeB] = parent.children;

    batch(() => {
      items.value = [{ id: "b" }, { id: "a" }];
    });

    // No re-render (no new keys), and the same nodes, reordered.
    expect(made).toEqual(["a", "b"]);
    expect(parent.children[0]).toBe(nodeB);
    expect(parent.children[1]).toBe(nodeA);
  });

  it("does not touch the DOM when keys and order are unchanged", () => {
    const items = cell<Item[]>([{ id: "a" }, { id: "b" }]);
    const parent = fakeParent();
    each(
      parent as unknown as Element,
      items,
      it => it.id,
      it => ({ tag: it.id }) as unknown as Node,
    );
    const initial = parent.replaceCount;
    // New array, identical keys and order — must not re-insert (would steal focus).
    batch(() => {
      items.value = [{ id: "a" }, { id: "b" }];
    });
    expect(parent.replaceCount).toBe(initial);
  });

  it("disposes an item's effects when it leaves the list", () => {
    const items = cell<Item[]>([{ id: "a" }, { id: "b" }]);
    const ticks: Record<string, number> = {};
    const cells: Record<string, Writable<Cell<number>>> = {};
    const parent = fakeParent();
    each(
      parent as unknown as Element,
      items,
      it => it.id,
      it => {
        cells[it.id] ??= cell(0);
        onCleanup(
          effect(() => {
            cells[it.id]!.value;
            ticks[it.id] = (ticks[it.id] ?? 0) + 1;
          }),
        );
        return { tag: it.id } as unknown as Node;
      },
    );
    expect(ticks).toEqual({ a: 1, b: 1 });

    batch(() => {
      items.value = [{ id: "a" }];
    });
    // b's node is gone; its effect must be disposed (won't tick again).
    batch(() => {
      cells.b!.value = 99;
    });
    expect(ticks.b).toBe(1);
    expect(parent.children).toHaveLength(1);
  });

  it("does not re-run the list when an item's own cell changes", () => {
    const items = cell<Item[]>([{ id: "a" }, { id: "b" }]);
    const cells: Record<string, Writable<Cell<number>>> = {};
    const parent = fakeParent();
    let renders = 0;
    each(
      parent as unknown as Element,
      items,
      it => it.id,
      it => {
        renders++;
        cells[it.id] ??= cell(0);
        onCleanup(
          effect(() => {
            cells[it.id]!.value;
          }),
        );
        return { tag: it.id } as unknown as Node;
      },
    );
    expect(renders).toBe(2);
    const replacesAfterInit = parent.replaceCount;

    batch(() => {
      cells.a!.value = 5;
    });
    // Item-internal change: no new render, no list rebuild.
    expect(renders).toBe(2);
    expect(parent.replaceCount).toBe(replacesAfterInit);
  });
});
