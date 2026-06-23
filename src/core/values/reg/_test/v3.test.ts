// v3.test.ts — the capabilities v3 adds over the 1-unambiguous v2 parser:
//   1. full unambiguity — common-prefix alternations and longest-match splits
//      that a single-pass parser can't handle (linear NFA/PikeVM),
//   2. construction-time ambiguity rejection with a concrete witness string,
//   3. captures inside `alt` branches,
//   4. non-`lit` separators and multi-char `until`,
//   5. `reg.optic()` composition with the rest of the lens algebra.

import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { type Cell, iso, optic, type Writable } from "../../../index";
import type { Arr } from "../../arr";
import { type Handle, Reg } from "../../reg";
import { type Str, str } from "../../str";

// biome-ignore lint/suspicious/noExplicitAny: V-erased grammar supertype
type G = Reg<any, any, any, any>;
const asStr = (h: Handle): Writable<Str> => h as unknown as Writable<Str>;
const asArr = (h: Handle): Arr<string> => h as unknown as Arr<string>;

// ── full unambiguity: things v2 rejected, v3 parses ────────────────────

describe("Reg v3 — full unambiguity (linear, no backtracking)", () => {
  it("common-prefix alternations parse (copy leaves)", () => {
    const g = Reg.alt(Reg.copy(/INFO/), Reg.copy(/INes/));
    expect(g.match("INFO")).toEqual({ branch: 0, val: "INFO" });
    expect(g.match("INes")).toEqual({ branch: 1, val: "INes" });
    expect(g.test("IN")).toBe(false);
    expect(g.test("INF")).toBe(false);
  });

  it("common-prefix alternations parse (lit branches)", () => {
    const g = Reg.alt(Reg.lit("--verbose"), Reg.lit("--version"));
    expect(g.test("--verbose")).toBe(true);
    expect(g.test("--version")).toBe(true);
    expect(g.test("--ver")).toBe(false);
  });

  it("longest-match split on a fixed-width left factor", () => {
    const g = Reg.copy(/\d\d/).then(Reg.digits());
    expect(g.match("1234")).toEqual(["12", "34"]);
    expect(g.match("123")).toEqual(["12", "3"]);
    expect(g.test("1")).toBe(false);
  });

  it("a wider fixed prefix then a variable tail", () => {
    const g = Reg.copy(/\d{4}/).then(Reg.lit("-"), Reg.digits());
    expect(g.match("2026-7")).toEqual(["2026", "7"]);
  });

  it("recognition agrees with native anchored RegExp on common-prefix grammars", () => {
    const cases: Array<[G, RegExp]> = [
      [Reg.alt(Reg.copy(/INFO/), Reg.copy(/INes/)), /^(INFO|INes)$/],
      [Reg.alt(Reg.lit("--verbose"), Reg.lit("--version")), /^(--verbose|--version)$/],
      [Reg.copy(/\d\d/).then(Reg.digits()), /^\d\d\d+$/],
    ];
    const alphabet = "INFOes-0123v";
    for (const [g, re] of cases) {
      for (let k = 0; k < 400; k++) {
        let s = "";
        const n = Math.floor(Math.random() * 8);
        for (let i = 0; i < n; i++) s += alphabet[Math.floor(Math.random() * alphabet.length)];
        expect(g.test(s)).toBe(re.test(s));
      }
    }
  });
});

// ── construction-time rejection names a witness ────────────────────────

