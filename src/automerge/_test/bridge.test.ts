// Automerge bridge: reconcile (minimal merge-friendly diff) and connectDoc (the
// two-way doc↔cell sync). Runs against a real in-memory Repo, so these also pin
// the WASM init + API shape we depend on.

import { getAllChanges, initSubduction, Repo } from "@automerge/automerge-repo";
import fc from "fast-check";
import { beforeAll, describe, expect, it } from "vitest";
import { batch } from "../../core/cell";
import { at } from "../../core/optics";
import { connectCell, connectDoc, connectStore } from "../doc-cell";
import { type By, type Replace, reconcile } from "../reconcile";

beforeAll(async () => {
  await initSubduction();
});

const repo = (): Repo => new Repo({});

// Total identity key: coordinate arrays key by value, everything else (e.g. the
// scalar coordinates within a cube) falls back to positional.
const by = (e: unknown): unknown => (Array.isArray(e) ? e.join(",") : undefined);

// Total identity key for `{ id, ... }` records; non-records fall back to positional.
const idBy: By = e =>
  e !== null && typeof e === "object" && !Array.isArray(e) && "id" in e
    ? (e as { id: unknown }).id
    : undefined;

// Count of committed changes in a doc (each non-empty `handle.change` adds one).
const changeCount = (h: { doc(): unknown }): number => getAllChanges(h.doc() as never).length;

describe("reconcile", () => {
  it("sets, deletes, and recurses object keys", () => {
    const h = repo().create<Record<string, unknown>>({ a: 1, b: { x: 1 }, drop: true });
    h.change(d => reconcile(d, { a: 2, b: { x: 1, y: 9 } }));
    expect(h.doc()).toEqual({ a: 2, b: { x: 1, y: 9 } });
  });

  it("edits, appends, and truncates lists", () => {
    const h = repo().create<{ xs: number[] }>({ xs: [1, 2, 3] });
    h.change(d => reconcile(d, { xs: [1, 20, 3, 4] }));
    expect(h.doc().xs).toEqual([1, 20, 3, 4]);
    h.change(d => reconcile(d, { xs: [1] }));
    expect(h.doc().xs).toEqual([1]);
  });

  it("replaces a value when its type changes", () => {
    const h = repo().create<Record<string, unknown>>({ v: { nested: true } });
    h.change(d => reconcile(d, { v: [1, 2] }));
    expect(h.doc().v).toEqual([1, 2]);
  });

  it("merges concurrent text edits char-level (no clobber)", () => {
    const r = repo();
    const a = r.create<{ title: string }>({ title: "hello world" });
    const b = r.clone(a);
    a.change(d => reconcile(d, { title: "hello brave world" }));
    b.change(d => reconcile(d, { title: "hello world!!!" }));
    a.merge(b);
    expect(a.doc().title).toBe("hello brave world!!!");
  });
});

describe("reconcile (keyed)", () => {
  it("reorders without rewriting shared elements in place", () => {
    const h = repo().create<{ cubes: number[][] }>({ cubes: [[0], [1], [2]] });
    h.change(d => reconcile(d, { cubes: [[2], [0], [1]] }, by));
    expect(h.doc().cubes).toEqual([[2], [0], [1]]);
  });

  it("inserts and deletes by identity, not index", () => {
    const h = repo().create<{ cubes: number[][] }>({ cubes: [[0], [1], [2]] });
    h.change(d => reconcile(d, { cubes: [[0], [9], [2]] }, by));
    expect(h.doc().cubes).toEqual([[0], [9], [2]]);
  });

  it("merges concurrent reorder + insert (no clobber)", () => {
    const r = repo();
    const a = r.create<{ cubes: number[][] }>({ cubes: [[0], [1], [2]] });
    const b = r.clone(a);
    // a reorders; b appends a new cube — keyed reconcile keeps them disjoint.
    a.change(d => reconcile(d, { cubes: [[2], [0], [1]] }, by));
    b.change(d => reconcile(d, { cubes: [[0], [1], [2], [3]] }, by));
    a.merge(b);
    const keys = new Set(a.doc().cubes.map(c => c.join(",")));
    expect(keys).toEqual(new Set(["0", "1", "2", "3"]));
  });

  it("falls back to positional when keys aren't total + unique", () => {
    const h = repo().create<{ xs: number[] }>({ xs: [1, 2, 3] });
    // plain numbers → by() is undefined → positional path
    h.change(d => reconcile(d, { xs: [1, 20, 3, 4] }, by));
    expect(h.doc().xs).toEqual([1, 20, 3, 4]);
  });
});

