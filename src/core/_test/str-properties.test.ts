// Property / random tests for the lean Str surface (reverse / trim / slice /
// split), organised by the laws in the literature. References:
//
//   Foster, Greenwald, Moore, Pierce, Schmitt (TOPLAS 2007) — GetPut/PutGet/PutPut.
//   Hofmann, Pierce, Wagner (POPL 2011, "Symmetric Lenses") — complement + PutRL/PutLR.
//
// Word/case lenses (caseFold) are tested in lenses/_test/text.test.ts.

import { describe, expect, it } from "vitest";
import type { Writable } from "../cell";
import { type Str, str } from "../values/str";
import {
  type SourceAndLens,
  verifyGetPut,
  verifyLensLaws,
  verifyPutGet,
  verifyPutPut,
  verifyReadStability,
} from "./_laws";

const TRIALS = 100;

const rngInt = (lo: number, hi: number): number => lo + Math.floor(Math.random() * (hi - lo + 1));
const rngChar = (chars: string): string => chars.charAt(rngInt(0, chars.length - 1));

const LETTERS = "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ";
const DIGITS = "0123456789";
const PUNCT = ".,!?;:-_'";
const WS = " \t\n";

const rngMixed = (len: number): string => {
  let s = "";
  for (let i = 0; i < len; i++) {
    const r = Math.random();
    if (r < 0.6) s += rngChar(LETTERS);
    else if (r < 0.7) s += rngChar(DIGITS);
    else if (r < 0.85) s += rngChar(PUNCT);
    else s += rngChar(WS);
  }
  return s;
};

const rngWord = (): string => {
  const n = rngInt(1, 8);
  let s = "";
  for (let i = 0; i < n; i++) s += rngChar(LETTERS);
  return s;
};

const rngSentence = (minWords = 1, maxWords = 8): string => {
  const n = rngInt(minWords, maxWords);
  const lead = Math.random() < 0.3 ? rngChar(WS).repeat(rngInt(1, 3)) : "";
  const trail = Math.random() < 0.3 ? rngChar(WS).repeat(rngInt(1, 3)) : "";
  let s = lead;
  for (let i = 0; i < n; i++) {
    s += rngWord();
    if (i < n - 1) s += " ";
  }
  return s + trail;
};

const strEq = (a: string, b: string) => a === b;

const makeLens = <V>(
  s: Writable<Str>,
  lens: { value: V; peek(): V },
): SourceAndLens<string, V> => ({
  source: {
    get value(): string {
      return s.peek();
    },
    set value(v: string) {
      s.value = v;
    },
    peek: () => s.peek(),
  },
  lens,
});

describe("PROPERTY: reverse — strict laws (involution)", () => {
  it("classical laws over random mixed strings", () => {
    verifyLensLaws(
      () => {
        const s = str(rngMixed(rngInt(0, 20)));
        return makeLens(s, s.reverse());
      },
      () => rngMixed(rngInt(0, 20)),
      { trials: TRIALS, sourceEq: strEq, viewEq: strEq },
    );
  });

  it("involution: reverse(reverse(s)) = s", () => {
    for (let i = 0; i < TRIALS; i++) {
      const v = rngMixed(rngInt(0, 30));
      const s = str(v);
      expect(s.reverse().reverse().value).toBe(v);
    }
  });
});

describe("PROPERTY: trim — classical laws within view domain", () => {
  it("GetPut over random padded sentences", () => {
    verifyGetPut(
      () => {
        const s = str(rngSentence());
        const t = s.trim();
        t.peek();
        return makeLens(s, t);
      },
      { trials: TRIALS, sourceEq: strEq },
    );
  });

  it("PutGet over random no-edge strings", () => {
    verifyPutGet(
      () => {
        const s = str(rngSentence());
        const t = s.trim();
        t.peek();
        return makeLens(s, t);
      },
      () => rngSentence().replace(/^\s+|\s+$/g, ""),
      { trials: TRIALS, viewEq: strEq },
    );
  });

  it("PutPut over random no-edge strings", () => {
    verifyPutPut(
      () => {
        const s = str(rngSentence());
        const t = s.trim();
        t.peek();
        return makeLens(s, t);
      },
      () => rngSentence().replace(/^\s+|\s+$/g, ""),
      { trials: TRIALS, sourceEq: strEq },
    );
  });

  it("read stability", () => {
    verifyReadStability(
      () => {
        const s = str(rngSentence());
        return makeLens(s, s.trim());
      },
      { trials: TRIALS, sourceEq: strEq, viewEq: strEq, reads: 5 },
    );
  });

  it("PutRL: putr ▶ putl returns source", () => {
    for (let i = 0; i < TRIALS; i++) {
      const source = rngSentence();
      const s = str(source);
      const t = s.trim();
      t.peek();
      t.value = t.value;
      expect(s.value).toBe(source);
    }
  });
});

describe("PROPERTY: split — round-trip + structural reversibility", () => {
  it("the view round-trips: read all segments, write each back, source intact", () => {
    for (let i = 0; i < TRIALS; i++) {
      const source = rngSentence(1, 6);
      const s = str(source);
      const a = s.split(/\s+/);
      const cells = a.cells;
      for (let k = 0; k < cells.length; k++) {
        (cells[k] as { value: string }).value = cells[k]!.value;
      }
      expect(s.value).toBe(source);
    }
  });

  it("editing one segment changes only that piece", () => {
    for (let i = 0; i < TRIALS; i++) {
      const source = rngSentence(2, 6).replace(/^\s+|\s+$/g, "");
      const s = str(source);
      const a = s.split(/\s+/);
      const before = [...a.values.value];
      const idx = rngInt(0, before.length - 1);
      const w = rngWord();
      (a.cells[idx] as { value: string }).value = w;
      const after = [...a.values.value];
      const expected = before.slice();
      expected[idx] = w;
      expect(after).toEqual(expected);
    }
  });

  it("insert then remove of the same word round-trips", () => {
    for (let i = 0; i < TRIALS; i++) {
      const source = rngSentence(1, 5).replace(/^\s+|\s+$/g, "");
      const s = str(source);
      const a = s.split(/\s+/);
      const at = rngInt(0, a.cells.length);
      const added = a.insert(rngWord(), at);
      a.remove(added);
      expect(s.value).toBe(source);
    }
  });
});

describe("PROPERTY: slice — windowed splice", () => {
  it("GetPut: writing back the read window is a no-op", () => {
    verifyGetPut(
      () => {
        const src = rngMixed(rngInt(4, 20));
        const s = str(src);
        const a = rngInt(0, src.length);
        const b = rngInt(a, src.length);
        return makeLens(s, s.slice(a, b));
      },
      { trials: TRIALS, sourceEq: strEq },
    );
  });
});

void ({} as SourceAndLens<string, string>);
