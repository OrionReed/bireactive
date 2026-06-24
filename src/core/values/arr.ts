import { batch, Cell, cell, derive, lazy, lens, type Read, type Writable } from "../cell";
import type { TraitDict } from "../traits";
import { Num } from "./num";

/** The value of an `Arr<T>`: its element cells, in order. */
type Elems<T> = readonly Cell<T>[];

/** Structural equality: same element cells (by reference) in the same order; a
 *  value change inside an element doesn't affect it. */
const sameCells = <E>(a: readonly E[], b: readonly E[]): boolean =>
  a === b || (a.length === b.length && a.every((c, i) => c === b[i]));

const clampInt = (v: number, lo: number, hi: number): number => {
  const r = Math.round(v);
  return r < lo ? lo : r > hi ? hi : r;
};

// View metadata, kept off the instance. A derived `Arr` (filter/sortBy/map, or
// a `fromSource` projection) routes structural edits through these closures; a
// missing op means the view doesn't support that edit (calling it throws).
// Moves use `moveBefore(e, anchor)`: the anchor is a shared element cell,
// meaningful in the base order, so it composes through views without
// translating index spaces.
interface ViewInfo {
  insert?: (v: unknown, at?: number) => Cell<unknown>;
  remove?: (e: Cell<unknown>) => void;
  moveBefore?: (e: Cell<unknown>, anchor: Cell<unknown> | null) => void;
  assertContains?: (e: Cell<unknown>) => void;
}
const views = new WeakMap<Arr<unknown>, ViewInfo>();

/** A predicate over an element cell; optional `assert(c)` makes the test pass
 *  by writing the cell. */
export interface CellPred<T> {
  (c: Cell<T>): boolean;
  assert?: (c: Cell<T>) => void;
}

export class Arr<T> extends Cell<Elems<T>> {
  static traits = {
    equals: sameCells,
  } satisfies TraitDict<Elems<unknown>>;
  declare readonly _t: typeof Arr.traits;

  constructor(items: Elems<T> = []) {
    super(items, { equals: sameCells as (a: Elems<T>, b: Elems<T>) => boolean });
  }