describe("connectCell / connectStore", () => {
  it("connectCell syncs both ways and disposes", () => {
    const h = repo().create<{ n: number }>({ n: 1 });
    const { cell, dispose } = connectCell(h);
    expect(cell.value).toEqual({ n: 1 });
    batch(() => {
      cell.value = { n: 2 };
    });
    expect(h.doc().n).toBe(2);
    dispose();
    h.change(d => {
      d.n = 5;
    });
    expect(cell.value).toEqual({ n: 2 });
  });

  it("connectStore writes through a deep field to the doc", () => {
    const h = repo().create<{ a: { b: number } }>({ a: { b: 1 } });
    const { store, dispose } = connectStore(h);
    batch(() => {
      store.a.b.value = 42;
    });
    expect(h.doc().a.b).toBe(42);
    dispose();
  });

  it("connectDoc with by reconciles list writes by identity", () => {
    const h = repo().create<{ cubes: number[][] }>({ cubes: [[0], [1]] });
    const { cell, dispose } = connectDoc(h, { by });
    batch(() => {
      cell.value = { cubes: [[1], [0], [2]] };
    });
    expect(h.doc().cubes).toEqual([[1], [0], [2]]);
    dispose();
  });

  it("connectDoc with replace writes the chosen key wholesale", () => {
    const r = repo();
    const a = r.create<{ blob: { x: number; y: number } }>({ blob: { x: 1, y: 1 } });
    const b = r.clone(a);
    const { cell, dispose } = connectDoc(a, { replace: k => k === "blob" });
    batch(() => {
      cell.value = { blob: { x: 2, y: 1 } };
    });
    b.change(d => reconcile(d, { blob: { x: 1, y: 2 } }, undefined, k => k === "blob"));
    a.merge(b);
    // Wholesale put on both sides → one whole blob wins, never a {x:2,y:2} merge.
    expect([JSON.stringify({ x: 2, y: 1 }), JSON.stringify({ x: 1, y: 2 })]).toContain(
      JSON.stringify(a.doc().blob),
    );
    dispose();
  });
});

describe("connectDoc", () => {
  it("reflects the doc and writes back through the cell", () => {
    const h = repo().create<{ n: number }>({ n: 1 });
    const { cell, dispose } = connectDoc(h);
    expect(cell.value).toEqual({ n: 1 });
    batch(() => {
      cell.value = { n: 2 };
    });
    expect(h.doc().n).toBe(2);
    dispose();
  });

  it("pushes external doc changes into the cell", () => {
    const h = repo().create<{ n: number }>({ n: 1 });
    const { cell, dispose } = connectDoc(h);
    h.change(d => {
      d.n = 42;
    });
    expect(cell.value).toEqual({ n: 42 });
    dispose();
  });

  it("commits lens-view writes to the doc and converges (no echo loop)", () => {
    const h = repo().create<{ a: number; b: number }>({ a: 1, b: 2 });
    const { cell, dispose } = connectDoc(h);
    const a = at(cell, "a");
    batch(() => {
      a.value = 10;
    });
    expect(h.doc()).toEqual({ a: 10, b: 2 });
    expect(cell.value).toEqual({ a: 10, b: 2 });
    dispose();
  });

  it("stops syncing after dispose", () => {
    const h = repo().create<{ n: number }>({ n: 1 });
    const { cell, dispose } = connectDoc(h);
    dispose();
    h.change(d => {
      d.n = 5;
    });
    expect(cell.value).toEqual({ n: 1 });
  });
});

