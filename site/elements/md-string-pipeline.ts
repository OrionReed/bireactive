// Bidirectional string editing through a chain of composable lenses.
//
// `Str` is now a lean primitive (trim / reverse / slice / split); the
// case-preserving fold is a free lens (`caseFold`). The Words pane is a
// `split(/\s+/)` view — an `Arr<string>` of positional segment lenses — so
// each word is independently editable AND the list is structurally editable
// (add / remove), every change flowing back through to the source.

import { type Arr, caseFold, effect, type Str, str, type Writable } from "@bireactive";
import { BaseElement, css } from "./base-element";

const INITIAL = "  The Quick Brown Fox Jumps over the lazy dog.  ";

interface PaneSpec {
  name: string;
  kind: string;
  cell: Writable<Str>;
}

export class MdStringPipeline extends BaseElement {
  static styles = css`
    :host {
      display: block;
      margin: 1.5rem 0;
      width: 100%;
      max-width: 720px;
      margin-left: auto;
      margin-right: auto;
      font-family: inherit;
      color: var(--text-color);
    }
    .grid {
      display: grid;
      grid-template-columns: repeat(2, minmax(0, 1fr));
      gap: 0.75rem;
    }
    @media (max-width: 600px) {
      .grid {
        grid-template-columns: 1fr;
      }
    }
    .pane {
      display: flex;
      flex-direction: column;
      gap: 0.4rem;
      padding: 0.6rem 0.75rem;
      border: 1px solid var(--border-color);
      border-radius: 6px;
      background: var(--bg-color);
    }
    .pane[data-source],
    .pane[data-wide] {
      grid-column: 1 / -1;
    }
    .pane[data-source] {
      border-color: var(--text-color);
    }
    .pane header {
      display: flex;
      justify-content: space-between;
      align-items: baseline;
      gap: 0.5rem;
    }
    .pane h3 {
      margin: 0;
      font-size: 0.95rem;
      font-weight: 600;
    }
    .badge {
      font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
      font-size: 0.7rem;
      color: var(--text-secondary);
      padding: 0.05rem 0.4rem;
      background: var(--code-bg);
      border-radius: 3px;
      white-space: nowrap;
    }
    textarea {
      width: 100%;
      box-sizing: border-box;
      font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
      font-size: 0.85rem;
      line-height: 1.45;
      padding: 0.4rem 0.55rem;
      background: var(--code-bg);
      color: var(--code-text);
      border: 1px solid var(--border-color);
      border-radius: 4px;
      resize: vertical;
      min-height: 3rem;
      white-space: pre;
      overflow: auto;
      tab-size: 2;
    }
    textarea:focus {
      outline: none;
      border-color: var(--text-color);
    }
    .pane[data-source] textarea {
      min-height: 4rem;
    }
    .words {
      display: flex;
      flex-wrap: wrap;
      gap: 0.4rem;
      align-items: center;
    }
    .word {
      display: inline-flex;
      align-items: stretch;
      border: 1px solid var(--border-color);
      border-radius: 4px;
      overflow: hidden;
      background: var(--code-bg);
    }
    .word input {
      border: 0;
      background: transparent;
      color: var(--code-text);
      font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
      font-size: 0.85rem;
      padding: 0.25rem 0.45rem;
      width: 6.5ch;
      min-width: 3ch;
    }
    .word input:focus {
      outline: none;
    }
    .word button {
      border: 0;
      border-left: 1px solid var(--border-color);
      background: transparent;
      color: var(--text-secondary);
      cursor: pointer;
      padding: 0 0.4rem;
      font-size: 0.85rem;
    }
    .word button:hover {
      color: var(--text-color);
    }
    .add {
      border: 1px dashed var(--border-color);
      border-radius: 4px;
      background: transparent;
      color: var(--text-secondary);
      cursor: pointer;
      padding: 0.25rem 0.6rem;
      font-size: 0.85rem;
    }
    .add:hover {
      color: var(--text-color);
      border-color: var(--text-color);
    }
    .hint {
      font-size: 0.8rem;
      color: var(--text-secondary);
      margin: 0 0 0.6rem;
      line-height: 1.4;
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

    const source = str(INITIAL);
    const trimmed = source.trim();
    const lowered = caseFold(trimmed);
    const reversed = source.reverse();
    const words = lowered.split(/\s+/);

    // Realize each complement so the first read converges before any
    // user interaction.
    void trimmed.value;
    void lowered.value;
    void reversed.value;
    void words.values.value;

    const hint = document.createElement("p");
    hint.className = "hint";
    hint.textContent =
      "Edit any pane — every other pane updates. Lossy projections recover what they discarded from each lens: trim restores padding, caseFold restores per-word case, split recovers separators. The Words pane is editable structurally too (add / remove).";
    this.shadow.append(hint);

    const grid = document.createElement("div");
    grid.className = "grid";

    const panes: PaneSpec[] = [
      { name: "Source", kind: "writable cell", cell: source },
      { name: "Trimmed", kind: "Str.trim", cell: trimmed },
      { name: "Lowercased", kind: "caseFold · per-word case", cell: lowered },
      { name: "Reversed", kind: "Str.reverse · involution", cell: reversed },
    ];

    for (const p of panes) {
      const wrap = document.createElement("div");
      wrap.className = "pane";
      if (p.name === "Source") wrap.dataset.source = "true";

      const header = document.createElement("header");
      const h = document.createElement("h3");
      h.textContent = p.name;
      const badge = document.createElement("span");
      badge.className = "badge";
      badge.textContent = p.kind;
      header.append(h, badge);
      wrap.append(header);

      const ta = document.createElement("textarea");
      ta.spellcheck = false;
      ta.autocapitalize = "off";
      ta.autocomplete = "off";
      ta.value = p.cell.value;
      ta.rows = p.name === "Source" ? 2 : 3;

      ta.addEventListener("input", () => {
        p.cell.value = ta.value;
      });
      ta.addEventListener("blur", () => {
        const v = p.cell.value;
        if (ta.value !== v) ta.value = v;
      });

      wrap.append(ta);
      grid.append(wrap);

      const dispose = effect(() => {
        const v = p.cell.value;
        if (this.shadow.activeElement === ta) return;
        if (ta.value !== v) ta.value = v;
      });
      this.#disposers.push(dispose);
    }

    grid.append(this.#wordsPane(words));
    this.shadow.append(grid);
  }

  /** The `split(/\s+/)` view, rendered as an editable list of word chips.
   *  Each chip's input is a positional segment lens (editing it rewrites
   *  the source); the × removes structurally, "+ word" inserts. */
  #wordsPane(words: Arr<string>): HTMLElement {
    const wrap = document.createElement("div");
    wrap.className = "pane";
    wrap.dataset.wide = "true";

    const header = document.createElement("header");
    const h = document.createElement("h3");
    h.textContent = "Words";
    const badge = document.createElement("span");
    badge.className = "badge";
    badge.textContent = "Str.split · positional segment lenses";
    header.append(h, badge);
    wrap.append(header);

    const list = document.createElement("div");
    list.className = "words";
    wrap.append(list);

    interface Row {
      el: HTMLDivElement;
      input: HTMLInputElement;
    }
    const rows: Row[] = [];
    const makeRow = (i: number): Row => {
      const el = document.createElement("div");
      el.className = "word";
      const input = document.createElement("input");
      input.type = "text";
      input.spellcheck = false;
      input.addEventListener("input", () => {
        const c = words.cells[i] as { value: string } | undefined;
        if (c) c.value = input.value;
      });
      const del = document.createElement("button");
      del.textContent = "×";
      del.title = "remove word";
      del.addEventListener("click", () => words.removeAt(i));
      el.append(input, del);
      return { el, input };
    };

    const add = document.createElement("button");
    add.className = "add";
    add.textContent = "+ word";
    add.addEventListener("click", () => words.push("word"));
    list.append(add);

    const dispose = effect(() => {
      const cells = words.cells;
      while (rows.length < cells.length) {
        const row = makeRow(rows.length);
        rows.push(row);
        list.insertBefore(row.el, add);
      }
      for (let i = 0; i < rows.length; i++) {
        const row = rows[i]!;
        const c = i < cells.length ? cells[i] : undefined;
        if (c) {
          row.el.style.display = "";
          const v = c.value;
          if (this.shadow.activeElement !== row.input && row.input.value !== v) row.input.value = v;
        } else {
          row.el.style.display = "none";
        }
      }
    });
    this.#disposers.push(dispose);

    return wrap;
  }
}
