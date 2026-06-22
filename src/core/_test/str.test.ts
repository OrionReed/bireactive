// Str runtime + lens laws for the lean core surface: reverse, trim, slice,
// split. (Case folding moved to `lenses/text.ts` — see text.test.ts.)

import { describe, expect, it } from "vitest";
import { effect, isLens, settle } from "../cell";
import { Num } from "../values/num";
import { reverseStr, Str, str } from "../values/str";
import {
  approxNumber,
  type SourceAndLens,
  verifyGetPut,
  verifyLensLaws,
  verifyPutGet,
  verifyPutPut,
  verifyRecovery,
} from "./_laws";

const strEq = (a: string, b: string) => a === b;

const rngChar = (): string => {
  const r = Math.random();
  if (r < 0.5) return String.fromCharCode(97 + Math.floor(Math.random() * 26));
  if (r < 0.8) return String.fromCharCode(65 + Math.floor(Math.random() * 26));
  if (r < 0.9) return " ";
  const p = ".,!?;:\n\t-_()[]";
  return p[Math.floor(Math.random() * p.length)]!;
};
const rngString = (len = 16): string => {
  let s = "";
  for (let i = 0; i < len; i++) s += rngChar();
  return s;
};
const rngWord = (): string => {
  const len = 1 + Math.floor(Math.random() * 6);
  let s = "";
  for (let i = 0; i < len; i++) s += String.fromCharCode(97 + Math.floor(Math.random() * 26));
  return s;
};

/** Read a (positionally-identified) segment cell as writable. */
const w = (c: { value: string } | undefined): { value: string } => c as { value: string };

describe("str() factory", () => {
  it("seeds a writable cell from a literal", () => {
    const s = str("hello");
    expect(s).toBeInstanceOf(Str);
    expect(s.value).toBe("hello");
    s.value = "world";
    expect(s.value).toBe("world");
  });

  it("identity-passes an existing Writable<Str>", () => {
    const a = str("a");
    expect(str(a)).toBe(a);
  });

  it("default is the empty string", () => {
    expect(str().value).toBe("");
  });
});

describe("Str.reverse()", () => {
  it("is involutive", () => {
    const s = str("Hello, World!");
    expect(s.reverse().value).toBe("!dlroW ,olleH");
    expect(s.reverse().reverse().value).toBe("Hello, World!");
  });

  it("is writable — writes propagate to source", () => {
    const s = str("abc");
    const r = s.reverse();
    expect(isLens(r)).toBe(true);
    r.value = "xyz";
    expect(s.value).toBe("zyx");
  });

  it("full lens laws", () => {
    verifyLensLaws(
      () => {
        const s = str(rngString(10));
        return { source: s, lens: s.reverse() };
      },
      () => rngString(10),
    );
  });

  it("preserves Unicode", () => {
    const s = str("café résumé");
    const r = s.reverse();
    expect(r.value).toBe("émusér éfac");
    r.value = "émusér éfac";
    expect(s.value).toBe("café résumé");
  });

  it("reverseStr is involutive", () => {
    const s = "Hello, World 123!";
    expect(reverseStr(reverseStr(s))).toBe(s);
  });
});