describe("reconcile (keyed) — edge cases", () => {
  type Items = { items: { id: number; v: number }[] };
  const seed = (items: Items["items"]) => repo().create<Items>({ items });
  const run = (h: ReturnType<typeof seed>, items: Items["items"]): Items["items"] => {
    h.change(d => reconcile(d, { items }, idBy));
    return (h.doc() as Items).items;
  };

  it("empty → populated (all inserts)", () => {
    expect(
      run(seed([]), [
        { id: 1, v: 1 },
        { id: 2, v: 2 },
      ]),
    ).toEqual([
      { id: 1, v: 1 },
      { id: 2, v: 2 },
    ]);
  });

  it("populated → empty (all deletes)", () => {
    expect(
      run(
        seed([
          { id: 1, v: 1 },
          { id: 2, v: 2 },
        ]),
        [],
      ),
    ).toEqual([]);
  });

  it("full reverse", () => {
    const out = run(
      seed([
        { id: 1, v: 1 },
        { id: 2, v: 2 },
        { id: 3, v: 3 },
      ]),
      [
        { id: 3, v: 3 },
        { id: 2, v: 2 },
        { id: 1, v: 1 },
      ],
    );
    expect(out).toEqual([
      { id: 3, v: 3 },
      { id: 2, v: 2 },
      { id: 1, v: 1 },
    ]);
  });

  it("mid-insert keeps neighbours", () => {
    expect(
      run(
        seed([
          { id: 1, v: 1 },
          { id: 3, v: 3 },
        ]),
        [
          { id: 1, v: 1 },
          { id: 2, v: 2 },
          { id: 3, v: 3 },
        ],
      ),
    ).toEqual([
      { id: 1, v: 1 },
      { id: 2, v: 2 },
      { id: 3, v: 3 },
    ]);
  });

  it("edits a kept element in place (same key, new field)", () => {
    expect(
      run(
        seed([
          { id: 1, v: 1 },
          { id: 2, v: 2 },
        ]),
        [
          { id: 1, v: 99 },
          { id: 2, v: 2 },
        ],
      ),
    ).toEqual([
      { id: 1, v: 99 },
      { id: 2, v: 2 },
    ]);
  });

  it("simultaneous reorder + insert + delete + edit", () => {
    expect(
      run(
        seed([
          { id: 1, v: 1 },
          { id: 2, v: 2 },
          { id: 3, v: 3 },
        ]),
        [
          { id: 3, v: 30 },
          { id: 4, v: 4 },
          { id: 1, v: 1 },
        ],
      ),
    ).toEqual([
      { id: 3, v: 30 },
      { id: 4, v: 4 },
      { id: 1, v: 1 },
    ]);
  });

  it("falls back to positional on duplicate keys", () => {
    const h = seed([{ id: 1, v: 1 }]);
    // two elements share id:7 → not unique → positional path still lands the value
    expect(
      run(h, [
        { id: 7, v: 1 },
        { id: 7, v: 2 },
      ]),
    ).toEqual([
      { id: 7, v: 1 },
      { id: 7, v: 2 },
    ]);
  });

  it("reconciles nested keyed lists", () => {
    type Doc = { rows: { id: number; cells: number[][] }[] };
    const h = repo().create<Doc>({ rows: [{ id: 1, cells: [[0], [1]] }] });
    const total: By = e => idBy(e) ?? by(e);
    h.change(d => reconcile(d, { rows: [{ id: 1, cells: [[1], [0], [2]] }] }, total));
    expect((h.doc() as Doc).rows).toEqual([{ id: 1, cells: [[1], [0], [2]] }]);
  });
});

