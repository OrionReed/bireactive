// Four schema versions of one task, related by composed POJO lenses in a
// branching graph A → B → {C, D} — the shape real schema evolution takes
// (not a line, not a hub-and-spoke). Each edge is a `pipe` of tiny complement-
// carrying lenses; editing any panel propagates across the whole graph, and
// the lossy steps round-trip because each step privately remembers what it
// dropped. The gnarly bits, all live and interactive:
//
//   • one owner (A) ⇄ a reorderable crew list (C) ⇄ the lead's first/last
//     name (D). The list is canonical; the single-person views track its
//     HEAD, and the rest of the crew is conserved (Cambria's scalar⇄array).
//   • a 1–5 priority slider (B, C) ⇄ low/med/high pills (D), a lossy
//     quantization whose exact level is remembered per band in a complement.
//   • a boolean `done` (A) ⇄ tri-state `state` (B, C) ⇄ boolean `closed` (D),
//     each collapse keeping the todo/doing nuance on its own edge.

import { type Cell, cell, effect, type Writable } from "@bireactive";
import {
  addField,
  headField,
  mapField,
  nestFields,
  type Obj,
  pipe,
  renameField,
  splitField,
  wrapField,
} from "@bireactive/schema";
import { BaseElement, css } from "./base-element";

type State = "todo" | "doing" | "done";
const STATES: readonly State[] = ["todo", "doing", "done"];
type Urg = "low" | "med" | "high";
const URGENCIES: readonly Urg[] = ["low", "med", "high"];

// ── the value-level bridges (each built from the generic kit) ─────────

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
  bwd: (closed, srcState, c) =>
    closed
      ? {
          src: "done",
          complement: { open: srcState && srcState !== "done" ? (srcState as State) : c.open },
        }
      : { src: c.open, complement: c },
});

// B's 1–5 `priority` ⇄ D's low/med/high `urgency`. Forward quantizes (lossy);
// the complement remembers the exact 1–5 value seen for EACH band, so leaving
// a band and returning restores the precise number — not a fresh guess.
const band = (n: number): Urg => (n <= 2 ? "low" : n === 3 ? "med" : "high");
const repNum = (u: Urg): number => (u === "low" ? 2 : u === "med" ? 3 : 4);
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

// D's flat `lead` string ⇄ {firstName, lastName}. The split boundary is
// ambiguous, so the chosen halves live in the complement; the exact original
// string (odd spacing and all) is preserved verbatim through a round-trip.
const nameSplit = {
  split: (whole: string): [string, string] => {
    // Last whitespace run with a real character on BOTH sides — so a trailing
    // space doesn't swallow the whole name into `firstName`.
    const m = whole.match(/^(.*\S)(\s+)(\S.*)$/);
    return m ? [m[1] as string, m[3] as string] : [whole, ""];
  },
  join: (a: string, b: string) => (b ? `${a} ${b}` : a),
};

const INITIAL: Obj = { text: "Ship the schema-lens demo", done: false, owner: "Ada Lovelace" };
const CREW = ["Ada Lovelace", "Grace Hopper", "Linus Torvalds"];

// ── per-version display + form descriptors ───────────────────────────

