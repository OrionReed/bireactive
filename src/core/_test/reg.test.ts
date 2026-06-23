// Reg — the unambiguous bidirectional regex-lens algebra. Organised by the
// laws in the literature (Foster et al. TOPLAS'07 GetPut/PutGet/PutPut;
// Zhu–Ko–Hu SLE'16 reflective parse/print) plus fast-check fuzzing,
// named-handle editing, construction-time ambiguity rejection, and a
// re-derivation of Str.split.

import fc from "fast-check";
import { describe, expect, it } from "vitest";
import type { Writable } from "../cell";
import { caseFold } from "../lenses/text";
import type { Arr } from "../values/arr";
import { type Handle, Reg, type RegVal } from "../values/reg";
import { type Str, str } from "../values/str";
import {
  type SourceAndLens,
  verifyGetPut,
  verifyLensLaws,
  verifyPutGet,
  verifyPutPut,
  verifyReadStability,
} from "./_laws";

const strEq = (a: string, b: string) => a === b;
const deepEq = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);
const asStr = (h: Handle): Writable<Str> => h as unknown as Writable<Str>;
const asArr = (h: Handle): Arr<string> => h as unknown as Arr<string>;

// ── pure parser / printer ────────────────────────────────────────────

describe("Reg — match / print", () => {
  it("typed leaves capture the matched text", () => {
    expect(Reg.digits().match("123")).toBe("123");
    expect(Reg.digits().match("12a")).toBeNull(); // must consume to end
    expect(Reg.letters().match("abc")).toBe("abc");
    expect(Reg.copy(/\d+/).match("42")).toBe("42"); // escape hatch
  });

  it("lit matches and prints but yields no value", () => {
    const r = Reg.lit("=");
    expect(r.test("=")).toBe(true);
    expect(r.test("x")).toBe(false);
  });

  it("seq yields a tuple of the visible (non-lit) children", () => {
    const r = Reg.digits().then(Reg.lit("-"), Reg.digits());
    expect(r.match("12-34")).toEqual(["12", "34"]);
    expect(r.print(["7", "8"])).toBe("7-8");
  });

  it("disjoint character classes need no delimiter", () => {
    const r = Reg.digits().then(Reg.letters());
    expect(r.match("12ab")).toEqual(["12", "ab"]);
    expect(r.print(["3", "cd"])).toBe("3cd");
  });

  it("alt picks the branch by first character, tagged", () => {
    const r = Reg.alt(Reg.digits(), Reg.letters());
    expect(r.match("42")).toEqual({ branch: 0, val: "42" });
    expect(r.match("foo")).toEqual({ branch: 1, val: "foo" });
    expect(r.print({ branch: 1, val: "bar" })).toBe("bar");
  });

  it("opt yields the inner value when present, null when absent", () => {
    const r = Reg.copy(/-/).optional().then(Reg.digits());
    expect(r.match("-5")).toEqual(["-", "5"]);
    expect(r.match("5")).toEqual([null, "5"]);
    expect(r.print(["-", "5"])).toBe("-5");
    expect(r.print([null, "5"])).toBe("5");
  });

  it("an optional literal records presence so it round-trips", () => {
    const r = Reg.lit("-").optional().then(Reg.digits());
    expect(r.match("-5")).toEqual([true, "5"]);
    expect(r.match("5")).toEqual([null, "5"]);
    expect(r.print([true, "5"])).toBe("-5");
    expect(r.print([null, "5"])).toBe("5");
  });

  it("plus requires at least one element; star allows zero", () => {
    expect(Reg.copy(/a/).star().match("")).toEqual({ items: [], seps: [] });
    expect(Reg.copy(/a/).plus().match("")).toBeNull();
    expect(Reg.copy(/a/).plus().match("aa")).toEqual({ items: ["a", "a"], seps: [] });
    // A separated star of a nullable element treats "" as one empty field.
    expect(Reg.until(",").star(Reg.lit(",")).match("")).toEqual({ items: [""], seps: [] });
  });

  it("of decodes/encodes through a codec", () => {
    const r = Reg.int();
    expect(r.match("42")).toBe(42);
    expect(r.print(7)).toBe("7");
  });

  it("GetPut: print(match s) === s on the recognized language", () => {
    const r = Reg.word().then(Reg.lit(": "), Reg.copy(/[^;]+/)).star(Reg.lit("; "));
    const s = "a: 1; bb: 22; ccc: 333";
    expect(r.print(r.match(s)!)).toBe(s);
  });

  it("fixed-width adjacent captures parse deterministically", () => {
    // \d{2}\d{2} has followLast ∅, so greedy is exact — accepted.
    expect(Reg.copy(/\d{2}/).then(Reg.copy(/\d{2}/)).match("1234")).toEqual(["12", "34"]);
  });
});

