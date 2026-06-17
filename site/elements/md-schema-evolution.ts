// Four schema versions of one record, related by composed POJO lenses in a
// branching graph A → B → {C, D} (not a line, not a hub-and-spoke — the shape
// real schema evolution takes). Each edge is a `pipe` of tiny complement-
// carrying lenses from the schema kit; editing any panel propagates across the
// whole graph, and the lossy steps (enum collapse, name split, array⇄string)
// round-trip because each step privately remembers what it dropped.

import { type Cell, cell, effect, type Writable } from "@bireactive";
import {
  addField,
  mapField,
  nestFields,
  type Obj,
  pipe,
  renameField,
  splitField,
} from "@bireactive/schema";
import { BaseElement, css } from "./base-element";

type State = "todo" | "doing" | "done";
const STATES: readonly State[] = ["todo", "doing", "done"];

// ── the value-level bridges (each built from the generic `mapField`) ──

// A's boolean `done` ⇄ B's tri-state `state`. Forward can't recover the
// todo/doing distinction from a bare `false`, so it lives in the complement.
const widenDone = mapField<{ open: State }>("done", {
  rename: "state",
  init: () => ({ open: "todo" }),
  fwd: (done, c) => (done ? "done" : c.open),
  bwd: (state, _done, c) =>
    state === "done"
      ? { src: true, complement: c }
      : { src: false, complement: { open: state as State } },
});

// B's tri-state `state` ⇄ D's boolean `closed`. The non-done distinction is
// remembered on THIS edge, independently of A's.
const narrowState = mapField<{ open: State }>("state", {
  rename: "closed",
  init: s => ({ open: s === "done" ? "todo" : ((s as State) ?? "todo") }),
  step: (s, c) => (s === "done" ? c : { open: s as State }),
  fwd: s => s === "done",
  // Closing remembers the live source state we're closing FROM, so reopening
  // restores it even if nothing read this edge in between.
  bwd: (closed, srcState, c) =>
    closed
      ? {
          src: "done",
          complement: { open: srcState && srcState !== "done" ? (srcState as State) : c.open },
        }
      : { src: c.open, complement: c },
});

// B's flat `owner` string ⇄ C's `{firstName, lastName}`. The split boundary is
// ambiguous, so the chosen halves live in the complement.
const splitOwner = splitField("owner", ["firstName", "lastName"], {
  split: whole => {
    const i = whole.lastIndexOf(" ");
    return i < 0 ? [whole, ""] : [whole.slice(0, i), whole.slice(i + 1)];
  },
  join: (a, b) => (b ? `${a} ${b}` : a),
});

// B's `tags: string[]` ⇄ D's `labels: string`. The raw text is the complement.
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

const INITIAL: Obj = { text: "Ship the schema-lens demo", done: false, tags: ["demo", "writing"] };

// ── per-version display + form descriptors ───────────────────────────

type FieldDesc =
  | { path: string[]; label: string; kind: "text" }
  | { path: string[]; label: string; kind: "num"; min: number; max: number }
  | { path: string[]; label: string; kind: "bool" }
  | { path: string[]; label: string; kind: "enum"; options: readonly string[] }
  | { path: string[]; label: string; kind: "csv" };

interface NodeDesc {
  id: string;
  name: string;
  type: string;
  fields: FieldDesc[];
  note?: string;
}

const A_TYPE = `type TodoV1 = {
  text: string;
  done: boolean;
  tags: string[];
};`;

const B_TYPE = `type TaskV2 = {
  title: string;
  state: "todo" | "doing" | "done";
  owner: string;
  priority: number;
  tags: string[];
};`;

const C_TYPE = `type MobileV3 = {
  label: string;
  assignee: { firstName: string; lastName: string };
  meta: { state: "todo" | "doing" | "done"; priority: number };
  tags: string[];
  starred: boolean;
};`;

const D_TYPE = `type WebV3 = {
  summary: string;
  closed: boolean;
  assignedTo: string;
  priority: number;
  labels: string;
};`;

const A_NODE: NodeDesc = {
  id: "A",
  name: "Todo 1.0",
  type: A_TYPE,
  fields: [
    { path: ["text"], label: "text", kind: "text" },
    { path: ["done"], label: "done", kind: "bool" },
    { path: ["tags"], label: "tags", kind: "csv" },
  ],
};

