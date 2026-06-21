// Automerge bridge: reconcile (minimal merge-friendly diff) and connectDoc (the
// two-way doc↔cell sync). Runs against a real in-memory Repo, so these also pin
// the WASM init + API shape we depend on.

import { initSubduction, Repo } from "@automerge/automerge-repo";
import { beforeAll, describe, expect, it } from "vitest";
import { batch } from "../../core/cell";
import { at } from "../../core/optics";
import { connectDoc } from "../doc-cell";
import { reconcile } from "../reconcile";

beforeAll(async () => {
  await initSubduction();
});

const repo = (): Repo => new Repo({});

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
