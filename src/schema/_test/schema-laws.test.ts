// Property-based lens laws for the schema kit. Each primitive is checked
// (very-well-behaved or lossy-but-PutGet) against random inputs, and a random
// *composed* pipeline is checked for GetPut — the composition round-trip that a
// stateless migration (Cambria) can't guarantee. fast-check shrinks any
// violation to a minimal repro.

import fc from "fast-check";
import { describe, expect, it } from "vitest";
import {
  addV,
  each,
  eachBy,
  headV,
  into,
  nestV,
  type Obj,
  onField,
  recurse,
  removeV,
  renameV,
  seq,
  splitV,
  type VLens,
  wrapV,
} from "../lens";
import { deepEqual, getPutV, veryWellBehavedV } from "./_vlaws";

// ── arbitraries ───────────────────────────────────────────────────────

// Canonical name strings: join(split(w)) === w, so split round-trips cleanly.
const word = fc.constantFrom("Ada", "Mary Anne", "Bob", "Grace Hopper", "x", "");
const scalar = fc.oneof(fc.integer({ min: 0, max: 9 }), fc.boolean(), word);

const splitSpec = {
  split: (whole: string): [string, string] => {
    const i = whole.lastIndexOf(" ");
    return i < 0 ? [whole, ""] : [whole.slice(0, i), whole.slice(i + 1)];
  },
  join: (a: string, b: string) => (b ? `${a} ${b}` : a),
};

// ── per-primitive laws ─────────────────────────────────────────────────

describe("renameV", () => {
  it("is very-well-behaved (no collision)", () => {
    const lens = renameV("a", "b");
    const src = fc.record({ a: scalar, c: scalar });
    const view = fc.record({ b: scalar, c: scalar });
    veryWellBehavedV(lens, src, view);
  });

  it("GetPut holds even when the target key collides upstream", () => {
    const lens = renameV("a", "b");
    // Source has BOTH `a` and `b`; the shadowed `b` must survive a read-write.
    const src = fc.record({ a: scalar, b: scalar, c: scalar });
    getPutV(lens, src);
  });
});

describe("addV", () => {
  it("is very-well-behaved (value lives in the complement)", () => {
    const lens = addV("flag", false);
    const src = fc.record({ a: scalar });
    const view = fc.record({ a: scalar, flag: scalar });
    veryWellBehavedV(lens, src, view);
  });
});

describe("removeV", () => {
  it("is very-well-behaved (value + position in the complement)", () => {
    const lens = removeV("secret");
    const src = fc.record({ a: scalar, secret: scalar, b: scalar });
    const view = fc.record({ a: scalar, b: scalar });
    veryWellBehavedV(lens, src, view);
  });
});

describe("nestV", () => {
  it("is very-well-behaved (bijective)", () => {
    const lens = nestV(["a", "b"], "meta");
    const src = fc.record({ a: scalar, b: scalar, c: scalar });
    const view = fc.record({ meta: fc.record({ a: scalar, b: scalar }), c: scalar });
    veryWellBehavedV(lens, src, view);
  });
});

describe("splitV", () => {
  it("is very-well-behaved on canonical strings", () => {
    const lens = splitV("owner", ["first", "last"], splitSpec);
    const src = fc.record({ owner: word, c: scalar });
    const view = fc.record({ first: word, last: word, c: scalar });
    veryWellBehavedV(lens, src, view);
  });

  it("GetPut preserves a non-canonical whole verbatim (the honest-complement win)", () => {
    const lens = splitV("owner", ["first", "last"], splitSpec);
    // Trailing space + double space: join(split(·)) would NOT reproduce these,
    // but the stored `whole` does — so reading then writing back is a no-op.
    for (const owner of ["Ada  Lovelace", "Bob ", "  ", "Mary Anne Smith "]) {
      const s = { owner };
      const c = lens.init(s);
      const v = lens.fwd(s, c);
      const r = lens.bwd(v, s, c);
      expect(r.s).toEqual({ owner });
    }
  });
});