// ── construction-time ambiguity rejection ──────────────────────────────

describe("Reg — rejects ambiguity at construction", () => {
  it("variable-width adjacent captures throw", () => {
    expect(() => Reg.digits().then(Reg.copy(/\d+/))).toThrow();
    expect(() => Reg.copy(/\d+/).then(Reg.copy(/\d+/))).toThrow();
  });

  it("a nullable non-final element throws", () => {
    expect(() => Reg.copy(/\d*/).then(Reg.copy(/\d+/))).toThrow();
  });

  it("an unseparated star over a nullable element throws", () => {
    expect(() => Reg.until(",").star()).toThrow();
    expect(() => Reg.copy(/a*/).star()).toThrow();
  });

  it("an optional that is itself nullable throws", () => {
    expect(() => Reg.copy(/a*/).optional()).toThrow();
  });

  it("overlapping alternation branches throw", () => {
    expect(() => Reg.alt(Reg.copy(/[ab]+/), Reg.copy(/[ab]+/))).toThrow();
    expect(() => Reg.digits().or(Reg.int())).toThrow();
  });

  it("a well-delimited grammar constructs cleanly", () => {
    expect(() => Reg.until(",").star(Reg.lit(","))).not.toThrow();
    expect(() =>
      Reg.word().then(Reg.lit(": "), Reg.copy(/[^;]+/)).star(Reg.lit("; ")),
    ).not.toThrow();
  });
});

// ── classical lens laws on the whole-value `view` ──────────────────────

const dateGrammar = Reg.digits()
  .as("y")
  .then(Reg.lit("-"), Reg.digits().as("m"), Reg.lit("-"), Reg.digits().as("d"));

type DateVal = [string, string, string];

const rngDigits = (): string => {
  const n = 1 + Math.floor(Math.random() * 4);
  let s = "";
  for (let i = 0; i < n; i++) s += String(Math.floor(Math.random() * 10));
  return s;
};
const rngDateVal = (): DateVal => [rngDigits(), rngDigits(), rngDigits()];
const rngDateStr = (): string => rngDateVal().join("-");

describe("Reg.view — classical laws (copy grammar, lossless)", () => {
  const make = (): SourceAndLens<string, DateVal> => {
    const source = str(rngDateStr());
    return { source, lens: dateGrammar.view(source) };
  };

  it("GetPut", () => {
    verifyGetPut(make, { sourceEq: strEq });
  });
  it("PutGet", () => {
    verifyPutGet(make, rngDateVal, { viewEq: deepEq });
  });
  it("PutPut", () => {
    verifyPutPut(make, rngDateVal, { sourceEq: strEq });
  });
  it("read stability", () => {
    verifyReadStability(
      () => {
        const source = str("12-7-2024");
        return { source, lens: dateGrammar.view(source) };
      },
      { viewEq: deepEq, sourceEq: strEq },
    );
  });
});

// ── named handles edit the source through a Str-lens ───────────────────

