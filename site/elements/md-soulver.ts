// A bidirectional, unit-aware calculator document — a "reactive napkin".
//
// Soulver/Numi let you write arithmetic in prose and read the result in a
// gutter. They are one-way: a line that references others is an *output* you
// can't touch. Here the whole document is a bireactive graph — leaf literals
// are `num` cells, every other line is a `derive` over them — so a result is
// not a dead end. Pick one leaf as the *unknown* (click its ◦), then drag or
// type any result that depends on it and the engine back-solves the unknown
// (a 1-D Newton solve, the `md-ik` pattern) and rewrites its source in place.
// Goal-Seek, but live, in a document, and dimension-checked: the unit algebra
// (reused from the units demo, plus a money dimension) rejects `length + mass`
// and propagates `km · ($/L)` etc., so a back-solve can never invent nonsense.

import { derive, effect, type Num, num, type Writable } from "@bireactive";
import { BaseElement, css } from "./base-element";
import {
  acre,
  byte,
  cm,
  cup,
  day,
  foot,
  gallon,
  gB,
  gram,
  hectare,
  hertz,
  hour,
  inch,
  joule,
  kB,
  kiB,
  km,
  kmh,
  knot,
  litre,
  m3,
  mB,
  meter,
  miB,
  mile,
  minute,
  mm,
  mphSpeed,
  mps,
  newton,
  nmi,
  ounce,
  pound,
  second,
  sqm,
  tonne,
  type Unit,
  watt,
  yard,
} from "./units";

// ─── Dimensions: 9 SI base dims (from units.ts) + 1 money dim ──────────────
const MONEY_I = 9;
const NDIM = 10;
type Dim = number[];
const DIMSYM = ["m", "kg", "s", "A", "K", "mol", "cd", "B", "rad", "$"];

const zeroDim = (): Dim => new Array(NDIM).fill(0);
const dimEq = (a: Dim, b: Dim): boolean => a.every((x, i) => x === b[i]);
const dimAdd = (a: Dim, b: Dim): Dim => a.map((x, i) => x + b[i]!);
const dimSub = (a: Dim, b: Dim): Dim => a.map((x, i) => x - b[i]!);
const dimZero = (d: Dim): boolean => d.every(x => x === 0);
const isMoney = (d: Dim): boolean =>
  d[MONEY_I] === 1 && d.every((x, i) => i === MONEY_I || x === 0);

const SUP: Record<string, string> = {
  "-": "⁻",
  "0": "⁰",
  "1": "¹",
  "2": "²",
  "3": "³",
  "4": "⁴",
  "5": "⁵",
  "6": "⁶",
  "7": "⁷",
  "8": "⁸",
  "9": "⁹",
};
const sup = (n: number): string =>
  String(n)
    .split("")
    .map(c => SUP[c] ?? c)
    .join("");
const fmtDimDesc = (d: Dim): string => {
  const parts = d
    .map((e, i) => (e === 0 ? "" : e === 1 ? DIMSYM[i]! : `${DIMSYM[i]}${sup(e)}`))
    .filter(Boolean);
  return parts.length ? parts.join("·") : "scalar";
};

// ─── A scalar unit: factor to base + dimension vector ──────────────────────
interface U {
  factor: number;
  dim: Dim;
}
const fromSI = (u: Unit): U => ({ factor: u.factor, dim: [...u.dim, 0] });
const moneyDim = (): Dim => {
  const d = zeroDim();
  d[MONEY_I] = 1;
  return d;
};
const MONEY: U = { factor: 1, dim: moneyDim() };

// Symbol → unit, for parsing. SI symbols come straight from the zoo; a handful
// of spelled-out aliases (day, hours, litre…) and the `$` money atom are added.
const UNITS: Record<string, U> = {};
for (const u of [
  meter,
  km,
  cm,
  mm,
  inch,
  foot,
  yard,
  mile,
  nmi,
  gram,
  tonne,
  pound,
  ounce,
  second,
  minute,
  hour,
  day,
  mps,
  kmh,
  mphSpeed,
  knot,
  sqm,
  hectare,
  acre,
  m3,
  litre,
  gallon,
  cup,
  newton,
  joule,
  watt,
  hertz,
  byte,
  kB,
  mB,
  gB,
  kiB,
  miB,
]) {
  if (u.symbol) UNITS[u.symbol] = fromSI(u);
}
const alias = (name: string, u: Unit): void => {
  UNITS[name] = fromSI(u);
};
alias("day", day);
alias("days", day);
alias("hr", hour);
alias("hrs", hour);
alias("hour", hour);
alias("hours", hour);
alias("min", minute);
alias("mins", minute);
alias("sec", second);
alias("secs", second);
alias("l", litre);
alias("litre", litre);
alias("liter", litre);
UNITS.$ = MONEY;

const isUnit = (w: string): boolean => Object.hasOwn(UNITS, w);

