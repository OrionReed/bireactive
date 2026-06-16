// Bench workloads, adapter-generic. The forward and backward shapes are
// deliberately dual (chain ↔ chain, fan-in ↔ fan-out) so the numbers
// line up: the same topology, edited from a source vs. edited from a
// view. Each workload returns a `tick(i)` that performs one edit and
// reads the sink, returning a number to keep the result live past the
// bench loop.

import type { ForwardReactive, Reactive, Source, View } from "../adapters/types";

export type Tick = (i: number) => number;

/** source → (+1) chain of `depth` computeds → sink. Edit: write source. */
export function fwdChain(rx: ForwardReactive, depth: number): Tick {
  const source = rx.signal(0);
  let cur: { read(): number } = source;
  for (let i = 0; i < depth; i++) {
    const prev = cur;
    cur = rx.computed(() => prev.read() + 1);
  }
  const sink = cur;
  return i => {
    source.write(i);
    return sink.read();
  };
}

/** `width` sources → sum computed → sink. Edit: write one source. */
export function fwdFan(rx: ForwardReactive, width: number): Tick {
  const sources = Array.from({ length: width }, () => rx.signal(0));
  const sink = rx.computed(() => sources.reduce((a, s) => a + s.read(), 0));
  return i => {
    sources[i % width].write(i);
    return sink.read();
  };
}

/** Affine 1→1 chain of `depth`. Edit: write the top view (propagates
 *  back to the single source). The dual of `fwdChain`. */
export function bwdChain(rx: Reactive, depth: number): Tick {
  const source = rx.signal(0);
  let cur: View<number> = source;
  for (let i = 0; i < depth; i++) {
    cur = rx.lens(
      cur,
      x => x + 1,
      v => v - 1,
    );
  }
  const top = cur;
  return i => {
    top.write(i);
    return source.read();
  };
}

/** `width` sources joined by a sum view. Edit: write the view (fans out
 *  to all sources). The dual of `fwdFan`. */
export function bwdFan(rx: Reactive, width: number): Tick {
  const sources = Array.from({ length: width }, () => rx.signal(0));
  const view = rx.lensN(
    sources as readonly Source<unknown>[],
    vals => (vals as number[]).reduce((a, b) => a + b, 0),
    (t: number, vals) => {
      const nums = vals as number[];
      const cur = nums.reduce((a, b) => a + b, 0);
      const delta = (t - cur) / width;
      return nums.map(x => x + delta);
    },
  );
  return i => {
    view.write(i);
    return sources[0].read();
  };
}

/** Affine 1→1 chain of `depth`; write the top view but NEVER read the
 *  graph. Isolates pure write-through cost: an unobserved write need not
 *  run the put-chain at all under demand-gating, whereas eager pays the
 *  full walk + commit every tick. */
export function bwdChainBlind(rx: Reactive, depth: number): Tick {
  const source = rx.signal(0);
  let cur: View<number> = source;
  for (let i = 0; i < depth; i++) {
    cur = rx.lens(
      cur,
      x => x + 1,
      v => v - 1,
    );
  }
  const top = cur;
  return i => {
    top.write(i);
    return i;
  };
}

/** Affine 1→1 chain of `depth`; write the top view `writes` times, then
 *  read the source once. Isolates write-coalescing: demand-gating resolves
 *  once (last-write-wins), eager pays every intermediate write. */
export function bwdCoalesce(rx: Reactive, depth: number, writes: number): Tick {
  const source = rx.signal(0);
  let cur: View<number> = source;
  for (let i = 0; i < depth; i++) {
    cur = rx.lens(
      cur,
      x => x + 1,
      v => v - 1,
    );
  }
  const top = cur;
  return i => {
    for (let w = 0; w < writes; w++) top.write(i + w);
    return source.read();
  };
}

/** `n` independent source→chain→top views; write every top each tick but
 *  read only chain 0's source. Isolates partial observation: demand-gating
 *  resolves the one observed chain, eager resolves all `n`. */
export function bwdChainsPartial(rx: Reactive, n: number, depth: number): Tick {
  const sources: Source<number>[] = [];
  const tops: View<number>[] = [];
  for (let c = 0; c < n; c++) {
    const source = rx.signal(0);
    let cur: View<number> = source;
    for (let i = 0; i < depth; i++) {
      cur = rx.lens(
        cur,
        x => x + 1,
        v => v - 1,
      );
    }
    sources.push(source);
    tops.push(cur);
  }
  return i => {
    for (const top of tops) top.write(i);
    return sources[0]!.read();
  };
}

/** A fan-in view with a live downstream effect, written every tick —
 *  the "drag the midpoint while something observes it" workload. Returns
 *  the observed total so the effect can't be optimized away. */
export function dragFan(rx: Reactive, width: number): Tick {
  const sources = Array.from({ length: width }, () => rx.signal(0));
  const view = rx.lensN(
    sources as readonly Source<unknown>[],
    vals => (vals as number[]).reduce((a, b) => a + b, 0),
    (t: number, vals) => {
      const nums = vals as number[];
      const cur = nums.reduce((a, b) => a + b, 0);
      const delta = (t - cur) / width;
      return nums.map(x => x + delta);
    },
  );
  const total = rx.computed(() => sources.reduce((a, s) => a + s.read(), 0));
  let observed = 0;
  rx.effect(() => {
    observed = total.read();
  });
  return i => {
    view.write(i);
    return observed;
  };
}