describe("Str.trim()", () => {
  it("reads trimmed value", () => {
    expect(str("  Hello  ").trim().value).toBe("Hello");
  });

  it("writes preserve original padding", () => {
    const s = str("  Hello  ");
    const t = s.trim();
    t.peek();
    t.value = "World";
    expect(s.value).toBe("  World  ");
  });

  it("preserves tab/newline padding", () => {
    const s = str("\t\n  hi  \t");
    const t = s.trim();
    expect(t.value).toBe("hi");
    t.value = "bye";
    expect(s.value).toBe("\t\n  bye  \t");
  });

  it("no whitespace → trim is identity", () => {
    const s = str("hello");
    const t = s.trim();
    expect(t.value).toBe("hello");
    t.value = "world";
    expect(s.value).toBe("world");
  });

  it("all-whitespace input — lead consumes everything", () => {
    const s = str("   ");
    const t = s.trim();
    expect(t.value).toBe("");
    t.value = "hi";
    expect(s.value).toBe("   hi");
  });

  it("edge whitespace typed in is stripped, doesn't grow padding", () => {
    const s = str("  hi  ");
    const t = s.trim();
    t.peek();
    for (let i = 0; i < 10; i++) t.value = "   hi   ";
    expect(s.value).toBe("  hi  ");
  });

  it("PutGet / GetPut / PutPut", () => {
    verifyPutGet(
      () => {
        const s = str(`  ${rngWord()}  `);
        return { source: s, lens: s.trim() };
      },
      () => rngWord(),
      { viewEq: strEq },
    );
    verifyGetPut(
      () => {
        const s = str(`  ${rngWord()}  `);
        const lens = s.trim();
        lens.peek();
        return { source: s, lens };
      },
      { sourceEq: strEq },
    );
    verifyPutPut(
      () => {
        const s = str(`  ${rngWord()}  `);
        const lens = s.trim();
        lens.peek();
        return { source: s, lens };
      },
      () => rngWord(),
      { sourceEq: strEq },
    );
  });

  it("recovery — collapse to empty, then back restores padding", () => {
    verifyRecovery(
      () => {
        const s = str("  hi  ");
        return { source: s, lens: s.trim() };
      },
      "",
      "back",
      _orig => "  back  ",
      { sourceEq: strEq },
    );
  });
});

describe("Str.slice()", () => {
  it("reads a window", () => {
    expect(str("hello world").slice(0, 5).value).toBe("hello");
    expect(str("hello world").slice(6).value).toBe("world");
    expect(str("hello world").slice(-5).value).toBe("world");
  });

  it("write splices the window back into the source (same length)", () => {
    const s = str("hello world");
    const sl = s.slice(0, 5);
    sl.value = "HELLO";
    expect(s.value).toBe("HELLO world");
  });

  it("write of a different length grows / shrinks the source", () => {
    const s = str("hello world");
    const sl = s.slice(0, 5);
    sl.value = "hi";
    expect(s.value).toBe("hi world");
  });

  it("negative-index window writes back", () => {
    const s = str("hello world");
    const sl = s.slice(-5);
    sl.value = "WORLD";
    expect(s.value).toBe("hello WORLD");
  });

  it("GetPut — writing back the read is a no-op", () => {
    verifyGetPut(
      () => {
        const s = str(rngString(12));
        return { source: s, lens: s.slice(2, 7) };
      },
      { sourceEq: strEq },
    );
  });

  it("PutGet — same-length writes read back exactly", () => {
    verifyPutGet(
      () => {
        const s = str(rngString(12));
        return { source: s, lens: s.slice(2, 7) };
      },
      () => rngString(5),
      { viewEq: strEq },
    );
  });
});