// Curated display units for derived results: pick the one that lands the
// magnitude in [1, 1000). Money / dimensionless are special-cased.
interface Disp {
  sym: string;
  factor: number;
  dim: Dim;
}
const DISPLAY: Disp[] = [
  km,
  meter,
  cm,
  mile, // length
  hour,
  minute,
  second, // time (day omitted: drive times read better in hours)
  litre,
  m3,
  gallon, // volume
  tonne,
  gram,
  pound, // mass (kg added below as base)
  kmh,
  mps,
  mphSpeed, // speed
  sqm,
  hectare, // area
  joule,
  watt,
  newton,
  hertz, // derived SI
  gB,
  mB,
  kB,
  byte, // data
].map(u => ({ sym: u.symbol, factor: u.factor, dim: [...u.dim, 0] }));
DISPLAY.push({ sym: "kg", factor: 1, dim: [0, 1, 0, 0, 0, 0, 0, 0, 0, 0] });

// ─── Quantities + formatting ───────────────────────────────────────────────
interface Qty {
  v: number; // value in base units
  dim: Dim;
}

const fmtPlain = (v: number): string => {
  if (!Number.isFinite(v)) return "—";
  const a = Math.abs(v);
  if (a !== 0 && a < 0.01) return v.toPrecision(2);
  return new Intl.NumberFormat("en-US", { maximumFractionDigits: 2 }).format(v);
};
// Higher-precision form for the *source* number rewritten by a solve, so the
// re-parsed value lands the target cleanly (chips still show the tidy 2-dp form).
const fmtSrc = (v: number): string => {
  if (!Number.isFinite(v)) return "0";
  return String(Number(v.toPrecision(6)));
};
const fmtMoney = (v: number): string => {
  if (!Number.isFinite(v)) return "—";
  const s = new Intl.NumberFormat("en-US", { maximumFractionDigits: 2 }).format(Math.abs(v));
  return (v < 0 ? "−$" : "$") + s;
};

type Kind = "money" | "time" | "length" | "speed" | "volume" | "mass" | "plain" | "raw";
interface ChipView {
  text: string;
  factor: number; // typed display number × factor = base value
  kind: Kind;
}
const kindOf = (dim: Dim): Kind => {
  if (dimEq(dim, [0, 0, 1, 0, 0, 0, 0, 0, 0, 0])) return "time";
  if (dimEq(dim, [1, 0, 0, 0, 0, 0, 0, 0, 0, 0])) return "length";
  if (dimEq(dim, [1, 0, -1, 0, 0, 0, 0, 0, 0, 0])) return "speed";
  if (dimEq(dim, [3, 0, 0, 0, 0, 0, 0, 0, 0, 0])) return "volume";
  if (dimEq(dim, [0, 1, 0, 0, 0, 0, 0, 0, 0, 0])) return "mass";
  return "raw";
};
const chipView = (q: Qty): ChipView => {
  if (dimZero(q.dim)) return { text: fmtPlain(q.v), factor: 1, kind: "plain" };
  if (isMoney(q.dim)) return { text: fmtMoney(q.v), factor: 1, kind: "money" };
  const cands = DISPLAY.filter(d => dimEq(d.dim, q.dim)).sort((a, b) => b.factor - a.factor);
  if (cands.length) {
    let pick = cands[cands.length - 1]!;
    for (const c of cands) {
      if (Math.abs(q.v / c.factor) >= 1) {
        pick = c;
        break;
      }
    }
    return {
      text: `${fmtPlain(q.v / pick.factor)} ${pick.sym}`,
      factor: pick.factor,
      kind: kindOf(q.dim),
    };
  }
  return { text: `${fmtPlain(q.v)} ${fmtDimDesc(q.dim)}`, factor: 1, kind: "raw" };
};

// ─── Expression AST + parser ───────────────────────────────────────────────
type Node =
  | { t: "num"; v: number; unit: U | null; node?: undefined }
  | { t: "unit"; u: U }
  | { t: "ref"; name: string }
  | { t: "neg"; a: Node }
  | { t: "bin"; op: "+" | "-" | "*" | "/"; a: Node; b: Node };

interface Tok {
  k: "num" | "word" | "op" | "lp" | "rp";
  s: string;
  v: number;
  money: boolean;
  start: number;
  end: number;
}

function lex(src: string): Tok[] {
  const out: Tok[] = [];
  const n = src.length;
  let i = 0;
  const digit = (c: string): boolean => c >= "0" && c <= "9";
  const push = (k: Tok["k"], s: string, start: number, end: number, v = 0, money = false): void => {
    out.push({ k, s, v, money, start, end });
  };
  while (i < n) {
    const c = src[i]!;
    if (c === " " || c === "\t") {
      i++;
      continue;
    }
    if (c === "(") {
      push("lp", "(", i, i + 1);
      i++;
      continue;
    }
    if (c === ")") {
      push("rp", ")", i, i + 1);
      i++;
      continue;
    }
    if ("+-−*·/".includes(c)) {
      const s = c === "−" ? "-" : c === "·" ? "*" : c;
      push("op", s, i, i + 1);
      i++;
      continue;
    }
    if (c === "$") {
      let j = i + 1;
      while (j < n && src[j] === " ") j++;
      let k = j;
      while (k < n && (digit(src[k]!) || src[k] === "," || src[k] === ".")) k++;
      if (k > j) {
        push(
          "num",
          src.slice(j, k),
          j,
          k,
          Number.parseFloat(src.slice(j, k).replace(/,/g, "")),
          true,
        );
        i = k;
        continue;
      }
      push("word", "$", i, i + 1);
      i++;
      continue;
    }
    if (digit(c) || (c === "." && digit(src[i + 1] ?? ""))) {
      let k = i;
      while (k < n && (digit(src[k]!) || src[k] === "," || src[k] === ".")) k++;
      push(
        "num",
        src.slice(i, k),
        i,
        k,
        Number.parseFloat(src.slice(i, k).replace(/,/g, "")),
        false,
      );
      i = k;
      continue;
    }
    if (/[A-Za-zµ°]/.test(c)) {
      let k = i;
      while (k < n && /[A-Za-z0-9_µ°²³]/.test(src[k]!)) k++;
      push("word", src.slice(i, k), i, k);
      i = k;
      continue;
    }
    i++; // skip anything else
  }
  return out;
}

