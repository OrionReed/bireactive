// Tests for the schema-lens kit: each primitive's round-trip laws, then the
// branching migration A–B–{C,D} the demo is built on, including the cases a
// stateless migration can't handle — ambiguous splits, lossy enum collapses
// on two independent branches, and branch-private fields.

import { describe, expect, it } from "vitest";
import { type Cell, cell, type Writable } from "../../core/cell";
import {
  addField,
  mapField,
  nestFields,
  type Obj,
  pipe,
  removeField,
  renameField,
  splitField,
} from "../lens";

const src = (v: Obj) => cell<Obj>(v);

describe("renameField", () => {
  it("renames forward and back; GetPut is a no-op", () => {
    const a = src({ x: 1, y: 2 });
    const b = renameField("x", "z")(a);
    expect(b.value).toEqual({ z: 1, y: 2 });
    b.value = b.value; // write back the read
    expect(a.value).toEqual({ x: 1, y: 2 });
  });

  it("PutGet: an edit through the view lands on the source", () => {
    const a = src({ x: 1, y: 2 });
    const b = renameField("x", "z")(a);
    b.value = { z: 9, y: 2 };
    expect(a.value).toEqual({ x: 9, y: 2 });
  });

  it("preserves key order", () => {
    const a = src({ x: 1, y: 2, w: 3 });
    const b = renameField("y", "yy")(a);
    expect(Object.keys(b.value)).toEqual(["x", "yy", "w"]);
  });
});

describe("addField", () => {
  it("seeds from the default and parks edits in the complement", () => {
    const a = src({ x: 1 });
    const b = addField("flag", false)(a);
    expect(b.value).toEqual({ x: 1, flag: false });

    b.value = { x: 1, flag: true };
    expect(a.value).toEqual({ x: 1 }); // source never learns about `flag`
    expect(b.value).toEqual({ x: 1, flag: true }); // but the view remembers it
  });

  it("the parked value survives an unrelated upstream edit", () => {
    const a = src({ x: 1 });
    const b = addField("flag", false)(a);
    b.value = { x: 1, flag: true };
    a.value = { x: 2 }; // edit a sibling field upstream
    expect(b.value).toEqual({ x: 2, flag: true }); // flag preserved
  });
});

describe("removeField", () => {
  it("drops the field forward, restores it (and its position) backward", () => {
    const a = src({ x: 1, secret: "s", y: 2 });
    const b = removeField("secret")(a);
    expect(b.value).toEqual({ x: 1, y: 2 });

    b.value = { x: 5, y: 2 };
    expect(a.value).toEqual({ x: 5, secret: "s", y: 2 });
    expect(Object.keys(a.value)).toEqual(["x", "secret", "y"]);
  });
});

describe("nestFields", () => {
  it("nests and unnests bijectively", () => {
    const a = src({ name: "t", state: "todo", priority: 2, tags: [] });
    const b = nestFields(["state", "priority"], "meta")(a);
    expect(b.value).toEqual({ name: "t", meta: { state: "todo", priority: 2 }, tags: [] });

    b.value = { name: "t", meta: { state: "done", priority: 3 }, tags: [] };
    expect(a.value).toEqual({ name: "t", state: "done", priority: 3, tags: [] });
  });
});

describe("splitField — the ambiguous one", () => {
  const spec = {
    split: (whole: string): [string, string] => {
      const i = whole.lastIndexOf(" ");
      return i < 0 ? [whole, ""] : [whole.slice(0, i), whole.slice(i + 1)];
    },
    join: (a: string, b: string) => (b ? `${a} ${b}` : a),
  };

  it("splits on the default boundary", () => {
    const a = src({ owner: "Ada Lovelace" });
    const b = splitField("owner", ["first", "last"], spec)(a);
    expect(b.value).toEqual({ first: "Ada", last: "Lovelace" });
  });

  it("round-trips a NON-default split the user chose", () => {
    const a = src({ owner: "Mary Anne Smith" });
    const b = splitField("owner", ["first", "last"], spec)(a);
    expect(b.value).toEqual({ first: "Mary Anne", last: "Smith" }); // default boundary

    // The user re-balances the split — first absorbs more of the name.
    b.value = { first: "Mary", last: "Anne Smith" };
    expect(a.value).toEqual({ owner: "Mary Anne Smith" }); // same whole
    // …and crucially the chosen split is what reads back, not a re-guess.
    expect(b.value).toEqual({ first: "Mary", last: "Anne Smith" });
  });
});

describe("mapField — lossy enum collapse (the trap case)", () => {
  type State = "todo" | "doing" | "done";
  const widen = mapField<{ open: State }>("done", {
    rename: "state",
    init: () => ({ open: "todo" }),
    fwd: (done, c) => (done ? "done" : c.open),
    bwd: (state, _done, c) =>
      state === "done"
        ? { src: true, complement: c }
        : { src: false, complement: { open: state as State } },
  });

  it("widening bool→enum remembers the non-done distinction across a toggle", () => {
    const a = src({ text: "x", done: false });
    const b = widen(a);
    expect(b.value).toEqual({ text: "x", state: "todo" });

    b.value = { text: "x", state: "doing" };
    expect(a.value).toEqual({ text: "x", done: false }); // source only sees a bool

    // Toggle done true→false through the SOURCE; the enum nuance survives.
    a.value = { text: "x", done: true };
    expect(b.value).toEqual({ text: "x", state: "done" });
    a.value = { text: "x", done: false };
    expect(b.value).toEqual({ text: "x", state: "doing" }); // "doing", not "todo"
  });
});

// ── the demo's actual branching migration ─────────────────────────────

type State = "todo" | "doing" | "done";

