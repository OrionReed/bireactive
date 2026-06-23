// A structured line, edited by field — with the parse made visible.
//
// One grammar names every field of a log line (`date`, `time`, `level`, …).
// `bind` exposes each as a writable lens into the source; `spans` reports where
// each capture lives in the string. The coloured strip renders that
// decomposition live — it *is* the `get` direction drawn on the source — while
// the field controls drive the `put` direction. Edit a field (the level is an
// enum `<select>`), watch its characters change in place; edit the raw line and
// watch the fields and the colouring re-derive. Hover a control to spotlight its
// span. If you break the shape, parsing fails and the strip greys out — the
// lens simply stops writing, exactly like the error-tolerant panes elsewhere.

import { effect, Reg, str } from "@bireactive";
import { BaseElement, css } from "./base-element";

type Span = readonly [start: number, end: number];

const INITIAL = "2026-06-22 23:14:07 WARN auth.session: token refresh failed for user 8123";

const grammar = Reg.copy(/\d{4}-\d{2}-\d{2}/)
  .as("date")
  .then(Reg.lit(" "))
  .then(Reg.copy(/\d{2}:\d{2}:\d{2}/).as("time"))
  .then(Reg.lit(" "))
  .then(Reg.copy(/INFO|WARN|ERROR|DEBUG/).as("level"))
  .then(Reg.lit(" "))
  .then(Reg.copy(/[A-Za-z0-9_.-]+/).as("module"))
  .then(Reg.lit(": "))
  .then(Reg.copy(/.*/).as("message"));

interface Field {
  name: string;
  label: string;
  options?: string[];
}

const FIELDS: Field[] = [
  { name: "date", label: "date" },
  { name: "time", label: "time" },
  { name: "level", label: "level", options: ["DEBUG", "INFO", "WARN", "ERROR"] },
  { name: "module", label: "module" },
  { name: "message", label: "message" },
];

const TINT: Record<string, string> = {
  date: "rgba(56, 139, 253, 0.22)",
  time: "rgba(63, 185, 80, 0.22)",
  level: "rgba(219, 109, 40, 0.28)",
  module: "rgba(163, 113, 247, 0.26)",
  message: "rgba(219, 90, 120, 0.24)",
};

const w = (h: unknown) => h as { value: string };