const times = (a: U | null, b: U): U =>
  a ? { factor: a.factor * b.factor, dim: dimAdd(a.dim, b.dim) } : b;

/** Parse the RHS of a line into an AST. `names` lets multi-word references
 *  (e.g. `fuel price`) resolve by longest match; throws on syntax errors. */
function parse(toks: Tok[], names: Set<string>): Node {
  let i = 0;
  const peek = (): Tok | undefined => toks[i];
  const eat = (): Tok => toks[i++]!;

  const expr = (): Node => {
    let a = term();
    for (let t = peek(); t && t.k === "op" && (t.s === "+" || t.s === "-"); t = peek()) {
      eat();
      a = { t: "bin", op: t.s, a, b: term() };
    }
    return a;
  };
  const term = (): Node => {
    let a = factor();
    for (let t = peek(); t && t.k === "op" && (t.s === "*" || t.s === "/"); t = peek()) {
      eat();
      a = { t: "bin", op: t.s, a, b: factor() };
    }
    return a;
  };
  const factor = (): Node => {
    const t = peek();
    if (t && t.k === "op" && t.s === "-") {
      eat();
      return { t: "neg", a: factor() };
    }
    if (t && t.k === "op" && t.s === "+") {
      eat();
      return factor();
    }
    return primary();
  };
  const primary = (): Node => {
    const t = peek();
    if (!t) throw new Error("unexpected end of line");
    if (t.k === "lp") {
      eat();
      const e = expr();
      const r = peek();
      if (!r || r.k !== "rp") throw new Error("missing )");
      eat();
      return e;
    }
    if (t.k === "num") {
      eat();
      let unit: U | null = t.money ? MONEY : null;
      const nx = peek();
      if (nx && nx.k === "word" && !names.has(nx.s) && isUnit(nx.s)) {
        unit = times(unit, UNITS[nx.s]!);
        eat();
      }
      return { t: "num", v: t.v, unit };
    }
    if (t.k === "word") {
      // longest-match a defined name from consecutive word tokens
      const words: string[] = [];
      let j = i;
      while (toks[j] && toks[j]!.k === "word") {
        words.push(toks[j]!.s);
        j++;
      }
      for (let len = words.length; len >= 1; len--) {
        const nm = words.slice(0, len).join(" ");
        if (names.has(nm)) {
          i += len;
          return { t: "ref", name: nm };
        }
      }
      if (isUnit(t.s)) {
        eat();
        return { t: "unit", u: UNITS[t.s]! };
      }
      throw new Error(`unknown name "${t.s}"`);
    }
    throw new Error(`unexpected "${t.s}"`);
  };

  const e = expr();
  if (i < toks.length) throw new Error(`unexpected "${toks[i]!.s}"`);
  return e;
}

function evalNode(node: Node, env: Map<string, Qty | null>): Qty {
  switch (node.t) {
    case "num":
      return node.unit
        ? { v: node.v * node.unit.factor, dim: node.unit.dim }
        : { v: node.v, dim: zeroDim() };
    case "unit":
      return { v: node.u.factor, dim: node.u.dim };
    case "ref": {
      const q = env.get(node.name);
      if (q == null) throw new Error(`needs "${node.name}"`);
      return q;
    }
    case "neg": {
      const a = evalNode(node.a, env);
      return { v: -a.v, dim: a.dim };
    }
    case "bin": {
      const a = evalNode(node.a, env);
      const b = evalNode(node.b, env);
      if (node.op === "*") return { v: a.v * b.v, dim: dimAdd(a.dim, b.dim) };
      if (node.op === "/") return { v: a.v / b.v, dim: dimSub(a.dim, b.dim) };
      if (!dimEq(a.dim, b.dim)) {
        throw new Error(
          `can't ${node.op === "+" ? "add" : "subtract"} ${fmtDimDesc(a.dim)} and ${fmtDimDesc(b.dim)}`,
        );
      }
      return { v: node.op === "+" ? a.v + b.v : a.v - b.v, dim: a.dim };
    }
  }
}

const refsOf = (node: Node, out: Set<string> = new Set()): Set<string> => {
  if (node.t === "ref") out.add(node.name);
  else if (node.t === "neg") refsOf(node.a, out);
  else if (node.t === "bin") {
    refsOf(node.a, out);
    refsOf(node.b, out);
  }
  return out;
};

