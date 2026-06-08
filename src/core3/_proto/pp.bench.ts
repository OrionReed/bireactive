// Head-to-head: production engine (eager) vs push-pull (`signal-pp.ts`) vs
// `signal-bp.ts`, over identical adapter-generic workloads.
//
//   node --expose-gc node_modules/.bin/vite-node src/core/_proto/pp.bench.ts

import { group, run } from "mitata";
import { bireactive } from "../_test/suite/adapters/bireactive";
import type { Reactive, Readable, Source, Update, View } from "../_test/suite/adapters/types";
import { reg } from "../_test/suite/bench/runner";
import {
  bwdChain,
  bwdFan,
  dragFan,
  fwdChain,
  fwdFan,
  type Tick,
} from "../_test/suite/bench/workloads";
import {
  batch as bbatch,
  cell as bcell,
  derive as bderive,
  effect as beffect,
  lens as bmlens,
  untracked as buntracked,
} from "./signal-bp";
import {
  batch,
  type Cell,
  cell,
  derive,
  effect,
  lens as mlens,
  type Read,
  untracked,
} from "./signal-pp";

interface Backed<T> extends Source<T> {
  readonly cell: Read<T>;
}
const cellOf = (s: Readable<unknown>): Read<unknown> => (s as Backed<unknown>).cell;
function wrap<T>(c: Cell<T>): Backed<T> {
  return {
    cell: c as Read<T>,
    read: () => c.value,
    write: (v: T) => {
      (c as { value: T }).value = v;
    },
  };
}
const pp: Reactive = {
  name: "bireactive-pp",
  signal: <T>(initial: T): Source<T> => wrap(cell(initial) as unknown as Cell<T>),
  computed: <T>(fn: () => T): Readable<T> => wrap(derive(fn)),
  effect: fn => effect(fn),
  batch: fn => batch(fn),
  untracked: fn => untracked(fn),
  lens: <S, V>(source: Source<S>, fwd: (s: S) => V, bwd: (v: V, s: S) => S): View<V> =>
    wrap(mlens(cellOf(source) as Read<S>, fwd, (t: V, s: S) => bwd(t, s)) as unknown as Cell<V>),
  lensN: <V>(
    sources: readonly Source<unknown>[],
    fwd: (vals: readonly unknown[]) => V,
    bwd: (v: V, vals: readonly unknown[]) => readonly Update<unknown>[],
  ): View<V> =>
    wrap(
      mlens(
        sources.map(cellOf),
        ((vals: readonly unknown[]) => fwd(vals)) as never,
        ((t: V, vals: readonly unknown[]) => bwd(t, vals)) as never,
      ) as unknown as Cell<V>,
    ),
};

const bp: Reactive = {
  name: "bireactive-bp",
  signal: <T>(initial: T): Source<T> => wrap(bcell(initial) as unknown as Cell<T>),
  computed: <T>(fn: () => T): Readable<T> => wrap(bderive(fn) as unknown as Cell<T>),
  effect: fn => beffect(fn),
  batch: fn => bbatch(fn),
  untracked: fn => buntracked(fn),
  lens: <S, V>(source: Source<S>, fwd: (s: S) => V, bwd: (v: V, s: S) => S): View<V> =>
    wrap(bmlens(cellOf(source) as Read<S>, fwd, (t: V, s: S) => bwd(t, s)) as unknown as Cell<V>),
  lensN: <V>(
    sources: readonly Source<unknown>[],
    fwd: (vals: readonly unknown[]) => V,
    bwd: (v: V, vals: readonly unknown[]) => readonly Update<unknown>[],
  ): View<V> =>
    wrap(
      bmlens(
        sources.map(cellOf),
        ((vals: readonly unknown[]) => fwd(vals)) as never,
        ((t: V, vals: readonly unknown[]) => bwd(t, vals)) as never,
      ) as unknown as Cell<V>,
    ),
};

/** One batch per tick containing `reps` writes to the SAME identity view,
 *  then read the source. Eager: `reps` walks/tick. Push-pull: 1 walk. */
function bwdBatchRepeat(rx: Reactive, reps: number): Tick {
  const s = rx.signal(0);
  const v = rx.lens(
    s,
    (x: number) => x,
    (t: number) => t,
  );
  return i => {
    rx.batch(() => {
      for (let k = 0; k < reps; k++) v.write(i + k);
    });
    return s.read();
  };
}

/** One batch per tick with a single view write (the common small batch). */
function bwdBatchSingle(rx: Reactive): Tick {
  const s = rx.signal(0);
  const v = rx.lens(
    s,
    (x: number) => x,
    (t: number) => t,
  );
  return i => {
    rx.batch(() => {
      v.write(i);
    });
    return s.read();
  };
}

// One engine per PROCESS (ENGINE=eager|pp|bp). Mixing Cell classes makes
// the `.value` call site megamorphic and taxes every variant unfairly —
// especially cheap-read workloads — so isolate to compare absolute numbers.
const which = process.env.ENGINE ?? "eager";
const rx: Reactive = which === "pp" ? pp : which === "bp" ? bp : bireactive;
const tag = rx.name;

group(`[${tag}] fwd chain 50`, () => reg("t", fwdChain(rx, 50)));
group(`[${tag}] fwd fan 50`, () => reg("t", fwdFan(rx, 50)));
group(`[${tag}] bwd chain 50 (single eager write)`, () => reg("t", bwdChain(rx, 50)));
group(`[${tag}] bwd fan 50 (single eager write)`, () => reg("t", bwdFan(rx, 50)));
group(`[${tag}] bwd batch: 1 write`, () => reg("t", bwdBatchSingle(rx)));
group(`[${tag}] bwd batch: 32 writes (coalescing)`, () => reg("t", bwdBatchRepeat(rx, 32)));
group(`[${tag}] drag fan 50`, () => reg("t", dragFan(rx, 50)));

await run({ format: "mitata" });