describe("Reg.bind — scalar handles", () => {
  it("editing a capture rewrites the source, preserving the rest", () => {
    const s = str("12-7-2024");
    const { y, m, d } = dateGrammar.bind(s) as { y: Handle; m: Handle; d: Handle };
    expect(asStr(y).value).toBe("12");
    expect(asStr(m).value).toBe("7");
    expect(asStr(d).value).toBe("2024");
    asStr(m).value = "11";
    expect(s.value).toBe("12-11-2024");
    asStr(y).value = "1";
    expect(s.value).toBe("1-11-2024");
  });

  it("an out-of-language write is rejected (source untouched)", () => {
    const s = str("12-7-2024");
    const { m } = dateGrammar.bind(s) as { m: Handle };
    asStr(m).value = "x"; // not /\d+/
    expect(s.value).toBe("12-7-2024");
  });

  it("external source edits flow back to the handles", () => {
    const s = str("12-7-2024");
    const { y } = dateGrammar.bind(s) as { y: Handle };
    expect(asStr(y).value).toBe("12");
    s.value = "99-1-2000";
    expect(asStr(y).value).toBe("99");
  });

  it("handle laws (string lens into source)", () => {
    verifyLensLaws(
      () => {
        const s = str(rngDateStr());
        const { m } = dateGrammar.bind(s) as { m: Handle };
        return { source: s, lens: asStr(m) };
      },
      rngDigits,
      { sourceEq: strEq, viewEq: strEq },
    );
  });

  it("does not clobber the rest when the source is off-language", () => {
    const s = str("12-7-2024");
    const { m } = dateGrammar.bind(s) as { m: Handle };
    s.value = "not a date at all";
    asStr(m).value = "11";
    expect(s.value).toBe("not a date at all");
    s.value = "12-7-2024";
    asStr(m).value = "11";
    expect(s.value).toBe("12-11-2024");
  });

  it("star edits no-op on an off-language source (no clobber)", () => {
    const g = Reg.digits().star(Reg.lit(",")).as("nums");
    const s = str("1,2,3");
    const arr = asArr(g.bind(s).nums);
    arr.values.value;
    s.value = "x,y"; // off-language: not digits
    arr.push("9");
    expect(s.value).toBe("x,y");
    s.value = "1,2,3";
    arr.push("9");
    expect(s.value).toBe("1,2,3,9");
  });

  it("composes with caseFold on a capture", () => {
    const grammar = Reg.word().as("word").then(Reg.lit("!"));
    const s = str("Hello!");
    const { word } = grammar.bind(s) as { word: Handle };
    const lo = caseFold(asStr(word));
    lo.peek();
    expect(lo.value).toBe("hello");
    lo.value = "world";
    expect(s.value).toBe("World!");
  });

  it("schema-typed bind gives known keys and per-handle types (no casts)", () => {
    const s = str("a,b,c");
    const g = Reg.until(",").star(Reg.lit(",")).as("cells");
    const { cells } = g.bind(s, { schema: { cells: "arr" } });
    cells.push("d");
    expect(s.value).toBe("a,b,c,d");
  });

  it("schema-typed bind rejects a mismatched or unknown tag", () => {
    const g = Reg.digits().as("n");
    expect(() => g.bind(str("5"), { schema: { n: "arr" } })).toThrow();
    expect(() => g.bind(str("5"), { schema: { nope: "str" } })).toThrow();
  });

  it("a named optional capture round-trips through bind", () => {
    const g = Reg.lit("v")
      .then(Reg.digits().as("major"), Reg.lit("."), Reg.digits().as("minor"))
      .then(Reg.lit("-").then(Reg.letters().as("tag")).optional());
    const s = str("v1.2-beta");
    const { tag, minor } = g.bind(s) as { tag: Handle; minor: Handle };
    expect(asStr(tag).value).toBe("beta");
    asStr(minor).value = "9";
    expect(s.value).toBe("v1.9-beta");
  });
});

// ── star handle → editable Arr ─────────────────────────────────────────

const csvGrammar = Reg.until(",").star(Reg.lit(",")).as("cells");

