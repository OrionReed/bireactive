// Engine + regex-subset parser tests. The centerpiece is differential testing:
// for each supported pattern, our derivative recognizer must agree with the
// native `RegExp` (anchored) on every short string over a small alphabet.

import { describe, expect, it } from "vitest";
import { accepts, alt, CharSet, chr, der, matchLengths, nullable, seq, star } from "../engine";
import { compileRegex, RegError } from "../regex";

const ALPHABET = [..."ab12-_, .\n"];

/** All strings up to `maxLen` over the alphabet. */
function* allStrings(maxLen: number): Generator<string> {
  yield "";
  let frontier = [""];
  for (let len = 1; len <= maxLen; len++) {
    const next: string[] = [];
    for (const s of frontier)
      for (const c of ALPHABET) {
        const t = s + c;
        next.push(t);
        yield t;
      }
    frontier = next;
  }
}

describe("CharSet", () => {
  it("membership, union, complement", () => {
    const digits = CharSet.range(0x30, 0x39);
    expect(digits.has(0x35)).toBe(true);
    expect(digits.has(0x41)).toBe(false);
    const notDigits = digits.complement();
    expect(notDigits.has(0x35)).toBe(false);
    expect(notDigits.has(0x41)).toBe(true);
    const merged = CharSet.range(0x30, 0x35).union(CharSet.range(0x34, 0x39));
    expect(merged.ranges.length).toBe(1);
    expect(merged.has(0x37)).toBe(true);
  });
});

describe("derivative core (hand-built)", () => {
  const a = chr(CharSet.char(0x61));
  const b = chr(CharSet.char(0x62));

  it("nullable", () => {
    expect(nullable(a)).toBe(false);
    expect(nullable(star(a))).toBe(true);
    expect(nullable(alt(a, star(b)))).toBe(true);
  });

  it("accepts a*b", () => {
    const r = seq(star(a), b);
    expect(accepts(r, "b")).toBe(true);
    expect(accepts(r, "aaab")).toBe(true);
    expect(accepts(r, "aaa")).toBe(false);
    expect(accepts(r, "")).toBe(false);
  });

  it("der peels one char", () => {
    const r = seq(a, b);
    expect(accepts(der(r, 0x61), "b")).toBe(true);
    expect(der(r, 0x62).k).toBe("emp");
  });
});

const PATTERNS: Array<{ src: string; flags?: string }> = [
  { src: "a" },
  { src: "abc" },
  { src: "a|b" },
  { src: "a*" },
  { src: "a+" },
  { src: "a?" },
  { src: "[a-b]+" },
  { src: "[^,]*" },
  { src: "\\d+" },
  { src: "\\d{2}" },
  { src: "\\d{2,3}" },
  { src: "\\w+" },
  { src: "\\s*" },
  { src: "(ab)+" },
  { src: "(?:a|b)1" },
  { src: "a.b" },
  { src: "a.b", flags: "s" },
  { src: "[a-z]+|\\d+" },
  { src: "ab{2}" },
  { src: "1?2?-?" },
  { src: "(a|b1)*" },
  { src: "[A-Z]+", flags: "i" },
  { src: "\\d+(-\\d+)*" },
  { src: "(?<year>\\d{4})" },
];

describe("differential recognition vs native RegExp", () => {
  for (const { src, flags } of PATTERNS) {
    it(`/${src}/${flags ?? ""}`, () => {
      const re = compileRegex(new RegExp(src, flags));
      const native = new RegExp(`^(?:${src})$`, flags);
      let checked = 0;
      for (const s of allStrings(4)) {
        expect(accepts(re, s), `string ${JSON.stringify(s)} on /${src}/`).toBe(native.test(s));
        checked++;
      }
      expect(checked).toBeGreaterThan(100);
    });
  }
});

describe("matchLengths enumerates every accepting prefix", () => {
  it("\\d+ over '123x' yields [1,2,3]", () => {
    const re = compileRegex(/\d+/);
    expect(matchLengths(re, "123x", 0)).toEqual([1, 2, 3]);
  });
  it("\\d* includes 0", () => {
    const re = compileRegex(/\d*/);
    expect(matchLengths(re, "12", 0)).toEqual([0, 1, 2]);
  });
  it("respects an offset", () => {
    const re = compileRegex(/[a-z]+/);
    expect(matchLengths(re, "12abc", 2)).toEqual([1, 2, 3]);
  });
});

describe("regex subset gate", () => {
  it("rejects anchors, lookaround, backreferences, boundaries", () => {
    expect(() => compileRegex(/^a/)).toThrow(RegError);
    expect(() => compileRegex(/a$/)).toThrow(RegError);
    expect(() => compileRegex(/a(?=b)/)).toThrow(RegError);
    expect(() => compileRegex(/a(?!b)/)).toThrow(RegError);
    expect(() => compileRegex(/(?<=a)b/)).toThrow(RegError);
    expect(() => compileRegex(/(a)\1/)).toThrow(RegError);
    expect(() => compileRegex(/\bword\b/)).toThrow(RegError);
  });
  it("accepts named/non-capturing groups as plain grouping", () => {
    expect(accepts(compileRegex(/(?<y>\d{4})/), "2026")).toBe(true);
    expect(accepts(compileRegex(/(?:ab)+/), "abab")).toBe(true);
  });
});
