// A kanban where every view is one `Coll<Card>` seen through a different
// *writable* structural lens. You edit the view, not the source: a drag is
// `board.move(card, column, index)` — the lens's backward pass writes the
// card's `status` (the group key), its `rank` (the order field), and, since
// the board is also `filter`ed, asserts whatever the filter demands
// (assignee, not-done). One call; the table re-sorts, the timeline slides,
// the tallies move. Add is `board.insert`, delete is `tasks.remove`. The
// renderer never names a field — the chain owns the backward writes.

import {
  batch,
  Bool,
  bool,
  type Cell,
  cell,
  coll,
  type Coll,
  derive,
  effect,
  type GroupView,
  type Num,
  num,
  type Str,
  str,
  type View,
  type Writable,
} from "@bireactive";
import { BaseElement, css } from "./base-element";

type Status = "todo" | "doing" | "done";
type Axis = "status" | "assignee" | "priority";
type SortKey = "title" | "assignee" | "status" | "priority" | "estimate" | "due";
type ViewKind = "board" | "table" | "timeline";

interface Card {
  id: string;
  title: Writable<Str>;
  status: Writable<Str>;
  assignee: Writable<Str>;
  priority: Writable<Num>;
  estimate: Writable<Num>;
  due: Writable<Num>;
  rank: Writable<Num>;
  /** Bool lens over `status`: true ⟺ "done"; writing rewrites the column. */
  done: Writable<Bool>;
}

const DAYS = 14;

const STATUSES: readonly Status[] = ["todo", "doing", "done"];
const STATUS_LABEL: Record<string, string> = { todo: "Todo", doing: "Doing", done: "Done" };
const STATUS_COLOR: Record<string, string> = { todo: "#94a3b8", doing: "#f59e0b", done: "#22c55e" };

const ASSIGNEES = ["Ada", "Linus", "Grace", "Rich"] as const;
const ASSIGNEE_COLOR: Record<string, string> = {
  Ada: "#6366f1",
  Linus: "#0ea5e9",
  Grace: "#ec4899",
  Rich: "#14b8a6",
};

const PRIORITIES = [2, 1, 0] as const;
const PRIORITY_LABEL: Record<number, string> = { 2: "High", 1: "Med", 0: "Low" };
const PRIORITY_COLOR: Record<number, string> = { 2: "#e11d48", 1: "#6366f1", 0: "#94a3b8" };
const FIB = [1, 2, 3, 5, 8];

let uidN = 0;
const card = (
  title: string,
  status: Status,
  assignee: string,
  priority: number,
  estimate: number,
  due: number,
  rank: number,
): Card => {
  const statusCell = str(status);
  return {
    id: `c${++uidN}`,
    title: str(title),
    status: statusCell,
    assignee: str(assignee),
    priority: num(priority),
    estimate: num(estimate),
    due: num(due),
    rank: num(rank),
    done: Bool.lens(
      statusCell,
      s => s === "done",
      (b: boolean) => (b ? "done" : "todo"),
    ) as Writable<Bool>,
  };
};

const SEED = (): Card[] => [
  card("Design landing page", "todo", "Grace", 2, 5, 1, 1),
  card("Set up CI pipeline", "doing", "Linus", 1, 3, 0, 1),
  card("Write API docs", "todo", "Ada", 0, 2, 4, 2),
  card("Fix auth redirect bug", "doing", "Ada", 2, 2, 1, 2),
  card("Migrate to Postgres", "todo", "Rich", 2, 8, 3, 3),
  card("Add dark mode", "done", "Grace", 0, 3, 0, 1),
  card("Refactor cell engine", "doing", "Linus", 1, 5, 5, 3),
  card("Onboarding emails", "todo", "Ada", 1, 1, 6, 4),
  card("Load-test checkout", "todo", "Rich", 2, 3, 8, 5),
  card("Ship release notes", "done", "Grace", 0, 1, 2, 2),
  card("Audit dependencies", "doing", "Rich", 0, 2, 7, 4),
  card("Mobile nav polish", "todo", "Grace", 1, 2, 9, 6),
  card("Cache invalidation", "done", "Linus", 2, 5, 1, 3),
  card("Triage inbox", "doing", "Ada", 0, 1, 10, 5),
];

interface AxisDesc {
  keys: readonly (string | number)[];
  label: (k: string | number) => string;
  color: (k: string | number) => string;
  field: (c: Card) => Writable<Num> | Writable<Str>;
}

const AXES: Record<Axis, AxisDesc> = {
  status: { keys: STATUSES, label: k => STATUS_LABEL[k], color: k => STATUS_COLOR[k], field: c => c.status },
  assignee: {
    keys: ASSIGNEES,
    label: k => String(k),
    color: k => ASSIGNEE_COLOR[k] ?? "#94a3b8",
    field: c => c.assignee,
  },
  priority: {
    keys: PRIORITIES,
    label: k => PRIORITY_LABEL[Number(k)],
    color: k => PRIORITY_COLOR[Number(k)],
    field: c => c.priority,
  },
};

const next = <T>(arr: readonly T[], cur: T): T => arr[(arr.indexOf(cur) + 1) % arr.length];