/** The single numeric literal in a leaf AST (for scrub / solve), or null. */
function soleNum(node: Node): Extract<Node, { t: "num" }> | null {
  const found: Extract<Node, { t: "num" }>[] = [];
  const walk = (n: Node): void => {
    if (n.t === "num") found.push(n);
    else if (n.t === "neg") walk(n.a);
    else if (n.t === "bin") {
      walk(n.a);
      walk(n.b);
    }
  };
  walk(node);
  return found.length === 1 ? found[0]! : null;
}

// ─── Parsed document ───────────────────────────────────────────────────────
interface ParsedLine {
  id: number;
  kind: "blank" | "comment" | "calc";
  name: string | null;
  ast: Node | null;
  rhsStart: number; // char offset of RHS within the full line
  error: string | null;
  isLeaf: boolean;
  solvable: boolean; // leaf with exactly one numeric literal
}
interface LeafInfo {
  cell: Writable<Num>;
  dim: Dim;
  K: number; // base value per unit of the literal number
  numStart: number; // span of the literal number within the full line text
  numEnd: number;
}
interface Built {
  lines: ParsedLine[];
  byId: Map<number, ParsedLine>;
  nameToId: Map<string, number>;
  order: number[]; // topo order of calc lines (cycles excluded)
  leaf: Map<number, LeafInfo>;
  deps: Map<number, Set<string>>; // line id → leaf names it (transitively) needs
  results: { value: Map<number, { ok: boolean; qty?: Qty; err?: string }> };
  dispose: () => void;
}

const splitAssign = (text: string): { name: string | null; rhs: string; rhsStart: number } => {
  const eq = text.indexOf("=");
  if (eq < 0) return { name: null, rhs: text, rhsStart: 0 };
  const lhs = text.slice(0, eq).trim();
  if (/^[A-Za-z][A-Za-z0-9 _]*$/.test(lhs)) {
    return { name: lhs, rhs: text.slice(eq + 1), rhsStart: eq + 1 };
  }
  return { name: null, rhs: text, rhsStart: 0 };
};

function evalAll(
  order: number[],
  byId: Map<number, ParsedLine>,
  leafBase: (id: number) => number,
): Map<number, { ok: boolean; qty?: Qty; err?: string }> {
  const env = new Map<string, Qty | null>();
  const out = new Map<number, { ok: boolean; qty?: Qty; err?: string }>();
  for (const id of order) {
    const pl = byId.get(id)!;
    try {
      const qty = pl.isLeaf
        ? { v: leafBase(id), dim: evalNode(pl.ast!, env).dim }
        : evalNode(pl.ast!, env);
      out.set(id, { ok: true, qty });
      if (pl.name) env.set(pl.name, qty);
    } catch (e) {
      out.set(id, { ok: false, err: (e as Error).message });
      if (pl.name) env.set(pl.name, null);
    }
  }
  return out;
}

// ─── The element ───────────────────────────────────────────────────────────
interface Row {
  id: number;
  el: HTMLElement;
  input: HTMLInputElement;
  badge: HTMLButtonElement;
  chip: HTMLElement;
}

const DOC = `# Road-trip budget — pick an unknown ◦, then drag a result
budget = $2,000
distance = 2,800 km
speed = 95 km/h
drive time = distance / speed
fuel = 165 L
fuel price = $1.75 / L
fuel cost = fuel * fuel price
trip length = 7 day
lodging rate = $95 / day
lodging = lodging rate * trip length
food rate = $55 / day
food = food rate * trip length
total = fuel cost + lodging + food
remaining = budget − total`;

