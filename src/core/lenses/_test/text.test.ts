// caseFold (case-preserving find/replace) + the word/case helpers it shares
// with Str.split. The Foster/Pierce headline: editing a folded view recovers
// the source's per-word case on write-back, by content then by position.

import { describe, expect, it } from "vitest";
import {
  type SourceAndLens,
  verifyGetPut,
  verifyLensLaws,
  verifyPutGet,
  verifyPutPut,
  verifyReadStability,
  verifyRecovery,
} from "../../_test/_laws";
import { effect, settle } from "../../cell";
import { Num } from "../../values/num";
import { str } from "../../values/str";
import {
  applyCaseMask,
  applyCasePattern,
  caseFold,
  caseMaskOf,
  parseWords,
  rebuildWords,
} from "../text";

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
const rngLowerWord = (): string => {
  const n = 1 + Math.floor(Math.random() * 8);
  let s = "";
  for (let i = 0; i < n; i++) s += String.fromCharCode(97 + Math.floor(Math.random() * 26));
  return s;
};

describe("caseFold — read", () => {
  it("folds to lower by default", () => {
    expect(caseFold(str("Hello World")).value).toBe("hello world");
  });

  it("folds to upper when asked", () => {
    expect(caseFold(str("Hello"), "upper").value).toBe("HELLO");
  });
});

describe("caseFold — write recovers source case", () => {
  it("Foster headline: lower view, write preserves per-word case", () => {
    const s = str("Hello World");
    const lo = caseFold(s);
    lo.peek();
    lo.value = "world fox";
    expect(s.value).toBe("World Fox");
  });

  it("mixed-case write preserves per-word case", () => {
    const s = str("Quick BROWN fox");
    const lo = caseFold(s);
    expect(lo.value).toBe("quick brown fox");
    lo.value = "happy purple cat";
    expect(s.value).toBe("Happy PURPLE cat");
  });

  it("longer write — word-aware case applies to the whole new word", () => {
    const s = str("Hi");
    const lo = caseFold(s);
    lo.peek();
    lo.value = "hello!";
    expect(s.value).toBe("Hello!");
  });

  it("shorter write — mask of word i applies to new word i", () => {
    const s = str("HELLO");
    const lo = caseFold(s);
    lo.peek();
    lo.value = "bye";
    expect(s.value).toBe("BYE");
  });

  it("punctuation positions are separators — only word chars get cased", () => {
    const s = str("Hi!");
    const lo = caseFold(s);
    lo.peek();
    lo.value = "go?";
    expect(s.value).toBe("Go?");
  });

  it("overflow words past the source keep target case", () => {
    const s = str("Hello");
    const lo = caseFold(s);
    lo.peek();
    lo.value = "world fox cat";
    expect(s.value).toBe("World fox cat");
  });

  it("upper view, write preserves source casing", () => {
    const s = str("Hello World");
    const up = caseFold(s, "upper");
    up.peek();
    up.value = "WORLD FOX";
    expect(s.value).toBe("World Fox");
  });
});

describe("caseFold — case preserved under structural edits (Boomerang)", () => {
  it("reorder preserves each word's case BY CONTENT", () => {
    const s = str("Hello world");
    const lo = caseFold(s);
    lo.peek();
    lo.value = "world hello";
    expect(s.value).toBe("world Hello");
  });

  it("split a word then rejoin restores original case", () => {
    const s = str("The Quick Brown Fox");
    const lo = caseFold(s);
    lo.peek();
    expect(lo.value).toBe("the quick brown fox");
    lo.value = "the q uick brown fox";
    lo.value = "the quick brown fox";
    expect(s.value).toBe("The Quick Brown Fox");
  });

  it("insert a new word then remove it round-trips", () => {
    const s = str("Hello World");
    const lo = caseFold(s);
    lo.peek();
    lo.value = "hello lazy world";
    expect(s.value).toBe("Hello Lazy World");
    lo.value = "hello world";
    expect(s.value).toBe("Hello World");
  });

  it("duplicates: FIFO case consumption", () => {
    const s = str("Hello hello");
    const lo = caseFold(s);
    lo.peek();
    lo.value = "world world";
    expect(s.value).toBe("World world");
  });

  it("external source change refreshes the mask", () => {
    const s = str("Hello World");
    const lo = caseFold(s);
    lo.peek();
    lo.value = "hello fox";
    expect(s.value).toBe("Hello Fox");
    s.value = "GREETINGS WORLD";
    expect(lo.value).toBe("greetings world");
    lo.value = "hi fox";
    expect(s.value).toBe("HI FOX");
  });
});

