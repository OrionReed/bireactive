// bireactive adapter — implements the full `Reactive` surface.
//
// Each adapter value carries the underlying bireactive `Cell` so that lenses
// can be stacked: a `View` is a `Source`, and `lens`/`lensN` reach the
// backing cell off whatever source they're handed.

import {
  batch,
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

// The conformance suites model synchronous signal libraries: a write is expected
// to have run dependent effects by the time it returns. bireactive defers
// effects to the microtask, so the adapter settles after each top-level write
// (but NOT inside a `batch`, where coalescing is the point — the batch flushes
// on exit). This re-presents bireactive's async effects as synchronous to the
// suite without touching the upstream tests.
let batchDepth = 0;

function wrap<T>(c: Cell<T>): Backed<T> {
  return {
    cell: c as Read<T>,
    read: () => c.value,
    write: (v: T) => {
      (c as { value: T }).value = v;
      if (batchDepth === 0) settle();
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
      return batch(fn);
    } finally {
      batchDepth--;
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
