// bireactive adapter — implements the full `Reactive` surface.
//
// Each adapter value carries the underlying bireactive `Cell` so that lenses
// can be stacked: a `View` is a `Source`, and `lens`/`lensN` reach the
// backing cell off whatever source they're handed.
//
// Effect scheduling bridge. The engine drains the VALUE graph synchronously
// but defers EFFECTS to a microtask; RFTS (and our law counters) observe
// effect runs synchronously right after a write. So this adapter drains
// effects synchronously at the natural transaction boundaries via `settle()`:
// after a top-level write, and at the end of the outermost `batch`. The
// `settling` guard means writes performed INSIDE an effect body don't each
// force a nested drain — they commit to the value graph and enqueue, and the
// in-progress `runEffects` loop picks them up. That preserves glitch-free
// implicit batching of inner writes (one notification, final values) exactly
// as the async engine would on its own microtask.

import {
  type Cell,
  cell,
  derive,
  effect,
  lens as mlens,
  type Read,
  settle,
  untracked,
} from "@bireactive/core";
import type { Reactive, Readable, Source, Update, View } from "./types";

interface Backed<T> extends Source<T> {
  readonly cell: Read<T>;
}

const cellOf = (s: Readable<unknown>): Read<unknown> => (s as Backed<unknown>).cell;

let batchDepth = 0;
let settling = false;

/** Drain effects synchronously at a transaction boundary, unless we're
 *  inside a batch (defer to its end) or already draining (let the
 *  in-progress `runEffects` loop absorb this write). */
function drain(): void {
  if (batchDepth > 0 || settling) return;
  settling = true;
  try {
    settle();
  } finally {
    settling = false;
  }
}

function wrap<T>(c: Cell<T>): Backed<T> {
  return {
    cell: c as Read<T>,
    read: () => c.value,
    write: (v: T) => {
      (c as { value: T }).value = v;
      drain();
    },
  };
}

export const bireactive: Reactive = {
  name: "bireactive",

  signal: <T>(initial: T): Source<T> => wrap(cell(initial) as unknown as Cell<T>),

  computed: <T>(fn: () => T): Readable<T> => wrap(derive(fn)),

  effect: fn => effect(fn),

  batch: fn => {
    batchDepth++;
    try {
      fn();
    } finally {
      batchDepth--;
      drain();
    }
  },

  untracked: fn => untracked(fn),

  lens: <S, V>(source: Source<S>, fwd: (s: S) => V, bwd: (v: V, s: S) => S): View<V> => {
    const parent = cellOf(source) as Read<S>;
    const view = mlens(parent, fwd, (target: V, s: S) => bwd(target, s));
    return wrap(view as unknown as Cell<V>);
  },

  lensN: <V>(
    sources: readonly Source<unknown>[],
    fwd: (vals: readonly unknown[]) => V,
    bwd: (v: V, vals: readonly unknown[]) => readonly Update<unknown>[],
  ): View<V> => {
    const parents = sources.map(cellOf);
    const view = mlens(
      parents,
      ((vals: readonly unknown[]) => fwd(vals)) as never,
      ((target: V, vals: readonly unknown[]) => bwd(target, vals)) as never,
    );
    return wrap(view as unknown as Cell<V>);
  },
};