  /** Build a derived `Arr` over any `Read` source. Variance escape: `Cell<R>`
   *  isn't assignable to `Cell<unknown>` (contravariant `_equals`), so typed
   *  `Arr.derive` can't see element subtyping. */
  static #view<P, R>(parent: Read<P>, getter: (v: P) => Elems<R>): Arr<R> {
    // biome-ignore lint/suspicious/noExplicitAny: variance escape (see above)
    return (Arr.derive as any)(parent, getter) as Arr<R>;
  }

  /** An `Arr` whose elements are derived from an external `source` and whose
   *  structural edits rewrite that source via `ops`. */
  static fromSource<S, R>(
    source: Read<S>,
    getter: (s: S) => Elems<R>,
    ops: {
      insert?: (v: R | Cell<R>, at?: number) => Cell<R>;
      remove?: (e: Cell<R>) => void;
      moveBefore?: (e: Cell<R>, anchor: Cell<R> | null) => void;
    },
  ): Arr<R> {
    const view = Arr.#view<S, R>(source, getter);
    views.set(view as Arr<unknown>, {
      insert: ops.insert as ViewInfo["insert"],
      remove: ops.remove as ViewInfo["remove"],
      moveBefore: ops.moveBefore as ViewInfo["moveBefore"],
    });
    return view;
  }

  // ── reads ────────────────────────────────────────────────────────────

  /** The element cells in order; tracked when read in an effect/derive. */
  get cells(): Elems<T> {
    return this.value;
  }

  /** Snapshot of element values, `readonly T[]`; re-derives on any value or
   *  structural change. Memoized per instance. */
  get values(): Read<readonly T[]> {
    return lazy(this, "values", () => derive(this, cs => cs.map(c => c.value)));
  }

  /** Element count as a reactive `Num` (structural changes only). */
  get length(): Num {
    return lazy(this, "length", () => Num.derive(this, cs => cs.length));
  }

  /** This element's index as a writable `Num`: reading gives its position,
   *  writing reorders (splices the reference to the rounded, clamped target).
   *  Writable on a base `Arr`; read-only over a derived view. */
  indexOf(e: Cell<T>): Writable<Num> {
    return Num.lens(
      this as Arr<T>,
      cs => cs.indexOf(e),
      (to, cs) => {
        const from = cs.indexOf(e);
        if (from < 0) return cs;
        const others = cs.filter(x => x !== e);
        const t = clampInt(to, 0, others.length);
        if (t === from) return cs;
        return [...others.slice(0, t), e, ...others.slice(t)];
      },
    ) as Writable<Num>;
  }

  // ── structural edits ────────────────────────────────────────────────

  /** Append `v` (a value is wrapped in a fresh cell; a cell passes through).
   *  Returns the element cell. */
  push(v: T | Cell<T>): Cell<T> {
    return this.insert(v);
  }

  /** Insert at `at` (default: end). On a view, delegates through the view's
   *  `insert` (a filter asserts its predicate; `map` has none, so it throws). */
  insert(v: T | Cell<T>, at?: number): Cell<T> {
    const info = views.get(this as Arr<unknown>);
    if (info) {
      if (!info.insert) throw new TypeError("Arr: this view does not support insert");
      return info.insert(v, at) as Cell<T>;
    }
    const e = (v instanceof Cell ? v : cell(v)) as Cell<T>;
    const cur = this.peek();
    const next = cur.slice();
    if (at == null || at >= next.length) next.push(e);
    else next.splice(Math.max(0, at), 0, e);
    this._writeSource(next);
    return e;
  }

  /** Remove element `e` (by reference). On a view, delegates through the
   *  view's `remove`. */
  remove(e: Cell<T>): void {
    const info = views.get(this as Arr<unknown>);
    if (info) {
      if (!info.remove) throw new TypeError("Arr: this view does not support remove");
      info.remove(e as Cell<unknown>);
      return;
    }
    const cur = this.peek();
    const next = cur.filter(x => x !== e);
    if (next.length !== cur.length) this._writeSource(next);
  }

  /** Remove the element at index `i` in this (view's) order. */
  removeAt(i: number): void {
    const e = this.peek()[i];
    if (e) this.remove(e);
  }

  /** Move `e` to index `to` (rounded, clamped) in this (view's) order. */
  move(e: Cell<T>, to: number): void {
    const cur = this.peek();
    const others = cur.filter(x => x !== e);
    const t = clampInt(to, 0, others.length);
    this.moveBefore(e, t < others.length ? others[t]! : null);
  }

  /** Splice `e` to just before `anchor` (or to the end when `anchor` is null).
   *  On a base `Arr` this rewrites the reference order; on a view it delegates
   *  through the view's `moveBefore`, where the shared `anchor` cell stays
   *  meaningful in the base order. No-op if `e` isn't present. */
  moveBefore(e: Cell<T>, anchor: Cell<T> | null): void {
    const info = views.get(this as Arr<unknown>);
    if (info) {
      if (!info.moveBefore) throw new TypeError("Arr: this view does not support move");
      info.moveBefore(e as Cell<unknown>, anchor as Cell<unknown> | null);
      return;
    }
    const cur = this.peek();
    if (!cur.includes(e)) return;
    const without = cur.filter(x => x !== e);
    const ai = anchor == null ? -1 : without.indexOf(anchor);
    const at = ai < 0 ? without.length : ai;
    const next = [...without.slice(0, at), e, ...without.slice(at)];
    if (!sameCells(next, cur)) this._writeSource(next);
  }

  /** Make `e` appear in this view: insert into the base if absent, then assert
   *  each view's constraint up the chain. */
  assertContains(e: Cell<T>): void {
    const info = views.get(this as Arr<unknown>);
    if (info) {
      info.assertContains?.(e as Cell<unknown>);
      return;
    }
    if (!this.peek().includes(e)) this.insert(e);
  }

  /** Empty the collection (a view removes only its visible elements). */
  clear(): void {
    if (views.get(this as Arr<unknown>)) {
      for (const e of [...this.peek()]) this.remove(e);
      return;
    }
    if (this.peek().length > 0) this._writeSource([]);
  }

  // ── views ────────────────────────────────────────────────────────────

  /** Subset whose elements pass `pred` (which reads element values, so the
   *  view re-derives reactively). Shares the element cells. `insert` adds to
   *  the parent and asserts the predicate. */
  filter(pred: CellPred<T>): Arr<T> {
    const base = this as Arr<T>;
    const view = Arr.#view<Elems<T>, T>(base, cs => cs.filter(c => pred(c)));
    views.set(view as Arr<unknown>, {
      insert: (v, at) => {
        const e = base.insert(v as T | Cell<T>, at);
        pred.assert?.(e);
        return e as Cell<unknown>;
      },
      remove: e => base.remove(e as Cell<T>),
      moveBefore: (e, anchor) => base.moveBefore(e as Cell<T>, anchor as Cell<T> | null),
      assertContains: e => {
        base.assertContains(e as Cell<T>);
        pred.assert?.(e as Cell<T>);
      },
    });
    return view;
  }

  /** Projection ordered by `key` (read off each element, so it re-sorts
   *  reactively). Shares the element cells; structural edits delegate to the
   *  base (a `move`/`insert` repositions in the base order, not the view's). */
  sortBy(key: (c: Cell<T>) => number): Arr<T> {
    const base = this as Arr<T>;
    const view = Arr.#view<Elems<T>, T>(base, cs => [...cs].sort((a, b) => key(a) - key(b)));
    views.set(view as Arr<unknown>, {
      insert: (v, at) => base.insert(v as T | Cell<T>, at) as Cell<unknown>,
      remove: e => base.remove(e as Cell<T>),
      moveBefore: (e, anchor) => base.moveBefore(e as Cell<T>, anchor as Cell<T> | null),
      assertContains: e => base.assertContains(e as Cell<T>),
    });
    return view;
  }

  /** Per-element map. `f` projects each element value; with the inverse `g`
   *  the mapped elements are writable lenses (editing one writes the source
   *  cell), else they're read-only. Element identity is stable: one lens per
   *  source cell, memoized. */
  map<U>(f: (v: T) => U, g?: (u: U, v: T) => T): Arr<U> {
    const fwd = new WeakMap<Cell<T>, Cell<U>>();
    const back = new WeakMap<Cell<U>, Cell<T>>();
    const lensOf = (c: Cell<T>): Cell<U> => {
      let m = fwd.get(c);
      if (m === undefined) {
        m = (g ? lens(c, f, (u: U, v: T) => g(u, v)) : derive(c, f)) as Cell<U>;
        fwd.set(c, m);
        back.set(m, c);
      }
      return m;
    };
    const base = this as Arr<T>;
    const view = Arr.#view<Elems<T>, U>(base, cs => cs.map(lensOf));
    views.set(view as Arr<unknown>, {
      remove: mc => {
        const src = back.get(mc as Cell<U>);
        if (src) base.remove(src);
      },
      moveBefore: (mc, anchor) => {
        const src = back.get(mc as Cell<U>);
        const a = anchor ? (back.get(anchor as Cell<U>) ?? null) : null;
        if (src) base.moveBefore(src, a);
      },
      assertContains: mc => {
        const src = back.get(mc as Cell<U>);
        if (src) base.assertContains(src);
      },
    });
    return view;
  }

  /** Partition by a per-element key field into derived sub-`Arr`s, one writable
   *  filter view per bucket. `move(e, key, index)` writes the key field and
   *  splices the base so `e` lands at `index` in its new group. `order` seeds
   *  empty buckets and pins their order. */
  groupBy<K>(
    field: (e: Cell<T>) => Writable<Cell<K>>,
    opts: { order?: readonly K[] } = {},
  ): GroupArr<K, T> {
    return new GroupArr<K, T>(this as Arr<T>, field, opts.order ?? []);
  }
}

