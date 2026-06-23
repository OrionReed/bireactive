// The parser and the ambiguity oracle, made visible.
//
// `Reg` is a *total function* from strings to values, which is only sound if
// the grammar is unambiguous. v3 buys that two ways, both on display here:
//
//   • Parsing. The grammar compiles to a tagged Thompson program run as a
//     PikeVM, so it accepts the full *unambiguous* regular class in linear
//     time — common-prefix alternations (`PUT | PATCH | POST`), longest-match
//     splits, fixed-width fields with no delimiters. Pick a grammar, edit the
//     input, and watch the coloured spans (the `get` direction drawn on the
//     string) and the parsed value re-derive. Break the shape and it greys out.
//
//   • Rejection. A genuinely ambiguous grammar can't be a function, so it's
//     refused at *construction* — with a concrete witness string that would
//     parse two ways. The lower panel builds four tempting-but-ambiguous
//     grammars and shows the exact input each one chokes on.

import { effect, Reg, str } from "@bireactive";
import { BaseElement, css } from "./base-element";

type Span = readonly [start: number, end: number];

// biome-ignore lint/suspicious/noExplicitAny: heterogeneous grammar list
type AnyReg = Reg<any, any, any, any>;

interface Example {
  key: string;
  label: string;
  code: string;
  grammar: AnyReg;
  sample: string;
}

const EXAMPLES: Example[] = [
  {
    key: "method",
    label: "HTTP request line (common-prefix alternation)",
    code: 'alt(copy(/GET/), copy(/POST/), copy(/PUT/), copy(/PATCH/), copy(/DELETE/)).as("method")\n  .then(lit(" "), copy(/[^ ]+/).as("path"))',
    grammar: Reg.alt(
      Reg.copy(/GET/).as("method"),
      Reg.copy(/POST/).as("method"),
      Reg.copy(/PUT/).as("method"),
      Reg.copy(/PATCH/).as("method"),
      Reg.copy(/DELETE/).as("method"),
    ).then(Reg.lit(" "), Reg.copy(/[^ ]+/).as("path")),
    sample: "PATCH /users/42",
  },
  {
    key: "semver",
    label: "Semantic version (optional, longest-match tail)",
    code: 'int().as("major").then(lit("."), int().as("minor"), lit("."), int().as("patch"))\n  .then(lit("-").then(copy(/[0-9A-Za-z.]+/).as("pre")).optional())\n  .then(lit("+").then(copy(/[0-9A-Za-z.]+/).as("build")).optional())',
    grammar: Reg.int()
      .as("major")
      .then(Reg.lit("."), Reg.int().as("minor"), Reg.lit("."), Reg.int().as("patch"))
      .then(
        Reg.lit("-")
          .then(Reg.copy(/[0-9A-Za-z.]+/).as("pre"))
          .optional(),
      )
      .then(
        Reg.lit("+")
          .then(Reg.copy(/[0-9A-Za-z.]+/).as("build"))
          .optional(),
      ),
    sample: "1.2.3-beta.1+build5",
  },
  {
    key: "date",
    label: "Compact date (fixed-width fields, no delimiters)",
    code: 'copy(/\\d{4}/).as("y").then(copy(/\\d\\d/).as("mo"), copy(/\\d\\d/).as("d"))',
    grammar: Reg.copy(/\d{4}/).as("y").then(Reg.copy(/\d\d/).as("mo"), Reg.copy(/\d\d/).as("d")),
    sample: "20260623",
  },
];

// Grammars that *cannot* be functions — each throws at construction, naming a
// concrete doubly-parsing witness. Built once; we display the messages.
const REJECTED: Array<{ label: string; code: string; build: () => unknown }> = [
  {
    label: "two variable-width numbers in a row",
    code: "digits().then(copy(/\\d+/))",
    build: () => Reg.digits().then(Reg.copy(/\d+/)),
  },
  {
    label: "an unseparated star over a multi-char token",
    code: "copy(/a+/).star()",
    build: () => Reg.copy(/a+/).star(),
  },
  {
    label: "a keyword whose language is a subset of the next",
    code: "alt(copy(/for/), copy(/[a-z]+/))",
    build: () => Reg.alt(Reg.copy(/for/), Reg.copy(/[a-z]+/)),
  },
  {
    label: "a nullable field before another field",
    code: "copy(/\\d*/).then(digits())",
    build: () => Reg.copy(/\d*/).then(Reg.digits()),
  },
];