const widenDone = mapField<{ open: State }>("done", {
  rename: "state",
  init: () => ({ open: "todo" }),
  fwd: (done, c) => (done ? "done" : c.open),
  bwd: (state, _d, c) =>
    state === "done"
      ? { src: true, complement: c }
      : { src: false, complement: { open: state as State } },
});

const narrowState = mapField<{ open: State }>("state", {
  rename: "closed",
  init: s => ({ open: (s === "done" ? "todo" : (s as State)) ?? "todo" }),
  step: (s, c) => (s === "done" ? c : { open: s as State }),
  fwd: s => s === "done",
  bwd: (closed, srcState, c) =>
    closed
      ? {
          src: "done",
          complement: { open: srcState && srcState !== "done" ? (srcState as State) : c.open },
        }
      : { src: c.open, complement: c },
});

const splitOwner = splitField("owner", ["firstName", "lastName"], {
  split: whole => {
    const i = whole.lastIndexOf(" ");
    return i < 0 ? [whole, ""] : [whole.slice(0, i), whole.slice(i + 1)];
  },
  join: (a, b) => (b ? `${a} ${b}` : a),
});

const arrayAsString = mapField<{ text: string }>("tags", {
  rename: "labels",
  init: arr => ({ text: (arr as string[]).join(", ") }),
  fwd: arr => (arr as string[]).join(", "),
  bwd: labels => ({
    src: String(labels)
      .split(",")
      .map(s => s.trim())
      .filter(Boolean),
    complement: { text: String(labels) },
  }),
});

function scenario(): {
  A: Writable<Cell<Obj>>;
  B: Writable<Cell<Obj>>;
  C: Writable<Cell<Obj>>;
  D: Writable<Cell<Obj>>;
} {
  const A = cell<Obj>({ text: "Ship it", done: false, tags: ["demo", "writing"] });
  const B = pipe(
    renameField("text", "title"),
    widenDone,
    addField("owner", "Ada Lovelace"),
    addField("priority", 2),
  )(A);
  const C = pipe(
    renameField("title", "label"),
    splitOwner,
    nestFields(["firstName", "lastName"], "assignee"),
    nestFields(["state", "priority"], "meta"),
    addField("starred", false),
  )(B);
  const D = pipe(
    renameField("title", "summary"),
    narrowState,
    renameField("owner", "assignedTo"),
    arrayAsString,
  )(B);
  // Realize every complement before interacting.
  void A.value;
  void B.value;
  void C.value;
  void D.value;
  return { A, B, C, D };
}

describe("branching migration A–B–{C,D}", () => {
  it("forward shapes are correct at every version", () => {
    const { B, C, D } = scenario();
    expect(B.value).toEqual({
      title: "Ship it",
      state: "todo",
      tags: ["demo", "writing"],
      owner: "Ada Lovelace",
      priority: 2,
    });
    expect(C.value).toEqual({
      label: "Ship it",
      meta: { state: "todo", priority: 2 },
      tags: ["demo", "writing"],
      assignee: { firstName: "Ada", lastName: "Lovelace" },
      starred: false,
    });
    expect(D.value).toEqual({
      summary: "Ship it",
      closed: false,
      labels: "demo, writing",
      assignedTo: "Ada Lovelace",
      priority: 2,
    });
  });

  it("an edit in C propagates through B to both A and D", () => {
    const { A, C, D } = scenario();
    C.value = { ...(C.value as Obj), label: "Renamed in mobile" };
    expect((A.value as Obj).text).toBe("Renamed in mobile");
    expect((D.value as Obj).summary).toBe("Renamed in mobile");
  });

  it("an ambiguous name split set in C round-trips to D's flat owner", () => {
    const { C, D } = scenario();
    C.value = { ...(C.value as Obj), assignee: { firstName: "Mary Anne", lastName: "Smith" } };
    expect((D.value as Obj).assignedTo).toBe("Mary Anne Smith");
    // The chosen split is preserved (not re-guessed to "Mary Anne"/"Smith" vs other).
    expect((C.value as Obj).assignee).toEqual({ firstName: "Mary Anne", lastName: "Smith" });
  });

  it("two branches collapse the enum independently, each keeping its nuance", () => {
    const { A, C, D } = scenario();
    // Set the rich state to "doing" via C.
    C.value = { ...(C.value as Obj), meta: { state: "doing", priority: 2 } };
    expect((D.value as Obj).closed).toBe(false); // D sees "not done"

    // Close it from D, then reopen from D: D remembers "doing".
    D.value = { ...(D.value as Obj), closed: true };
    expect((C.value as Obj).meta).toMatchObject({ state: "done" });
    expect((A.value as Obj).done).toBe(true);
    D.value = { ...(D.value as Obj), closed: false };
    expect((C.value as Obj).meta).toMatchObject({ state: "doing" }); // reopened to "doing"
  });

  it("branch-private fields stay on their branch", () => {
    const { A, B, C, D } = scenario();
    C.value = { ...(C.value as Obj), starred: true };
    // `starred` exists only on the C branch — A, B, D never see it.
    expect("starred" in (A.value as Obj)).toBe(false);
    expect("starred" in (B.value as Obj)).toBe(false);
    expect("starred" in (D.value as Obj)).toBe(false);
    expect((C.value as Obj).starred).toBe(true);
  });

  it("D's array⇄string edit flows back to the tags array everywhere", () => {
    const { A, C, D } = scenario();
    D.value = { ...(D.value as Obj), labels: "demo, writing, urgent" };
    expect((A.value as Obj).tags).toEqual(["demo", "writing", "urgent"]);
    expect((C.value as Obj).tags).toEqual(["demo", "writing", "urgent"]);
  });
});