describe("wrapV (scalar ⇄ array, tail in the complement)", () => {
  const lens = onField("assignee", "assignees", wrapV());

  it("is well-behaved for non-empty arrays", () => {
    const src = fc.record({ assignee: word, c: scalar });
    const view = fc.record({ assignees: fc.array(word, { minLength: 1 }), c: scalar });
    veryWellBehavedV(lens, src, view as fc.Arbitrary<Obj>);
  });

  it("conserves the unseen tail when the scalar side writes (Cambria Appendix III)", () => {
    // New client put three assignees; the array is the head + a tail.
    const s = { assignee: "Alice" };
    let c = lens.init(s);
    // Simulate the array view holding [Alice, Bob, Charlie].
    const seeded = lens.bwd({ assignees: ["Alice", "Bob", "Charlie"] }, s, c);
    const src2 = seeded.s as Obj; // { assignee: "Alice" }
    c = seeded.c;
    expect(src2).toEqual({ assignee: "Alice" });

    // Old (scalar) client renames the head to "Eve". The tail is CONSERVED.
    const view = lens.fwd(src2, c);
    expect(view).toEqual({ assignees: ["Alice", "Bob", "Charlie"] });
    const head = lens.bwd({ assignees: ["Eve", "Bob", "Charlie"] }, src2, c);
    expect(lens.fwd(head.s as Obj, head.c)).toEqual({ assignees: ["Eve", "Bob", "Charlie"] });
  });
});

describe("headV (array → scalar head, tail stays in the source)", () => {
  const lens = onField("crew", "lead", headV());

  it("is very-well-behaved for non-empty arrays", () => {
    const src = fc.record({ crew: fc.array(word, { minLength: 1 }), c: scalar });
    const view = fc.record({ lead: word, c: scalar });
    veryWellBehavedV(lens, src as fc.Arbitrary<Obj>, view as fc.Arbitrary<Obj>);
  });

  it("writing the head conserves the tail", () => {
    const s: Obj = { crew: ["Ada", "Grace", "Linus"] };
    const c = lens.init(s);
    expect(lens.fwd(s, c)).toEqual({ lead: "Ada" });
    const r = lens.bwd({ lead: "Eve" }, s, c);
    expect(r.s).toEqual({ crew: ["Eve", "Grace", "Linus"] });
  });
});

describe("convert — lossy enum widen, distinction kept in the complement", () => {
  type S = "todo" | "doing" | "done";
  const widenInner: VLens<unknown, unknown, { open: S }> = {
    init: () => ({ open: "todo" }),
    fwd: (done, c) => (done ? "done" : c.open),
    bwd: (state, _d, c) =>
      state === "done" ? { s: true, c } : { s: false, c: { open: state as S } },
  };
  const lens = onField("done", "state", widenInner);

  it("round-trips all three view states despite the source being a bool", () => {
    const src = fc.record({ done: fc.boolean(), x: word });
    const view = fc.record({ state: fc.constantFrom<S>("todo", "doing", "done"), x: word });
    veryWellBehavedV(lens, src, view as fc.Arbitrary<Obj>);
  });
});

// ── array element migration ────────────────────────────────────────────

describe("eachBy — keyed array element migration", () => {
  const lens = into(
    "items",
    eachBy(e => e.id, renameV("name", "title")),
  );
  const srcItem = fc.record({ id: fc.integer({ min: 0, max: 5 }), name: word });
  const viewItem = fc.record({ id: fc.integer({ min: 0, max: 5 }), title: word });
  // Distinct ids so the keying is unambiguous.
  const distinct = <T extends { id: number }>(xs: T[]) =>
    xs.filter((x, i) => xs.findIndex(y => y.id === x.id) === i);
  const src = fc.array(srcItem).map(xs => ({ items: distinct(xs) }) as Obj);
  const view = fc.array(viewItem).map(xs => ({ items: distinct(xs) }) as Obj);

  it("is very-well-behaved across inserts, deletes, and reorders", () => {
    veryWellBehavedV(lens, src, view);
  });

  it("each element keeps its own complement across a reorder", () => {
    // Two elements with private per-element state would survive reorder; here
    // we at least confirm a reorder writes back as a reordered source.
    const s: Obj = {
      items: [
        { id: 1, name: "a" },
        { id: 2, name: "b" },
      ],
    };
    const c = lens.init(s);
    const reordered = {
      items: [
        { id: 2, title: "b" },
        { id: 1, title: "a" },
      ],
    };
    const r = lens.bwd(reordered, s, c);
    expect(r.s).toEqual({
      items: [
        { id: 2, name: "b" },
        { id: 1, name: "a" },
      ],
    });
  });
});

