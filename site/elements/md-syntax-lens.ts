// Four concrete syntaxes over one abstract value, each a stateful text
// lens whose complement is the concrete document (CST + error spans).
// Valid edits propagate through the hub; broken panes hold the hub and
// absorb external edits by surgical span edits AROUND their error
// regions — fix the syntax and the pane publishes again.

import { derive, effect } from "@bireactive";
import {
  ednFormat,
  type FormatAdapter,
  formatSpoke,
  type JsonValue,
  jsonFormat,
  lineColOf,
  tomlFormat,
  valueHub,
  yamlFormat,
} from "@bireactive/formats";
import { BaseElement, css } from "./base-element";

const INITIAL: JsonValue = {
  name: "starship",
  version: "2.4.1",
  active: true,
  retries: 3,
  tags: ["alpha", "fast"],
  server: { host: "example.com", port: 8080, secure: true },
};

/** Map a cursor offset through a text change via common prefix/suffix. */
function remapCursor(oldText: string, newText: string, offset: number): number {
  const max = Math.min(oldText.length, newText.length);
  let p = 0;
  while (p < max && oldText[p] === newText[p]) p++;
  if (offset <= p) return offset;
  let s = 0;
  while (s < max - p && oldText[oldText.length - 1 - s] === newText[newText.length - 1 - s]) s++;
  if (offset >= oldText.length - s) return offset + (newText.length - oldText.length);
  return Math.min(newText.length - s, Math.max(p, offset));
}

export class MdSyntaxLens extends BaseElement {
  static styles = css`
    :host {
      display: block;
      margin: 1.5rem 0;
      width: 100%;
      max-width: 760px;
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
    @media (max-width: 640px) {
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
      transition: border-color 0.15s ease;
    }
    .pane[data-broken] {
      border-color: #d4524e;
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
      font-size: 0.8rem;
      line-height: 1.45;
      padding: 0.4rem 0.55rem;
      background: var(--code-bg);
      color: var(--code-text);
      border: 1px solid var(--border-color);
      border-radius: 4px;
      resize: vertical;
      min-height: 13.5rem;
      white-space: pre;
      overflow: auto;
      tab-size: 2;
    }
    textarea:focus {
      outline: none;
      border-color: var(--text-color);
    }
    .pane[data-broken] textarea:focus {
      border-color: #d4524e;
    }
    .status {
      font-size: 0.72rem;
      font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
      color: var(--text-secondary);
      min-height: 1em;
      white-space: nowrap;
      overflow: hidden;
      text-overflow: ellipsis;
    }
    .pane[data-broken] .status {
      color: #d4524e;
    }
    .hintrow {
      display: flex;
      justify-content: space-between;
      align-items: baseline;
      gap: 1rem;
      margin: 0 0 0.6rem;
    }
    .hint {
      font-size: 0.8rem;
      color: var(--text-secondary);
      margin: 0;
      line-height: 1.4;
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

    const hub = valueHub(structuredClone(INITIAL));
    const panes: Array<{ adapter: FormatAdapter; badge: string }> = [
      { adapter: jsonFormat, badge: "comma-separated" },
      { adapter: yamlFormat, badge: "indentation · comments" },
      { adapter: tomlFormat, badge: "sections · comments" },
      { adapter: ednFormat, badge: "keywords · whitespace" },
    ];

    const hintrow = document.createElement("div");
    hintrow.className = "hintrow";
    const hint = document.createElement("p");
    hint.className = "hint";
    hint.textContent =
      "One value, four syntaxes — edit any pane. Break one (delete a quote, a comma) and it holds: " +
      "the others keep syncing, and their edits are written around the broken span. Fix it and it publishes.";
    const reset = document.createElement("button");
    reset.textContent = "reset";
    reset.addEventListener("click", () => this.render());
    hintrow.append(hint, reset);
    this.shadow.append(hintrow);

    const grid = document.createElement("div");
    grid.className = "grid";

    for (const p of panes) {
      const spoke = formatSpoke(hub, p.adapter);
      void spoke.value; // realize the complement before interaction

      const wrap = document.createElement("div");
      wrap.className = "pane";

      const header = document.createElement("header");
      const h = document.createElement("h3");
      h.textContent = p.adapter.name;
      const badge = document.createElement("span");
      badge.className = "badge";
      badge.textContent = p.badge;
      header.append(h, badge);

      const ta = document.createElement("textarea");
      ta.spellcheck = false;
      ta.autocapitalize = "off";
      ta.autocomplete = "off";
      ta.value = spoke.value;
      ta.addEventListener("input", () => {
        spoke.value = ta.value;
      });

      const status = document.createElement("div");
      status.className = "status";

      wrap.append(header, ta, status);
      grid.append(wrap);

      // Spoke → textarea. The focused pane updates too (that's the
      // write-around demo); the cursor is remapped through the change.
      this.#disposers.push(
        effect(() => {
          const v = spoke.value;
          if (ta.value === v) return;
          if (this.shadow.activeElement === ta) {
            const old = ta.value;
            const selS = ta.selectionStart;
            const selE = ta.selectionEnd;
            ta.value = v;
            ta.selectionStart = remapCursor(old, v, selS);
            ta.selectionEnd = remapCursor(old, v, selE);
          } else {
            ta.value = v;
          }
        }),
      );

      // Parse status: error count + first location, or synced.
      const errs = derive(() => p.adapter.parse(spoke.value).errors);
      this.#disposers.push(
        effect(() => {
          const es = errs.value;
          if (es.length === 0) {
            delete wrap.dataset.broken;
            status.textContent = "✓ synced";
          } else {
            wrap.dataset.broken = "true";
            const first = es[0]!;
            const { line } = lineColOf(spoke.value, first.start);
            const n = es.length;
            status.textContent = `✗ ${n} error${n === 1 ? "" : "s"} · holding — L${line}: ${first.message}`;
          }
        }),
      );
    }

    this.shadow.append(grid);
  }
}
