// store.ts — a lens-backed deep store proxy over a `Cell`.
//
// Signal libraries grow a separate `store` primitive for nested objects:
// `store.user.name` reads a path, `setStore(...)` writes one. Here that's just
// field lenses (`at`) under a recursive proxy — no second reactive primitive, no
// fine-grained store engine. `store(cell).a.b` is a `Cell` (a chain of `at`
// lenses), so it composes with everything else: read `.value`, write `.value`,
// pass it to a component, bind it in JSX. Writes are spread-replace puts straight
// back to the root cell, so the whole tree stays one source of truth.
//
// Navigation yields Stores; the leaf is written through `.value`
// (`store.user.name.value = "x"`). A property whose name collides with the cell
// surface below (`value`, `peek`, `lens`, `derive`, `merge`, `through`) resolves
// to the cell member, not a field — drop to `at(cell, key)` for such a field.

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
 *  write through `.value` at any depth. Works over any writable cell, including a
 *  lens, so the store stays one source of truth with the rest of the graph. */
export function store<T>(cell: Writable<Cell<T>>): Store<T> {
  return wrap(cell as Cell<unknown>) as Store<T>;
}
