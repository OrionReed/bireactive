// Plain-record field optics over a `Cell<T>`. Unlike `fieldOf`/`fieldLens`
// (cell.ts), which need the field's Cell constructor to return a typed value
// class, `at`/`fields` return a base `Cell<T[K]>` with full key inference and no
// constructor argument — thin sugar over `fieldOf` for plain records.

import { Cell, fieldOf, type Read, type Writable } from "./cell";

/** Writable field view of `c.value[key]` (spread-replace put). A read-only
 *  parent yields a read-only view. */
export function at<T, K extends keyof T>(c: Writable<Cell<T>>, key: K): Writable<Cell<T[K]>>;
export function at<T, K extends keyof T>(c: Read<T>, key: K): Cell<T[K]>;
export function at<T, K extends keyof T>(c: Read<T>, key: K): Cell<T[K]> {
  const ctor = Cell as unknown as new () => Cell<T[K]>;
  return fieldOf(c as unknown as Cell<unknown>, key as string | symbol, ctor) as Cell<T[K]>;
}

/** Lens view of every field, lazily and memoized — `const { r, g, b } =
 *  fields(rgb)` yields one writable `at` per key. */
export function fields<T extends object>(
  c: Writable<Cell<T>>,
): { [K in keyof T]-?: Writable<Cell<T[K]>> } {
  const cache = new Map<PropertyKey, unknown>();
  return new Proxy(Object.create(null), {
    get(_t, key: PropertyKey) {
      if (typeof key === "symbol") return undefined;
      let v = cache.get(key);
      if (v === undefined) {
        v = at(c, key as keyof T);
        cache.set(key, v);
      }
      return v;
    },
  }) as { [K in keyof T]-?: Writable<Cell<T[K]>> };
}