export class MdKanban extends BaseElement {
  static styles = css`
    :host {
      display: block;
      margin: 1.5rem auto;
      width: 100%;
      max-width: 1040px;
      font-family: inherit;
      color: var(--text-color);
    }
    .hint {
      font-size: 0.8rem;
      color: var(--text-secondary);
      margin: 0 0 0.9rem;
      line-height: 1.45;
    }
    .frame {
      border: 1px solid var(--border-color);
      border-radius: 10px;
      background: var(--bg-color);
      overflow: hidden;
    }
    .toolbar {
      display: flex;
      flex-wrap: wrap;
      align-items: center;
      gap: 0.6rem 0.9rem;
      padding: 0.7rem 0.9rem;
      border-bottom: 1px solid var(--border-color);
      background: var(--code-bg);
    }
    .search {
      flex: 1 1 150px;
      min-width: 110px;
      font: inherit;
      font-size: 0.85rem;
      padding: 0.4rem 0.6rem;
      border: 1px solid var(--border-color);
      border-radius: 6px;
      background: var(--bg-color);
      color: var(--text-color);
    }
    .search:focus {
      outline: none;
      border-color: var(--ink-fill, #5b8def);
    }
    .seg {
      display: inline-flex;
      border: 1px solid var(--border-color);
      border-radius: 7px;
      overflow: hidden;
    }
    .seg button {
      font: inherit;
      font-size: 0.78rem;
      padding: 0.35rem 0.66rem;
      border: none;
      background: var(--bg-color);
      color: var(--text-secondary);
      cursor: pointer;
      border-left: 1px solid var(--border-color);
    }
    .seg button:first-child {
      border-left: none;
    }
    .seg button.on {
      background: var(--ink-fill, #5b8def);
      color: #fff;
    }
    .label-sm {
      font-size: 0.7rem;
      text-transform: uppercase;
      letter-spacing: 0.04em;
      color: var(--text-secondary);
    }
    .switch {
      display: inline-flex;
      align-items: center;
      gap: 0.35rem;
      font-size: 0.78rem;
      color: var(--text-secondary);
      cursor: pointer;
      user-select: none;
    }
    .switch input {
      accent-color: var(--ink-fill, #5b8def);
      width: 15px;
      height: 15px;
      cursor: pointer;
    }

    /* section scaffolding */
    .section-h {
      font-size: 0.66rem;
      text-transform: uppercase;
      letter-spacing: 0.05em;
      color: var(--text-secondary);
      margin: 0 0 0.45rem;
      font-weight: 600;
    }
    .pane {
      padding: 0.85rem;
    }
    .pane-hint {
      font-size: 0.72rem;
      color: var(--text-secondary);
      margin: 0 0 0.6rem;
    }

    /* compact insights strip, merged into the header */
    .insights-strip {
      display: flex;
      flex-wrap: wrap;
      align-items: center;
      gap: 0.5rem 1.1rem;
      padding: 0.5rem 0.9rem;
      border-bottom: 1px solid var(--border-color);
      font-size: 0.74rem;
      color: var(--text-secondary);
    }
    .istat {
      display: inline-flex;
      align-items: center;
      gap: 0.45rem;
    }
    .istat .progress {
      width: 96px;
      height: 7px;
      background: var(--border-color);
      border-radius: 4px;
      overflow: hidden;
    }
    .istat .progress .bar {
      height: 100%;
      background: #22c55e;
      transition: width 0.2s ease;
    }
    .prog-text {
      font-variant-numeric: tabular-nums;
    }
    .wl-group {
      display: flex;
      flex-wrap: wrap;
      align-items: center;
      gap: 0.3rem 0.7rem;
    }
    .wl {
      display: inline-flex;
      align-items: center;
      gap: 0.3rem;
    }
    .wl input[type="checkbox"] {
      accent-color: #22c55e;
      width: 14px;
      height: 14px;
      cursor: pointer;
      margin: 0;
    }
    .wl .who {
      font-weight: 600;
    }
    .wl .wl-bar {
      width: 32px;
      height: 6px;
      border-radius: 3px;
      background: var(--border-color);
      overflow: hidden;
    }
    .wl .wl-bar .fill {
      height: 100%;
      transition: width 0.2s ease;
    }
    .wl .meta {
      font-variant-numeric: tabular-nums;
      opacity: 0.85;
    }

    /* board */
    .board {
      display: flex;
      gap: 0.7rem;
      overflow-x: auto;
      align-items: flex-start;
    }
    .col {
      flex: 1 1 0;
      min-width: 150px;
      display: flex;
      flex-direction: column;
      background: var(--code-bg);
      border-radius: 8px;
      border: 1px solid var(--border-color);
    }
    .col.dragover {
      border-color: var(--ink-fill, #5b8def);
      box-shadow: 0 0 0 1px var(--ink-fill, #5b8def) inset;
    }
    .col-head {
      display: flex;
      align-items: center;
      gap: 0.5rem;
      padding: 0.55rem 0.65rem 0.4rem;
    }
    .col-dot {
      width: 9px;
      height: 9px;
      border-radius: 50%;
      flex: none;
    }
    .col-title {
      font-weight: 600;
      font-size: 0.82rem;
    }
    .col-count {
      margin-left: auto;
      font-size: 0.72rem;
      color: var(--text-secondary);
      background: var(--bg-color);
      border: 1px solid var(--border-color);
      border-radius: 10px;
      padding: 0.02rem 0.42rem;
      min-width: 1.1rem;
      text-align: center;
    }
    .cards {
      display: flex;
      flex-direction: column;
      gap: 0.45rem;
      padding: 0.15rem 0.5rem 0.4rem;
      min-height: 18px;
    }
    .add {
      margin: 0 0.5rem 0.5rem;
      font: inherit;
      font-size: 0.76rem;
      padding: 0.3rem;
      border: 1px dashed var(--border-color);
      border-radius: 6px;
      background: transparent;
      color: var(--text-secondary);
      cursor: pointer;
    }
    .add:hover {
      border-color: var(--ink-fill, #5b8def);
      color: var(--text-color);
    }

    /* card — constant height: one title row + one no-wrap meta row */
    .card {
      background: var(--bg-color);
      border: 1px solid var(--border-color);
      border-left: 3px solid var(--prio, #94a3b8);
      border-radius: 7px;
      padding: 0.45rem 0.5rem;
      cursor: grab;
      display: flex;
      flex-direction: column;
      gap: 0.4rem;
      box-shadow: 0 1px 2px rgba(0, 0, 0, 0.04);
    }
    .card.dragging {
      opacity: 0.4;
    }
    .card.drop-before {
      box-shadow: 0 -2px 0 var(--ink-fill, #5b8def);
    }
    .card-top {
      display: flex;
      align-items: flex-start;
      gap: 0.4rem;
    }
    .prio-dot {
      flex: none;
      width: 11px;
      height: 11px;
      border-radius: 50%;
      border: none;
      padding: 0;
      cursor: pointer;
      margin-top: 0.18rem;
    }
    .title {
      flex: 1;
      font-size: 0.84rem;
      line-height: 1.3;
      outline: none;
      border-radius: 3px;
      cursor: text;
      min-width: 0;
    }
    .title:focus {
      box-shadow: 0 0 0 2px var(--ink-fill, #5b8def);
    }
    .card.done-card .title {
      text-decoration: line-through;
      opacity: 0.55;
    }
    .card-top input[type="checkbox"] {
      accent-color: #22c55e;
      width: 15px;
      height: 15px;
      cursor: pointer;
      margin: 0;
      flex: none;
    }
    .del {
      border: none;
      background: transparent;
      color: var(--text-secondary);
      cursor: pointer;
      font-size: 0.95rem;
      line-height: 1;
      padding: 0 0.1rem;
      opacity: 0;
      flex: none;
    }
    .card:hover .del {
      opacity: 0.55;
    }
    .del:hover {
      opacity: 1;
      color: #e05a5a;
    }
    .foot {
      display: flex;
      flex-wrap: nowrap;
      align-items: center;
      gap: 0.3rem;
      overflow: hidden;
    }
    .chip {
      font: inherit;
      font-size: 0.68rem;
      border: none;
      border-radius: 10px;
      padding: 0.08rem 0.5rem;
      cursor: pointer;
      color: #fff;
      line-height: 1.5;
      white-space: nowrap;
    }
    .pill {
      font: inherit;
      font-size: 0.66rem;
      border: 1px solid var(--border-color);
      border-radius: 10px;
      padding: 0.04rem 0.45rem;
      cursor: pointer;
      background: var(--bg-color);
      color: var(--text-secondary);
      display: inline-flex;
      align-items: center;
      gap: 0.28rem;
      white-space: nowrap;
    }
    .pdot {
      width: 7px;
      height: 7px;
      border-radius: 50%;
      flex: none;
    }
    .status-dot {
      margin-top: 0;
    }
    .est {
      margin-left: auto;
      font-variant-numeric: tabular-nums;
    }

    /* table */
    table {
      width: 100%;
      border-collapse: collapse;
      font-size: 0.8rem;
    }
    th {
      text-align: left;
      font-size: 0.66rem;
      text-transform: uppercase;
      letter-spacing: 0.04em;
      color: var(--text-secondary);
      padding: 0.35rem 0.5rem;
      border-bottom: 1px solid var(--border-color);
      cursor: pointer;
      user-select: none;
      white-space: nowrap;
    }
    th .arrow {
      opacity: 0.5;
      font-size: 0.7em;
    }
    td {
      padding: 0.3rem 0.5rem;
      border-bottom: 1px solid var(--border-color);
      vertical-align: middle;
    }
    tr:last-child td {
      border-bottom: none;
    }
    td.t-title {
      outline: none;
      min-width: 120px;
    }
    td.t-title:focus {
      box-shadow: 0 0 0 2px var(--ink-fill, #5b8def) inset;
    }
    tr.done-row td.t-title {
      text-decoration: line-through;
      opacity: 0.55;
    }

    /* timeline */
    .timeline {
      display: flex;
      flex-direction: column;
      gap: 0.45rem;
    }
    .tl-axis {
      display: grid;
      grid-template-columns: 4rem 1fr;
      align-items: center;
      font-size: 0.62rem;
      color: var(--text-secondary);
    }
    .tl-ticks {
      position: relative;
      height: 0.9rem;
    }
    .tl-ticks span {
      position: absolute;
      transform: translateX(-50%);
    }
    .tl-ticks span:first-child {
      transform: none;
    }
    .tl-ticks span:last-child {
      transform: translateX(-100%);
    }
    .tl-lane {
      display: grid;
      grid-template-columns: 4rem 1fr;
      align-items: start;
      gap: 0.5rem;
    }
    .tl-name {
      font-size: 0.74rem;
      font-weight: 600;
      white-space: nowrap;
      padding-top: 0.2rem;
    }
    .tl-track {
      position: relative;
      min-height: 24px;
      background-color: var(--code-bg);
      background-image: repeating-linear-gradient(
        to right,
        transparent 0,
        transparent calc(100% / 14 - 1px),
        var(--border-color) calc(100% / 14 - 1px),
        var(--border-color) calc(100% / 14)
      );
      border: 1px solid var(--border-color);
      border-radius: 5px;
    }
    .tl-bar {
      position: absolute;
      height: 18px;
      border-radius: 4px;
      cursor: grab;
      display: flex;
      align-items: center;
      padding: 0 0.35rem;
      font-size: 0.64rem;
      font-weight: 500;
      color: #fff;
      overflow: hidden;
      white-space: nowrap;
      text-overflow: ellipsis;
      box-sizing: border-box;
      touch-action: none;
      box-shadow: 0 1px 2px rgba(0, 0, 0, 0.18);
    }
    .tl-bar.dragging {
      cursor: grabbing;
      opacity: 0.9;
      z-index: 2;
    }
    .tl-bar.done-bar {
      opacity: 0.5;
      text-decoration: line-through;
    }
  `;

