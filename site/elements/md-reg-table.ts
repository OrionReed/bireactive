// A CSV string edited as a 2-D grid — composed regex-lenses, one source.
//
// Two `Reg` grammars, composed: the outer splits the source into lines
// (`copy(/[^\n]*/).star("\n")`), giving an `Arr<string>` of row lenses; each
// row cell is itself an ordinary writable lens, so the inner grammar
// (`copy(/[^,]*/).star(",")`) binds *into* a row to expose its cells as a
// second `Arr<string>`. The result is structural editing in both dimensions —
// add / remove / reorder rows AND add / remove / edit cells — every change
// reflectively reprinted back into the single backing string. No CSV model, no
// parse/serialize round-trip we maintain by hand: the string *is* the model.

import { type Arr, type Cell, effect, Reg, str } from "@bireactive";
import { BaseElement, css } from "./base-element";

const INITIAL = [
  "name,role,city",
  "Ada,engineer,London",
  "Bao,designer,Taipei",
  "Cy,writer,Oslo",
].join("\n");

const rowsOf = Reg.copy(/[^\n]*/)
  .star(Reg.lit("\n"))
  .as("rows");
const cellsOf = Reg.copy(/[^,]*/).star(Reg.lit(",")).as("cells");

const w = (c: Cell<string>) => c as unknown as { value: string };

interface RowUi {
  el: HTMLDivElement;
  dispose: () => void;
}

