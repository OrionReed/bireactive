// coll.ts — a keyed, ordered, *bidirectional* collection.
//
// The structural sibling of `tree.ts`. A `Coll<E>` holds stable element
// handles (records of cells), and each projection — `filter` / `sortBy` /
// `groupBy` — is a WRITABLE structural lens. You edit the *view* and the
// backward pass writes the elements' own fields:
//
//   sortBy(rank)  → move(e, i)        writes `rank`   (position is a field)
//   groupBy(key)  → move(e, k, i)     writes `key`    (membership is a field)
//   filter(pred)  → insert/assert     writes whatever pred demands
//
// Because position / group / visibility are the elements' own writable
// cells, these lenses are COMPLEMENT-FREE — the "complement" lives in the
// field cells, not the lens (contrast `Seq<T>`, where order is imposed and
// must be remembered). One `move`/`insert` composes the backward passes up
// the chain in a single `batch`: drop into a filtered + grouped + sorted
// view and the filter's predicate, the group key, and the rank all get set
// at once.
//
// Two change classes, mirroring the engine's two levels:
//   • value change   — a field cell changes; forward derivations re-flow.
//   • structural edit — insert/remove/move; a discrete batched transition.
// No lens edges are built at runtime, so acyclicity holds as ever.

import { batch, type Cell, cell, derive, type Read, type Writable } from "./core";

/** Accessor for an element's writable field cell. Forward reads `.value`;
 *  the backward pass writes it. */
export type Field<E, V> = (e: E) => Writable<Cell<V>>;

/** A forward test over an element's fields, optionally assertable —
 *  `assert(e)` makes the test pass by writing fields. */
export interface FieldPred<E> {
  (e: E): boolean;
  assert?: (e: E) => void;
}

export interface Group<K, E> {
  key: K;
  items: readonly E[];
}

export interface GroupOpts<E, K> {
  /** Fixed key order; seeds empty buckets and pins column order. */
  order?: readonly K[];
  /** Order field within each group; enables `move(e, key, index)`. */
  sort?: Field<E, number>;
}

/** `field === value`, assertable by writing the field. */
export function is<E, V>(field: Field<E, V>, value: V): FieldPred<E> {
  const p = ((e: E) => field(e).value === value) as FieldPred<E>;
  p.assert = (e: E) => {
    field(e).value = value;
  };
  return p;
}

/** Conjunction; asserts every clause. */
export function allPass<E>(...preds: readonly FieldPred<E>[]): FieldPred<E> {
  const p = ((e: E) => preds.every(q => q(e))) as FieldPred<E>;
  p.assert = (e: E) => {
    for (const q of preds) q.assert?.(e);
  };
  return p;
}

/** Read-only projection with chainable structural lenses. */
export class View<E> {
  protected constructor(
    protected readonly list: Read<readonly E[]>,
    readonly key: (e: E) => unknown,
    protected readonly parent: View<E> | null,
  ) {}

  /** Current members; tracked when read in an effect/derive. */
  get items(): readonly E[] {
    return this.list.value;
  }

  /** The source collection at the head of the chain. */
  get root(): Coll<E> {
    let v: View<E> = this;
    while (v.parent) v = v.parent;
    return v as Coll<E>;
  }

  /** Make `e` appear in this view: satisfy own constraint, recursively up. */
  assertContains(e: E): void {
    this.parent?.assertContains(e);
    this.assertSelf(e);
  }
  protected assertSelf(_e: E): void {}

  filter(pred: FieldPred<E>): View<E> {
    return new FilterView(this, pred);
  }
  sortBy(field: Field<E, number>): SortView<E> {
    return new SortView(this, field);
  }
  groupBy<K>(field: Field<E, K>, opts?: GroupOpts<E, K>): GroupView<K, E> {
    return new GroupView(this, field, opts);
  }
  map<F>(f: (e: E) => F): Read<readonly F[]> {
    return derive(() => this.list.value.map(f));
  }

  /** Remove `e` from the source. */
  remove(e: E): void {
    this.root.removeFromSource(e);
  }
}

/** A writable source collection. */
export class Coll<E> extends View<E> {
  readonly #src: Writable<Cell<readonly E[]>>;

  constructor(items: readonly E[], key: (e: E) => unknown) {
    const src = cell<readonly E[]>(items);
    super(src, key, null);
    this.#src = src;
  }