describe("Str.split()", () => {
  it("reads segments", () => {
    const a = str("the quick brown").split(/\s+/);
    expect([...a.values.value]).toEqual(["the", "quick", "brown"]);
  });

  it("string separator splits on a literal", () => {
    const a = str("a,b,c").split(",");
    expect([...a.values.value]).toEqual(["a", "b", "c"]);
  });

  it("editing a segment writes back, separators preserved", () => {
    const s = str("the quick brown");
    const a = s.split(/\s+/);
    w(a.cells[1]).value = "slow";
    expect(s.value).toBe("the slow brown");
  });

  it("preserves the exact separator text", () => {
    const s = str("a,\tb,\tc");
    const a = s.split(/,\s*/);
    w(a.cells[0]).value = "x";
    expect(s.value).toBe("x,\tb,\tc");
  });

  it("insert appends a word with the join separator", () => {
    const s = str("the quick");
    const a = s.split(/\s+/);
    a.push("fox");
    expect(s.value).toBe("the quick fox");
  });

  it("insert at the front", () => {
    const s = str("the quick");
    const a = s.split(/\s+/);
    a.insert("hi", 0);
    expect(s.value).toBe("hi the quick");
  });

  it("remove drops a word and a separator", () => {
    const s = str("the quick brown");
    const a = s.split(/\s+/);
    a.removeAt(1);
    expect(s.value).toBe("the brown");
  });

  it("remove the last word keeps the rest", () => {
    const s = str("the quick brown");
    const a = s.split(/\s+/);
    a.removeAt(2);
    expect(s.value).toBe("the quick");
  });

  it("move reorders parts through fixed gaps", () => {
    const s = str("a b c d");
    const a = s.split(/\s+/);
    a.move(a.cells[0]!, 2);
    expect(s.value).toBe("b c a d");
  });

  it("identity is positional — the cell at i stays stable across edits", () => {
    const s = str("a b c");
    const a = s.split(/\s+/);
    const c1 = a.cells[1];
    w(a.cells[0]).value = "x";
    expect(a.cells[1]).toBe(c1);
  });

  it("words = split(/\\s+/).filter(non-empty) drops padding segments", () => {
    const s = str("  the quick  ");
    const words = s.split(/\s+/).filter(c => c.value.length > 0);
    expect([...words.values.value]).toEqual(["the", "quick"]);
  });

  it("editing through the filtered words view writes the source", () => {
    const s = str("the quick brown");
    const words = s.split(/\s+/).filter(c => c.value.length > 0);
    w(words.cells[0]).value = "a";
    expect(s.value).toBe("a quick brown");
  });

  it("length is reactive", () => {
    const s = str("a b c");
    const a = s.split(/\s+/);
    expect(a.length.value).toBe(3);
    a.push("d");
    expect(a.length.value).toBe(4);
    a.removeAt(0);
    expect(a.length.value).toBe(3);
  });

  it("writing a segment back to its own value is a no-op", () => {
    const s = str("the quick, brown fox");
    const a = s.split(/\s+/);
    for (let i = 0; i < a.cells.length; i++) w(a.cells[i]).value = a.cells[i]!.value;
    expect(s.value).toBe("the quick, brown fox");
  });

  it("effects fire when a segment changes", () => {
    const s = str("the quick");
    const a = s.split(/\s+/);
    let seen = "";
    let fires = 0;
    const dispose = effect(() => {
      seen = a.values.value.join("|");
      fires++;
    });
    fires = 0;
    w(a.cells[0]).value = "a";
    settle();
    expect(seen).toBe("a|quick");
    expect(fires).toBe(1);
    dispose();
  });
});

describe("composition", () => {
  it("trim ▶ reverse", () => {
    const s = str("  Hello  ");
    const r = s.trim().reverse();
    r.peek();
    expect(r.value).toBe("olleH");
    r.value = "olleH";
    expect(s.value).toBe("  Hello  ");
  });

  it("trim ▶ split", () => {
    const s = str("  the quick brown  ");
    const a = s.trim().split(/\s+/);
    expect([...a.values.value]).toEqual(["the", "quick", "brown"]);
    w(a.cells[0]).value = "a";
    expect(s.value).toBe("  a quick brown  ");
  });

  it("RO derivation off a chain tracks without writes", () => {
    const s = str("  Hello World  ");
    const len = Num.derive(() => s.trim().value.length);
    expect(len.value).toBe(11);
    s.value = "  Hi  ";
    expect(len.value).toBe(2);
  });

  it("empty string survives every projection", () => {
    const s = str("");
    expect(s.trim().value).toBe("");
    expect(s.reverse().value).toBe("");
    expect(s.slice(0, 3).value).toBe("");
    expect([...s.split(/\s+/).values.value]).toEqual([""]);
  });
});

interface StrSourceAndLens extends SourceAndLens<string, string> {}
void approxNumber;
void ({} as StrSourceAndLens);