export class MdRegTable extends BaseElement {
  static styles = css`
    :host {
      display: block;
      margin: 1.5rem 0;
      width: 100%;
      max-width: 720px;
      margin-left: auto;
      margin-right: auto;
      color: var(--text-color);
      font-family: inherit;
    }
    .hint {
      font-size: 0.8rem;
      color: var(--text-secondary);
      margin: 0 0 0.6rem;
      line-height: 1.4;
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
      min-height: 4rem;
      white-space: pre;
      overflow: auto;
      margin-bottom: 0.75rem;
    }
    textarea:focus {
      outline: none;
      border-color: var(--text-color);
    }
    .rows {
      display: flex;
      flex-direction: column;
      gap: 0.35rem;
    }
    .row {
      display: flex;
      align-items: center;
      gap: 0.35rem;
      padding: 0.3rem;
      border: 1px solid var(--border-color);
      border-radius: 6px;
      background: var(--bg-color);
    }
    .grip {
      display: flex;
      flex-direction: column;
      gap: 1px;
    }
    .icon {
      border: 1px solid var(--border-color);
      background: var(--code-bg);
      color: var(--text-secondary);
      cursor: pointer;
      border-radius: 3px;
      font-size: 0.7rem;
      line-height: 1;
      padding: 0.1rem 0.3rem;
    }
    .icon:hover {
      color: var(--text-color);
      border-color: var(--text-color);
    }
    .cells {
      display: flex;
      flex-wrap: wrap;
      gap: 0.3rem;
      flex: 1;
    }
    .cell {
      display: inline-flex;
      align-items: stretch;
      border: 1px solid var(--border-color);
      border-radius: 4px;
      overflow: hidden;
      background: var(--code-bg);
    }
    .cell input {
      border: 0;
      background: transparent;
      color: var(--code-text);
      font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
      font-size: 0.85rem;
      padding: 0.25rem 0.45rem;
      width: 8ch;
      min-width: 3ch;
    }
    .cell input:focus {
      outline: none;
    }
    .cell button {
      border: 0;
      border-left: 1px solid var(--border-color);
      background: transparent;
      color: var(--text-secondary);
      cursor: pointer;
      padding: 0 0.35rem;
    }
    .cell button:hover {
      color: var(--text-color);
    }
    .add {
      border: 1px dashed var(--border-color);
      border-radius: 4px;
      background: transparent;
      color: var(--text-secondary);
      cursor: pointer;
      padding: 0.25rem 0.6rem;
      font-size: 0.8rem;
    }
    .add:hover {
      color: var(--text-color);
      border-color: var(--text-color);
    }
    .footer {
      margin-top: 0.5rem;
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
    const rowsArr = rowsOf.bind(source).rows as Arr<string>;
    void rowsArr.values.value;

    const hint = document.createElement("p");
    hint.className = "hint";
    hint.textContent =
      "One string, two composed regex-lenses. Edit a cell, drag a row up or down, add or remove rows and columns — or edit the raw CSV directly. Every dimension is a lens back into the single source below.";
    this.shadow.append(hint);

    const ta = document.createElement("textarea");
    ta.spellcheck = false;
    ta.autocomplete = "off";
    ta.rows = 5;
    ta.value = source.value;
    ta.addEventListener("input", () => {
      source.value = ta.value;
    });
    this.shadow.append(ta);
    this.#disposers.push(
      effect(() => {
        const v = source.value;
        if (this.shadow.activeElement === ta) return;
        if (ta.value !== v) ta.value = v;
      }),
    );

    const list = document.createElement("div");
    list.className = "rows";
    this.shadow.append(list);

    const footer = document.createElement("div");
    footer.className = "footer";
    const addRow = document.createElement("button");
    addRow.className = "add";
    addRow.textContent = "+ row";
    addRow.addEventListener("click", () => {
      const n = (rowsArr.values.value[0]?.split(",").length ?? 1) || 1;
      rowsArr.push(Array.from({ length: n }, () => "").join(","));
    });
    footer.append(addRow);
    this.shadow.append(footer);

    const cache = new Map<Cell<string>, RowUi>();
    this.#disposers.push(
      effect(() => {
        const cells = rowsArr.cells;
        const live = new Set(cells);
        for (const [c, ui] of cache) {
          if (!live.has(c)) {
            ui.dispose();
            ui.el.remove();
            cache.delete(c);
          }
        }
        for (const c of cells) {
          let ui = cache.get(c);
          if (!ui) {
            ui = this.#row(c, rowsArr);
            cache.set(c, ui);
          }
          list.append(ui.el); // append moves existing nodes into order
        }
      }),
    );
  }

  /** One CSV line, bound as an inner `Arr<string>` of cell lenses. */
  #row(rowCell: Cell<string>, rowsArr: Arr<string>): RowUi {
    const el = document.createElement("div");
    el.className = "row";

    const grip = document.createElement("div");
    grip.className = "grip";
    const up = document.createElement("button");
    up.className = "icon";
    up.textContent = "▲";
    up.title = "move up";
    up.addEventListener("click", () => {
      const i = rowsArr.cells.indexOf(rowCell);
      if (i > 0) rowsArr.move(rowCell, i - 1);
    });
    const down = document.createElement("button");
    down.className = "icon";
    down.textContent = "▼";
    down.title = "move down";
    down.addEventListener("click", () => {
      const i = rowsArr.cells.indexOf(rowCell);
      if (i >= 0 && i < rowsArr.cells.length - 1) rowsArr.move(rowCell, i + 1);
    });
    grip.append(up, down);

    const del = document.createElement("button");
    del.className = "icon";
    del.textContent = "×";
    del.title = "remove row";
    del.addEventListener("click", () => rowsArr.remove(rowCell));

    const cellsBox = document.createElement("div");
    cellsBox.className = "cells";

    const cellsArr = cellsOf.bind(rowCell).cells as Arr<string>;
    void cellsArr.values.value;

    const addCol = document.createElement("button");
    addCol.className = "add";
    addCol.textContent = "+";
    addCol.title = "add cell";
    addCol.addEventListener("click", () => cellsArr.push(""));

    el.append(grip, del, cellsBox, addCol);

    interface CellUi {
      el: HTMLDivElement;
      input: HTMLInputElement;
    }
    const cellCache = new Map<Cell<string>, CellUi>();
    const dispose = effect(() => {
      const cells = cellsArr.cells;
      const live = new Set(cells);
      for (const [c, ui] of cellCache) {
        if (!live.has(c)) {
          ui.el.remove();
          cellCache.delete(c);
        }
      }
      for (const c of cells) {
        let ui = cellCache.get(c);
        if (!ui) {
          const chip = document.createElement("div");
          chip.className = "cell";
          const input = document.createElement("input");
          input.type = "text";
          input.spellcheck = false;
          input.addEventListener("input", () => {
            w(c).value = input.value;
          });
          const x = document.createElement("button");
          x.textContent = "×";
          x.title = "remove cell";
          x.addEventListener("click", () => cellsArr.remove(c));
          chip.append(input, x);
          ui = { el: chip, input };
          cellCache.set(c, ui);
        }
        const v = c.value;
        if (this.shadow.activeElement !== ui.input && ui.input.value !== v) ui.input.value = v;
        cellsBox.append(ui.el);
      }
    });

    return { el, dispose };
  }
}