const TINTS = [
  "rgba(56, 139, 253, 0.24)",
  "rgba(63, 185, 80, 0.24)",
  "rgba(219, 109, 40, 0.3)",
  "rgba(163, 113, 247, 0.28)",
  "rgba(219, 90, 120, 0.26)",
];

export class MdRegPlayground extends BaseElement {
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
    select,
    .input {
      width: 100%;
      box-sizing: border-box;
      font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
      font-size: 0.85rem;
      padding: 0.4rem 0.55rem;
      background: var(--code-bg);
      color: var(--code-text);
      border: 1px solid var(--border-color);
      border-radius: 4px;
    }
    select {
      margin-bottom: 0.5rem;
      font-family: inherit;
    }
    select:focus,
    .input:focus {
      outline: none;
      border-color: var(--text-color);
    }
    .code {
      font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
      font-size: 0.78rem;
      color: var(--text-secondary);
      white-space: pre-wrap;
      margin: 0 0 0.5rem;
      line-height: 1.5;
    }
    .strip {
      font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
      font-size: 0.95rem;
      line-height: 1.8;
      padding: 0.5rem 0.6rem;
      background: var(--code-bg);
      border: 1px solid var(--border-color);
      border-radius: 4px;
      white-space: pre-wrap;
      word-break: break-word;
      margin: 0.5rem 0;
      min-height: 1.6rem;
    }
    .strip.broken {
      opacity: 0.55;
    }
    .tok {
      border-radius: 3px;
      padding: 0.05rem 0.1rem;
    }
    .legend {
      display: flex;
      flex-wrap: wrap;
      gap: 0.5rem 0.9rem;
      font-size: 0.75rem;
      color: var(--text-secondary);
      margin-bottom: 0.4rem;
    }
    .legend span {
      display: inline-flex;
      align-items: center;
      gap: 0.3rem;
    }
    .swatch {
      width: 0.7rem;
      height: 0.7rem;
      border-radius: 2px;
      display: inline-block;
    }
    .value {
      font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
      font-size: 0.82rem;
      white-space: pre-wrap;
      word-break: break-word;
      padding: 0.5rem 0.6rem;
      background: var(--code-bg);
      border: 1px solid var(--border-color);
      border-radius: 4px;
      margin: 0;
    }
    .row {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 0.5rem;
      margin: 0.55rem 0 0.2rem;
    }
    .row .label {
      font-size: 0.7rem;
      text-transform: uppercase;
      letter-spacing: 0.04em;
      color: var(--text-secondary);
    }
    .badge {
      font-size: 0.72rem;
      padding: 0.1rem 0.45rem;
      border-radius: 999px;
      border: 1px solid var(--border-color);
    }
    .badge.ok {
      color: rgb(63, 185, 80);
      border-color: rgba(63, 185, 80, 0.6);
    }
    .badge.no {
      color: rgb(219, 90, 120);
      border-color: rgba(219, 90, 120, 0.6);
    }
    .divider {
      margin: 1.2rem 0 0.6rem;
      font-size: 0.7rem;
      text-transform: uppercase;
      letter-spacing: 0.05em;
      color: var(--text-secondary);
      border-top: 1px solid var(--border-color);
      padding-top: 0.7rem;
    }
    .rejected {
      display: grid;
      gap: 0.5rem;
    }
    .card {
      border: 1px solid var(--border-color);
      border-left: 3px solid rgba(219, 90, 120, 0.7);
      border-radius: 4px;
      padding: 0.45rem 0.6rem;
      background: var(--code-bg);
    }
    .card .gl {
      font-size: 0.74rem;
      color: var(--text-secondary);
      margin-bottom: 0.2rem;
    }
    .card .gc {
      font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
      font-size: 0.82rem;
      margin-bottom: 0.25rem;
    }
    .card .gm {
      font-size: 0.78rem;
      color: rgb(219, 90, 120);
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

    const input = str(EXAMPLES[0]!.sample);
    const choice = str(EXAMPLES[0]!.key);

    const hint = document.createElement("p");
    hint.className = "hint";
    hint.textContent =
      "Pick a grammar and edit the input. The coloured strip is the parse drawn onto the string; the value below is what Reg returns. All three pick a grammar a single-pass parser can't handle — a common-prefix alternation, an optional longest-match tail, fixed-width fields with no delimiters — yet each parses in linear time.";
    this.shadow.append(hint);

    const sel = document.createElement("select");
    for (const ex of EXAMPLES) {
      const opt = document.createElement("option");
      opt.value = ex.key;
      opt.textContent = ex.label;
      sel.append(opt);
    }
    this.shadow.append(sel);

    const code = document.createElement("p");
    code.className = "code";
    this.shadow.append(code);

    const legend = document.createElement("div");
    legend.className = "legend";
    this.shadow.append(legend);

    const strip = document.createElement("div");
    strip.className = "strip";
    this.shadow.append(strip);

    const inputEl = document.createElement("input");
    inputEl.type = "text";
    inputEl.className = "input";
    inputEl.spellcheck = false;
    inputEl.autocomplete = "off";
    inputEl.value = input.value;
    inputEl.addEventListener("input", () => {
      input.value = inputEl.value;
    });
    this.shadow.append(inputEl);

    const row = document.createElement("div");
    row.className = "row";
    const valLabel = document.createElement("span");
    valLabel.className = "label";
    valLabel.textContent = "parsed value";
    const badge = document.createElement("span");
    badge.className = "badge";
    row.append(valLabel, badge);
    this.shadow.append(row);

    const value = document.createElement("pre");
    value.className = "value";
    this.shadow.append(value);

    const current = (): Example => EXAMPLES.find(e => e.key === choice.value) ?? EXAMPLES[0]!;

    sel.addEventListener("change", () => {
      choice.value = sel.value;
      const ex = current();
      input.value = ex.sample;
      inputEl.value = ex.sample;
    });

    this.#disposers.push(
      effect(() => {
        const ex = current();
        code.textContent = ex.code;
      }),
      effect(() => {
        const ex = current();
        const s = input.value;
        const spans = ex.grammar.spans(s);
        this.#paintStrip(strip, legend, s, spans);
        const matched = ex.grammar.test(s);
        const v = ex.grammar.match(s);
        const round = matched ? ex.grammar.print(v) === s : false;
        badge.className = matched ? "badge ok" : "badge no";
        badge.textContent = matched ? (round ? "matches · round-trips" : "matches") : "no match";
        value.textContent = matched ? JSON.stringify(v, null, 2) : "—";
      }),
    );

