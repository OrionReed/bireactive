// types.test.ts — compile-time guarantees for Writable<R>.

import { describe, expect, it } from "vitest";
import { type Cell, derive, num, type Traits, Vec, vec, type Writable } from "../index";

describe("compile-time guarantees", () => {
  it("Writable<R> field lenses are settable at runtime and tsc", () => {
    const v: Writable<Vec> = vec(1, 2);
    v.x.value = 5;
    expect(v.x.value).toBe(5);
  });
});

function _probes(): void {
  const v: Writable<Vec> = vec(1, 2);
  v.value = { x: 0, y: 0 };
  v.x.value = 5; // field lens lifted to Writable<Num>

  // Bare-value-class direct writes ERROR at the type level. `Cell`
  // declares `value` as `readonly` (the runtime accessor is installed
  // on the prototype after class declaration); `Writable<R>` adds a
  // settable `value` via intersection.
  const ro: Vec = v.normalize();
  // @ts-expect-error — bare Vec.value is read-only at the type level
  ro.value = { x: 0, y: 0 };
  // @ts-expect-error — bare Vec.x → bare Num, also read-only
  ro.x.value = 5;

  // Eager invertible chain — Writable<Vec> stays writable
  const chain = v.add({ x: 1, y: 0 }).scale(2);
  chain.value = { x: 0, y: 0 };

  // Buggy fn — declaring a Vec parameter implies "RO surface."
  function _buggy(p: Vec) {
    // @ts-expect-error — RO .value
    p.value = { x: 0, y: 0 };
    // @ts-expect-error — RO field lens
    p.x.value = 5;
  }
  void _buggy;

  // Generic over T, requires writable surface (brand) + listed traits. The `_t`
  // slot carries the static traits dict at the type level, so `Traits<T, ...>`
  // verifies presence at compile time. Bare RO Vec is rejected via the brand.
  function spring<T>(s: Writable<Cell<T>> & Traits<T, "linear" | "metric">, target: T): void {
    s.value = target;
  }
  spring(v, { x: 0, y: 0 }); // Writable<Vec> ⊆ Writable<Cell<V>>
  spring(num(5), 10);
  // @ts-expect-error — bare Vec has no WritableBrand
  spring(ro, { x: 0, y: 0 });
  // @ts-expect-error — Vec from `new Vec()` has no brand
  spring(new Vec(), { x: 0, y: 0 });

  // `Read<Inner<Vec>>` accepts anything with `{ readonly value; peek() }` (bare
  // Vec, Writable<Vec>, custom readers). Stricter `(p: Vec)` accepts only bare
  // Vec — Writable<Vec>'s lifted invertibles mismatch TS's variance check.
  function readVec(p: import("../cell").Read<{ x: number; y: number }>) {
    return p.value;
  }
  void readVec(v); // ✓ Writable<Vec> has readable value
  void readVec(ro); // ✓ bare Vec
  void readVec({ value: { x: 0, y: 0 }, peek: () => ({ x: 0, y: 0 }) });

  const c = derive(() => 1);
  // @ts-expect-error — bare `Cell<T>` is RO at the type level
  // (the class declares `readonly value: T`; the runtime accessor is
  // installed on the prototype). `cell(...)` returns
  // `Writable<Cell<T>>` for writable sources.
  c.value = 5;

  void chain;
}
_probes;
if (Math.random() < -1) _probes();