const B_NODE: NodeDesc = {
  id: "B",
  name: "Tasks 2.0",
  type: B_TYPE,
  fields: [
    { path: ["title"], label: "title", kind: "text" },
    { path: ["state"], label: "state", kind: "enum", options: STATES },
    { path: ["owner"], label: "owner", kind: "text" },
    { path: ["priority"], label: "priority", kind: "num", min: 0, max: 3 },
    { path: ["tags"], label: "tags", kind: "csv" },
  ],
};

const C_NODE: NodeDesc = {
  id: "C",
  name: "Mobile 3.0",
  type: C_TYPE,
  note: "starred is private to this branch — it lives in the B→C complement, so A, B and D never see it.",
  fields: [
    { path: ["label"], label: "label", kind: "text" },
    { path: ["assignee", "firstName"], label: "assignee.firstName", kind: "text" },
    { path: ["assignee", "lastName"], label: "assignee.lastName", kind: "text" },
    { path: ["meta", "state"], label: "meta.state", kind: "enum", options: STATES },
    { path: ["meta", "priority"], label: "meta.priority", kind: "num", min: 0, max: 3 },
    { path: ["tags"], label: "tags", kind: "csv" },
    { path: ["starred"], label: "starred", kind: "bool" },
  ],
};

const D_NODE: NodeDesc = {
  id: "D",
  name: "Web 3.0",
  type: D_TYPE,
  note: "closed collapses the tri-state independently of A — reopen it and the doing/todo nuance returns from this edge's complement.",
  fields: [
    { path: ["summary"], label: "summary", kind: "text" },
    { path: ["closed"], label: "closed", kind: "bool" },
    { path: ["assignedTo"], label: "assignedTo", kind: "text" },
    { path: ["priority"], label: "priority", kind: "num", min: 0, max: 3 },
    { path: ["labels"], label: "labels", kind: "text" },
  ],
};

const EDGE_AB =
  'renameField("text","title") · widen(done→state) · addField("owner") · addField("priority")';
const EDGE_BC =
  'renameField("title","label") · splitField(owner→firstName,lastName) · nestFields(→assignee) · nestFields(→meta) · addField("starred")';
const EDGE_BD =
  'renameField("title","summary") · narrow(state→closed) · renameField("owner","assignedTo") · tags⇄labels';

// ── path helpers ──────────────────────────────────────────────────────

function getPath(obj: unknown, path: string[]): unknown {
  let cur = obj;
  for (const k of path) {
    if (cur == null || typeof cur !== "object") return undefined;
    cur = (cur as Obj)[k];
  }
  return cur;
}

function setPath(obj: unknown, path: string[], val: unknown): unknown {
  if (path.length === 0) return val;
  const [head, ...rest] = path;
  const base = obj != null && typeof obj === "object" ? (obj as Obj) : {};
  return { ...base, [head as string]: setPath(base[head as string], rest, val) };
}

