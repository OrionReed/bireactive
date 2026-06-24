// Deep store proxy over a `Cell`: `store(cell).a.b` is a chain of `at` field
// lenses, so it's an ordinary `Cell` (read/write `.value`, bind in JSX, compose
// with the graph). Writes are spread-replace puts back to the root.
//
// A field whose name collides with the cell surface (`value`, `peek`, `lens`,
// `derive`, `merge`, `through`) resolves to the cell member — use `at(cell, key)`
// to reach such a field.

import type { Cell, Writable } from "./cell";
import { at } from "./optics";

/** Deep store view: the cell itself, plus a `Store` per object field. Primitives
 *  and functions bottom out at the plain `Writable<Cell<T>>`. */
export type Store<T> = Writable<Cell<T>> &
  // biome-ignore lint/suspicious/noExplicitAny: structural function guard
  (T extends readonly any[]
    ? unknown
    : // biome-ignore lint/suspicious/noExplicitAny: structural function guard
      T extends (...args: any[]) => any
      ? unknown
      : T extends object
        ? { [K in keyof T]-?: Store<T[K]> }
        : unknown);

// Cell members forwarded to the underlying cell rather than treated as a field,
// plus the object protocol methods JS itself may touch.
const FORWARD = new Set<string>([
  "value",
  "peek",
  "lens",
  "derive",
  "merge",
  "through",
  "toString",
  "valueOf",
  "toJSON",
  "constructor",
]);

// One proxy per cell, so `store(c).a === store(c).a` and child stores are stable.
const wrapped = new WeakMap<Cell<unknown>, unknown>();

function wrap(cell: Cell<unknown>): unknown {
  const hit = wrapped.get(cell);
  if (hit !== undefined) return hit;

  // Per-key field lenses and their child stores, both memoized.
  const lensFor = new Map<PropertyKey, Cell<unknown>>();
  const fieldLens = (key: PropertyKey): Cell<unknown> => {
    let l = lensFor.get(key);
    if (l === undefined) {
      l = at(cell as Writable<Cell<Record<PropertyKey, unknown>>>, key) as Cell<unknown>;
      lensFor.set(key, l);
    }
    return l;
  };
  const childStores = new Map<PropertyKey, unknown>();

  const proxy = new Proxy(cell, {
    get(target, key) {
      if (typeof key === "symbol" || FORWARD.has(key)) {
        const v = (target as unknown as Record<PropertyKey, unknown>)[key];
        return typeof v === "function" ? v.bind(target) : v;
      }
      if (key === "then") return undefined; // never a thenable
      let s = childStores.get(key);
      if (s === undefined) {
        s = wrap(fieldLens(key));
        childStores.set(key, s);
      }
      return s;
    },
    set(target, key, value) {
      if (typeof key === "symbol" || FORWARD.has(key)) {
        (target as unknown as Record<PropertyKey, unknown>)[key] = value;
        return true;
      }
      (fieldLens(key) as Writable<Cell<unknown>>).value = value;
      return true;
    },
    has(target, key) {
      if (typeof key === "symbol" || FORWARD.has(key)) return true;
      const v = target.peek();
      return typeof v === "object" && v !== null && key in v;
    },
  });

  wrapped.set(cell, proxy);
  return proxy;
}

/** Deep, lens-backed store view of `cell`. Field access returns a nested `Store`;
 *  write through `.value` at any depth. */
export function store<T>(cell: Writable<Cell<T>>): Store<T> {
  return wrap(cell as Cell<unknown>) as Store<T>;
}