  override assertContains(e: E): void {
    if (!this.#src.value.includes(e)) this.insert(e);
  }

  insert(e: E, at?: number): void {
    const arr = [...this.#src.value];
    if (at == null) arr.push(e);
    else arr.splice(at, 0, e);
    this.#src.value = arr;
  }

  removeFromSource(e: E): void {
    this.#src.value = this.#src.value.filter(x => x !== e);
  }
}

class FilterView<E> extends View<E> {
  readonly #pred: FieldPred<E>;
  constructor(parent: View<E>, pred: FieldPred<E>) {
    super(
      derive(() => parent.items.filter(pred)),
      parent.key,
      parent,
    );
    this.#pred = pred;
  }
  protected override assertSelf(e: E): void {
    this.#pred.assert?.(e);
  }
}

/** Sorted view. `move` writes the order field between the drop neighbours. */
export class SortView<E> extends View<E> {
  readonly #field: Field<E, number>;
  constructor(parent: View<E>, field: Field<E, number>) {
    super(
      derive(() => [...parent.items].sort((a, b) => field(a).value - field(b).value)),
      parent.key,
      parent,
    );
    this.#field = field;
  }

  move(e: E, to: number): void {
    const others = this.items.filter(x => x !== e);
    batch(() => {
      this.assertContains(e);
      this.#field(e).value = between(rankAt(others, this.#field, to - 1), rankAt(others, this.#field, to));
    });
  }
}

/** Grouped view. `move`/`insert` write the group field (and, with a `sort`
 *  field, the order field). Backward composition runs the parent chain. */
export class GroupView<K, E> {
  readonly groups: Read<readonly Group<K, E>[]>;
  readonly #parent: View<E>;
  readonly #field: Field<E, K>;
  readonly #order: readonly K[];
  readonly #sort?: Field<E, number>;

  constructor(parent: View<E>, field: Field<E, K>, opts: GroupOpts<E, K> = {}) {
    this.#parent = parent;
    this.#field = field;
    this.#order = opts.order ?? [];
    this.#sort = opts.sort;
    this.groups = derive(() => {
      const sort = this.#sort;
      const items = sort ? [...parent.items].sort((a, b) => sort(a).value - sort(b).value) : parent.items;
      return groupItems(items, e => field(e).value, this.#order);
    });
  }

  get value(): readonly Group<K, E>[] {
    return this.groups.value;
  }

  map<F>(f: (g: Group<K, E>) => F): Read<readonly F[]> {
    return derive(() => this.value.map(f));
  }

  /** Place `e` in group `toKey` at `index`. Inserts it into the source if
   *  it isn't there yet, asserts every upstream filter, then writes the
   *  group key and order field — all in one batch. */
  move(e: E, toKey: K, index?: number): void {
    const target = (this.value.find(g => Object.is(g.key, toKey))?.items ?? []).filter(x => x !== e);
    const sort = this.#sort;
    batch(() => {
      this.#parent.assertContains(e);
      this.#field(e).value = toKey;
      if (sort && index != null)
        sort(e).value = between(rankAt(target, sort, index - 1), rankAt(target, sort, index));
    });
  }

  insert(e: E, toKey: K, index?: number): void {
    this.move(e, toKey, index);
  }

  remove(e: E): void {
    this.#parent.remove(e);
  }
}

function groupItems<K, E>(
  items: readonly E[],
  keyOf: (e: E) => K,
  order: readonly K[],
): Group<K, E>[] {
  const buckets = new Map<K, E[]>();
  for (const k of order) buckets.set(k, []);
  for (const e of items) {
    const k = keyOf(e);
    const arr = buckets.get(k);
    if (arr) arr.push(e);
    else buckets.set(k, [e]);
  }
  return [...buckets].map(([key, items]) => ({ key, items }));
}

function rankAt<E>(arr: readonly E[], field: Field<E, number>, i: number): number | undefined {
  return i >= 0 && i < arr.length ? field(arr[i]).value : undefined;
}

function between(a: number | undefined, b: number | undefined): number {
  if (a != null && b != null) return (a + b) / 2;
  if (a != null) return a + 1;
  if (b != null) return b - 1;
  return 0;
}

export function coll<E>(items: readonly E[], key: (e: E) => unknown): Coll<E> {
  return new Coll(items, key);
}