describe("Reg v3 — ambiguity rejected with a witness string", () => {
  const ambiguous: Array<[string, () => unknown, RegExp]> = [
    ["two variable-width captures", () => Reg.digits().then(Reg.copy(/\d+/)), /splits two ways/],
    ["nullable non-final", () => Reg.copy(/\d*/).then(Reg.digits()), /splits two ways/],
    ["self-running star", () => Reg.copy(/a+/).star(), /iterates two ways/],
    ["identical alt branches", () => Reg.alt(Reg.copy(/[ab]+/), Reg.copy(/[ab]+/)), /both match/],
    ["keyword ⊂ identifier", () => Reg.alt(Reg.copy(/for/), Reg.copy(/[a-z]+/)), /both match/],
  ];
  for (const [name, build, msg] of ambiguous) {
    it(`throws naming a witness: ${name}`, () => {
      expect(build).toThrow(msg);
      // The message embeds a concrete doubly-parsing input (a quoted string).
      let caught = "";
      try {
        build();
      } catch (e) {
        caught = (e as Error).message;
      }
      expect(caught).toMatch(/"[^"]*"/);
    });
  }
});

// ── captures inside an alt branch ──────────────────────────────────────

describe("Reg v3 — captures inside alt", () => {
  const g = Reg.alt(
    Reg.lit("n:").then(Reg.digits().as("num")),
    Reg.lit("w:").then(Reg.letters().as("word")),
  );

  it("spans descend into the matched branch", () => {
    expect(g.spans("n:42")).toEqual({ num: [2, 4] });
    expect(g.spans("w:hi")).toEqual({ word: [2, 4] });
  });

  it("the active branch's handle reads and writes; the inactive one is inert", () => {
    const s = str("n:42");
    const h = g.bind(s) as { num: Handle; word: Handle };
    expect(asStr(h.num).value).toBe("42");
    expect(asStr(h.word).value).toBe(""); // inactive branch
    asStr(h.num).value = "99";
    expect(s.value).toBe("n:99");
    asStr(h.word).value = "zzz"; // inactive: no-op
    expect(s.value).toBe("n:99");
  });
});

// ── non-lit separators and multi-char until ────────────────────────────

describe("Reg v3 — separators and until", () => {
  it("a non-lit separator inserts its shortest accepted member", () => {
    const g = Reg.digits().star(Reg.copy(/-+/)).as("xs");
    const s = str("1-2--3");
    const arr = asArr(g.bind(s).xs);
    expect(arr.values.value).toEqual(["1", "2", "3"]);
    arr.push("9");
    expect(s.value).toBe("1-2--3-9"); // joiner is the shortest separator, "-"
  });

  it("multi-char until excludes every listed delimiter", () => {
    const u = Reg.until(",;");
    expect(u.match("ab")).toBe("ab");
    expect(u.match("a,b")).toBeNull();
    expect(u.match("a;b")).toBeNull();
  });
});

// ── reg.optic(): composition with the lens algebra ─────────────────────

const dateGrammar = Reg.digits().then(Reg.lit("-"), Reg.digits(), Reg.lit("-"), Reg.digits());