describe("Reg.bind — star handle is an editable Arr", () => {
  it("reads the elements", () => {
    const s = str("a,b,c");
    const { cells } = csvGrammar.bind(s) as { cells: Handle };
    expect(asArr(cells).values.value).toEqual(["a", "b", "c"]);
  });

  it("keeps separators verbatim so it round-trips (incl. empty fields)", () => {
    const r = Reg.until(",").star(Reg.lit(","));
    const v = r.match("a,b,,c");
    expect(v).toEqual({ items: ["a", "b", "", "c"], seps: [",", ",", ","] });
    expect(r.print(v!)).toBe("a,b,,c");
  });

  it("editing an element rewrites the source", () => {
    const s = str("a,b,c");
    const { cells } = csvGrammar.bind(s) as { cells: Handle };
    const arr = asArr(cells);
    arr.values.value;
    (arr.cells[1] as { value: string }).value = "BB";
    expect(s.value).toBe("a,BB,c");
  });

  it("structural insert / remove / move rewrite the source", () => {
    const s = str("a,b,c");
    const { cells } = csvGrammar.bind(s) as { cells: Handle };
    const arr = asArr(cells);
    arr.values.value;
    arr.push("d");
    expect(s.value).toBe("a,b,c,d");
    arr.removeAt(0);
    expect(s.value).toBe("b,c,d");
    arr.moveBefore(arr.cells[0]!, null);
    expect(s.value).toBe("c,d,b");
  });

  it("resourceful star: element handles follow identity across reorder", () => {
    const g = Reg.letters()
      .star(Reg.lit(","), { key: x => x })
      .as("xs");
    const s = str("a,b,c");
    const arr = asArr(g.bind(s).xs);
    const bCell = arr.cells[1] as { value: string };
    expect(bCell.value).toBe("b");
    arr.moveBefore(arr.cells[2]!, arr.cells[0]!); // c before a → "c,a,b"
    expect(s.value).toBe("c,a,b");
    expect(bCell.value).toBe("b");
    expect(arr.cells[2]).toBe(bCell as unknown);
  });

  it("positional star (default) tracks position, not identity", () => {
    const g = Reg.letters().star(Reg.lit(",")).as("xs");
    const s = str("a,b,c");
    const arr = asArr(g.bind(s).xs);
    const idx1 = arr.cells[1] as { value: string };
    arr.moveBefore(arr.cells[2]!, arr.cells[0]!); // → "c,a,b"
    expect(s.value).toBe("c,a,b");
    expect(idx1.value).toBe("a");
  });

  it("astral text round-trips losslessly (code-unit matching)", () => {
    const g = Reg.until(",").star(Reg.lit(","));
    const s = "a,😀,🇬🇧z,b";
    const v = g.match(s);
    expect(v).not.toBeNull();
    expect(g.print(v!)).toBe(s);
    expect(v!.items).toEqual(["a", "😀", "🇬🇧z", "b"]);
  });

  it("re-derives Str.split: same element values", () => {
    fc.assert(
      fc.property(fc.array(fc.stringMatching(/^[^,]*$/), { minLength: 1, maxLength: 6 }), words => {
        const text = words.join(",");
        const viaSplit = str(text).split(/,/).values.value;
        const viaReg = csvGrammar.bind(str(text)).cells as Handle;
        expect(asArr(viaReg).values.value).toEqual([...viaSplit]);
      }),
    );
  });
});

// ── fast-check property fuzzing ────────────────────────────────────────