  #disposers: Array<() => void> = [];
  #viewDisposers: Array<() => void> = [];
  #cardDisposers = new Map<string, Array<() => void>>();

  #tasks: Coll<Card> = coll<Card>([], c => (c as Card).id);
  #visible!: View<Card>;
  #board!: GroupView<string | number, Card>;
  #cardById = new Map<string, Card>();
  #cardEls = new Map<string, HTMLElement>();
  #rowEls = new Map<string, HTMLElement>();
  #barEls = new Map<string, HTMLElement>();

  #axis: Axis = "status";
  #view: ViewKind = "board";
  #sort = cell<{ key: SortKey; dir: 1 | -1 }>({ key: "priority", dir: -1 });
  #query = str("");
  #activeOnly = bool(false);
  #dragId: string | null = null;
  #boardEl!: HTMLElement;
  #panes = new Map<ViewKind, HTMLElement>();
  #groupCtl!: HTMLElement;

  #bind(fn: () => void): void {
    this.#disposers.push(effect(fn));
  }
  #bindView(fn: () => void): void {
    this.#viewDisposers.push(effect(fn));
  }
  #bindCard(id: string, fn: () => void): void {
    let bucket = this.#cardDisposers.get(id);
    if (!bucket) this.#cardDisposers.set(id, (bucket = []));
    bucket.push(effect(fn));
  }

  disconnectedCallback(): void {
    for (const d of this.#viewDisposers) d();
    for (const d of this.#disposers) d();
    for (const b of this.#cardDisposers.values()) for (const d of b) d();
    this.#viewDisposers = [];
    this.#disposers = [];
    this.#cardDisposers.clear();
  }

  protected render(): void {
    this.disconnectedCallback();
    this.shadow.replaceChildren();

    uidN = 0;
    this.#cardById = new Map();
    this.#cardEls = new Map();
    this.#rowEls = new Map();
    this.#barEls = new Map();
    this.#query = str("");
    this.#activeOnly = bool(false);
    this.#sort = cell<{ key: SortKey; dir: 1 | -1 }>({ key: "priority", dir: -1 });

    const cards = SEED();
    for (const c of cards) this.#cardById.set(c.id, c);
    this.#tasks = coll(cards, c => c.id);

    // One reactive, assertable predicate drives every view. Reading the
    // toggle cells makes filtering reactive; `assert` makes a drop into a
    // filtered view set the fields that satisfy it.
    const pred = Object.assign(
      (c: Card) => {
        if (this.#activeOnly.value && c.done.value) return false;
        const q = this.#query.value.trim().toLowerCase();
        if (q) return c.title.value.toLowerCase().includes(q) || c.assignee.value.toLowerCase().includes(q);
        return true;
      },
      {
        assert: (c: Card) => {
          if (this.#activeOnly.value) c.done.value = false;
        },
      },
    );
    this.#visible = this.#tasks.filter(pred);

    const hint = document.createElement("p");
    hint.className = "hint";
    hint.textContent =
      "One Coll<Card>, three views of it. A drag is board.move(card, column, i) — the lens writes status, rank, and (with the filter on) assignee in one batch. Switch views and edit any of them; the shared collection keeps them all in sync.";
    this.shadow.append(hint);

    const frame = document.createElement("div");
    frame.className = "frame";
    frame.append(this.#buildToolbar(), this.#buildInsightsStrip());

    const boardPane = document.createElement("div");
    boardPane.className = "pane";
    const bh = document.createElement("p");
    bh.className = "pane-hint";
    bh.textContent = "Drag a card between columns or reorder within one — the move writes the grouping field and rank.";
    this.#boardEl = document.createElement("div");
    boardPane.append(bh, this.#boardEl);

    const tablePane = this.#buildTable();
    tablePane.classList.add("pane");
    const timelinePane = this.#buildTimeline();
    timelinePane.classList.add("pane");

    frame.append(boardPane, tablePane, timelinePane);
    this.shadow.append(frame);

    this.#panes = new Map([
      ["board", boardPane],
      ["table", tablePane],
      ["timeline", timelinePane],
    ]);
    this.#setView(this.#view);
    this.#rebuildBoard();
  }

  #setView(v: ViewKind): void {
    this.#view = v;
    for (const [k, el] of this.#panes) el.style.display = k === v ? "" : "none";
    if (this.#groupCtl) this.#groupCtl.style.display = v === "board" ? "" : "none";
  }

  // ---- toolbar ----------------------------------------------------------
  #buildToolbar(): HTMLElement {
    const bar = document.createElement("div");
    bar.className = "toolbar";

    const search = document.createElement("input");
    search.className = "search";
    search.type = "search";
    search.placeholder = "Search title or assignee…";
    search.spellcheck = false;
    search.addEventListener("input", () => {
      this.#query.value = search.value;
    });
    bar.append(search);

    bar.append(
      this.#segment(
        "View",
        [
          ["board", "Board"],
          ["table", "Table"],
          ["timeline", "Timeline"],
        ],
        () => this.#view,
        v => this.#setView(v as ViewKind),
      ),
    );

    this.#groupCtl = this.#segment(
      "Group",
      [
        ["status", "Status"],
        ["assignee", "Assignee"],
        ["priority", "Priority"],
      ],
      () => this.#axis,
      v => {
        this.#axis = v as Axis;
        this.#rebuildBoard();
      },
    );
    bar.append(this.#groupCtl);

    bar.append(this.#toggle("Active only", this.#activeOnly));

    return bar;
  }

  #segment(
    label: string,
    options: ReadonlyArray<[string, string]>,
    get: () => string,
    onPick: (v: string) => void,
  ): HTMLElement {
    const wrap = document.createElement("span");
    wrap.style.display = "inline-flex";
    wrap.style.alignItems = "center";
    wrap.style.gap = "0.4rem";
    const tag = document.createElement("span");
    tag.className = "label-sm";
    tag.textContent = label;
    const seg = document.createElement("span");
    seg.className = "seg";
    const buttons: HTMLButtonElement[] = [];
    for (const [value, text] of options) {
      const b = document.createElement("button");
      b.textContent = text;
      b.classList.toggle("on", get() === value);
      b.addEventListener("click", () => {
        onPick(value);
        for (const other of buttons) other.classList.toggle("on", other === b);
      });
      buttons.push(b);
      seg.append(b);
    }
    wrap.append(tag, seg);
    return wrap;
  }

  #toggle(label: string, cellRef: Writable<Bool>): HTMLElement {
    const sw = document.createElement("label");
    sw.className = "switch";
    const cb = document.createElement("input");
    cb.type = "checkbox";
    cb.addEventListener("change", () => {
      cellRef.value = cb.checked;
    });
    sw.append(cb, document.createTextNode(label));
    return sw;
  }

  // ---- board ------------------------------------------------------------
  #rebuildBoard(): void {
    for (const d of this.#viewDisposers) d();
    this.#viewDisposers = [];
    this.#boardEl.replaceChildren();

    const axis = AXES[this.#axis];
    // `axis.field` is a per-axis cell of differing type (Str / Num); the cast
    // unifies the key type so one board pipeline serves all three axes.
    this.#board = this.#visible.groupBy(c => axis.field(c) as Writable<Cell<string | number>>, {
      order: axis.keys,
      sort: c => c.rank,
    });

    const board = document.createElement("div");
    board.className = "board";
    const bodies = new Map<string, { body: HTMLElement; count: HTMLElement }>();

    for (const key of axis.keys) {
      const col = document.createElement("div");
      col.className = "col";
      const head = document.createElement("div");
      head.className = "col-head";
      const dot = document.createElement("span");
      dot.className = "col-dot";
      dot.style.background = axis.color(key);
      const title = document.createElement("span");
      title.className = "col-title";
      title.textContent = axis.label(key);
      const count = document.createElement("span");
      count.className = "col-count";
      head.append(dot, title, count);

      const body = document.createElement("div");
      body.className = "cards";

      const add = document.createElement("button");
      add.className = "add";
      add.textContent = "+ Add card";
      add.addEventListener("click", () => this.#addCard(key));

      col.append(head, body, add);
      board.append(col);
      bodies.set(String(key), { body, count });
      this.#wireColumnDrop(col, body, key);
    }

    this.#bindView(() => {
      for (const g of this.#board.value) {
        const slot = bodies.get(String(g.key));
        if (!slot) continue;
        this.#reconcile(
          slot.body,
          g.items.map(c => this.#cardEl(c)),
        );
        slot.count.textContent = String(g.items.length);
      }
    });

    this.#boardEl.append(board);
  }

  #wireColumnDrop(col: HTMLElement, body: HTMLElement, key: string | number): void {
    col.addEventListener("dragover", e => {
      e.preventDefault();
      if (e.dataTransfer) e.dataTransfer.dropEffect = "move";
      col.classList.add("dragover");
      this.#showDropMarker(body, e.clientY);
    });
    col.addEventListener("dragleave", e => {
      if (!col.contains(e.relatedTarget as Node)) col.classList.remove("dragover");
    });
    col.addEventListener("drop", e => {
      e.preventDefault();
      col.classList.remove("dragover");
      const id = this.#dragId ?? e.dataTransfer?.getData("text/plain") ?? "";
      const dragged = this.#cardById.get(id);
      if (!dragged) return;
      const index = this.#dropIndex(body, e.clientY, id);
      // The entire move: backward pass writes the group key, the rank, and
      // asserts the active filters — one call, every view re-flows.
      this.#board.move(dragged, key, index);
      for (const m of this.shadow.querySelectorAll(".drop-before")) m.classList.remove("drop-before");
    });
  }

  #cardsIn(body: HTMLElement, excludeId?: string): HTMLElement[] {
    return [...body.children].filter(
      (n): n is HTMLElement => n instanceof HTMLElement && !!n.dataset.id && n.dataset.id !== excludeId,
    );
  }

  #dropIndex(body: HTMLElement, y: number, excludeId: string): number {
    const cards = this.#cardsIn(body, excludeId);
    for (let i = 0; i < cards.length; i++) {
      const r = cards[i].getBoundingClientRect();
      if (y < r.top + r.height / 2) return i;
    }
    return cards.length;
  }

  #showDropMarker(body: HTMLElement, y: number): void {
    for (const m of this.shadow.querySelectorAll(".drop-before")) m.classList.remove("drop-before");
    const cards = this.#cardsIn(body, this.#dragId ?? undefined);
    const idx = this.#dropIndex(body, y, this.#dragId ?? "");
    if (idx < cards.length) cards[idx].classList.add("drop-before");
  }

  // ---- card element -----------------------------------------------------
  #cardEl(c: Card): HTMLElement {
    const cached = this.#cardEls.get(c.id);
    if (cached) return cached;

    const el = document.createElement("div");
    el.className = "card";
    el.dataset.id = c.id;
    el.draggable = true;

    const top = document.createElement("div");
    top.className = "card-top";
    const prioDot = document.createElement("button");
    prioDot.className = "prio-dot";
    prioDot.addEventListener("click", () => {
      c.priority.value = next(PRIORITIES, c.priority.value as (typeof PRIORITIES)[number]);
    });
    const title = document.createElement("span");
    title.className = "title";
    title.contentEditable = "true";
    title.spellcheck = false;
    this.#wireTitle(title, c);
    title.addEventListener("focus", () => {
      el.draggable = false;
    });
    title.addEventListener("blur", () => {
      el.draggable = true;
    });
    const done = document.createElement("input");
    done.type = "checkbox";
    done.title = "Mark done";
    done.addEventListener("change", () => {
      c.done.value = done.checked;
    });
    const del = document.createElement("button");
    del.className = "del";
    del.textContent = "×";
    del.title = "Delete card";
    del.draggable = false;
    del.addEventListener("click", () => this.#deleteCard(c));
    top.append(prioDot, title, done, del);

    const foot = document.createElement("div");
    foot.className = "foot";
    const who = document.createElement("button");
    who.className = "chip";
    who.title = "Click to reassign";
    who.addEventListener("click", () => {
      c.assignee.value = next(ASSIGNEES, c.assignee.value as (typeof ASSIGNEES)[number]);
    });
    const est = document.createElement("button");
    est.className = "pill est";
    est.title = "Click to change estimate";
    est.addEventListener("click", () => {
      c.estimate.value = next(FIB, c.estimate.value);
    });
    foot.append(who, this.#statusDot(c), est);

    el.append(top, foot);

    this.#bindCard(c.id, () => {
      const a = c.assignee.value;
      who.textContent = a;
      who.style.background = ASSIGNEE_COLOR[a] ?? "#94a3b8";
      const pc = PRIORITY_COLOR[c.priority.value] ?? "#94a3b8";
      el.style.setProperty("--prio", pc);
      prioDot.style.background = pc;
      prioDot.title = `Priority: ${PRIORITY_LABEL[c.priority.value]} — click to change`;
      est.textContent = `${c.estimate.value} pt`;
      const d = c.done.value;
      done.checked = d;
      el.classList.toggle("done-card", d);
    });

    el.addEventListener("dragstart", e => {
      this.#dragId = c.id;
      el.classList.add("dragging");
      e.dataTransfer?.setData("text/plain", c.id);
      if (e.dataTransfer) e.dataTransfer.effectAllowed = "move";
    });
    el.addEventListener("dragend", () => {
      this.#dragId = null;
      el.classList.remove("dragging");
      for (const m of this.shadow.querySelectorAll(".drop-before")) m.classList.remove("drop-before");
      for (const m of this.shadow.querySelectorAll(".col.dragover")) m.classList.remove("dragover");
    });

    this.#cardEls.set(c.id, el);
    return el;
  }

  #statusDot(c: Card): HTMLElement {
    const dot = document.createElement("button");
    dot.className = "prio-dot status-dot";
    dot.addEventListener("click", () => {
      c.status.value = next(STATUSES, c.status.value as Status);
    });
    this.#bindCard(c.id, () => {
      const s = c.status.value;
      dot.style.background = STATUS_COLOR[s] ?? "#94a3b8";
      dot.title = `Status: ${STATUS_LABEL[s] ?? s} — click to change`;
    });
    return dot;
  }

  #statusPill(c: Card): HTMLElement {
    const pill = document.createElement("button");
    pill.className = "pill";
    pill.title = "Click to change status";
    const dot = document.createElement("span");
    dot.className = "pdot";
    const text = document.createElement("span");
    pill.append(dot, text);
    pill.addEventListener("click", () => {
      c.status.value = next(STATUSES, c.status.value as Status);
    });
    this.#bindCard(c.id, () => {
      const s = c.status.value;
      dot.style.background = STATUS_COLOR[s] ?? "#94a3b8";
      text.textContent = STATUS_LABEL[s] ?? s;
    });
    return pill;
  }

  #prioPill(c: Card): HTMLElement {
    const pill = document.createElement("button");
    pill.className = "pill";
    pill.title = "Click to change priority";
    const dot = document.createElement("span");
    dot.className = "pdot";
    const text = document.createElement("span");
    pill.append(dot, text);
    pill.addEventListener("click", () => {
      c.priority.value = next(PRIORITIES, c.priority.value as (typeof PRIORITIES)[number]);
    });
    this.#bindCard(c.id, () => {
      const p = c.priority.value;
      dot.style.background = PRIORITY_COLOR[p] ?? "#94a3b8";
      text.textContent = PRIORITY_LABEL[p] ?? String(p);
    });
    return pill;
  }

  // ---- table view -------------------------------------------------------
  #buildTable(): HTMLElement {
    const wrap = document.createElement("div");
    const h = document.createElement("p");
    h.className = "pane-hint";
    h.textContent = "Click a header to sort. Edit any cell — chips and pills are leaf writes; the board and timeline update with it.";
    const table = document.createElement("table");
    const thead = document.createElement("tr");

    const cols: ReadonlyArray<[string, SortKey | null]> = [
      ["Title", "title"],
      ["Who", "assignee"],
      ["Status", "status"],
      ["Pri", "priority"],
      ["Due", "due"],
      ["Done", null],
    ];
    const arrows = new Map<SortKey, HTMLElement>();
    for (const [text, key] of cols) {
      const th = document.createElement("th");
      th.textContent = text;
      if (key) {
        const arrow = document.createElement("span");
        arrow.className = "arrow";
        th.append(arrow);
        arrows.set(key, arrow);
        th.addEventListener("click", () => {
          const cur = this.#sort.value;
          this.#sort.value = cur.key === key ? { key, dir: cur.dir === 1 ? -1 : 1 } : { key, dir: 1 };
        });
      }
      thead.append(th);
    }
    table.append(thead);
    const tbody = document.createElement("tbody");
    table.append(tbody);
    wrap.append(h, table);

    const rows = derive(() => {
      const { key, dir } = this.#sort.value;
      const arr = [...this.#visible.items];
      arr.sort((a, b) => dir * cmp(fieldValue(a, key), fieldValue(b, key)));
      return arr;
    });

    this.#bind(() => {
      const { key, dir } = this.#sort.value;
      for (const [k, arrow] of arrows) arrow.textContent = k === key ? (dir === 1 ? " ▲" : " ▼") : "";
      this.#reconcile(
        tbody,
        rows.value.map(c => this.#rowEl(c)),
      );
    });

    return wrap;
  }

  #rowEl(c: Card): HTMLElement {
    const cached = this.#rowEls.get(c.id);
    if (cached) return cached;

    const tr = document.createElement("tr");
    tr.dataset.id = c.id;

    const tdTitle = document.createElement("td");
    tdTitle.className = "t-title";
    tdTitle.contentEditable = "true";
    tdTitle.spellcheck = false;
    this.#wireTitle(tdTitle, c);

    const tdWho = document.createElement("td");
    const who = document.createElement("button");
    who.className = "chip";
    who.title = "Click to reassign";
    who.addEventListener("click", () => {
      c.assignee.value = next(ASSIGNEES, c.assignee.value as (typeof ASSIGNEES)[number]);
    });
    tdWho.append(who);

    const tdStatus = document.createElement("td");
    tdStatus.append(this.#statusPill(c));
    const tdPrio = document.createElement("td");
    tdPrio.append(this.#prioPill(c));

    const tdDue = document.createElement("td");
    tdDue.style.fontVariantNumeric = "tabular-nums";

    const tdDone = document.createElement("td");
    const done = document.createElement("input");
    done.type = "checkbox";
    done.addEventListener("change", () => {
      c.done.value = done.checked;
    });
    tdDone.append(done);

    tr.append(tdTitle, tdWho, tdStatus, tdPrio, tdDue, tdDone);

    this.#bindCard(c.id, () => {
      const a = c.assignee.value;
      who.textContent = a;
      who.style.background = ASSIGNEE_COLOR[a] ?? "#94a3b8";
      tdDue.textContent = `d${c.due.value}`;
      const d = c.done.value;
      done.checked = d;
      tr.classList.toggle("done-row", d);
    });

    this.#rowEls.set(c.id, tr);
    return tr;
  }

  // ---- timeline view ----------------------------------------------------
  #buildTimeline(): HTMLElement {
    const wrap = document.createElement("div");
    const h = document.createElement("p");
    h.className = "pane-hint";
    h.textContent = "Lanes are the assignee lens; each bar sits at its due day, width = estimate. Drag a bar to write due.";
    wrap.append(h);

    const tl = document.createElement("div");
    tl.className = "timeline";

    const axis = document.createElement("div");
    axis.className = "tl-axis";
    const spacer = document.createElement("span");
    const ticks = document.createElement("div");
    ticks.className = "tl-ticks";
    for (let d = 0; d <= DAYS; d += 2) {
      const t = document.createElement("span");
      t.textContent = `d${d}`;
      t.style.left = `${(d / DAYS) * 100}%`;
      ticks.append(t);
    }
    axis.append(spacer, ticks);
    tl.append(axis);

    const lanes = this.#visible.groupBy(c => c.assignee, { order: ASSIGNEES });
    const tracks = new Map<string, HTMLElement>();
    for (const name of ASSIGNEES) {
      const lane = document.createElement("div");
      lane.className = "tl-lane";
      const nm = document.createElement("span");
      nm.className = "tl-name";
      nm.textContent = name;
      nm.style.color = ASSIGNEE_COLOR[name];
      const track = document.createElement("div");
      track.className = "tl-track";
      lane.append(nm, track);
      tl.append(lane);
      tracks.set(name, track);
    }

    // One effect per render reads every member's due/estimate/status, so it
    // re-packs whenever any of them change — no per-bar layout race.
    this.#bind(() => {
      for (const g of lanes.value) {
        const track = tracks.get(String(g.key));
        if (!track) continue;
        this.#reconcile(
          track,
          g.items.map(c => this.#barEl(c, track)),
        );
        this.#packLane(track, g.items);
      }
    });

    wrap.append(tl);
    return wrap;
  }

  /** Greedy interval-packing: stack overlapping bars into sub-rows so a
   *  lane never collides, and size the track to the rows used. */
  #packLane(track: HTMLElement, items: readonly Card[]): void {
    const BAR_H = 18;
    const GAP = 3;
    const sorted = [...items].sort((a, b) => a.due.value - b.due.value);
    const rowEnds: number[] = [];
    for (const c of sorted) {
      const left = c.due.value;
      const span = Math.max(c.estimate.value, 1);
      let row = rowEnds.findIndex(end => end <= left + 1e-6);
      if (row === -1) {
        row = rowEnds.length;
        rowEnds.push(left + span);
      } else rowEnds[row] = left + span;

      const bar = this.#barEls.get(c.id);
      if (!bar) continue;
      bar.style.left = `${(left / DAYS) * 100}%`;
      bar.style.width = `${Math.max(4, (Math.min(span, DAYS - left) / DAYS) * 100)}%`;
      bar.style.top = `${row * (BAR_H + GAP) + GAP}px`;
      bar.style.background = STATUS_COLOR[c.status.value] ?? "#94a3b8";
      bar.classList.toggle("done-bar", c.done.value);
      bar.textContent = c.title.value;
      bar.title = `${c.title.value} · due d${left} · ${c.estimate.value} pt`;
    }
    const rows = Math.max(1, rowEnds.length);
    track.style.height = `${rows * (BAR_H + GAP) + GAP}px`;
  }

  #barEl(c: Card, track: HTMLElement): HTMLElement {
    const cached = this.#barEls.get(c.id);
    if (cached) return cached;

    const bar = document.createElement("div");
    bar.className = "tl-bar";
    bar.dataset.id = c.id;

    // Pointer-drag the bar to write `due` — a continuous edit of the view.
    let startX = 0;
    let startDue = 0;
    const onMove = (e: PointerEvent) => {
      const w = track.getBoundingClientRect().width;
      const dDays = ((e.clientX - startX) / w) * DAYS;
      c.due.value = Math.max(0, Math.min(DAYS, Math.round(startDue + dDays)));
    };
    const onUp = (e: PointerEvent) => {
      bar.classList.remove("dragging");
      bar.releasePointerCapture(e.pointerId);
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
    };
    bar.addEventListener("pointerdown", e => {
      startX = e.clientX;
      startDue = c.due.value;
      bar.classList.add("dragging");
      bar.setPointerCapture(e.pointerId);
      window.addEventListener("pointermove", onMove);
      window.addEventListener("pointerup", onUp);
    });

    this.#barEls.set(c.id, bar);
    return bar;
  }

  #wireTitle(el: HTMLElement, c: Card): void {
    el.addEventListener("input", () => {
      c.title.value = el.textContent ?? "";
    });
    el.addEventListener("keydown", e => {
      if (e.key === "Enter") {
        e.preventDefault();
        el.blur();
      }
    });
    this.#bindCard(c.id, () => {
      const v = c.title.value;
      if (this.shadow.activeElement !== el && el.textContent !== v) el.textContent = v;
    });
  }

  // ---- mutations --------------------------------------------------------
  #addCard(key: string | number): void {
    const maxRank = this.#tasks.items.reduce((m, c) => Math.max(m, c.rank.value), 0);
    const c = card("New task", "todo", ASSIGNEES[0], 1, 1, 0, maxRank + 1);
    this.#cardById.set(c.id, c);
    // Insert into the chosen column of the (possibly filtered) board: sets
    // the group key, the rank, and asserts the filter — one call.
    this.#board.insert(c, key, 0);
    requestAnimationFrame(() => {
      const title = this.#cardEls.get(c.id)?.querySelector(".title") as HTMLElement | null;
      if (title) {
        title.focus();
        const range = document.createRange();
        range.selectNodeContents(title);
        const sel = window.getSelection();
        sel?.removeAllRanges();
        sel?.addRange(range);
      }
    });
  }

  #deleteCard(c: Card): void {
    this.#tasks.remove(c);
    this.#cardById.delete(c.id);
    const bucket = this.#cardDisposers.get(c.id);
    if (bucket) for (const d of bucket) d();
    this.#cardDisposers.delete(c.id);
    this.#cardEls.get(c.id)?.remove();
    this.#rowEls.get(c.id)?.remove();
    this.#barEls.get(c.id)?.remove();
    this.#cardEls.delete(c.id);
    this.#rowEls.delete(c.id);
    this.#barEls.delete(c.id);
  }

  // ---- insights (compact strip in the header) ---------------------------
  #buildInsightsStrip(): HTMLElement {
    const wrap = document.createElement("div");
    wrap.className = "insights-strip";

    const prog = document.createElement("span");
    prog.className = "istat";
    const plabel = document.createElement("span");
    plabel.className = "label-sm";
    plabel.textContent = "Done";
    const pbar = document.createElement("span");
    pbar.className = "progress";
    const fill = document.createElement("span");
    fill.className = "bar";
    pbar.append(fill);
    const ptext = document.createElement("span");
    ptext.className = "prog-text";
    prog.append(plabel, pbar, ptext);

    const wlGroup = document.createElement("span");
    wlGroup.className = "wl-group";
    const wlabel = document.createElement("span");
    wlabel.className = "label-sm";
    wlabel.textContent = "Load";
    wlGroup.append(wlabel);

    const rows = new Map<string, { check: HTMLInputElement; bar: HTMLElement; meta: HTMLElement }>();
    for (const name of ASSIGNEES) {
      const unit = document.createElement("span");
      unit.className = "wl";
      const check = document.createElement("input");
      check.type = "checkbox";
      check.title = `Mark all of ${name}'s cards done`;
      check.addEventListener("change", () => {
        const v = check.checked;
        batch(() => {
          for (const c of this.#tasks.items) if (c.assignee.value === name) c.done.value = v;
        });
      });
      const who = document.createElement("span");
      who.className = "who";
      who.textContent = name;
      who.style.color = ASSIGNEE_COLOR[name];
      const track = document.createElement("span");
      track.className = "wl-bar";
      const f = document.createElement("span");
      f.className = "fill";
      f.style.background = ASSIGNEE_COLOR[name];
      track.append(f);
      const meta = document.createElement("span");
      meta.className = "meta";
      unit.append(check, who, track, meta);
      wlGroup.append(unit);
      rows.set(name, { check, bar: f, meta });
    }

    this.#bind(() => {
      const items = this.#tasks.items;
      const total = items.length;
      const doneCount = items.filter(c => c.done.value).length;
      const pct = total ? (doneCount / total) * 100 : 0;
      fill.style.width = `${pct}%`;
      ptext.textContent = `${doneCount}/${total} · ${pct.toFixed(0)}%`;

      const load = new Map<string, { est: number; done: number; n: number }>();
      for (const name of ASSIGNEES) load.set(name, { est: 0, done: 0, n: 0 });
      for (const c of items) {
        const slot = load.get(c.assignee.value);
        if (!slot) continue;
        slot.est += c.estimate.value;
        slot.n += 1;
        if (c.done.value) slot.done += 1;
      }
      const maxEst = Math.max(1, ...[...load.values()].map(v => v.est));
      for (const [name, slot] of load) {
        const r = rows.get(name);
        if (!r) continue;
        r.bar.style.width = `${(slot.est / maxEst) * 100}%`;
        r.meta.textContent = `${slot.done}/${slot.n}`;
        r.check.checked = slot.n > 0 && slot.done === slot.n;
        r.check.indeterminate = slot.done > 0 && slot.done < slot.n;
      }
    });

    wrap.append(prog, wlGroup);
    return wrap;
  }

  #reconcile(parent: Element, desired: HTMLElement[]): void {
    for (let i = 0; i < desired.length; i++) {
      const want = desired[i];
      const have = parent.childNodes[i];
      if (have !== want) parent.insertBefore(want, have ?? null);
    }
    while (parent.childNodes.length > desired.length) parent.lastChild!.remove();
  }
}

function fieldValue(c: Card, k: SortKey): string | number {
  switch (k) {
    case "title":
      return c.title.value.toLowerCase();
    case "assignee":
      return c.assignee.value.toLowerCase();
    case "status":
      return STATUSES.indexOf(c.status.value as Status);
    case "priority":
      return c.priority.value;
    case "estimate":
      return c.estimate.value;
    case "due":
      return c.due.value;
  }
}

function cmp(a: string | number, b: string | number): number {
  if (typeof a === "number" && typeof b === "number") return a - b;
  return String(a) < String(b) ? -1 : String(a) > String(b) ? 1 : 0;
}