export class MdSchemaEvolution extends BaseElement {
  static styles = css`
    :host {
      display: block;
      margin: 1.5rem auto;
      width: 100%;
      max-width: 880px;
      font-family: inherit;
      color: var(--text-color);
    }
    .hintrow {
      display: flex;
      justify-content: space-between;
      align-items: baseline;
      gap: 1rem;
      margin: 0 0 0.75rem;
    }
    .hint {
      font-size: 0.8rem;
      color: var(--text-secondary);
      margin: 0;
      line-height: 1.45;
    }
    button {
      font: inherit;
      font-size: 0.75rem;
      color: var(--text-secondary);
      background: var(--code-bg);
      border: 1px solid var(--border-color);
      border-radius: 4px;
      padding: 0.15rem 0.55rem;
      cursor: pointer;
      white-space: nowrap;
    }
    button:hover {
      color: var(--text-color);
      border-color: var(--text-color);
    }
    .row {
      display: flex;
      justify-content: center;
      gap: 0.75rem;
    }
    .row.split {
      align-items: stretch;
    }
    .edge {
      display: flex;
      flex-direction: column;
      align-items: center;
      gap: 0.15rem;
      margin: 0.35rem 0;
      color: var(--text-secondary);
    }
    .edge .arrow {
      font-size: 0.9rem;
      line-height: 1;
    }
    .edge .ops {
      font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
      font-size: 0.66rem;
      text-align: center;
      max-width: 620px;
      line-height: 1.35;
    }
    .edge-pair {
      display: grid;
      grid-template-columns: 1fr 1fr;
      gap: 0.75rem;
    }
    .pane {
      display: flex;
      flex-direction: column;
      gap: 0.5rem;
      padding: 0.65rem 0.8rem;
      border: 1px solid var(--border-color);
      border-radius: 6px;
      background: var(--bg-color);
      flex: 1 1 0;
      min-width: 0;
    }
    .pane.wide {
      max-width: 520px;
      margin: 0 auto;
      width: 100%;
    }
    .pane header {
      display: flex;
      align-items: baseline;
      gap: 0.5rem;
    }
    .pane h3 {
      margin: 0;
      font-size: 0.9rem;
      font-weight: 600;
    }
    .pane .ver {
      font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
      font-size: 0.72rem;
      color: #fff;
      background: var(--text-color);
      border-radius: 3px;
      padding: 0.05rem 0.4rem;
    }
    pre.schema {
      margin: 0;
      font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
      font-size: 0.68rem;
      line-height: 1.4;
      padding: 0.45rem 0.6rem;
      background: var(--code-bg);
      color: var(--code-text);
      border-radius: 4px;
      overflow-x: auto;
      white-space: pre;
    }
    .form {
      display: grid;
      grid-template-columns: max-content 1fr;
      gap: 0.3rem 0.6rem;
      align-items: center;
    }
    .form label {
      font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
      font-size: 0.72rem;
      color: var(--text-secondary);
      white-space: nowrap;
    }
    .form input[type="text"],
    .form select {
      width: 100%;
      box-sizing: border-box;
      font: inherit;
      font-size: 0.78rem;
      padding: 0.2rem 0.4rem;
      background: var(--code-bg);
      color: var(--code-text);
      border: 1px solid var(--border-color);
      border-radius: 4px;
    }
    .form input:focus,
    .form select:focus {
      outline: none;
      border-color: var(--text-color);
    }
    .numrow {
      display: flex;
      align-items: center;
      gap: 0.5rem;
    }
    .numrow input[type="range"] {
      flex: 1;
    }
    .numrow .badge {
      font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
      font-size: 0.72rem;
      color: var(--text-secondary);
      min-width: 1ch;
    }
    .note {
      font-size: 0.7rem;
      color: var(--text-secondary);
      line-height: 1.4;
      margin: 0;
      border-top: 1px dashed var(--border-color);
      padding-top: 0.4rem;
    }
  `;

  #disposers: Array<() => void> = [];