describe("Reg — property fuzzing", () => {
  const digits = fc.stringMatching(/^[0-9]{1,4}$/);

  it("date view round-trips for any in-domain triple (GetPut + PutGet)", () => {
    fc.assert(
      fc.property(digits, digits, digits, (y, m, d) => {
        const source = str(`${y}-${m}-${d}`);
        const view = dateGrammar.view(source);
        const got = view.value;
        view.value = got;
        expect(source.value).toBe(`${y}-${m}-${d}`);
        const next: DateVal = [d, y, m];
        view.value = next;
        expect(deepEq(view.value, next)).toBe(true);
      }),
    );
  });

  it("editing one handle never disturbs sibling captures", () => {
    fc.assert(
      fc.property(digits, digits, digits, digits, (y, m, d, m2) => {
        const s = str(`${y}-${m}-${d}`);
        const h = dateGrammar.bind(s) as { y: Handle; m: Handle; d: Handle };
        asStr(h.m).value = m2;
        expect(s.value).toBe(`${y}-${m2}-${d}`);
        expect(asStr(h.y).value).toBe(y);
        expect(asStr(h.d).value).toBe(d);
      }),
    );
  });

  it("CSV round-trips through bind + reprint for any field list", () => {
    fc.assert(
      fc.property(
        fc.array(fc.stringMatching(/^[^,]*$/), { minLength: 1, maxLength: 8 }),
        fields => {
          const text = fields.join(",");
          const s = str(text);
          const { cells } = csvGrammar.bind(s) as { cells: Handle };
          expect(asArr(cells).values.value).toEqual(fields);
          expect(s.value).toBe(text);
        },
      ),
    );
  });
});

// ── compositional binding (a grammar over another grammar's element) ────

describe("Reg — composition (table = rows of cells)", () => {
  const rows = Reg.until("\n").star(Reg.lit("\n")).as("rows");
  const cols = Reg.until(",").star(Reg.lit(",")).as("cells");

  it("inner edits and outer reorders both rewrite the one source", () => {
    const s = str("a,b,c\nd,e,f");
    const rowArr = asArr(rows.bind(s).rows);
    expect(rowArr.values.value).toEqual(["a,b,c", "d,e,f"]);

    const row0 = rowArr.cells[0]! as unknown as import("../cell").Cell<string>;
    const cellArr = asArr(cols.bind(row0).cells);
    expect(cellArr.values.value).toEqual(["a", "b", "c"]);

    (cellArr.cells[1] as unknown as Writable<Str>).value = "BB";
    expect(s.value).toBe("a,BB,c\nd,e,f");

    rowArr.moveBefore(rowArr.cells[0]!, null);
    expect(s.value).toBe("d,e,f\na,BB,c");
  });

  it("fixed-schema rows expose named cell handles via an inner seq", () => {
    const row = Reg.until(",").as("name").then(Reg.lit(",")).then(Reg.until(",").as("email"));
    const s = str("ann,a@x\nbob,b@y");
    const rowArr = asArr(rows.bind(s).rows);
    const r1 = rowArr.cells[1]! as unknown as import("../cell").Cell<string>;
    const fields = row.bind(r1) as { name: Handle; email: Handle };
    expect(asStr(fields.name).value).toBe("bob");
    asStr(fields.email).value = "bob@z";
    expect(s.value).toBe("ann,a@x\nbob,bob@z");
  });
});

// ── reflective spans (the get/put correspondence, made visible) ─────────

describe("Reg.spans — named-capture source spans", () => {
  const g = Reg.copy(/\d{4}/)
    .as("y")
    .then(Reg.lit("-"))
    .then(Reg.copy(/\d{2}/).as("m"))
    .then(Reg.lit("-"))
    .then(Reg.copy(/\d{2}/).as("d"));

  it("reports each capture's [start, end) and slices back the value", () => {
    const s = "2026-06-22";
    const sp = g.spans(s);
    expect(sp).toEqual({ y: [0, 4], m: [5, 7], d: [8, 10] });
    for (const [name, [a, b]] of Object.entries(sp)) {
      expect(s.slice(a, b)).toBe({ y: "2026", m: "06", d: "22" }[name]);
    }
  });

  it("covers the whole run for a star capture", () => {
    const csv = Reg.until(",").star(Reg.lit(",")).as("cells");
    expect(csv.spans("a,bb,ccc")).toEqual({ cells: [0, 8] });
  });

  it("returns {} when the string doesn't fully match", () => {
    expect(g.spans("2026-06")).toEqual({});
  });
});

// `RegVal` is exercised structurally above; keep the import meaningful.
export type _RegVal = RegVal;