/** One bucket of a `groupBy`: its key and the derived sub-`Arr` of members. */
export interface Group<K, T> {
  key: K;
  items: Arr<T>;
}

/** The result of `Arr.groupBy`: derived buckets plus a grouped `move`/`insert`
 *  whose backward pass writes the group field and reorders the base. */
export class GroupArr<K, T> {
  readonly #parent: Arr<T>;
  readonly #field: (e: Cell<T>) => Writable<Cell<K>>;
  readonly #order: readonly K[];
  readonly #subs = new Map<K, Arr<T>>();
  /** The buckets in order; tracked when read in an effect/derive. */
  readonly groups: Read<readonly Group<K, T>[]>;

  constructor(parent: Arr<T>, field: (e: Cell<T>) => Writable<Cell<K>>, order: readonly K[]) {
    this.#parent = parent;
    this.#field = field;
    this.#order = order;
    this.groups = derive(parent, cells => this.#bucket(cells));
  }

  #bucket(cells: Elems<T>): Group<K, T>[] {
    const keys: K[] = [...this.#order];
    const seen = new Set<K>(keys);
    for (const c of cells) {
      const k = this.#field(c).value;
      if (!seen.has(k)) {
        seen.add(k);
        keys.push(k);
      }
    }
    return keys.map(key => ({ key, items: this.#sub(key) }));
  }

  /** One memoized filter view per key — stable identity across re-buckets. */
  #sub(key: K): Arr<T> {
    let s = this.#subs.get(key);
    if (s === undefined) {
      const pred: CellPred<T> = c => Object.is(this.#field(c).value, key);
      pred.assert = c => {
        this.#field(c).value = key;
      };
      s = this.#parent.filter(pred);
      this.#subs.set(key, s);
    }
    return s;
  }

  get value(): readonly Group<K, T>[] {
    return this.groups.value;
  }

  map<F>(f: (g: Group<K, T>) => F): Read<readonly F[]> {
    return derive(this.groups, gs => gs.map(f));
  }

  /** Place `e` in group `key` at `index` (within that group's order). Asserts
   *  every upstream filter, writes the group field, and splices the base — one
   *  batch, so every view re-flows once. Omit `index` to keep base order. */
  move(e: Cell<T>, key: K, index?: number): void {
    batch(() => {
      this.#parent.assertContains(e);
      this.#field(e).value = key;
      if (index != null) {
        const members = this.#parent
          .peek()
          .filter(c => c !== e && Object.is(this.#field(c).peek(), key));
        const t = index < 0 ? 0 : index > members.length ? members.length : index;
        this.#parent.moveBefore(e, t < members.length ? members[t]! : null);
      }
    });
  }

  /** Alias of `move`. */
  insert(e: Cell<T>, key: K, index?: number): void {
    this.move(e, key, index);
  }

  /** Remove `e` from the source through the chain. */
  remove(e: Cell<T>): void {
    this.#parent.remove(e);
  }
}

/** `field === value`, assertable by writing the field; for `filter` predicates. */
export function is<T, V>(field: (e: Cell<T>) => Writable<Cell<V>>, value: V): CellPred<T> {
  const p = ((c: Cell<T>) => Object.is(field(c).value, value)) as CellPred<T>;
  p.assert = c => {
    field(c).value = value;
  };
  return p;
}

/** Conjunction of cell predicates; asserts every clause. */
export function allPass<T>(...preds: readonly CellPred<T>[]): CellPred<T> {
  const p = ((c: Cell<T>) => preds.every(q => q(c))) as CellPred<T>;
  p.assert = c => {
    for (const q of preds) q.assert?.(c);
  };
  return p;
}

/** Writable `Arr<T>` from values and/or cells (values are wrapped in fresh
 *  cells; cells pass through by identity). */
export function arr<T>(items: Iterable<T | Cell<T>> = []): Writable<Arr<T>> {
  const cells = [...items].map(x => (x instanceof Cell ? x : cell(x)) as Cell<T>);
  return new Arr<T>(cells) as Writable<Arr<T>>;
}