export class MdSoulver extends BaseElement {
  static styles = css`
    :host {
      display: block;
      margin: 1.5rem auto;
      width: 100%;
      max-width: 640px;
      font-family: inherit;
      color: var(--text-color);
    }
    .hint {
      font-size: 0.8rem;
      color: var(--text-secondary);
      line-height: 1.5;
      margin: 0 0 0.8rem;
    }
    .sheet {
      border: 1px solid var(--border-color);
      border-radius: 8px;
      background: var(--bg-color);
      overflow: hidden;
    }
    .row {
      display: grid;
      grid-template-columns: 1.4rem minmax(0, 1fr) auto;
      align-items: center;
      gap: 0.5rem;
      padding: 0.05rem 0.6rem 0.05rem 0.4rem;
      border-bottom: 1px solid color-mix(in srgb, var(--border-color) 45%, transparent);
    }
    .row:last-child {
      border-bottom: none;
    }
    .row:hover {
      background: color-mix(in srgb, var(--text-color) 3%, transparent);
    }
    .badge {
      width: 1rem;
      height: 1rem;
      border-radius: 50%;
      border: 1.5px solid var(--text-secondary);
      background: transparent;
      padding: 0;
      cursor: pointer;
      opacity: 0;
      transition: opacity 0.12s, background 0.12s, border-color 0.12s;
      justify-self: center;
    }
    .row:hover .badge,
    .badge.on {
      opacity: 0.55;
    }
    .badge:hover {
      opacity: 0.9;
    }
    .badge.on {
      background: var(--accent, #5b8def);
      border-color: var(--accent, #5b8def);
      opacity: 1;
      box-shadow: 0 0 0 3px color-mix(in srgb, var(--accent, #5b8def) 22%, transparent);
    }
    .src {
      font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
      font-size: 0.86rem;
      line-height: 1.85;
      border: none;
      outline: none;
      background: transparent;
      color: var(--text-color);
      width: 100%;
      padding: 0.12rem 0;
      min-width: 0;
    }
    .row[data-kind="comment"] .src {
      color: var(--text-secondary);
      font-style: italic;
    }
    .chip {
      font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
      font-size: 0.84rem;
      font-weight: 600;
      white-space: nowrap;
      padding: 0.08rem 0.45rem;
      border-radius: 5px;
      color: var(--text-secondary);
      user-select: none;
      justify-self: end;
    }
    .chip[data-kind="money"] {
      color: #2f9e5f;
    }
    .chip[data-kind="time"] {
      color: #d98a2b;
    }
    .chip[data-kind="length"],
    .chip[data-kind="speed"] {
      color: #5b8def;
    }
    .chip.err {
      color: #e25c5c;
      font-weight: 500;
      font-style: italic;
    }
    .chip.solvable {
      cursor: ew-resize;
      background: color-mix(in srgb, var(--accent, #5b8def) 12%, transparent);
      box-shadow: inset 0 0 0 1px color-mix(in srgb, var(--accent, #5b8def) 35%, transparent);
    }
    .chip.solvable:hover {
      background: color-mix(in srgb, var(--accent, #5b8def) 20%, transparent);
    }
    .chip.empty {
      visibility: hidden;
    }
    .chip-edit {
      font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
      font-size: 0.84rem;
      font-weight: 600;
      width: 5.5rem;
      text-align: right;
      border: 1px solid var(--accent, #5b8def);
      border-radius: 5px;
      background: var(--bg-color);
      color: var(--text-color);
      outline: none;
      padding: 0.06rem 0.4rem;
    }
    .foot {
      font-size: 0.76rem;
      color: var(--text-secondary);
      margin: 0.7rem 0 0;
      line-height: 1.5;
    }
    .foot b {
      color: var(--text-color);
      font-weight: 600;
    }
  `;

  #rows: Row[] = [];
  #built: Built | null = null;
  #unknown: string | null = "trip length";
  #nextId = 0;
  #sheet!: HTMLElement;

  disconnectedCallback(): void {
    this.#built?.dispose();
    this.#built = null;
  }