describe("reconcile (replace)", () => {
  const blobOnly: Replace = k => k === "blob";

  it("assigns a replace key wholesale, result deep-equals next", () => {
    const h = repo().create<Record<string, unknown>>({ blob: { x: 1 }, n: 0 });
    h.change(d => reconcile(d, { blob: { x: 2, y: 3 }, n: 1 }, undefined, blobOnly));
    expect(h.doc()).toEqual({ blob: { x: 2, y: 3 }, n: 1 });
  });

  it("clobbers (no field-level merge) on concurrent edits to a replace key", () => {
    const r = repo();
    const a = r.create<{ blob: { x: number; y: number } }>({ blob: { x: 1, y: 1 } });
    const b = r.clone(a);
    a.change(d => reconcile(d, { blob: { x: 2, y: 1 } }, undefined, blobOnly));
    b.change(d => reconcile(d, { blob: { x: 1, y: 2 } }, undefined, blobOnly));
    a.merge(b);
    // Wholesale puts conflict → one side's *whole* blob wins; never a {x:2,y:2} merge.
    expect([JSON.stringify({ x: 2, y: 1 }), JSON.stringify({ x: 1, y: 2 })]).toContain(
      JSON.stringify(a.doc().blob),
    );
  });

  it("merges field-level for the SAME edits without replace (contrast)", () => {
    const r = repo();
    const a = r.create<{ blob: { x: number; y: number } }>({ blob: { x: 1, y: 1 } });
    const b = r.clone(a);
    a.change(d => reconcile(d, { blob: { x: 2, y: 1 } }));
    b.change(d => reconcile(d, { blob: { x: 1, y: 2 } }));
    a.merge(b);
    expect(a.doc().blob).toEqual({ x: 2, y: 2 });
  });

  it("skips the write when the replace key is already deep-equal (guard)", () => {
    const r = repo();
    const a = r.create<{ blob: { x: number }; n: number }>({ blob: { x: 1 }, n: 0 });
    const b = r.clone(a);
    // a touches only `n`; blob is deep-equal so the guard avoids a spurious put.
    a.change(d => reconcile(d, { blob: { x: 1 }, n: 5 }, undefined, blobOnly));
    // b replaces blob wholesale.
    b.change(d => reconcile(d, { blob: { x: 9 }, n: 0 }, undefined, blobOnly));
    a.merge(b);
    // No conflict: a's blob put never happened, so b's blob survives alongside a's n.
    expect(a.doc()).toEqual({ blob: { x: 9 }, n: 5 });
  });

  it("does not rewrite a deep-equal nested array under a replace key", () => {
    const h = repo().create<{ blob: { xs: number[] } }>({ blob: { xs: [1, 2, 3] } });
    const before = changeCount(h);
    h.change(d => reconcile(d, { blob: { xs: [1, 2, 3] } }, undefined, blobOnly));
    expect(changeCount(h) - before).toBe(0); // deep-equal → empty change
  });

  it("replaces a chosen list index wholesale (numeric key)", () => {
    const h = repo().create<{ xs: { v: number }[] }>({ xs: [{ v: 1 }, { v: 2 }] });
    const replaceFirst: Replace = k => k === 1;
    h.change(d => reconcile(d, { xs: [{ v: 1 }, { v: 22 }] }, undefined, replaceFirst));
    expect(h.doc().xs).toEqual([{ v: 1 }, { v: 22 }]);
  });
});

describe("reconcile (keyed) — merge confluence", () => {
  it("reorder on one side preserves a concurrent edit to a kept element", () => {
    const r = repo();
    const a = r.create<{ items: { id: number; v: number }[] }>({
      items: [
        { id: 1, v: 1 },
        { id: 2, v: 2 },
        { id: 3, v: 3 },
      ],
    });
    const b = r.clone(a);
    // a moves id:3 to the front (id:1, id:2 stay → in the LCS, untouched).
    a.change(d =>
      reconcile(
        d,
        {
          items: [
            { id: 3, v: 3 },
            { id: 1, v: 1 },
            { id: 2, v: 2 },
          ],
        },
        idBy,
      ),
    );
    // b edits a kept element concurrently.
    b.change(d =>
      reconcile(
        d,
        {
          items: [
            { id: 1, v: 111 },
            { id: 2, v: 2 },
            { id: 3, v: 3 },
          ],
        },
        idBy,
      ),
    );
    a.merge(b);
    const items = a.doc().items;
    expect(Object.fromEntries(items.map(i => [i.id, i.v]))).toEqual({ 1: 111, 2: 2, 3: 3 });
    expect(items[0].id).toBe(3); // a's reorder survives
  });

  it("concurrent inserts on both sides both survive", () => {
    const r = repo();
    const a = r.create<{ items: { id: number; v: number }[] }>({
      items: [{ id: 1, v: 1 }],
    });
    const b = r.clone(a);
    a.change(d =>
      reconcile(
        d,
        {
          items: [
            { id: 1, v: 1 },
            { id: 2, v: 2 },
          ],
        },
        idBy,
      ),
    );
    b.change(d =>
      reconcile(
        d,
        {
          items: [
            { id: 1, v: 1 },
            { id: 3, v: 3 },
          ],
        },
        idBy,
      ),
    );
    a.merge(b);
    expect(new Set(a.doc().items.map(i => i.id))).toEqual(new Set([1, 2, 3]));
  });
});

