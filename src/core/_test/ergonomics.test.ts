// Ergonomics layer: optic-as-value (`lens`/`iso`/`atKey`), the lens-backed
// `store` proxy, debug labels/`explain`/`dumpGraph`/`traceWrites`, and the
// `name` cell option. All sit on top of the engine, so these mostly pin the
// user-visible contracts (round-trips, spread-replace, identity).

import { describe, expect, it } from "vitest";
import { cell, lens } from "../cell";
import { dumpGraph, explain, label, traceWrites } from "../debug";
import { atKey, iso, optic } from "../optic";
import { at } from "../optics";
import { store } from "../store";

type Rgb = { r: number; g: number; b: number };

describe("optics as values", () => {
  it("iso round-trips forward and writes back", () => {
    const c = cell(0);
    const f = c.lens(
      iso(
        x => (x * 9) / 5 + 32,
        x => ((x - 32) * 5) / 9,
      ),
    );
    expect(f.value).toBe(32);
    f.value = 212;
    expect(c.value).toBe(100);
  });

  it("atKey projects a field and puts back spread-replace", () => {
    const o = cell<Rgb>({ r: 1, g: 2, b: 3 });
    const r = o.lens(atKey("r"));
    expect(r.value).toBe(1);
    r.value = 9;
    expect(o.value).toEqual({ r: 9, g: 2, b: 3 });
  });

  it("variadic lens composes left-to-right", () => {
    const c = cell<Rgb>({ r: 10, g: 20, b: 30 });
    // pick g, then scale it ×2
    const g2 = c.lens(
      atKey<Rgb, "g">("g"),
      iso<number, number>(
        x => x * 2,
        x => x / 2,
      ),
    );
    expect(g2.value).toBe(40);
    g2.value = 100;
    expect(c.value).toEqual({ r: 10, g: 50, b: 30 });
  });

  it("optic put arity distinguishes source-reading from iso", () => {
    const sourceReading = optic<Rgb, number>(
      o => o.r,
      (v, o) => ({ ...o, r: v }),
    );
    expect(sourceReading.put.length).toBe(2);
    expect(
      iso(
        (x: number) => x,
        x => x,
      ).put.length,
    ).toBe(1);
  });
});

describe("lens-backed store", () => {
  type State = { user: { name: string; age: number }; theme: { dark: boolean } };
  const seed = (): State => ({ user: { name: "ada", age: 36 }, theme: { dark: false } });

  it("reads deep paths", () => {
    const st = store(cell(seed()));
    expect(st.user.name.value).toBe("ada");
    expect(st.theme.dark.value).toBe(false);
  });

  it("writes deep through .value with spread-replace siblings preserved", () => {
    const s = cell(seed());
    const st = store(s);
    st.user.name.value = "ada lovelace";
    expect(s.value.user.name).toBe("ada lovelace");
    expect(s.value.user.age).toBe(36);
    expect(s.value.theme).toEqual({ dark: false });
  });

  it("at over an array element preserves array type on write", () => {
    // Object-spread cloning would demote the array to a plain record; `at` must
    // keep it an array so list-shaped docs survive a field write.
    const c = cell<number[]>([1, 2, 3]);
    const one = at(c, 1);
    expect(one.value).toBe(2);
    one.value = 20;
    expect(Array.isArray(c.value)).toBe(true);
    expect(c.value).toEqual([1, 20, 3]);
  });

  it("memoizes child stores and field lenses (stable identity)", () => {
    const st = store(cell(seed()));
    expect(st.user).toBe(st.user);
    expect(st.user.name).toBe(st.user.name);
  });

  it("supports `in` without throwing on primitive leaves", () => {
    const st = store(cell(seed()));
    expect("name" in st.user).toBe(true);
    expect("missing" in st.user).toBe(false);
    expect(() => "anything" in st.user.name).not.toThrow();
  });

  it("works over a lens root (stays one source of truth)", () => {
    const s = cell(seed());
    const userLens = s.lens(atKey("user"));
    const st = store(userLens);
    st.age.value = 37;
    expect(s.value.user.age).toBe(37);
    expect(s.value.user.name).toBe("ada");
  });
});

describe("debug tools", () => {
  it("name option drives the label", () => {
    const x = cell(2, { name: "x" });
    expect(label(x)).toBe("x");
    expect(explain(x)).toContain("x = 2");
    expect(explain(x)).toContain("[source]");
  });

  it("dumpGraph shows the upstream tree", () => {
    const a = cell(1, { name: "a" });
    const b = cell(2, { name: "b" });
    const sum = lens(
      { a, b },
      ({ a, b }) => a + b,
      (t: number) => ({ a: t - 2, b: 2 }),
    );
    (sum as { name?: string }).name = "sum";
    const dump = dumpGraph(sum);
    expect(dump).toContain("sum =");
    expect(dump).toContain("a = 1");
    expect(dump).toContain("b = 2");
  });

  it("traceWrites records source writes from a back-write", () => {
    const s = cell(0, { name: "s" });
    const f = s.lens(
      iso(
        x => x + 1,
        x => x - 1,
      ),
    );
    const { writes } = traceWrites(() => {
      f.value = 10;
      void s.value; // pull to resolve the armed back-write
    });
    expect(writes).toContain(s);
  });
});
