// One value, three syntaxes — kept in sync by composed lenses.
//
// A single backing string holds a list of key/value pairs. Three one-line `Reg`
// grammars describe three *encodings* of the same list — a URL query
// (`a=1&b=2`), key/value lines (`a: 1`…), and a compact form (`a,1;b,2`). Each
// grammar is exposed as `reg.optic(): Optic<string, Pairs>`, so a pane is just
// the source composed *through* the canonical grammar and *back out through*
// another's print: `source.lens(canonical, format(other))`. Edit any pane
// and the shared value updates; the other panes re-derive. The separators are
// normalised at the grammar boundary, so each format renders with its own.
//
// This is the "compose with the rest of the lens algebra" payoff: `Reg` drops
// straight into `cell.lens(...)` alongside `iso` / `atKey`.

import { effect, type Optic, optic, Reg, str } from "@bireactive";
import { BaseElement, css } from "./base-element";

type Pairs = unknown;
// A value-erased grammar type: all three encodings share one `[k, v]`-item
// value shape, so this is the common currency the panes compose over.
// biome-ignore lint/suspicious/noExplicitAny: erase the phantom boundary params
type G = Reg<Pairs, any, any, any>;

const INITIAL = "host=localhost&port=8080&tls=on";

// key=value pairs, one record per grammar; all three yield the same `[k, v]`
// item shape, so a value parsed by one prints through another.
const query = Reg.word().then(Reg.lit("="), Reg.until("&")).star(Reg.lit("&")) as unknown as G;
const lines = Reg.word().then(Reg.lit(": "), Reg.until("\n")).star(Reg.lit("\n")) as unknown as G;
const compact = Reg.word().then(Reg.lit(","), Reg.until(";")).star(Reg.lit(";")) as unknown as G;

/** Drop the stored star separators so a value parsed by one grammar reprints
 *  with the target grammar's own joiner instead of the source's. */
function stripSeps(v: Pairs): Pairs {
  if (Array.isArray(v)) return v.map(stripSeps);
  if (v !== null && typeof v === "object" && "items" in v) {
    const sv = v as { items: readonly Pairs[] };
    return { items: sv.items.map(stripSeps), seps: [] };
  }
  return v;
}

/** A format as an optic from the canonical (seps-free) value to its string. */
function format(r: G): Optic<Pairs, string> {
  return optic<Pairs, string>(
    v => r.print(stripSeps(v)),
    (t: string, v: Pairs) => stripSeps((r.match(t) ?? v) as Pairs),
  );
}

interface Pane {
  label: string;
  rows: number;
  lens: { value: string };
}

export class MdRegFormats extends BaseElement {
  static styles = css`
    :host {
      display: block;
      margin: 1.5rem auto;
      width: 100%;
      max-width: 720px;
      color: var(--text-color);
      font-family: inherit;
    }
    .hint {
      font-size: 0.8rem;
      color: var(--text-secondary);
      margin: 0 0 0.6rem;
      line-height: 1.4;
    }
    .panes {
      display: grid;
      grid-template-columns: repeat(3, minmax(0, 1fr));
      gap: 0.6rem;
    }
    @media (max-width: 560px) {
      .panes {
        grid-template-columns: 1fr;
      }
    }
    .pane {
      display: flex;
      flex-direction: column;
      gap: 0.25rem;
    }
    .pane label {
      font-size: 0.7rem;
      text-transform: uppercase;
      letter-spacing: 0.04em;
      color: var(--text-secondary);
    }
    textarea {
      width: 100%;
      box-sizing: border-box;
      font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
      font-size: 0.85rem;
      padding: 0.4rem 0.55rem;
      background: var(--code-bg);
      color: var(--code-text);
      border: 1px solid var(--border-color);
      border-radius: 4px;
      resize: vertical;
      min-height: 5.5rem;
      white-space: pre;
      overflow-wrap: normal;
    }
    textarea:focus {
      outline: none;
      border-color: var(--text-color);
    }
    textarea.broken {
      border-color: rgba(219, 90, 120, 0.8);
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
    const canonical = query.optic();

    const panes: Pane[] = [
      { label: "url query", rows: 4, lens: source },
      { label: "key: value lines", rows: 4, lens: source.lens(canonical, format(lines)) },
      { label: "compact", rows: 4, lens: source.lens(canonical, format(compact)) },
    ];

    const hint = document.createElement("p");
    hint.className = "hint";
    hint.textContent =
      "One backing string, three encodings of the same key/value list. Each pane is source.lens(canonical, format(other)) — the grammar composed as an Optic. Edit any pane; the shared value updates and the others re-derive. Type something off-grammar and that pane just stops writing.";
    this.shadow.append(hint);

    const panesEl = document.createElement("div");
    panesEl.className = "panes";
    this.shadow.append(panesEl);

    for (const pane of panes) {
      const wrap = document.createElement("div");
      wrap.className = "pane";
      const label = document.createElement("label");
      label.textContent = pane.label;
      const ta = document.createElement("textarea");
      ta.spellcheck = false;
      ta.autocomplete = "off";
      ta.rows = pane.rows;
      ta.value = pane.lens.value;
      ta.addEventListener("input", () => {
        pane.lens.value = ta.value;
        // If the write was rejected (off-grammar), the lens value won't match
        // what was typed; flag it.
        ta.classList.toggle("broken", pane.lens.value !== ta.value);
      });
      wrap.append(label, ta);
      panesEl.append(wrap);

      this.#disposers.push(
        effect(() => {
          const v = pane.lens.value;
          if (this.shadow.activeElement !== ta && ta.value !== v) {
            ta.value = v;
            ta.classList.remove("broken");
          }
        }),
      );
    }
  }
}
