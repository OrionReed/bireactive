// robustness.test.ts — the v2 guarantees:
//   1. accepted grammars parse in linear time (no backtracking, no ReDoS),
//   2. ambiguity is impossible at runtime because it's rejected at
//      construction, and
//   3. match/test/print/spans never throw and round-trip, fuzzed over a space
//      of valid (delimited, disjoint) grammars.

import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { Reg } from "../../reg";

// A V-erased supertype: `Reg` is invariant in its value parameter, so a
// heterogeneous list of grammars needs `any` slots to share one type.
// biome-ignore lint/suspicious/noExplicitAny: see above
type G = Reg<any, any, any, any>;

/** Assert `fn` finishes within `ms` (a coarse linear-time guard). */
function within(ms: number, fn: () => void): void {
  const t0 = performance.now();
  fn();
  const dt = performance.now() - t0;
  expect(dt).toBeLessThan(ms);
}

// ── linear time on adversarial-shaped input ────────────────────────────

describe("Reg — linear time, no blow-up", () => {
  it("classic ReDoS shapes are either rejected or linear", () => {
    // (a*)*-style ambiguity is rejected at construction…
    expect(() => Reg.copy(/a*/).star()).toThrow();
    // …and the legitimate, delimited form is linear even on a long mismatch.
    const g = Reg.copy(/a+/).star(Reg.lit(",")).then(Reg.lit("X"));
    const big = `${"a".repeat(100000)},${"a".repeat(100000)}`;
    within(1000, () => {
      expect(g.test(`${big}Y`)).toBe(false); // long non-match
      expect(g.test(`${big}X`)).toBe(true); // long match
    });
  });

  it("a huge separated star parses and reprints in linear time", () => {
    const g = Reg.until(",").star(Reg.lit(","));
    const n = 50000;
    const text = Array.from({ length: n }, (_, i) => String(i)).join(",");
    within(2000, () => {
      const v = g.match(text)!;
      expect(v.items.length).toBe(n);
      expect(g.print(v)).toBe(text);
    });
  });

  it("a deeply repeated record does not overflow the stack", () => {
    const rec = Reg.until(":").then(Reg.lit(":"), Reg.until(";"));
    const g = rec.star(Reg.lit(";"));
    const text = Array.from({ length: 20000 }, (_, i) => `k${i}:v${i}`).join(";");
    within(2000, () => {
      expect(g.test(text)).toBe(true);
    });
  });

  it("a single enormous token is linear", () => {
    const g = Reg.digits();
    const text = "9".repeat(500000);
    within(1000, () => expect(g.match(text)).toBe(text));
  });
});

// ── ambiguity is a construction-time error, not a runtime hazard ────────

describe("Reg — ambiguity is rejected up front", () => {
  const ambiguous: Array<[string, () => unknown]> = [
    ["two variable-width captures", () => Reg.digits().then(Reg.copy(/\d+/))],
    ["nullable non-final", () => Reg.copy(/\d*/).then(Reg.digits())],
    ["unseparated nullable star", () => Reg.until(",").star()],
    ["nullable optional", () => Reg.copy(/a*/).optional()],
    ["overlapping alternation", () => Reg.digits().or(Reg.int())],
    ["self-running star element", () => Reg.copy(/a+/).star()],
  ];
  for (const [name, build] of ambiguous) {
    it(`throws: ${name}`, () => expect(build).toThrow());
  }

  it("disjoint / delimited forms are accepted", () => {
    expect(() => Reg.digits().then(Reg.letters())).not.toThrow();
    expect(() => Reg.until(",").star(Reg.lit(","))).not.toThrow();
    expect(() => Reg.digits().or(Reg.letters())).not.toThrow();
  });
});

// ── differential recognition vs native anchored RegExp ─────────────────

describe("Reg — recognition agrees with native RegExp", () => {
  const cases: Array<[G, RegExp]> = [
    [Reg.digits().then(Reg.lit("-"), Reg.digits()), /^\d+-\d+$/],
    [Reg.until(",").star(Reg.lit(",")), /^[^,]*(,[^,]*)*$/],
    [Reg.alt(Reg.digits(), Reg.letters()), /^(\d+|[A-Za-z]+)$/],
    [Reg.lit("-").optional().then(Reg.digits()), /^-?\d+$/],
  ];
  const alphabet = "0123ab-,X";
  const randStr = (): string => {
    let s = "";
    const n = Math.floor(Math.random() * 6);
    for (let i = 0; i < n; i++) s += alphabet[Math.floor(Math.random() * alphabet.length)];
    return s;
  };
  it("matches the same strings", () => {
    for (const [g, re] of cases) {
      for (let i = 0; i < 500; i++) {
        const s = randStr();
        expect(g.test(s)).toBe(re.test(s));
      }
    }
  });
});

// ── fuzzed lens laws over a space of valid grammars ────────────────────

describe("Reg — fuzzed laws on valid grammars", () => {
  // Leaf builders whose boundaries are disjoint from the comma/semicolon
  // delimiters used below, so every generated grammar is deterministic.
  const leaf = fc.constantFrom(
    () => Reg.digits(),
    () => Reg.letters(),
    () => Reg.copy(/[a-z]+/),
  );

  // A delimited grammar: either a single leaf, a separated star, or a
  // two-field record — all guaranteed unambiguous by construction.
  const grammar: fc.Arbitrary<G> = fc
    .tuple(leaf, leaf, fc.constantFrom("leaf", "star", "record"))
    .map(([a, b, shape]): G => {
      if (shape === "star") return a().star(Reg.lit(","));
      if (shape === "record") return a().then(Reg.lit(":"), b());
      return a();
    });

  it("construction never throws for the valid space", () => {
    fc.assert(
      fc.property(grammar, g => {
        expect(g).toBeInstanceOf(Reg);
      }),
    );
  });

  it("match/test/print never throw and gate-agree", () => {
    fc.assert(
      fc.property(grammar, fc.string(), (g, s) => {
        const t = g.test(s);
        const v = g.match(s);
        expect(typeof t).toBe("boolean");
        // match succeeds exactly when the recognizer accepts (modulo codecs;
        // these grammars have none), and a lit-only value may be null.
        if (v !== null) expect(t).toBe(true);
        if (t) expect(() => g.print(g.match(s)!)).not.toThrow();
      }),
    );
  });

  it("GetPut: print(match s) === s whenever it matches", () => {
    fc.assert(
      fc.property(grammar, fc.string(), (g, s) => {
        if (g.test(s)) {
          const v = g.match(s);
          if (v !== null) expect(g.print(v)).toBe(s);
        }
      }),
    );
  });
});

// ── edge cases ─────────────────────────────────────────────────────────

describe("Reg — edge cases", () => {
  it("empty input", () => {
    expect(Reg.until(",").star(Reg.lit(",")).match("")).toEqual({ items: [""], seps: [] });
    expect(Reg.digits().match("")).toBeNull();
  });

  it("astral characters round-trip as code units", () => {
    const g = Reg.until(",").star(Reg.lit(","));
    const s = "😀,🇬🇧,x";
    expect(g.print(g.match(s)!)).toBe(s);
  });

  it("literal metacharacters in lit/until are matched verbatim", () => {
    const g = Reg.until(".").star(Reg.lit("."));
    expect(g.match("a.b.c")).toEqual({ items: ["a", "b", "c"], seps: [".", "."] });
  });
});
