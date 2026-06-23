// types.test.ts — the compile-time half of the ambiguity guarantee. These
// bodies are never executed (constructing the ambiguous grammars would throw
// at runtime); the point is that `tsc` flags the `@ts-expect-error` lines. If a
// guard regresses, the unused-directive becomes a type error and CI fails.

import { describe, expect, it } from "vitest";
import { Reg } from "../../reg";

describe("Reg — compile-time ambiguity rejection", () => {
  it("flags provably-overlapping adjacencies in the type system", () => {
    const _ambiguous = () => {
      // @ts-expect-error digits()·digits() overlap on the digit class
      Reg.digits().then(Reg.digits());
      // @ts-expect-error letters()·word() overlap on the letter classes
      Reg.letters().then(Reg.word());
      // @ts-expect-error until(",")·until(",") both end/begin on non-comma
      Reg.until(",").then(Reg.until(","));
      // @ts-expect-error a digit literal classifies to the digit class
      Reg.digits().then(Reg.lit("5"));
    };
    void _ambiguous;

    // Accepted forms type-check (no directive): delimited or disjoint.
    const _ok = () => {
      Reg.digits().then(Reg.lit("-")).then(Reg.digits());
      Reg.digits().then(Reg.letters());
      Reg.until(",").star(Reg.lit(","));
      Reg.digits().then(Reg.lit("x")); // 'x' is a letter, disjoint from digits
      Reg.copy(/\d+/).then(Reg.copy(/[a-z]+/)); // escape hatch: deferred to runtime
    };
    void _ok;

    expect(true).toBe(true);
  });
});