describe("Reg v3 — optic composition", () => {
  it("obeys the optic round-trip laws (GetPut / PutGet)", () => {
    const o = dateGrammar.optic();
    fc.assert(
      fc.property(
        fc.stringMatching(/^\d{1,3}$/),
        fc.stringMatching(/^\d{1,3}$/),
        fc.stringMatching(/^\d{1,3}$/),
        (y, m, d) => {
          const s = `${y}-${m}-${d}`;
          expect(o.put(o.get(s), s)).toBe(s); // GetPut
          const v: [string, string, string] = [y, m, d];
          expect(o.get(o.put(v, s))).toEqual(v); // PutGet
        },
      ),
    );
  });

  it("composes through an iso into a different surface syntax", () => {
    const s = str("12-7-2024");
    const slashed = s.through(
      dateGrammar.optic(),
      iso(
        (v: [string, string, string]) => v.join("/"),
        (t: string) => t.split("/") as [string, string, string],
      ),
    ) as unknown as Cell<string> & { value: string };
    expect(slashed.value).toBe("12/7/2024");
    slashed.value = "1/2/3";
    expect(s.value).toBe("1-2-3");
  });

  it("cell.through(reg.optic()) matches view()", () => {
    const s = str("12-7-2024");
    const view = dateGrammar.view(s);
    expect(view.value).toEqual(["12", "7", "2024"]);
    view.value = ["1", "1", "1"];
    expect(s.value).toBe("1-1-1");
  });

  it("multi-format round-trip: one source, three grammars, all in sync", () => {
    type Pairs = unknown;
    const stripSeps = (v: Pairs): Pairs =>
      Array.isArray(v)
        ? v.map(stripSeps)
        : v !== null && typeof v === "object" && "items" in v
          ? { items: (v as { items: Pairs[] }).items.map(stripSeps), seps: [] }
          : v;
    const fmt = (r: G) =>
      optic<Pairs, string>(
        v => r.print(stripSeps(v)),
        (t: string, v: Pairs) => stripSeps(r.match(t) ?? v),
      );

    const query = Reg.word().then(Reg.lit("="), Reg.until("&")).star(Reg.lit("&")) as G;
    const lines = Reg.word().then(Reg.lit(": "), Reg.until("\n")).star(Reg.lit("\n")) as G;
    const compact = Reg.word().then(Reg.lit(","), Reg.until(";")).star(Reg.lit(";")) as G;

    const source = str("host=localhost&port=8080");
    const linesView = source.through(query.optic(), fmt(lines)) as unknown as { value: string };
    const compactView = source.through(query.optic(), fmt(compact)) as unknown as {
      value: string;
    };

    expect(linesView.value).toBe("host: localhost\nport: 8080");
    expect(compactView.value).toBe("host,localhost;port,8080");

    linesView.value = "host: 127.0.0.1\nport: 9090";
    expect(source.value).toBe("host=127.0.0.1&port=9090");
    expect(compactView.value).toBe("host,127.0.0.1;port,9090");

    compactView.value = "host,example.com;port,443";
    expect(source.value).toBe("host=example.com&port=443");
  });
});

// ── the demo grammars (md-reg-playground) ──────────────────────────────

describe("Reg v3 — playground grammars", () => {
  // A common-prefix alternation whose branches all carry the *same* capture
  // name — the active branch alone reports its span (what the demo strip draws).
  const method = Reg.alt(
    Reg.copy(/GET/).as("method"),
    Reg.copy(/POST/).as("method"),
    Reg.copy(/PUT/).as("method"),
    Reg.copy(/PATCH/).as("method"),
    Reg.copy(/DELETE/).as("method"),
  ).then(Reg.lit(" "), Reg.copy(/[^ ]+/).as("path"));

  it("HTTP request line: common-prefix branches share a capture name", () => {
    expect(method.spans("PATCH /users/42")).toEqual({ method: [0, 5], path: [6, 15] });
    expect(method.spans("PUT /x")).toEqual({ method: [0, 3], path: [4, 6] });
    expect(method.test("P /x")).toBe(false); // a prefix is not a method
    expect(method.test("GET")).toBe(false); // needs a path
    expect(method.print(method.match("DELETE /a/b")!)).toBe("DELETE /a/b");
  });

  const semver = Reg.int()
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
    );

  it("semantic version: optional longest-match tail", () => {
    expect(semver.match("1.2.3")).toEqual([1, 2, 3, null, null]);
    expect(semver.match("2.0.0-rc.1")).toEqual([2, 0, 0, ["rc.1"], null]);
    expect(semver.match("1.2.3-beta.1+build5")).toEqual([1, 2, 3, ["beta.1"], ["build5"]]);
    expect(semver.spans("1.2.3-beta.1+build5")).toEqual({
      major: [0, 1],
      minor: [2, 3],
      patch: [4, 5],
      pre: [6, 12],
      build: [13, 19],
    });
    expect(semver.print(semver.match("3.4.5-x.9+y.0")!)).toBe("3.4.5-x.9+y.0");
  });

  const date = Reg.copy(/\d{4}/).as("y").then(Reg.copy(/\d\d/).as("mo"), Reg.copy(/\d\d/).as("d"));

  it("compact date: fixed-width fields with no delimiters", () => {
    expect(date.match("20260623")).toEqual(["2026", "06", "23"]);
    expect(date.spans("20260623")).toEqual({ y: [0, 4], mo: [4, 6], d: [6, 8] });
    expect(date.test("2026062")).toBe(false); // one digit short
    expect(date.test("202606230")).toBe(false); // one digit over
  });
});