describe("reconcile — properties", () => {
  // JSON-ish trees automerge accepts: objects, arrays, ints, bools, short strings.
  const key = fc.string({ minLength: 1, maxLength: 4 });
  const leaf = fc.oneof(
    fc.integer({ min: -1000, max: 1000 }),
    fc.boolean(),
    fc.string({ maxLength: 6 }),
  );
  // Automerge's hydrate import rejects null-prototype objects, so keep every
  // generated object a plain `{}` (`noNullPrototype`).
  const { node } = fc.letrec(tie => ({
    node: fc.oneof(
      { maxDepth: 3, depthIdentifier: "json" },
      leaf,
      fc.array(tie("node"), { maxLength: 4 }),
      fc.dictionary(key, tie("node"), { maxKeys: 4, noNullPrototype: true }),
    ),
  }));
  const obj = fc.dictionary(key, node, { maxKeys: 4, noNullPrototype: true });

  it("positional: result deep-equals next for arbitrary from → to", () => {
    fc.assert(
      fc.property(obj, obj, (from, to) => {
        const h = repo().create(from as Record<string, unknown>);
        h.change(d => reconcile(d, to));
        expect(h.doc()).toEqual(to);
      }),
      { numRuns: 120 },
    );
  });

  // Records keyed by a unique id, with an arbitrary edit-set in `to`. Spread to a
  // plain prototype (see above) since `fc.record` can emit null-prototype objects.
  const record = fc
    .record({ id: fc.integer({ min: 0, max: 12 }), v: fc.integer({ min: 0, max: 99 }) })
    .map(r => ({ ...r }));
  const recList = fc.uniqueArray(record, { selector: r => r.id, maxLength: 8 });

  it("keyed: result deep-equals next, and matches the positional result", () => {
    fc.assert(
      fc.property(recList, recList, (from, to) => {
        const keyed = repo().create({ items: from });
        keyed.change(d => reconcile(d, { items: to }, idBy));
        expect(keyed.doc().items).toEqual(to);

        const positional = repo().create({ items: from });
        positional.change(d => reconcile(d, { items: to }));
        expect(positional.doc().items).toEqual(to);
      }),
      { numRuns: 120 },
    );
  });
});

describe("connect* — lifecycle", () => {
  it("retarget re-seeds and rebinds in both directions; old doc detaches", () => {
    const a = repo().create<{ n: number }>({ n: 1 });
    const b = repo().create<{ n: number }>({ n: 99 });
    const bridge = connectCell(a);
    expect(bridge.cell.value).toEqual({ n: 1 });

    bridge.retarget(b);
    expect(bridge.cell.value).toEqual({ n: 99 }); // doc → cell re-seeded

    batch(() => {
      bridge.cell.value = { n: 100 };
    });
    expect(b.doc().n).toBe(100); // cell → doc now targets b
    expect(a.doc().n).toBe(1); // old doc untouched

    b.change(d => {
      d.n = 7;
    });
    expect(bridge.cell.value).toEqual({ n: 7 }); // new doc → cell

    a.change(d => {
      d.n = 5;
    });
    expect(bridge.cell.value).toEqual({ n: 7 }); // old doc detached
    bridge.dispose();
  });

  it("batch coalesces many cell writes into a single change", () => {
    const h = repo().create<{ xs: number[] }>({ xs: [] });
    const { cell, dispose } = connectCell(h);
    const before = changeCount(h);
    batch(() => {
      cell.value = { xs: [1] };
      cell.value = { xs: [1, 2] };
      cell.value = { xs: [1, 2, 3] };
    });
    expect(changeCount(h) - before).toBe(1);
    expect(h.doc().xs).toEqual([1, 2, 3]);
    dispose();
  });

  it("external doc changes flow into a store view", () => {
    const h = repo().create<{ a: { b: number } }>({ a: { b: 1 } });
    const { store, dispose } = connectStore(h);
    expect(store.a.b.value).toBe(1);
    h.change(d => {
      d.a.b = 5;
    });
    expect(store.a.b.value).toBe(5);
    dispose();
  });

  it("store retarget keeps deep views live against the new doc", () => {
    const a = repo().create<{ a: { b: number } }>({ a: { b: 1 } });
    const b = repo().create<{ a: { b: number } }>({ a: { b: 2 } });
    const bridge = connectStore(a);
    const deep = bridge.store.a.b;
    expect(deep.value).toBe(1);
    bridge.retarget(b);
    expect(deep.value).toBe(2);
    batch(() => {
      deep.value = 42;
    });
    expect(b.doc().a.b).toBe(42);
    bridge.dispose();
  });
});