  protected render(): void {
    this.#built?.dispose();
    this.#built = null;
    this.#rows = [];
    this.shadow.replaceChildren();

    const hint = document.createElement("p");
    hint.className = "hint";
    hint.innerHTML =
      "A calculator you can run <em>backwards</em>. Each line is a bireactive cell; literals are inputs, the rest derive. " +
      "Click a ◦ to mark a leaf as the <em>unknown</em>, then <b>drag</b> (or click to type) any highlighted result and the unknown solves to match.";
    this.shadow.append(hint);

    this.#sheet = document.createElement("div");
    this.#sheet.className = "sheet";
    this.shadow.append(this.#sheet);

    for (const text of DOC.split("\n")) this.#addRow(text);

    const foot = document.createElement("p");
    foot.className = "foot";
    foot.innerHTML =
      "Try: unknown = <b>trip length</b>, then drag <b>remaining</b> down to $0 — how long a trip the budget affords. " +
      "Or unknown = <b>fuel</b>, drag <b>fuel cost</b>. Units are checked: every back-solve stays dimensionally honest.";
    this.shadow.append(foot);

    this.#build();
  }

  #addRow(text: string, atIndex?: number): Row {
    const id = this.#nextId++;
    const el = document.createElement("div");
    el.className = "row";

    const badge = document.createElement("button");
    badge.className = "badge";
    badge.title = "solve for this";
    badge.addEventListener("pointerdown", e => e.stopPropagation());
    badge.addEventListener("click", () => {
      this.#unknown =
        this.#unknown === this.#built?.byId.get(id)?.name
          ? null
          : (this.#built?.byId.get(id)?.name ?? null);
      this.#renderResults();
    });

    const input = document.createElement("input");
    input.className = "src";
    input.type = "text";
    input.spellcheck = false;
    input.autocapitalize = "off";
    input.setAttribute("autocomplete", "off");
    input.value = text;
    input.addEventListener("input", () => this.#build());
    input.addEventListener("keydown", e => this.#onKey(e, id));

    const chip = document.createElement("div");
    chip.className = "chip empty";
    this.#wireChip(chip, id);

    el.append(badge, input, chip);
    const row: Row = { id, el, input, badge, chip };

    if (atIndex == null || atIndex >= this.#rows.length) {
      this.#sheet.append(el);
      this.#rows.push(row);
    } else {
      this.#sheet.insertBefore(el, this.#rows[atIndex]!.el);
      this.#rows.splice(atIndex, 0, row);
    }
    return row;
  }

  #onKey(e: KeyboardEvent, id: number): void {
    const idx = this.#rows.findIndex(r => r.id === id);
    if (e.key === "Enter") {
      e.preventDefault();
      const row = this.#addRow("", idx + 1);
      row.input.focus();
      this.#build();
    } else if (
      e.key === "Backspace" &&
      this.#rows[idx]!.input.value === "" &&
      this.#rows.length > 1
    ) {
      e.preventDefault();
      const row = this.#rows[idx]!;
      row.el.remove();
      this.#rows.splice(idx, 1);
      const prev = this.#rows[Math.max(0, idx - 1)]!;
      prev.input.focus();
      prev.input.setSelectionRange(prev.input.value.length, prev.input.value.length);
      this.#build();
    }
  }

  #rowById(id: number): Row | undefined {
    return this.#rows.find(r => r.id === id);
  }

  // ── Build the bireactive graph from current row text ──────────────────────
  #build(): void {
    const prev = this.#built;

    const lines: ParsedLine[] = [];
    const byId = new Map<number, ParsedLine>();
    const nameToId = new Map<string, number>();

    // Pass 1: names.
    const meta = this.#rows.map(r => {
      const raw = r.input.value;
      const trimmed = raw.trim();
      const blank = trimmed === "";
      const comment = trimmed.startsWith("#");
      const a = blank || comment ? { name: null, rhs: "", rhsStart: 0 } : splitAssign(raw);
      return { id: r.id, raw, blank, comment, ...a };
    });
    const names = new Set<string>();
    for (const m of meta) if (m.name) names.add(m.name);

    // Pass 2: parse + classify.
    const leaf = new Map<number, LeafInfo>();
    for (const m of meta) {
      if (m.blank || m.comment) {
        const pl: ParsedLine = {
          id: m.id,
          kind: m.blank ? "blank" : "comment",
          name: null,
          ast: null,
          rhsStart: 0,
          error: null,
          isLeaf: false,
          solvable: false,
        };
        lines.push(pl);
        byId.set(m.id, pl);
        continue;
      }
      let ast: Node | null = null;
      let error: string | null = null;
      try {
        ast = parse(lex(m.rhs), names);
      } catch (e) {
        error = (e as Error).message;
      }
      const refs = ast ? refsOf(ast) : new Set<string>();
      const isLeaf = ast != null && refs.size === 0;
      const pl: ParsedLine = {
        id: m.id,
        kind: "calc",
        name: m.name,
        ast,
        rhsStart: m.rhsStart,
        error,
        isLeaf,
        solvable: false,
      };
      lines.push(pl);
      byId.set(m.id, pl);
      if (m.name) nameToId.set(m.name, m.id);

      if (ast && isLeaf && !error) {
        try {
          const q = evalNode(ast, new Map());
          const sn = soleNum(ast);
          if (sn && sn.v !== 0) {
            const before = sn.v;
            sn.v = 1;
            const K = evalNode(ast, new Map()).v;
            sn.v = before;
            // span of the literal number in the full line text
            const tok = lex(m.rhs).find(t => t.k === "num");
            const numStart = m.rhsStart + (tok?.start ?? 0);
            const numEnd = m.rhsStart + (tok?.end ?? 0);
            leaf.set(m.id, { cell: num(q.v), dim: q.dim, K, numStart, numEnd });
            pl.solvable = true;
          } else {
            leaf.set(m.id, { cell: num(q.v), dim: q.dim, K: 1, numStart: 0, numEnd: 0 });
          }
        } catch (e) {
          pl.error = (e as Error).message;
          pl.isLeaf = false;
        }
      }
    }

    // Topo order over calc lines; lines in a cycle are flagged.
    const order = topo(lines, byId, nameToId);
    for (const pl of lines) {
      if (pl.kind === "calc" && !pl.error && !order.includes(pl.id)) pl.error = "cycle";
    }

    // Transitive leaf-name dependencies, for solvability.
    const deps = computeDeps(lines, byId, nameToId);

    // Reactive results: read leaf cells inside a derive.
    const results = derive(() => evalAll(order, byId, id => leaf.get(id)!.cell.value));
    const built: Built = { lines, byId, nameToId, order, leaf, deps, results, dispose: () => {} };
    // Assign before subscribing: `effect` runs its body synchronously once, and
    // that first paint must see the *new* graph (the stale one lacks new rows).
    this.#built = built;
    built.dispose = effect(() => {
      void results.value;
      this.#renderResults();
    });
    prev?.dispose();
    this.#renderResults();
  }

  // ── Paint chips + badges from the current built graph ─────────────────────
  #renderResults(): void {
    const b = this.#built;
    if (!b) return;
    const out = b.results.value;
    const unkId = this.#unknown != null ? b.nameToId.get(this.#unknown) : undefined;

    for (const row of this.#rows) {
      const pl = b.byId.get(row.id);
      if (!pl) continue;
      row.el.dataset.kind = pl.kind;

      // Badge: only on solvable leaves.
      const showBadge = pl.kind === "calc" && pl.solvable && b.leaf.has(row.id);
      row.badge.style.visibility = showBadge ? "" : "hidden";
      row.badge.classList.toggle("on", showBadge && pl.name === this.#unknown);

      const chip = row.chip;
      // Don't disturb an in-progress inline edit.
      if (chip.dataset.editing === "1") continue;

      if (pl.kind !== "calc") {
        chip.className = "chip empty";
        chip.textContent = "";
        continue;
      }
      const res = out.get(row.id);
      if (pl.error || !res || !res.ok || !res.qty) {
        chip.className = "chip err";
        chip.textContent = pl.error ?? res?.err ?? "?";
        delete chip.dataset.solvable;
        continue;
      }
      if (pl.isLeaf) {
        // The value lives in the source; keep the gutter clean.
        chip.className = "chip empty";
        chip.textContent = "";
        continue;
      }
      const view = chipView(res.qty);
      chip.className = "chip";
      chip.dataset.kind = view.kind;
      chip.textContent = view.text;

      const dependsOnUnknown =
        this.#unknown != null && unkId != null && (b.deps.get(row.id)?.has(this.#unknown) ?? false);
      if (dependsOnUnknown) {
        chip.classList.add("solvable");
        chip.dataset.solvable = "1";
        chip.dataset.factor = String(view.factor);
        chip.dataset.base = String(res.qty.v);
        chip.dataset.kindv = view.kind;
        chip.title = `drag to solve "${this.#unknown}"`;
      } else {
        delete chip.dataset.solvable;
        chip.title = "";
      }
    }
  }

  // ── Chip interactions: drag-scrub + click-to-type, both back-solve ────────
  #wireChip(chip: HTMLElement, id: number): void {
    let dragging = false;
    let moved = false;
    let startX = 0;
    let startTarget = 0;
    let pre = "";
    let post = "";
    let lf: LeafInfo | null = null;
    let unkId = -1;

    const begin = (e: PointerEvent): boolean => {
      if (chip.dataset.solvable !== "1") return false;
      const b = this.#built;
      if (!b || this.#unknown == null) return false;
      const uId = b.nameToId.get(this.#unknown);
      if (uId == null) return false;
      const info = b.leaf.get(uId);
      if (!info) return false;
      lf = info;
      unkId = uId;
      const txt = this.#rowById(uId)!.input.value;
      pre = txt.slice(0, info.numStart);
      post = txt.slice(info.numEnd);
      startX = e.clientX;
      startTarget = Number(chip.dataset.base ?? "0");
      return true;
    };

    chip.addEventListener("pointerdown", e => {
      if (!begin(e)) return;
      dragging = true;
      moved = false;
      try {
        chip.setPointerCapture(e.pointerId);
      } catch {
        /* ok */
      }
      e.preventDefault();
    });
    chip.addEventListener("pointermove", e => {
      if (!dragging || !lf) return;
      const dx = e.clientX - startX;
      if (Math.abs(dx) > 3) moved = true;
      if (!moved) return;
      const kind = chip.dataset.kindv as Kind;
      const step = Math.max(Math.abs(startTarget), kind === "money" ? 40 : 1) * 0.004;
      const target = startTarget + dx * step;
      this.#scrub(id, unkId, lf, target, pre, post);
    });
    const end = (e: PointerEvent): void => {
      if (!dragging) return;
      dragging = false;
      try {
        chip.releasePointerCapture(e.pointerId);
      } catch {
        /* ok */
      }
      if (moved) this.#build();
      else this.#editChip(chip, id);
    };
    chip.addEventListener("pointerup", end);
    chip.addEventListener("pointercancel", end);
  }

  /** Live drag: solve the unknown number for `targetBase` and splice it in. */
  #scrub(
    targetId: number,
    unkId: number,
    lf: LeafInfo,
    targetBase: number,
    pre: string,
    post: string,
  ): void {
    const b = this.#built;
    if (!b) return;
    const x0 = lf.cell.peek() / lf.K;
    const x = this.#solveNumber(targetId, unkId, lf.K, targetBase, x0);
    if (x == null || !Number.isFinite(x)) return;
    const row = this.#rowById(unkId);
    if (row) row.input.value = pre + fmtSrc(x) + post;
    lf.cell.value = x * lf.K; // reactive: chips update via the effect
  }

  #editChip(chip: HTMLElement, targetId: number): void {
    const b = this.#built;
    if (!b || chip.dataset.solvable !== "1") return;
    const factor = Number(chip.dataset.factor ?? "1");
    const base = Number(chip.dataset.base ?? "0");
    const input = document.createElement("input");
    input.className = "chip-edit";
    input.value = fmtPlain(base / factor).replace(/,/g, "");
    chip.dataset.editing = "1";
    chip.replaceChildren(input);
    input.focus();
    input.select();
    let done = false;
    const commit = (apply: boolean): void => {
      if (done) return;
      done = true;
      delete chip.dataset.editing;
      if (apply) {
        const typed = Number.parseFloat(input.value.replace(/,/g, ""));
        if (Number.isFinite(typed)) this.#solveTo(targetId, typed * factor);
      }
      this.#renderResults();
    };
    input.addEventListener("keydown", e => {
      if (e.key === "Enter") {
        e.preventDefault();
        commit(true);
      } else if (e.key === "Escape") {
        e.preventDefault();
        commit(false);
      }
    });
    input.addEventListener("blur", () => commit(true));
  }

  /** One-shot back-solve (typed target): solve, rewrite source, rebuild. */
  #solveTo(targetId: number, targetBase: number): void {
    const b = this.#built;
    if (!b || this.#unknown == null) return;
    const unkId = b.nameToId.get(this.#unknown);
    if (unkId == null) return;
    const lf = b.leaf.get(unkId);
    if (!lf) return;
    const x0 = lf.cell.peek() / lf.K;
    const x = this.#solveNumber(targetId, unkId, lf.K, targetBase, x0);
    if (x == null || !Number.isFinite(x)) return;
    const row = this.#rowById(unkId);
    if (row) {
      const txt = row.input.value;
      row.input.value = txt.slice(0, lf.numStart) + fmtSrc(x) + txt.slice(lf.numEnd);
    }
    this.#build();
  }

  /** Newton (with bisection fallback) on the unknown's literal number. */
  #solveNumber(
    targetId: number,
    unkId: number,
    K: number,
    targetBase: number,
    x0: number,
  ): number | null {
    const b = this.#built;
    if (!b) return null;
    const f = (x: number): number | null => {
      const out = evalAll(b.order, b.byId, id =>
        id === unkId ? x * K : b.leaf.get(id)!.cell.peek(),
      );
      const r = out.get(targetId);
      return r?.ok && r.qty ? r.qty.v : null;
    };
    const tol = 1e-7 * Math.max(1, Math.abs(targetBase));
    let x = x0;
    for (let it = 0; it < 60; it++) {
      const y = f(x);
      if (y == null) break;
      const e = y - targetBase;
      if (Math.abs(e) <= tol) return x;
      const h = (Math.abs(x) > 1 ? Math.abs(x) : 1) * 1e-6;
      const y2 = f(x + h);
      if (y2 == null) break;
      const slope = (y2 - y) / h;
      if (!Number.isFinite(slope) || Math.abs(slope) < 1e-15) break;
      x -= e / slope;
      if (!Number.isFinite(x)) break;
    }
    // Bisection fallback over a wide bracket.
    let lo = -1e9;
    let hi = 1e9;
    const flo = f(lo);
    const fhi = f(hi);
    if (flo != null && fhi != null && (flo - targetBase) * (fhi - targetBase) <= 0) {
      for (let it = 0; it < 200; it++) {
        const mid = (lo + hi) / 2;
        const fm = f(mid);
        if (fm == null) break;
        const fl = f(lo)!;
        if ((fm - targetBase) * (fl - targetBase) <= 0) hi = mid;
        else lo = mid;
        if (hi - lo < 1e-9) break;
      }
      return (lo + hi) / 2;
    }
    return null;
  }
}