// ── round-trip & differential properties (try to break it) ─────────────

describe("Reg v3 — round-trip and differential properties", () => {
  it("print ∘ match is identity on the request-line grammar", () => {
    const method = Reg.alt(
      Reg.copy(/GET/),
      Reg.copy(/POST/),
      Reg.copy(/PUT/),
      Reg.copy(/PATCH/),
      Reg.copy(/DELETE/),
    ).then(Reg.lit(" "), Reg.copy(/[^ ]+/));
    fc.assert(
      fc.property(
        fc.constantFrom("GET", "POST", "PUT", "PATCH", "DELETE"),
        fc.stringMatching(/^[^ ]+$/),
        (m, p) => {
          const s = `${m} ${p}`;
          expect(method.test(s)).toBe(true);
          expect(method.print(method.match(s)!)).toBe(s);
        },
      ),
    );
  });

  it("print ∘ match is identity on the fixed-width date grammar", () => {
    const date = Reg.copy(/\d{4}/).then(Reg.copy(/\d\d/), Reg.copy(/\d\d/));
    fc.assert(
      fc.property(fc.stringMatching(/^\d{8}$/), s => {
        expect(date.print(date.match(s)!)).toBe(s);
      }),
    );
  });

  it("recognition agrees with anchored RegExp on the playground shapes", () => {
    const cases: Array<[G, RegExp]> = [
      [
        Reg.alt(Reg.copy(/GET/), Reg.copy(/POST/), Reg.copy(/PUT/), Reg.copy(/PATCH/)).then(
          Reg.lit(" "),
          Reg.copy(/[^ ]+/),
        ),
        /^(GET|POST|PUT|PATCH) [^ ]+$/,
      ],
      [Reg.copy(/\d{4}/).then(Reg.copy(/\d\d/), Reg.copy(/\d\d/)), /^\d{8}$/],
    ];
    const alphabet = "GETPOSUACHd /0129x".split("");
    const word = fc.array(fc.constantFrom(...alphabet), { maxLength: 12 }).map(a => a.join(""));
    for (const [g, re] of cases) {
      fc.assert(
        fc.property(word, s => {
          expect(g.test(s)).toBe(re.test(s));
        }),
        { numRuns: 500 },
      );
    }
  });

  it("never throws on arbitrary input — match/test/spans are total", () => {
    const grammars: G[] = [
      Reg.alt(Reg.copy(/GET/), Reg.copy(/POST/)).then(Reg.lit(" "), Reg.copy(/[^ ]+/)),
      Reg.copy(/\d{4}/).then(Reg.copy(/\d\d/), Reg.copy(/\d\d/)),
      Reg.int().then(Reg.lit("."), Reg.int(), Reg.lit("."), Reg.int()),
    ];
    fc.assert(
      fc.property(fc.string(), s => {
        for (const g of grammars) {
          expect(() => g.test(s)).not.toThrow();
          expect(() => g.match(s)).not.toThrow();
          expect(() => g.spans(s)).not.toThrow();
          if (g.test(s)) expect(g.print(g.match(s)!)).toBe(s);
        }
      }),
    );
  });
});

// ── linearity holds for the new shapes ─────────────────────────────────

describe("Reg v3 — linear on common-prefix-heavy input", () => {
  it("a starred common-prefix alternation stays linear", () => {
    const tok = Reg.alt(Reg.copy(/INFO/), Reg.copy(/INes/), Reg.copy(/WARNING/));
    const g = tok.star(Reg.lit(" "));
    const text = Array.from({ length: 20000 }, (_, i) => (i % 2 ? "INes" : "INFO")).join(" ");
    const t0 = performance.now();
    expect(g.test(text)).toBe(true);
    expect(performance.now() - t0).toBeLessThan(1000);
  });
});
