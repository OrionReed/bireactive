// optics.ts — plain-record field optics over a `Cell<T>`.
//
// `fieldOf` / `fieldLens` (cell.ts) project a value-class field and need the
// field's Cell constructor, so `Vec.x` comes back as a typed `Num` carrying its
// domain methods. For a plain record you just want `Cell<T[K]>` with the same
// spread-replace put — `at` / `fields` supply that with full key inference and
// no constructor argument. Both are thin sugar over `fieldOf` with the base
// `Cell` as the result type.

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