export class MdRegLog extends BaseElement {
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
    .strip {
      font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
      font-size: 0.9rem;
      line-height: 1.7;
      padding: 0.5rem 0.6rem;
      background: var(--code-bg);
      border: 1px solid var(--border-color);
      border-radius: 4px;
      white-space: pre-wrap;
      word-break: break-word;
      margin-bottom: 0.75rem;
    }
    .strip.broken {
      color: var(--text-secondary);
      opacity: 0.6;
    }
    .tok {
      border-radius: 3px;
      padding: 0.05rem 0;
      transition: box-shadow 0.1s ease;
    }
    .tok.on {
      box-shadow: 0 0 0 2px var(--text-color);
    }
    .fields {
      display: grid;
      grid-template-columns: repeat(2, minmax(0, 1fr));
      gap: 0.5rem;
    }
    .field.wide {
      grid-column: 1 / -1;
    }
    @media (max-width: 520px) {
      .fields {
        grid-template-columns: 1fr;
      }
    }
    .field {
      display: flex;
      flex-direction: column;
      gap: 0.2rem;
    }
    .field label {
      font-size: 0.7rem;
      text-transform: uppercase;
      letter-spacing: 0.04em;
      color: var(--text-secondary);
    }
    .field input,
    .field select {
      font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
      font-size: 0.85rem;
      padding: 0.3rem 0.45rem;
      background: var(--code-bg);
      color: var(--code-text);
      border: 1px solid var(--border-color);
      border-radius: 4px;
    }
    .field input:focus,
    .field select:focus {
      outline: none;
      border-color: var(--text-color);
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
      min-height: 2.5rem;
      white-space: pre-wrap;
    }
    .raw:focus {
      outline: none;
      border-color: var(--text-color);
    }
  `;

  #disposers: Array<() => void> = [];
  #emph: string | null = null;
  #toks = new Map<string, HTMLSpanElement>();

  disconnectedCallback(): void {
    for (const d of this.#disposers) d();
    this.#disposers.length = 0;
  }

  protected render(): void {
    for (const d of this.#disposers) d();
    this.#disposers.length = 0;
    this.shadow.replaceChildren();
    this.#toks.clear();

    const source = str(INITIAL);
    const handles = grammar.bind(source) as Record<string, unknown>;

    const hint = document.createElement("p");
    hint.className = "hint";
    hint.textContent =
      "The coloured strip is the parse drawn onto the source string. Edit a field below — the level is an enum select — and its characters change in place; edit the raw line and the fields re-derive. Hover a control to spotlight its span. Break the shape and the strip greys out: the lens stops writing.";
    this.shadow.append(hint);

    const strip = document.createElement("div");
    strip.className = "strip";
    this.shadow.append(strip);

    const fields = document.createElement("div");
    fields.className = "fields";
    this.shadow.append(fields);

    for (const f of FIELDS) {
      const wrap = document.createElement("div");
      wrap.className = f.name === "message" ? "field wide" : "field";
      const label = document.createElement("label");
      label.textContent = f.label;
      wrap.append(label);

      const control = f.options
        ? this.#select(f.options)
        : (() => {
            const i = document.createElement("input");
            i.type = "text";
            i.spellcheck = false;
            return i;
          })();
      const handle = w(handles[f.name]);
      control.addEventListener("input", () => {
        handle.value = (control as HTMLInputElement | HTMLSelectElement).value;
      });
      control.addEventListener("focus", () => this.#spotlight(f.name));
      control.addEventListener("mouseenter", () => this.#spotlight(f.name));
      control.addEventListener("blur", () => this.#spotlight(null));
      control.addEventListener("mouseleave", () => this.#spotlight(null));
      wrap.append(control);
      fields.append(wrap);

      this.#disposers.push(
        effect(() => {
          const v = handle.value;
          if (this.shadow.activeElement === control) return;
          if ((control as HTMLInputElement | HTMLSelectElement).value !== v) {
            (control as HTMLInputElement | HTMLSelectElement).value = v;
          }
        }),
      );
    }

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
    );

    this.#disposers.push(
      effect(() => {
        const s = source.value;
        this.#paintStrip(strip, s, grammar.spans(s));
      }),
    );
  }

  #select(options: string[]): HTMLSelectElement {
    const sel = document.createElement("select");
    for (const o of options) {
      const opt = document.createElement("option");
      opt.value = o;
      opt.textContent = o;
      sel.append(opt);
    }
    return sel;
  }

  /** Rebuild the coloured decomposition: literal gaps plain, captures tinted. */
  #paintStrip(strip: HTMLDivElement, s: string, spans: Record<string, Span>): void {
    strip.replaceChildren();
    this.#toks.clear();
    const ordered = Object.entries(spans).sort((a, b) => a[1][0] - b[1][0]);
    if (ordered.length === 0) {
      strip.classList.add("broken");
      strip.textContent = s || "(empty)";
      return;
    }
    strip.classList.remove("broken");
    let at = 0;
    for (const [name, [a, b]] of ordered) {
      if (a > at) strip.append(document.createTextNode(s.slice(at, a)));
      const tok = document.createElement("span");
      tok.className = "tok";
      tok.dataset.field = name;
      tok.style.background = TINT[name] ?? "rgba(128,128,128,0.2)";
      tok.textContent = s.slice(a, b) || "·";
      strip.append(tok);
      this.#toks.set(name, tok);
      at = b;
    }
    if (at < s.length) strip.append(document.createTextNode(s.slice(at)));
    if (this.#emph) this.#applyEmph();
  }

  #spotlight(name: string | null): void {
    this.#emph = name;
    this.#applyEmph();
  }

  #applyEmph(): void {
    for (const [name, tok] of this.#toks) tok.classList.toggle("on", name === this.#emph);
  }
}