type FieldDesc =
  | { path: string[]; label: string; kind: "text" }
  | { path: string[]; label: string; kind: "bool" }
  | { path: string[]; label: string; kind: "enum"; options: readonly string[] }
  | { path: string[]; label: string; kind: "pills"; options: readonly string[] }
  | { path: string[]; label: string; kind: "slider"; min: number; max: number }
  | { path: string[]; label: string; kind: "list" };

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
  owner: string;
};`;

const B_TYPE = `type TaskV2 = {
  title: string;
  state: "todo" | "doing" | "done";
  assignees: string[];
  priority: number; // 1–5
};`;

const C_TYPE = `type MobileV3 = {
  label: string;
  crew: string[];
  meta: {
    state: "todo" | "doing" | "done";
    priority: number;
  };
  pinned: boolean;
};`;

const D_TYPE = `type WebV3 = {
  summary: string;
  closed: boolean;
  firstName: string;
  lastName: string;
  urgency: "low" | "med" | "high";
};`;

const A_NODE: NodeDesc = {
  id: "A",
  name: "Todo 1.0",
  type: A_TYPE,
  fields: [
    { path: ["text"], label: "text", kind: "text" },
    { path: ["done"], label: "done", kind: "bool" },
    { path: ["owner"], label: "owner", kind: "text" },
  ],
  note: "owner is a single person — it tracks the HEAD of B's crew list; the rest is conserved in the wrap lens's complement.",
};

const B_NODE: NodeDesc = {
  id: "B",
  name: "Tasks 2.0",
  type: B_TYPE,
  fields: [
    { path: ["title"], label: "title", kind: "text" },
    { path: ["state"], label: "state", kind: "enum", options: STATES },
    { path: ["assignees"], label: "assignees", kind: "list" },
    { path: ["priority"], label: "priority", kind: "slider", min: 1, max: 5 },
  ],
};

const C_NODE: NodeDesc = {
  id: "C",
  name: "Mobile 3.0",
  type: C_TYPE,
  note: "Reorder the crew — the lead (★) is what Todo's owner and Web's name show. pinned is private to this branch (it lives in the B→C complement).",
  fields: [
    { path: ["label"], label: "label", kind: "text" },
    { path: ["crew"], label: "crew", kind: "list" },
    { path: ["meta", "state"], label: "meta.state", kind: "enum", options: STATES },
    { path: ["meta", "priority"], label: "meta.priority", kind: "slider", min: 1, max: 5 },
    { path: ["pinned"], label: "pinned", kind: "bool" },
  ],
};

const D_NODE: NodeDesc = {
  id: "D",
  name: "Web 3.0",
  type: D_TYPE,
  note: "firstName/lastName split the lead's name; urgency quantizes the 1–5 priority but the lens remembers the exact level per band — drop to low and back to high and the original number returns.",
  fields: [
    { path: ["summary"], label: "summary", kind: "text" },
    { path: ["closed"], label: "closed", kind: "bool" },
    { path: ["firstName"], label: "firstName", kind: "text" },
    { path: ["lastName"], label: "lastName", kind: "text" },
    { path: ["urgency"], label: "urgency", kind: "pills", options: URGENCIES },
  ],
};

const EDGE_AB =
  'renameField("text","title") · widen(done→state) · wrapField(owner→assignees) · addField("priority",3)';
const EDGE_BC =
  'renameField("title","label") · renameField("assignees","crew") · nestFields([state,priority]→meta) · addField("pinned")';
const EDGE_BD =
  'renameField("title","summary") · narrow(state→closed) · headField(assignees→lead) · splitField(lead→firstName,lastName) · priority→urgency';

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
    button:hover:not(:disabled) {
      color: var(--text-color);
      border-color: var(--text-color);
    }
    button:disabled {
      opacity: 0.35;
      cursor: default;
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
      max-width: 640px;
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
      gap: 0.35rem 0.6rem;
      align-items: start;
    }
    .form > label {
      font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
      font-size: 0.72rem;
      color: var(--text-secondary);
      white-space: nowrap;
      padding-top: 0.2rem;
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
    .pills {
      display: inline-flex;
      gap: 0;
      border: 1px solid var(--border-color);
      border-radius: 5px;
      overflow: hidden;
    }
    .pills button {
      border: none;
      border-radius: 0;
      border-right: 1px solid var(--border-color);
      padding: 0.18rem 0.6rem;
      background: var(--code-bg);
    }
    .pills button:last-child {
      border-right: none;
    }
    .pills button.on {
      background: var(--text-color);
      color: #fff;
    }
    .list {
      display: flex;
      flex-direction: column;
      gap: 0.25rem;
    }
    .chip {
      display: flex;
      align-items: center;
      gap: 0.25rem;
      padding: 0.1rem 0.15rem 0.1rem 0.3rem;
      border: 1px solid var(--border-color);
      border-radius: 5px;
      background: var(--code-bg);
    }
    .chip.head {
      border-color: var(--text-color);
      box-shadow: inset 2px 0 0 var(--text-color);
    }
    .chip .star {
      font-size: 0.7rem;
      min-width: 0.9rem;
      text-align: center;
      color: var(--text-secondary);
    }
    .chip.head .star {
      color: var(--text-color);
    }
    .chip input {
      flex: 1;
      border: none;
      background: transparent;
      font: inherit;
      font-size: 0.78rem;
      color: var(--code-text);
      min-width: 0;
      padding: 0.1rem 0.1rem;
    }
    .chip input:focus {
      outline: none;
    }
    .chip .mv {
      font-size: 0.7rem;
      padding: 0 0.3rem;
      background: transparent;
      border: none;
      color: var(--text-secondary);
    }
    .addchip {
      align-self: flex-start;
      font-size: 0.72rem;
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

    const hintrow = document.createElement("div");
    hintrow.className = "hintrow";
    const hint = document.createElement("p");
    hint.className = "hint";
    hint.innerHTML =
      "One task across four app versions, related by composed POJO lenses in a <b>branching</b> graph " +
      "A → B → {C, D}. Edit any panel; the change flows across the whole graph. Try: reorder the <b>crew</b> in " +
      "Mobile and watch Todo's <code>owner</code> and Web's <code>firstName/lastName</code> follow the new lead " +
      "(the rest of the crew is conserved); or set <code>urgency=low</code> in Web, then back to <code>high</code> — " +
      "the exact 1–5 priority returns.";
    const reset = document.createElement("button");
    reset.textContent = "reset";
    reset.addEventListener("click", () => this.render());
    hintrow.append(hint, reset);
    this.shadow.append(hintrow);

    this.shadow.append(this.#paneRow(A_NODE, A, true));
    this.shadow.append(this.#edge(EDGE_AB));
    this.shadow.append(this.#paneRow(B_NODE, B, true));
    const edgePair = document.createElement("div");
    edgePair.className = "edge-pair";
    edgePair.append(this.#edge(EDGE_BC), this.#edge(EDGE_BD));
    this.shadow.append(edgePair);
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

    const refreshers: Array<(v: unknown) => void> = [];

    for (const f of desc.fields) {
      const label = document.createElement("label");
      label.textContent = f.label;
      form.append(label);

      const commit = (raw: unknown) => {
        cellRef.value = setPath(cellRef.value, f.path, raw) as Obj;
      };

      if (f.kind === "text") {
        refreshers.push(this.#textControl(form, commit));
      } else if (f.kind === "bool") {
        refreshers.push(this.#boolControl(form, commit));
      } else if (f.kind === "enum") {
        refreshers.push(this.#enumControl(form, f.options, commit));
      } else if (f.kind === "pills") {
        refreshers.push(this.#pillsControl(form, f.options, commit));
      } else if (f.kind === "slider") {
        refreshers.push(this.#sliderControl(form, f.min, f.max, commit));
      } else {
        refreshers.push(this.#listControl(form, commit));
      }
    }

    pane.append(header, schema, form);

    if (desc.note) {
      const note = document.createElement("p");
      note.className = "note";
      note.textContent = desc.note;
      pane.append(note);
    }

    this.#disposers.push(
      effect(() => {
        const v = cellRef.value;
        for (let i = 0; i < refreshers.length; i++) {
          refreshers[i]?.(getPath(v, desc.fields[i]!.path));
        }
      }),
    );

    return pane;
  }

  // ── controls (each appends to the form grid and returns a refresher) ──

  #textControl(form: HTMLElement, commit: (raw: unknown) => void): (v: unknown) => void {
    const input = document.createElement("input");
    input.type = "text";
    input.spellcheck = false;
    input.autocomplete = "off";
    input.addEventListener("input", () => commit(input.value));
    form.append(input);
    return v => {
      if (this.shadow.activeElement === input) return;
      const text = String(v ?? "");
      if (input.value !== text) input.value = text;
    };
  }

  #boolControl(form: HTMLElement, commit: (raw: unknown) => void): (v: unknown) => void {
    const input = document.createElement("input");
    input.type = "checkbox";
    input.addEventListener("change", () => commit(input.checked));
    const wrap = document.createElement("div");
    wrap.append(input);
    form.append(wrap);
    return v => {
      if (this.shadow.activeElement === input) return;
      input.checked = Boolean(v);
    };
  }

  #enumControl(
    form: HTMLElement,
    options: readonly string[],
    commit: (raw: unknown) => void,
  ): (v: unknown) => void {
    const select = document.createElement("select");
    for (const opt of options) {
      const o = document.createElement("option");
      o.value = opt;
      o.textContent = opt;
      select.append(o);
    }
    select.addEventListener("change", () => commit(select.value));
    form.append(select);
    return v => {
      if (this.shadow.activeElement === select) return;
      select.value = String(v ?? "");
    };
  }

  #pillsControl(
    form: HTMLElement,
    options: readonly string[],
    commit: (raw: unknown) => void,
  ): (v: unknown) => void {
    const group = document.createElement("div");
    group.className = "pills";
    const buttons: HTMLButtonElement[] = [];
    for (const opt of options) {
      const b = document.createElement("button");
      b.type = "button";
      b.textContent = opt;
      b.addEventListener("click", () => commit(opt));
      group.append(b);
      buttons.push(b);
    }
    form.append(group);
    return v => {
      const cur = String(v ?? "");
      buttons.forEach((b, i) => b.classList.toggle("on", options[i] === cur));
    };
  }

  #sliderControl(
    form: HTMLElement,
    min: number,
    max: number,
    commit: (raw: unknown) => void,
  ): (v: unknown) => void {
    const numrow = document.createElement("div");
    numrow.className = "numrow";
    const input = document.createElement("input");
    input.type = "range";
    input.min = String(min);
    input.max = String(max);
    input.step = "1";
    const badge = document.createElement("span");
    badge.className = "badge";
    input.addEventListener("input", () => {
      badge.textContent = input.value;
      commit(Number(input.value));
    });
    numrow.append(input, badge);
    form.append(numrow);
    return v => {
      const n = Number(v ?? 0);
      badge.textContent = String(n);
      if (this.shadow.activeElement === input) return;
      input.value = String(n);
    };
  }

  #listControl(form: HTMLElement, commit: (raw: unknown) => void): (v: unknown) => void {
    const wrap = document.createElement("div");
    const list = document.createElement("div");
    list.className = "list";
    const add = document.createElement("button");
    add.type = "button";
    add.className = "addchip";
    add.textContent = "+ add";
    wrap.append(list, add);
    form.append(wrap);

    const inputs: HTMLInputElement[] = [];
    const values = (): string[] => inputs.map(i => i.value);
    const commitFrom = (arr: string[]) => commit(arr);

    const rebuild = (n: number) => {
      list.replaceChildren();
      inputs.length = 0;
      for (let i = 0; i < n; i++) {
        const chip = document.createElement("div");
        chip.className = i === 0 ? "chip head" : "chip";
        const star = document.createElement("span");
        star.className = "star";
        star.textContent = i === 0 ? "★" : String(i + 1);
        const input = document.createElement("input");
        input.type = "text";
        input.spellcheck = false;
        input.addEventListener("input", () => commitFrom(values()));
        const up = document.createElement("button");
        up.type = "button";
        up.className = "mv";
        up.textContent = "↑";
        up.disabled = i === 0;
        up.addEventListener("click", () => {
          const arr = values();
          [arr[i - 1], arr[i]] = [arr[i] as string, arr[i - 1] as string];
          commitFrom(arr);
        });
        const down = document.createElement("button");
        down.type = "button";
        down.className = "mv";
        down.textContent = "↓";
        down.disabled = i === n - 1;
        down.addEventListener("click", () => {
          const arr = values();
          [arr[i + 1], arr[i]] = [arr[i] as string, arr[i + 1] as string];
          commitFrom(arr);
        });
        const rm = document.createElement("button");
        rm.type = "button";
        rm.className = "mv";
        rm.textContent = "×";
        rm.disabled = n <= 1;
        rm.addEventListener("click", () => {
          const arr = values();
          arr.splice(i, 1);
          commitFrom(arr);
        });
        chip.append(star, input, up, down, rm);
        list.append(chip);
        inputs.push(input);
      }
    };

    add.addEventListener("click", () => commitFrom([...values(), ""]));

    return v => {
      const arr = (Array.isArray(v) ? v : []).map(x => String(x ?? ""));
      if (arr.length !== inputs.length) rebuild(arr.length);
      inputs.forEach((inp, i) => {
        if (this.shadow.activeElement !== inp && inp.value !== (arr[i] ?? "")) {
          inp.value = arr[i] ?? "";
        }
      });
    };
  }
}
