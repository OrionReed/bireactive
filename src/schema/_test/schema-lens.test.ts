// Tests for the schema-lens kit: each primitive's round-trip laws, then the
// branching migration A–B–{C,D} the demo is built on, including the cases a
// stateless migration can't handle — ambiguous splits, lossy enum collapses
// on two independent branches, and branch-private fields.

import { describe, expect, it } from "vitest";
import { type Cell, cell, type Writable } from "../../core/cell";
import {
  addField,
  each,
  headField,
  inField,
  into,
  mapElems,
  mapField,
  nestFields,
  type Obj,
  pipe,
  recurse,
  removeField,
  renameField,
  renameV,
  seq,
  splitField,
  toStep,
  wrapField,
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

describe("wrapField — scalar ⇄ array (Cambria Appendix III)", () => {
  it("an old scalar client conserves the tail it can't see", () => {
    const a = src({ assignee: "Alice" });
    const arr = wrapField("assignee", "assignees")(a);
    expect(arr.value).toEqual({ assignees: ["Alice"] });

    // The new (array) client assigns three people.
    arr.value = { assignees: ["Alice", "Bob", "Charlie"] };
    expect(a.value).toEqual({ assignee: "Alice" }); // old client still sees the head

    // The old client renames the single assignee it can see.
    a.value = { assignee: "Eve" };
    // Cambria's defective head/wrap would clobber or drop Bob & Charlie; here
    // the tail is conserved in the complement.
    expect(arr.value).toEqual({ assignees: ["Eve", "Bob", "Charlie"] });
  });
});

describe("inField — a sub-migration inside a nested object (Cambria `in`)", () => {
  it("renames a field nested under `user`, leaving siblings untouched", () => {
    const a = src({ user: { id: 7, login: "octocat", avatar: "x.gif" } });
    const lens = inField("user", seq(renameV("login", "handle")))(a);
    expect(lens.value).toEqual({ user: { id: 7, handle: "octocat", avatar: "x.gif" } });

    lens.value = { user: { id: 7, handle: "monalisa", avatar: "x.gif" } };
    expect(a.value).toEqual({ user: { id: 7, login: "monalisa", avatar: "x.gif" } });
  });
});

describe("mapElems — keyed array element migration", () => {
  it("migrates every element and round-trips inserts/edits", () => {
    const a = src({
      items: [
        { id: 1, name: "first" },
        { id: 2, name: "second" },
      ],
    });
    const view = mapElems("items", e => e.id, renameV("name", "title"))(a);
    expect(view.value).toEqual({
      items: [
        { id: 1, title: "first" },
        { id: 2, title: "second" },
      ],
    });

    // Edit one title and append a new element through the view.
    view.value = {
      items: [
        { id: 1, title: "FIRST" },
        { id: 2, title: "second" },
        { id: 3, title: "third" },
      ],
    };
    expect(a.value).toEqual({
      items: [
        { id: 1, name: "FIRST" },
        { id: 2, name: "second" },
        { id: 3, name: "third" },
      ],
    });
  });
});

describe("recurse — rename a field at every depth (Cambria recursive schemas)", () => {
  const deepRename = toStep(
    recurse(self => seq(renameV("name", "title"), into("subtasks", each(self)))),
  );

  it("renames recursively and writes edits back at any depth", () => {
    const a = src({
      name: "root",
      subtasks: [
        { name: "a", subtasks: [{ name: "a1", subtasks: [] }] },
        { name: "b", subtasks: [] },
      ],
    });
    const view = deepRename(a);
    expect(view.value).toEqual({
      title: "root",
      subtasks: [
        { title: "a", subtasks: [{ title: "a1", subtasks: [] }] },
        { title: "b", subtasks: [] },
      ],
    });

    // Edit a deeply-nested title; it lands on the source's `name`.
    view.value = {
      title: "root",
      subtasks: [
        { title: "a", subtasks: [{ title: "DEEP", subtasks: [] }] },
        { title: "b", subtasks: [] },
      ],
    };
    expect(((a.value as Obj).subtasks as Obj[])[0]!.subtasks).toEqual([
      { name: "DEEP", subtasks: [] },
    ]);
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

type Urg = "low" | "med" | "high";
const band = (n: number): Urg => (n <= 2 ? "low" : n === 3 ? "med" : "high");
const repNum = (u: Urg): number => (u === "low" ? 2 : u === "med" ? 3 : 4);

// 1–5 priority ⇄ low/med/high urgency; the exact level is remembered per band.
const priorityToUrgency = mapField<{ seen: Partial<Record<Urg, number>> }>("priority", {
  rename: "urgency",
  init: n => {
    const v = Number(n) || 1;
    return { seen: { [band(v)]: v } };
  },
  step: (n, c) => {
    const v = Number(n) || 1;
    return { seen: { ...c.seen, [band(v)]: v } };
  },
  fwd: n => band(Number(n) || 1),
  bwd: (u, _src, c) => {
    const urg = u as Urg;
    const v = c.seen[urg] ?? repNum(urg);
    return { src: v, complement: { seen: { ...c.seen, [urg]: v } } };
  },
});

const nameSplit = {
  split: (whole: string): [string, string] => {
    const m = whole.match(/^(.*\S)(\s+)(\S.*)$/);
    return m ? [m[1] as string, m[3] as string] : [whole, ""];
  },
  join: (a: string, b: string) => (b ? `${a} ${b}` : a),
};

const CREW = ["Ada Lovelace", "Grace Hopper", "Linus Torvalds"];

function scenario(): {
  A: Writable<Cell<Obj>>;
  B: Writable<Cell<Obj>>;
  C: Writable<Cell<Obj>>;
  D: Writable<Cell<Obj>>;
} {
  const A = cell<Obj>({ text: "Ship it", done: false, owner: "Ada Lovelace" });
  const B = pipe(
    renameField("text", "title"),
    widenDone,
    wrapField("owner", "assignees"),
    addField("priority", 3),
  )(A);
  const C = pipe(
    renameField("title", "label"),
    renameField("assignees", "crew"),
    nestFields(["state", "priority"], "meta"),
    addField("pinned", false),
  )(B);
  const D = pipe(
    renameField("title", "summary"),
    narrowState,
    headField("assignees", "lead"),
    splitField("lead", ["firstName", "lastName"], nameSplit),
    priorityToUrgency,
  )(B);
  // Realize complements, then seed a crew the single-owner schema can't hold.
  void A.value;
  void B.value;
  void C.value;
  void D.value;
  B.value = { ...(B.value as Obj), assignees: [...CREW] };
  void C.value;
  void D.value;
  return { A, B, C, D };
}

describe("branching migration A–B–{C,D}", () => {
  it("forward shapes are correct at every version", () => {
    const { A, B, C, D } = scenario();
    expect(A.value).toEqual({ text: "Ship it", done: false, owner: "Ada Lovelace" });
    expect(B.value).toEqual({
      title: "Ship it",
      state: "todo",
      assignees: CREW,
      priority: 3,
    });
    expect(C.value).toEqual({
      label: "Ship it",
      crew: CREW,
      meta: { state: "todo", priority: 3 },
      pinned: false,
    });
    expect(D.value).toEqual({
      summary: "Ship it",
      closed: false,
      firstName: "Ada",
      lastName: "Lovelace",
      urgency: "med",
    });
  });

  it("an edit in C propagates through B to both A and D", () => {
    const { A, C, D } = scenario();
    C.value = { ...(C.value as Obj), label: "Renamed in mobile" };
    expect((A.value as Obj).text).toBe("Renamed in mobile");
    expect((D.value as Obj).summary).toBe("Renamed in mobile");
  });

  it("reordering the crew moves the lead everywhere, conserving the rest", () => {
    const { A, C, D } = scenario();
    // Promote Grace to lead via Mobile's crew list.
    C.value = { ...(C.value as Obj), crew: ["Grace Hopper", "Ada Lovelace", "Linus Torvalds"] };
    expect((A.value as Obj).owner).toBe("Grace Hopper"); // single-owner view tracks head
    expect((D.value as Obj).firstName).toBe("Grace");
    expect((D.value as Obj).lastName).toBe("Hopper");
    // The rest of the crew is conserved, not dropped.
    expect((C.value as Obj).crew).toEqual(["Grace Hopper", "Ada Lovelace", "Linus Torvalds"]);
  });

  it("editing the lead's name in D writes the head, conserving the tail", () => {
    const { A, C, D } = scenario();
    D.value = { ...(D.value as Obj), firstName: "Mary Anne", lastName: "Smith" };
    expect((A.value as Obj).owner).toBe("Mary Anne Smith"); // head replaced
    expect((C.value as Obj).crew).toEqual(["Mary Anne Smith", "Grace Hopper", "Linus Torvalds"]);
    // The chosen split is preserved (not re-guessed).
    expect((D.value as Obj).firstName).toBe("Mary Anne");
    expect((D.value as Obj).lastName).toBe("Smith");
  });

  it("priority quantizes to urgency but the exact level returns per band", () => {
    const { C, D } = scenario();
    // Slide priority to 5 in Mobile → Web shows "high".
    C.value = { ...(C.value as Obj), meta: { state: "todo", priority: 5 } };
    expect((D.value as Obj).urgency).toBe("high");
    // Drop to "low" in Web → priority becomes a representative low (2).
    D.value = { ...(D.value as Obj), urgency: "low" };
    expect((C.value as Obj).meta).toMatchObject({ priority: 2 });
    // Back to "high" → the original 5 is restored from the complement.
    D.value = { ...(D.value as Obj), urgency: "high" };
    expect((C.value as Obj).meta).toMatchObject({ priority: 5 });
  });

  it("two branches collapse the enum independently, each keeping its nuance", () => {
    const { A, C, D } = scenario();
    C.value = { ...(C.value as Obj), meta: { state: "doing", priority: 3 } };
    expect((D.value as Obj).closed).toBe(false); // D sees "not done"

    D.value = { ...(D.value as Obj), closed: true };
    expect((C.value as Obj).meta).toMatchObject({ state: "done" });
    expect((A.value as Obj).done).toBe(true);
    D.value = { ...(D.value as Obj), closed: false };
    expect((C.value as Obj).meta).toMatchObject({ state: "doing" }); // reopened to "doing"
  });

  it("branch-private fields stay on their branch", () => {
    const { A, B, C, D } = scenario();
    C.value = { ...(C.value as Obj), pinned: true };
    // `pinned` exists only on the C branch — A, B, D never see it.
    expect("pinned" in (A.value as Obj)).toBe(false);
    expect("pinned" in (B.value as Obj)).toBe(false);
    expect("pinned" in (D.value as Obj)).toBe(false);
    expect((C.value as Obj).pinned).toBe(true);
  });
});
