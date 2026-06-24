import { type Read, SKIP, type Skip, type Writable } from "../cell";
import { type Num, num } from "./num";
import { Str, str } from "./str";

/** Textual codec for a slot value. `parse` returns `undefined` to reject. */
export interface Codec<T> {
  format(v: T): string;
  parse(s: string): T | undefined;
}

/** Identity codec for string slots. */
export const strCodec: Codec<string> = {
  format: v => v,
  parse: s => s,
};

/** Numeric codec; `int` rounds on both read and write. Rejects non-finite. */
export const numCodec = (int = false): Codec<number> => ({
  format: v => (int ? String(Math.round(v)) : String(v)),
  parse: s => {
    const t = s.trim();
    if (t === "") return undefined;
    const n = Number(t);
    if (!Number.isFinite(n)) return undefined;
    return int ? Math.round(n) : n;
  },
});

/** Enumerated string codec: accepts only members of `options`. */
export const enumCodec = (options: readonly string[]): Codec<string> => ({
  format: v => v,
  parse: s => (options.includes(s) ? s : undefined),
});

/** A typed hole: the parent cell plus its `string ⇄ T` codec. */
export interface Slot<T> {
  name: string;
  cell: Writable<Read<T>>;
  codec: Codec<T>;
}

/** Slot constructors that infer the codec from the cell's value class. */
export const slot = {
  str: (cell: Writable<Str>, name = ""): Slot<string> => ({ name, cell, codec: strCodec }),
  num: (cell: Writable<Num>, name = ""): Slot<number> => ({ name, cell, codec: numCodec() }),
  int: (cell: Writable<Num>, name = ""): Slot<number> => ({ name, cell, codec: numCodec(true) }),
  pick: (cell: Writable<Str>, options: readonly string[], name = ""): Slot<string> => ({
    name,
    cell,
    codec: enumCodec(options),
  }),
};

const render = (
  literals: readonly string[],
  slots: readonly Slot<unknown>[],
  vals: readonly unknown[],
): string => {
  let out = literals[0] ?? "";
  for (let i = 0; i < slots.length; i++) {
    out += slots[i]!.codec.format(vals[i]);
    out += literals[i + 1] ?? "";
  }
  return out;
};

const parse = (
  literals: readonly string[],
  slots: readonly Slot<unknown>[],
  edited: string,
): (unknown | Skip)[] => {
  const k = slots.length;
  const reject = (): Skip[] => new Array(k).fill(SKIP);
  const updates: (unknown | Skip)[] = reject();
  const lit0 = literals[0] ?? "";
  if (!edited.startsWith(lit0)) return updates;
  let pos = lit0.length;
  for (let i = 0; i < k; i++) {
    const delim = literals[i + 1] ?? "";
    let segEnd: number;
    if (delim === "") {
      // Last segment runs to the end; an empty interior literal means two
      // adjacent slots — unsplittable, so this slot takes the empty span.
      segEnd = i === k - 1 ? edited.length : pos;
    } else {
      const idx = edited.indexOf(delim, pos);
      if (idx < 0) return reject();
      segEnd = idx;
    }
    const v = slots[i]!.codec.parse(edited.slice(pos, segEnd));
    if (v !== undefined) updates[i] = v;
    pos = segEnd + delim.length;
  }
  return updates;
};

/** Core builder: `literals.length === slots.length + 1`. Returns the
 *  rendered text as a `Writable<Str>` that parses back into the slots. */
export function template(
  literals: readonly string[],
  slots: readonly Slot<unknown>[],
): Writable<Str> {
  if (slots.length === 0) return str(literals.join(""));
  const cells = slots.map(s => s.cell);
  // Heterogeneous, dynamic-length parents don't fit the static N-tuple
  // overload; bind a flat signature. `.bind(Str)` keeps the static `this`.
  const lensN = Str.lens.bind(Str) as unknown as (
    parents: readonly unknown[],
    fwd: (vals: readonly unknown[]) => string,
    bwd: (edited: string) => (unknown | Skip)[],
  ) => Writable<Str>;
  return lensN(
    cells,
    vals => render(literals, slots, vals),
    edited => parse(literals, slots, edited),
  );
}

/** Tagged template; interpolate `slot.*` holes. Bring your own cells:
 *
 *      tpl`Hello ${slot.str(name)}, ×${slot.int(count)}` */
export function tpl(strings: TemplateStringsArray, ...slots: Slot<unknown>[]): Writable<Str> {
  return template([...strings], slots);
}

type ParamKind = "str" | "int" | "num";
type ParamCell<K extends ParamKind> = K extends "str" ? Writable<Str> : Writable<Num>;

/** Parse a `:name` pattern against a kind schema, owning fresh slot cells.
 *  Returns the rendered URL `text` and the typed `params` cells; edit
 *  either side and the other stays in sync.
 *
 *      const { text, params } = route("/users/:id/posts/:slug",
 *        { id: "int", slug: "str" }); */
export function route<S extends Record<string, ParamKind>>(
  pattern: string,
  schema: S,
): { text: Writable<Str>; params: { [K in keyof S]: ParamCell<S[K]> } } {
  const literals: string[] = [];
  const slots: Slot<unknown>[] = [];
  const params: Record<string, unknown> = {};
  const re = /:([A-Za-z_][A-Za-z0-9_]*)/g;
  let last = 0;
  let m: RegExpExecArray | null = re.exec(pattern);
  while (m !== null) {
    literals.push(pattern.slice(last, m.index));
    const name = m[1]!;
    const kind = schema[name];
    if (!kind) throw new Error(`route: ":${name}" has no schema entry`);
    if (kind === "str") {
      const c = str("");
      params[name] = c;
      slots.push(slot.str(c, name));
    } else {
      const c = num(0);
      params[name] = c;
      slots.push(kind === "int" ? slot.int(c, name) : slot.num(c, name));
    }
    last = m.index + m[0].length;
    m = re.exec(pattern);
  }
  literals.push(pattern.slice(last));
  return { text: template(literals, slots), params: params as never };
}