describe("caseFold — classical laws", () => {
  it("PutGet within lowercased domain", () => {
    verifyPutGet(
      () => {
        const s = str(rngString(10));
        return { source: s, lens: caseFold(s) };
      },
      () => rngString(10).toLowerCase(),
      { viewEq: strEq },
    );
  });

  it("GetPut", () => {
    verifyGetPut(
      () => {
        const s = str(rngString(10));
        const lens = caseFold(s);
        lens.peek();
        return { source: s, lens };
      },
      { sourceEq: strEq },
    );
  });

  it("PutPut", () => {
    verifyPutPut(
      () => {
        const s = str(rngString(8));
        const lens = caseFold(s);
        lens.peek();
        return { source: s, lens };
      },
      () => rngString(8).toLowerCase(),
      { sourceEq: strEq },
    );
  });

  it("upper — full laws", () => {
    verifyLensLaws(
      () => {
        const s = str(rngString(8));
        const up = caseFold(s, "upper");
        up.peek();
        return { source: s, lens: up };
      },
      () => rngString(8).toUpperCase(),
      { viewEq: strEq, sourceEq: strEq },
    );
  });

  it("read stability", () => {
    verifyReadStability(
      () => {
        const s = str("ABCdef");
        return { source: s, lens: caseFold(s) };
      },
      { viewEq: strEq, sourceEq: strEq, reads: 5 },
    );
  });

  it('recovery: "" → "foo" applies the source mask to non-empty positions', () => {
    verifyRecovery(
      () => {
        const s = str("HELLO");
        return { source: s, lens: caseFold(s) };
      },
      "",
      "foo",
      _orig => "FOO",
      { sourceEq: strEq },
    );
  });

  it("PROPERTY: reorder preserves per-word case for uniquely-keyed words", () => {
    for (let i = 0; i < 100; i++) {
      const n = 2 + Math.floor(Math.random() * 5);
      const sourceWords: string[] = [];
      for (let k = 0; k < n; k++) {
        const w = rngLowerWord();
        const cased =
          Math.random() < 0.5
            ? w
            : Math.random() < 0.5
              ? w.toUpperCase()
              : w.charAt(0).toUpperCase() + w.slice(1);
        sourceWords.push(cased);
      }
      const lowered = sourceWords.map(w => w.toLowerCase());
      if (new Set(lowered).size !== lowered.length) continue;
      const s = str(sourceWords.join(" "));
      const lo = caseFold(s);
      lo.peek();
      const order = [...Array(n).keys()].sort(() => Math.random() - 0.5);
      lo.value = order.map(i => lowered[i]!).join(" ");
      expect(s.value).toBe(order.map(i => sourceWords[i]!).join(" "));
    }
  });
});

describe("caseFold — composition + effects", () => {
  it("trim ▶ caseFold: writes propagate through both layers", () => {
    const s = str("  Hello World  ");
    const lo = caseFold(s.trim());
    lo.peek();
    expect(lo.value).toBe("hello world");
    lo.value = "world fox";
    expect(s.value).toBe("  World Fox  ");
  });

  it("caseFold ▶ reverse", () => {
    const s = str("Hello");
    const r = caseFold(s).reverse();
    r.peek();
    expect(r.value).toBe("olleh");
    r.value = "dlrow";
    expect(s.value).toBe("World");
  });

  it("effect fires when written through caseFold", () => {
    const s = str("Hello World");
    const lo = caseFold(s);
    lo.peek();
    let last = lo.value;
    let fires = 0;
    const dispose = effect(() => {
      last = lo.value;
      fires++;
    });
    fires = 0;
    lo.value = "hi bye";
    settle();
    expect(last).toBe("hi bye");
    expect(fires).toBe(1);
    dispose();
  });

  it("RO derivation off caseFold tracks without writes", () => {
    const s = str("  Hello World  ");
    const lo = caseFold(s.trim());
    const len = Num.derive(() => lo.value.length);
    expect(len.value).toBe(11);
    s.value = "  Hi  ";
    expect(len.value).toBe(2);
  });
});

describe("word/case helpers", () => {
  it("parseWords / rebuildWords round-trip", () => {
    const cases = [
      "",
      "hello",
      "  hello",
      "hello  ",
      "  hello world  ",
      "hello,\tworld!",
      "  The Quick Brown Fox  ",
      "Hi.",
      "no-trail",
      "   ",
      "...",
      "a.b.c",
    ];
    for (const s of cases) {
      const { words, seps } = parseWords(s);
      expect(rebuildWords(words, seps)).toBe(s);
    }
  });

  it("caseMaskOf is length-preserving with U/L/space alphabet", () => {
    expect(caseMaskOf("Hi!")).toBe("UL ");
    expect(caseMaskOf("ABC")).toBe("UUU");
    expect(caseMaskOf("abc")).toBe("LLL");
    expect(caseMaskOf("a B c")).toBe("L U L");
  });

  it("applyCaseMask preserves overflow when target > mask", () => {
    expect(applyCaseMask("hello world", "UL")).toBe("Hello world");
  });

  it("applyCasePattern detects all-upper / all-lower / title", () => {
    expect(applyCasePattern("hello", "UUUUU")).toBe("HELLO");
    expect(applyCasePattern("HELLO", "LLLLL")).toBe("hello");
    expect(applyCasePattern("hello", "UL")).toBe("Hello");
  });
});

// Satisfy the law-harness type import without an active source/lens.
void ({} as SourceAndLens<string, string>);
