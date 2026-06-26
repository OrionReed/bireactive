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

  it("reorders via moveBefore (no remove/insert) when supported", () => {
    // Faithful-enough fake DOM: tracks parentage so `reorder` takes the moveBefore
    // path and we can assert surviving nodes are moved, never detached.
    class Node {
      parent: Parent | null = null;
      removed = 0;
      constructor(public id: string) {}
      get nextSibling(): Node | null {
        const ks = this.parent?.kids;
        if (!ks) return null;
        const i = ks.indexOf(this);
        return i >= 0 && i + 1 < ks.length ? ks[i + 1]! : null;
      }
      get parentNode(): Parent | null {
        return this.parent;
      }
      remove(): void {
        const ks = this.parent?.kids;
        if (ks) ks.splice(ks.indexOf(this), 1);
        this.removed++;
        this.parent = null;
      }
    }
    class Parent {
      kids: Node[] = [];
      moves = 0;
      get childNodes(): Node[] {
        return this.kids;
      }
      get firstChild(): Node | null {
        return this.kids[0] ?? null;
      }
      insertBefore(node: Node, ref: Node | null): void {
        if (node.parent) {
          const ks = node.parent.kids;
          ks.splice(ks.indexOf(node), 1);
        }
        const i = ref ? this.kids.indexOf(ref) : this.kids.length;
        this.kids.splice(i < 0 ? this.kids.length : i, 0, node);
        node.parent = this;
      }
      moveBefore(node: Node, ref: Node | null): void {
        if (node.parent !== this) throw new Error("moveBefore: not a child");
        this.moves++;
        this.kids.splice(this.kids.indexOf(node), 1);
        const i = ref ? this.kids.indexOf(ref) : this.kids.length;
        this.kids.splice(i < 0 ? this.kids.length : i, 0, node);
      }
      replaceChildren(): void {
        throw new Error("replaceChildren should not be called on the moveBefore path");
      }
    }

    const items = cell<Item[]>([{ id: "a" }, { id: "b" }, { id: "c" }]);
    const parent = new Parent();
    const made: Record<string, Node> = {};
    let renders = 0;
    each(
      parent as unknown as Element,
      items,
      it => it.id,
      it => {
        renders++;
        return (made[it.id] = new Node(it.id)) as unknown as globalThis.Node;
      },
    );
    expect(parent.kids.map(k => k.id)).toEqual(["a", "b", "c"]);

    batch(() => {
      items.value = [{ id: "c" }, { id: "a" }, { id: "b" }];
    });
    // Same node objects, reordered via moveBefore — no re-render, no detach.
    expect(renders).toBe(3);
    expect(parent.kids[0]).toBe(made.c);
    expect(parent.kids.map(k => k.id)).toEqual(["c", "a", "b"]);
    expect(parent.moves).toBeGreaterThan(0);
    expect([made.a, made.b, made.c].every(n => n.removed === 0)).toBe(true);
  });

  it("removes departed nodes on the moveBefore path", () => {
    class Node {
      parent: Parent | null = null;
      removed = 0;
      constructor(public id: string) {}
      get nextSibling(): Node | null {
        const ks = this.parent?.kids;
        if (!ks) return null;
        const i = ks.indexOf(this);
        return i >= 0 && i + 1 < ks.length ? ks[i + 1]! : null;
      }
      get parentNode(): Parent | null {
        return this.parent;
      }
      remove(): void {
        const ks = this.parent?.kids;
        if (ks) ks.splice(ks.indexOf(this), 1);
        this.removed++;
        this.parent = null;
      }
    }
    class Parent {
      kids: Node[] = [];
      get childNodes(): Node[] {
        return this.kids;
      }
      get firstChild(): Node | null {
        return this.kids[0] ?? null;
      }
      insertBefore(node: Node, ref: Node | null): void {
        if (node.parent) node.parent.kids.splice(node.parent.kids.indexOf(node), 1);
        const i = ref ? this.kids.indexOf(ref) : this.kids.length;
        this.kids.splice(i < 0 ? this.kids.length : i, 0, node);
        node.parent = this;
      }
      moveBefore(node: Node, ref: Node | null): void {
        this.kids.splice(this.kids.indexOf(node), 1);
        const i = ref ? this.kids.indexOf(ref) : this.kids.length;
        this.kids.splice(i < 0 ? this.kids.length : i, 0, node);
      }
      replaceChildren(): void {
        throw new Error("replaceChildren should not be called on the moveBefore path");
      }
    }

    const items = cell<Item[]>([{ id: "a" }, { id: "b" }, { id: "c" }]);
    const parent = new Parent();
    each(
      parent as unknown as Element,
      items,
      it => it.id,
      it => new Node(it.id) as unknown as globalThis.Node,
    );
    batch(() => {
      items.value = [{ id: "a" }, { id: "c" }];
    });
    expect(parent.kids.map(k => k.id)).toEqual(["a", "c"]);
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