// ─── Free helpers ───────────────────────────────────────────────────────────
function topo(
  lines: ParsedLine[],
  byId: Map<number, ParsedLine>,
  nameToId: Map<string, number>,
): number[] {
  const calc = lines.filter(l => l.kind === "calc" && l.ast && !l.error);
  const state = new Map<number, 0 | 1 | 2>(); // 0 unvisited, 1 in-stack, 2 done
  const order: number[] = [];
  const visit = (id: number): boolean => {
    const s = state.get(id) ?? 0;
    if (s === 2) return true;
    if (s === 1) return false; // cycle
    const pl = byId.get(id);
    if (!pl || pl.kind !== "calc" || !pl.ast || pl.error) return true;
    state.set(id, 1);
    let ok = true;
    for (const r of refsOf(pl.ast)) {
      const rid = nameToId.get(r);
      if (rid != null && !visit(rid)) ok = false;
    }
    state.set(id, 2);
    if (ok) order.push(id);
    return ok;
  };
  for (const l of calc) visit(l.id);
  return order;
}

function computeDeps(
  lines: ParsedLine[],
  byId: Map<number, ParsedLine>,
  nameToId: Map<string, number>,
): Map<number, Set<string>> {
  const memo = new Map<string, Set<string>>();
  const stack = new Set<string>();
  const depName = (name: string): Set<string> => {
    const hit = memo.get(name);
    if (hit) return hit;
    const out = new Set<string>();
    const id = nameToId.get(name);
    const pl = id != null ? byId.get(id) : undefined;
    if (!pl || pl.kind !== "calc" || !pl.ast || pl.error) {
      memo.set(name, out);
      return out;
    }
    if (pl.solvable) {
      out.add(name);
      memo.set(name, out);
      return out;
    }
    if (stack.has(name)) return out;
    stack.add(name);
    for (const r of refsOf(pl.ast)) if (nameToId.has(r)) for (const x of depName(r)) out.add(x);
    stack.delete(name);
    memo.set(name, out);
    return out;
  };
  const deps = new Map<number, Set<string>>();
  for (const pl of lines) {
    if (pl.kind !== "calc" || !pl.ast) continue;
    if (pl.solvable) {
      deps.set(pl.id, new Set(pl.name ? [pl.name] : []));
      continue;
    }
    const out = new Set<string>();
    for (const r of refsOf(pl.ast)) if (nameToId.has(r)) for (const x of depName(r)) out.add(x);
    deps.set(pl.id, out);
  }
  return deps;
}