// ── recursion (Cambria's open "recursive schemas" case) ────────────────

describe("recurse — rename a field at every depth", () => {
  // rename `name` → `title` through a subtask tree of arbitrary depth.
  const deepRename = recurse(self => seq(renameV("name", "title"), into("subtasks", each(self))));

  it("renames recursively and round-trips", () => {
    const tree: Obj = {
      name: "root",
      subtasks: [
        { name: "a", subtasks: [{ name: "a1", subtasks: [] }] },
        { name: "b", subtasks: [] },
      ],
    };
    const c = deepRename.init(tree);
    const view = deepRename.fwd(tree, c);
    expect(view).toEqual({
      title: "root",
      subtasks: [
        { title: "a", subtasks: [{ title: "a1", subtasks: [] }] },
        { title: "b", subtasks: [] },
      ],
    });
    const r = deepRename.bwd(view, tree, c);
    expect(r.s).toEqual(tree);
  });
});

// ── random composed pipeline: GetPut survives arbitrary composition ────

describe("random composed pipeline", () => {
  type Op = { t: "rename" } | { t: "add" } | { t: "remove" } | { t: "wrap" } | { t: "split" };
  const opArb = fc.constantFrom<Op>(
    { t: "rename" },
    { t: "add" },
    { t: "remove" },
    { t: "wrap" },
    { t: "split" },
  );

  // Interpret a token stream against a tracked, evolving key set so every
  // chosen primitive is valid where it lands. Returns the composite lens.
  function build(ops: Op[], startKeys: string[]): VLens<Obj, Obj, unknown> {
    let keys = [...startKeys];
    let fresh = 0;
    // biome-ignore lint/suspicious/noExplicitAny: heterogeneous complements
    const lenses: VLens<Obj, Obj, any>[] = [];
    for (const op of ops) {
      if (op.t === "rename" && keys.length) {
        const from = keys[0]!;
        const to = `r${fresh++}`;
        lenses.push(renameV(from, to));
        keys = [to, ...keys.slice(1)];
      } else if (op.t === "add") {
        const k = `a${fresh++}`;
        lenses.push(addV(k, 0));
        keys.push(k);
      } else if (op.t === "remove" && keys.length > 1) {
        const k = keys[0]!;
        lenses.push(removeV(k));
        keys = keys.slice(1);
      } else if (op.t === "wrap" && keys.length) {
        const k = keys[0]!;
        lenses.push(onField(k, k, wrapV()));
      } else if (op.t === "split" && keys.length) {
        const k = keys[0]!;
        const ka = `${k}_a${fresh++}`;
        const kb = `${k}_b${fresh++}`;
        lenses.push(splitV(k, [ka, kb], splitSpec));
        keys = [ka, kb, ...keys.slice(1)];
      }
    }
    return seq(...lenses);
  }

  it("GetPut holds for any composition of primitives", () => {
    const startKeys = ["a", "b", "c"];
    fc.assert(
      fc.property(
        fc.array(opArb, { maxLength: 12 }),
        fc.record({ a: word, b: word, c: word }),
        (ops, s0) => {
          const lens = build(ops, startKeys);
          const s = { ...s0 } as Obj;
          const c = lens.init(s);
          const v = lens.fwd(s, c);
          const r = lens.bwd(v, s, c);
          if (!deepEqual(r.s, s))
            throw new Error(`GetPut broke: ${JSON.stringify(s)} → ${JSON.stringify(r.s)}`);
        },
      ),
      { numRuns: 300 },
    );
  });
});
