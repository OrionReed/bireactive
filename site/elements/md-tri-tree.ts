// Nested checkbox tree with three-valued (Tri) folder aggregates.
//
// One node shape, one factory: a leaf is a source `Tri`; a folder's cell
// is `Tri.allOf` over its children's cells. Aggregation composes up the
// tree and a write cascades back down, so rendering is a single uniform
// recursion with no separate aggregate pass and no leaf-flattening.

import { effect, Num, Tri, tri, type Writable } from "@bireactive";
import { BaseElement, css } from "./base-element";

interface Node {
  label: string;
  checked: Writable<Tri>;
  children: Node[];
}

const node = (label: string, children: Node[] = [], init = false): Node => ({
  label,
  children,
  checked: children.length ? Tri.allOf(children.map(c => c.checked)) : tri(init),
});

const leavesOf = (n: Node): Node[] => (n.children.length ? n.children.flatMap(leavesOf) : [n]);

export class MdTriTree extends BaseElement {
  static styles = css`
    :host {
      display: block;
      margin: 1.5rem auto;
      width: 100%;
      max-width: 640px;
      font-family: inherit;
      color: var(--text-color);
    }
    .wrap {
      display: grid;
      grid-template-columns: 1fr auto;
      gap: 1.25rem;
      align-items: start;
      padding: 0.75rem 1rem;
      border: 1px solid var(--border-color);
      border-radius: 6px;
      background: var(--bg-color);
    }
    @media (max-width: 540px) {
      .wrap {
        grid-template-columns: 1fr;
      }
    }
    ul {
      list-style: none;
      padding: 0;
      margin: 0;
    }
    ul ul {
      padding-left: 1.5rem;
    }
    li {
      padding: 0.15rem 0;
    }
    .row {
      display: flex;
      align-items: center;
      gap: 0.55rem;
      font-size: 0.95rem;
    }
    .row.folder > .label {
      font-weight: 600;
    }
    .row.leaf > .label {
      font-weight: 400;
    }
    input[type="checkbox"] {
      width: 16px;
      height: 16px;
      cursor: pointer;
      accent-color: var(--ink-fill, #5b8def);
      margin: 0;
    }
    .label {
      cursor: pointer;
      user-select: none;
      transition: opacity 0.15s ease;
    }
    .row.leaf:has(input[type="checkbox"]:checked) > .label {
      text-decoration: line-through;
      opacity: 0.55;
    }
    .stats {
      align-self: stretch;
      display: flex;
      flex-direction: column;
      gap: 0.5rem;
      padding: 0.6rem 0.75rem;
      background: var(--code-bg);
      border-radius: 4px;
      font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
      font-size: 0.8rem;
      color: var(--text-secondary);
      min-width: 130px;
    }
    .stats .progress {
      height: 6px;
      background: var(--border-color);
      border-radius: 3px;
      overflow: hidden;
    }
    .stats .bar {
      height: 100%;
      background: var(--ink-fill, #5b8def);
      transition: width 0.15s ease;
    }
    .hint {
      font-size: 0.8rem;
      color: var(--text-secondary);
      margin: 0.4rem 0 0.6rem;
    }
  `;

  #disposers: Array<() => void> = [];

  /** Run `fn` as an effect tied to this element's lifetime. */
  #bind(fn: () => void): void {
    this.#disposers.push(effect(fn));
  }

  disconnectedCallback(): void {
    for (const d of this.#disposers) d();
    this.#disposers.length = 0;
  }

  protected render(): void {
    this.disconnectedCallback();
    this.shadow.replaceChildren();

    const tree = node("Tasks", [
      node("Work", [
        node("Write quarterly report"),
        node("Review pull request", [], true),
        node("Reply to client email"),
      ]),
      node("Personal", [node("Buy groceries"), node("Call mom", [], true), node("Do laundry")]),
      node("Reading", [
        node("Finish chapter 4", [], true),
        node("Take notes on chapter 5", [], true),
      ]),
    ]);

    const leaves = leavesOf(tree);
    const checkedCount = Num.derive(() => leaves.filter(l => l.checked.value === true).length);

    const hint = document.createElement("p");
    hint.className = "hint";
    hint.textContent =
      "Click any checkbox. Folders are Tri.allOf(children) — clicking cascades; partial states show indeterminate.";
    this.shadow.append(hint);

    const wrap = document.createElement("div");
    wrap.className = "wrap";
    const ul = document.createElement("ul");
    ul.append(this.#renderNode(tree));
    wrap.append(ul, this.#renderStats(checkedCount, leaves.length));
    this.shadow.append(wrap);
  }

  #renderNode(node: Node): HTMLLIElement {
    const kind = node.children.length ? "folder" : "leaf";
    const li = document.createElement("li");
    const row = document.createElement("div");
    row.className = `row ${kind}`;
    const cb = document.createElement("input");
    cb.type = "checkbox";
    const label = document.createElement("span");
    label.className = "label";
    label.textContent = node.label;
    row.append(cb, label);
    li.append(row);

    // One binding for both kinds: `mixed` drives `indeterminate` (a no-op
    // for leaves, which never go mixed on their own). Writes go out as a
    // plain boolean — for a folder that's a valid Tri value and triggers
    // the broadcast-down policy in its bwd.
    const cell = node.checked;
    this.#bind(() => {
      const v = cell.value;
      cb.checked = v === true;
      cb.indeterminate = v === "mixed";
    });
    cb.addEventListener("change", () => {
      cell.value = cb.checked;
    });
    label.addEventListener("click", () => {
      cell.value = cell.peek() === true ? false : true;
    });

    if (node.children.length) {
      const childUl = document.createElement("ul");
      for (const child of node.children) childUl.append(this.#renderNode(child));
      li.append(childUl);
    }
    return li;
  }

  #renderStats(checked: Num, total: number): HTMLElement {
    const wrap = document.createElement("div");
    wrap.className = "stats";

    const countLine = document.createElement("div");
    const remainingLine = document.createElement("div");
    const percentLine = document.createElement("div");
    const progress = document.createElement("div");
    progress.className = "progress";
    const bar = document.createElement("div");
    bar.className = "bar";
    progress.append(bar);

    this.#bind(() => {
      const c = checked.value;
      const pct = total > 0 ? (c / total) * 100 : 0;
      countLine.textContent = `${c} / ${total} checked`;
      remainingLine.textContent = `${total - c} remaining`;
      percentLine.textContent = `${pct.toFixed(0)}% complete`;
      bar.style.width = `${pct}%`;
    });

    wrap.append(countLine, remainingLine, progress, percentLine);
    return wrap;
  }
}
