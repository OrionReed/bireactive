// Case-preserving find/replace — the canonical Boomerang result, built from
// two one-line lenses that *compose*.
//
// `Reg.letters().star(lit(", "))` splits the source into an editable `Arr` of
// word cells; each word cell is itself a `Writable<Str>` lens into the source.
// Composing one with `caseFold` gives a lowercased view whose write-back
// restores that word's *original* case pattern (UPPER / lower / Title). So a
// rename — set every cell whose folded form matches the search term to the
// replacement — preserves the case of each occurrence for free: "Color" →
// "Colour", "COLOR" → "COLOUR", "color" → "colour". The grammar finds the
// tokens; `caseFold` carries the case; neither knows about the other.

import { type Arr, type Cell, caseFold, effect, Reg, str } from "@bireactive";
import { BaseElement, css } from "./base-element";

const INITIAL = "Color, COLOR, color, Magenta, MAGENTA, Crimson";

const grammar = Reg.letters().star(Reg.lit(", ")).as("words");

export class MdRegRename extends BaseElement {
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
    .chips {
      display: flex;
      flex-wrap: wrap;
      gap: 0.4rem;
      padding: 0.55rem 0.6rem;
      background: var(--code-bg);
      border: 1px solid var(--border-color);
      border-radius: 4px;
      min-height: 1.4rem;
    }
    .chips.broken {
      opacity: 0.5;
    }
    .chip {
      font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
      font-size: 0.85rem;
      padding: 0.1rem 0.45rem;
      border-radius: 3px;
      background: rgba(163, 113, 247, 0.22);
      transition: background 0.12s ease;
    }
    .chip.hit {
      background: rgba(63, 185, 80, 0.32);
      box-shadow: 0 0 0 1px rgba(63, 185, 80, 0.6);
    }
    .controls {
      display: flex;
      flex-wrap: wrap;
      gap: 0.5rem;
      align-items: flex-end;
      margin-top: 0.75rem;
    }
    .field {
      display: flex;
      flex-direction: column;
      gap: 0.2rem;
      flex: 1 1 8rem;
    }
    .field label {
      font-size: 0.7rem;
      text-transform: uppercase;
      letter-spacing: 0.04em;
      color: var(--text-secondary);
    }
    input {
      font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
      font-size: 0.85rem;
      padding: 0.3rem 0.45rem;
      background: var(--code-bg);
      color: var(--code-text);
      border: 1px solid var(--border-color);
      border-radius: 4px;
    }
    input:focus,
    button:focus {
      outline: none;
      border-color: var(--text-color);
    }
    button {
      font-family: inherit;
      font-size: 0.85rem;
      padding: 0.35rem 0.8rem;
      background: var(--text-color);
      color: var(--bg-color);
      border: 1px solid var(--text-color);
      border-radius: 4px;
      cursor: pointer;
    }
    .raw {
      width: 100%;
      box-sizing: border-box;
      font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
      font-size: 0.85rem;
      padding: 0.4rem 0.55rem;
      margin-top: 0.75rem;
      background: var(--code-bg);
      color: var(--code-text);
      border: 1px solid var(--border-color);
      border-radius: 4px;
      resize: vertical;
      min-height: 2.2rem;
      white-space: pre-wrap;
    }
    .raw:focus {
      outline: none;
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

    const source = str(INITIAL);
    const term = str("color");
    const arr = grammar.bind(source).words as Arr<string>;

    const hint = document.createElement("p");
    hint.className = "hint";
    hint.textContent =
      "A comma-separated list, split by a one-line Reg grammar into editable word cells. Type a term and a replacement, then Replace: every matching word changes, preserving each one's own case (UPPER / lower / Title). The grammar finds the words; caseFold carries the case — composed, neither knows about the other.";
    this.shadow.append(hint);

    const chips = document.createElement("div");
    chips.className = "chips";
    this.shadow.append(chips);

    const controls = document.createElement("div");
    controls.className = "controls";
    this.shadow.append(controls);

    const mkField = (label: string, value: string): HTMLInputElement => {
      const wrap = document.createElement("div");
      wrap.className = "field";
      const l = document.createElement("label");
      l.textContent = label;
      const i = document.createElement("input");
      i.type = "text";
      i.spellcheck = false;
      i.value = value;
      wrap.append(l, i);
      controls.append(wrap);
      return i;
    };

    const findInput = mkField("find", "color");
    const replaceInput = mkField("replace with", "colour");
    findInput.addEventListener("input", () => {
      term.value = findInput.value;
    });

    const btn = document.createElement("button");
    btn.type = "button";
    btn.textContent = "Replace";
    controls.append(btn);

    btn.addEventListener("click", () => {
      const find = findInput.value.trim().toLowerCase();
      const to = replaceInput.value.trim().toLowerCase();
      if (find === "" || to === "") return;
      arr.values.value; // realize the element cells
      for (const cell of arr.cells) {
        const folded = caseFold(cell as unknown as Cell<string>);
        if (folded.value === find) folded.value = to;
      }
    });

    const raw = document.createElement("textarea");
    raw.className = "raw";
    raw.spellcheck = false;
    raw.autocomplete = "off";
    raw.rows = 2;
    raw.value = source.value;
    raw.addEventListener("input", () => {
      source.value = raw.value;
    });
    this.shadow.append(raw);

    this.#disposers.push(
      effect(() => {
        const v = source.value;
        if (this.shadow.activeElement !== raw && raw.value !== v) raw.value = v;
      }),
      effect(() => {
        const s = source.value;
        const v = grammar.match(s);
        const find = term.value.trim().toLowerCase();
        chips.replaceChildren();
        if (v === null) {
          chips.classList.add("broken");
          chips.textContent = "(doesn't match the list grammar)";
          return;
        }
        chips.classList.remove("broken");
        for (const word of v.items as string[]) {
          const chip = document.createElement("span");
          chip.className = "chip";
          if (find !== "" && word.toLowerCase() === find) chip.classList.add("hit");
          chip.textContent = word;
          chips.append(chip);
        }
      }),
    );
  }
}