    // ── the ambiguity oracle, made visible ──────────────────────────
    const divider = document.createElement("div");
    divider.className = "divider";
    divider.textContent =
      "rejected at construction — each names a witness that would parse two ways";
    this.shadow.append(divider);

    const rejected = document.createElement("div");
    rejected.className = "rejected";
    this.shadow.append(rejected);

    for (const r of REJECTED) {
      let message = "(unexpectedly constructed)";
      try {
        r.build();
      } catch (e) {
        message = (e as Error).message;
      }
      const card = document.createElement("div");
      card.className = "card";
      const gl = document.createElement("div");
      gl.className = "gl";
      gl.textContent = r.label;
      const gc = document.createElement("div");
      gc.className = "gc";
      gc.textContent = r.code;
      const gm = document.createElement("div");
      gm.className = "gm";
      gm.textContent = message;
      card.append(gl, gc, gm);
      rejected.append(card);
    }
  }

  /** Draw the coloured span decomposition + a legend keyed by capture name. */
  #paintStrip(
    strip: HTMLDivElement,
    legend: HTMLDivElement,
    s: string,
    spans: Record<string, Span>,
  ): void {
    strip.replaceChildren();
    legend.replaceChildren();
    const ordered = Object.entries(spans).sort((a, b) => a[1][0] - b[1][0]);
    if (ordered.length === 0) {
      strip.classList.add("broken");
      strip.textContent = s === "" ? "(empty)" : s;
      return;
    }
    strip.classList.remove("broken");
    const tintOf = new Map<string, string>();
    let ti = 0;
    let at = 0;
    for (const [name, [a, b]] of ordered) {
      if (!tintOf.has(name)) tintOf.set(name, TINTS[ti++ % TINTS.length]!);
      if (a > at) strip.append(document.createTextNode(s.slice(at, a)));
      const tok = document.createElement("span");
      tok.className = "tok";
      tok.style.background = tintOf.get(name)!;
      tok.textContent = s.slice(a, b) || "·";
      strip.append(tok);
      at = b;
    }
    if (at < s.length) strip.append(document.createTextNode(s.slice(at)));
    for (const [name, tint] of tintOf) {
      const item = document.createElement("span");
      const sw = document.createElement("span");
      sw.className = "swatch";
      sw.style.background = tint;
      item.append(sw, document.createTextNode(name));
      legend.append(item);
    }
  }
}
