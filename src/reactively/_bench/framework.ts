// The js-reactivity-benchmark `ReactiveFramework` shape (signal / computed /
// effect / withBatch / withBuild / cleanup), plus the three adapters we put
// head-to-head: upstream reactively (`vendor`), our explicit-stack + bitflag
// variant (`fast`), and `alien` as the performance ceiling.
//
// The reactively adapters drive effects by calling `stabilize()` at the end of
// each batch (reactively defers effect runs); alien batches natively. This
// mirrors milomg's own adapters so the numbers are comparable to the published
// charts.

import {
  computed as aComputed,
  effect as aEffect,
  signal as aSignal,
  endBatch,
  startBatch,
} from "alien-signals";
import { Reactive as FastReactive, stabilize as fastStabilize } from "../core";
import { Reactive as VendorReactive, stabilize as vendorStabilize } from "../vendor";

export interface Signal<T> {
  read(): T;
  write(v: T): void;
}
export interface Computed<T> {
  read(): T;
}

export interface ReactiveFramework {
  name: string;
  signal<T>(initial: T): Signal<T>;
  computed<T>(fn: () => T): Computed<T>;
  effect(fn: () => void): void;
  withBatch(fn: () => void): void;
  withBuild<T>(fn: () => T): T;
  cleanup(): void;
}

function reactivelyAdapter(
  name: string,
  Node: typeof VendorReactive,
  stabilize: () => void,
): ReactiveFramework {
  return {
    name,
    signal: initial => {
      const r = new Node(initial);
      return { read: () => r.get(), write: v => r.set(v) };
    },
    computed: fn => {
      const r = new Node(fn);
      return { read: () => r.get() };
    },
    effect: fn => {
      new Node(fn, true);
    },
    withBatch: fn => {
      fn();
      stabilize();
    },
    withBuild: fn => fn(),
    cleanup: () => {},
  };
}

export const vendor: ReactiveFramework = reactivelyAdapter(
  "reactively",
  VendorReactive,
  vendorStabilize,
);

export const fast: ReactiveFramework = reactivelyAdapter(
  "reactively-fast",
  FastReactive as unknown as typeof VendorReactive,
  fastStabilize,
);

export const alien: ReactiveFramework = {
  name: "alien",
  signal: initial => {
    const s = aSignal(initial);
    return { read: () => s(), write: v => s(v) };
  },
  computed: fn => {
    const c = aComputed(fn);
    return { read: () => c() };
  },
  effect: fn => {
    // Wrap so a value-returning body (e.g. mux's `() => x.read()`) isn't
    // mistaken by alien for a cleanup function.
    aEffect(() => {
      fn();
    });
  },
  withBatch: fn => {
    startBatch();
    try {
      fn();
    } finally {
      endBatch();
    }
  },
  withBuild: fn => fn(),
  cleanup: () => {},
};