  disconnectedCallback(): void {
    for (const d of this.#disposers) d();
    this.#disposers.length = 0;
  }

  protected render(): void {
    for (const d of this.#disposers) d();
    this.#disposers.length = 0;
    this.shadow.replaceChildren();

    // The branching graph: A (root) → B → {C, D}. B is shared by both
    // branches, so edits to B-level fields reach C and D alike.
    const A = cell<Obj>(structuredClone(INITIAL));
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

    // Realize every complement before interaction.
    void A.value;
    void B.value;
    void C.value;
    void D.value;

    // Header.
    const hintrow = document.createElement("div");
    hintrow.className = "hintrow";
    const hint = document.createElement("p");
    hint.className = "hint";
    hint.innerHTML =
      "One record across four app versions, related by composed POJO lenses in a <b>branching</b> graph " +
      "A → B → {C, D}. Edit any panel; the change flows across the whole graph. Try: rebalance the name split in " +
      "Mobile (<code>Mary&nbsp;Anne</code> / <code>Smith</code>) and watch Web's flat <code>assignedTo</code>; or set " +
      "<code>meta.state = doing</code>, close it from Web, then reopen — the nuance survives both lossy collapses.";
    const reset = document.createElement("button");
    reset.textContent = "reset";
    reset.addEventListener("click", () => this.render());
    hintrow.append(hint, reset);
    this.shadow.append(hintrow);

    // A.
    this.shadow.append(this.#paneRow(A_NODE, A, true));
    this.shadow.append(this.#edge(EDGE_AB));
    // B.
    this.shadow.append(this.#paneRow(B_NODE, B, true));
    // Branch edges.
    const edgePair = document.createElement("div");
    edgePair.className = "edge-pair";
    edgePair.append(this.#edge(EDGE_BC), this.#edge(EDGE_BD));
    this.shadow.append(edgePair);
    // C and D side by side.
    const split = document.createElement("div");
    split.className = "row split";
    split.append(this.#pane(C_NODE, C), this.#pane(D_NODE, D));
    this.shadow.append(split);
  }

  #edge(ops: string): HTMLElement {
    const e = document.createElement("div");
    e.className = "edge";
    const arrow = document.createElement("div");
    arrow.className = "arrow";
    arrow.textContent = "↓";
    const o = document.createElement("div");
    o.className = "ops";
    o.textContent = ops;
    e.append(arrow, o);
    return e;
  }

  #paneRow(desc: NodeDesc, cellRef: Writable<Cell<Obj>>, wide: boolean): HTMLElement {
    const row = document.createElement("div");
    row.className = "row";
    const pane = this.#pane(desc, cellRef);
    if (wide) pane.classList.add("wide");
    row.append(pane);
    return row;
  }

  #pane(desc: NodeDesc, cellRef: Writable<Cell<Obj>>): HTMLElement {
    const pane = document.createElement("div");
    pane.className = "pane";

    const header = document.createElement("header");
    const ver = document.createElement("span");
    ver.className = "ver";
    ver.textContent = desc.id;
    const h = document.createElement("h3");
    h.textContent = desc.name;
    header.append(ver, h);

    const schema = document.createElement("pre");
    schema.className = "schema";
    schema.textContent = desc.type;

    const form = document.createElement("div");
    form.className = "form";

    // Per-field control + a refresher closure (run by one shared effect).
    const refreshers: Array<(v: unknown) => void> = [];

    for (const f of desc.fields) {
      const label = document.createElement("label");
      label.textContent = f.label;
      form.append(label);

      const commit = (raw: unknown) => {
        cellRef.value = setPath(cellRef.value, f.path, raw) as Obj;
      };

      if (f.kind === "text" || f.kind === "csv") {
        const input = document.createElement("input");
        input.type = "text";
        input.spellcheck = false;
        input.autocomplete = "off";
        input.addEventListener("input", () => {
          commit(
            f.kind === "csv"
              ? input.value
                  .split(",")
                  .map(s => s.trim())
                  .filter(Boolean)
              : input.value,
          );
        });
        form.append(input);
        refreshers.push(v => {
          if (this.shadow.activeElement === input) return;
          const text = f.kind === "csv" && Array.isArray(v) ? v.join(", ") : String(v ?? "");
          if (input.value !== text) input.value = text;
        });
      } else if (f.kind === "bool") {
        const input = document.createElement("input");
        input.type = "checkbox";
        input.addEventListener("change", () => commit(input.checked));
        const wrap = document.createElement("div");
        wrap.append(input);
        form.append(wrap);
        refreshers.push(v => {
          if (this.shadow.activeElement === input) return;
          input.checked = Boolean(v);
        });
      } else if (f.kind === "enum") {
        const select = document.createElement("select");
        for (const opt of f.options) {
          const o = document.createElement("option");
          o.value = opt;
          o.textContent = opt;
          select.append(o);
        }
        select.addEventListener("change", () => commit(select.value));
        form.append(select);
        refreshers.push(v => {
          if (this.shadow.activeElement === select) return;
          select.value = String(v ?? "");
        });
      } else {
        // num → range + value badge
        const numrow = document.createElement("div");
        numrow.className = "numrow";
        const input = document.createElement("input");
        input.type = "range";
        input.min = String(f.min);
        input.max = String(f.max);
        input.step = "1";
        const badge = document.createElement("span");
        badge.className = "badge";
        input.addEventListener("input", () => {
          badge.textContent = input.value;
          commit(Number(input.value));
        });
        numrow.append(input, badge);
        form.append(numrow);
        refreshers.push(v => {
          const n = Number(v ?? 0);
          badge.textContent = String(n);
          if (this.shadow.activeElement === input) return;
          input.value = String(n);
        });
      }
    }

    pane.append(header, schema, form);

    if (desc.note) {
      const note = document.createElement("p");
      note.className = "note";
      note.textContent = desc.note;
      pane.append(note);
    }

    // One effect per pane refreshes every control from the cell.
    this.#disposers.push(
      effect(() => {
        const v = cellRef.value;
        for (let i = 0; i < refreshers.length; i++) {
          refreshers[i]!(getPath(v, desc.fields[i]!.path));
        }
      }),
    );

    return pane;
  }
}
