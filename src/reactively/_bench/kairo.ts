// The kairo propagation suite from milomg/js-reactivity-benchmark
// (packages/core/src/benches/kairo/*), ported to be adapter-generic. Each
// builder wires a graph for the given framework and returns a `tick()` that
// performs one round of edits + reads — exactly the inner loop the upstream
// harness times. Correctness asserts are kept so a broken engine can't post a
// fast (but wrong) number.

import type { Computed, ReactiveFramework } from "./framework";

export type Tick = () => void;
export interface Case {
  name: string;
  build(rx: ReactiveFramework): Tick;
}

function assert(cond: boolean, msg?: string): void {
  if (!cond) throw new Error(`kairo assertion failed${msg ? `: ${msg}` : ""}`);
}

function busy(): void {
  let a = 0;
  for (let i = 0; i < 100; i++) a++;
  void a;
}

const avoidable: Case = {
  name: "avoidablePropagation",
  build(rx) {
    const head = rx.signal(0);
    const c1 = rx.computed(() => head.read());
    const c2 = rx.computed(() => (c1.read(), 0));
    const c3 = rx.computed(() => (busy(), c2.read() + 1));
    const c4 = rx.computed(() => c3.read() + 2);
    const c5 = rx.computed(() => c4.read() + 3);
    rx.effect(() => {
      c5.read();
      busy();
    });
    return () => {
      rx.withBatch(() => head.write(1));
      assert(c5.read() === 6);
      for (let i = 0; i < 1000; i++) {
        rx.withBatch(() => head.write(i));
        assert(c5.read() === 6);
      }
    };
  },
};

const broad: Case = {
  name: "broadPropagation",
  build(rx) {
    const head = rx.signal(0);
    let last = head as Computed<number>;
    let count = 0;
    for (let i = 0; i < 50; i++) {
      const current = rx.computed(() => head.read() + i);
      const current2 = rx.computed(() => current.read() + 1);
      rx.effect(() => {
        current2.read();
        count++;
      });
      last = current2;
    }
    return () => {
      rx.withBatch(() => head.write(1));
      const atleast = 50 * 50;
      count = 0;
      for (let i = 0; i < 50; i++) {
        rx.withBatch(() => head.write(i));
        assert(last.read() === i + 50);
      }
      assert(count === atleast, String(count));
    };
  },
};

const deep: Case = {
  name: "deepPropagation",
  build(rx) {
    const len = 50;
    const head = rx.signal(0);
    let current = head as Computed<number>;
    for (let i = 0; i < len; i++) {
      const c = current;
      current = rx.computed(() => c.read() + 1);
    }
    let count = 0;
    rx.effect(() => {
      current.read();
      count++;
    });
    const iter = 50;
    return () => {
      rx.withBatch(() => head.write(1));
      count = 0;
      for (let i = 0; i < iter; i++) {
        rx.withBatch(() => head.write(i));
        assert(current.read() === len + i);
      }
      assert(count === iter);
    };
  },
};

const diamond: Case = {
  name: "diamond",
  build(rx) {
    const width = 5;
    const head = rx.signal(0);
    const current: Computed<number>[] = [];
    for (let i = 0; i < width; i++) current.push(rx.computed(() => head.read() + 1));
    const sum = rx.computed(() => current.map(x => x.read()).reduce((a, b) => a + b, 0));
    let count = 0;
    rx.effect(() => {
      sum.read();
      count++;
    });
    return () => {
      rx.withBatch(() => head.write(1));
      assert(sum.read() === 2 * width);
      count = 0;
      for (let i = 0; i < 500; i++) {
        rx.withBatch(() => head.write(i));
        assert(sum.read() === (i + 1) * width);
      }
      assert(count === 500);
    };
  },
};

const mux: Case = {
  name: "mux",
  build(rx) {
    const heads = new Array(100).fill(null).map(() => rx.signal(0));
    const muxed = rx.computed(() => Object.fromEntries(heads.map(h => h.read()).entries()));
    const splited = heads
      .map((_, index) => rx.computed(() => muxed.read()[index]))
      .map(x => rx.computed(() => x.read() + 1));
    splited.forEach(x => rx.effect(() => x.read()));
    return () => {
      for (let i = 0; i < 10; i++) {
        rx.withBatch(() => heads[i].write(i));
        assert(splited[i].read() === i + 1);
      }
      for (let i = 0; i < 10; i++) {
        rx.withBatch(() => heads[i].write(i * 2));
        assert(splited[i].read() === i * 2 + 1);
      }
    };
  },
};

const repeated: Case = {
  name: "repeatedObservers",
  build(rx) {
    const size = 30;
    const head = rx.signal(0);
    const current = rx.computed(() => {
      let result = 0;
      for (let i = 0; i < size; i++) result += head.read();
      return result;
    });
    let count = 0;
    rx.effect(() => {
      current.read();
      count++;
    });
    return () => {
      rx.withBatch(() => head.write(1));
      assert(current.read() === size);
      count = 0;
      for (let i = 0; i < 100; i++) {
        rx.withBatch(() => head.write(i));
        assert(current.read() === i * size);
      }
      assert(count === 100);
    };
  },
};

const triangle: Case = {
  name: "triangle",
  build(rx) {
    const width = 10;
    const head = rx.signal(0);
    let current = head as Computed<number>;
    const list: Computed<number>[] = [];
    for (let i = 0; i < width; i++) {
      const c = current;
      list.push(current);
      current = rx.computed(() => c.read() + 1);
    }
    const sum = rx.computed(() => list.map(x => x.read()).reduce((a, b) => a + b, 0));
    let count = 0;
    rx.effect(() => {
      sum.read();
      count++;
    });
    const constant = Array.from({ length: width }, (_, i) => i + 1).reduce((x, y) => x + y, 0);
    return () => {
      rx.withBatch(() => head.write(1));
      assert(sum.read() === constant);
      count = 0;
      for (let i = 0; i < 100; i++) {
        rx.withBatch(() => head.write(i));
        assert(sum.read() === constant - width + i * width);
      }
      assert(count === 100);
    };
  },
};

const unstable: Case = {
  name: "unstable",
  build(rx) {
    const head = rx.signal(0);
    const double = rx.computed(() => head.read() * 2);
    const inverse = rx.computed(() => -head.read());
    const current = rx.computed(() => {
      let result = 0;
      for (let i = 0; i < 20; i++) result += head.read() % 2 ? double.read() : inverse.read();
      return result;
    });
    let count = 0;
    rx.effect(() => {
      current.read();
      count++;
    });
    return () => {
      rx.withBatch(() => head.write(1));
      assert(current.read() === 40);
      count = 0;
      for (let i = 0; i < 100; i++) rx.withBatch(() => head.write(i));
      assert(count === 100);
    };
  },
};

function fib(n: number): number {
  return n < 2 ? 1 : fib(n - 1) + fib(n - 2);
}
function hard(n: number): number {
  return n + fib(16);
}

const mol: Case = {
  name: "molBench",
  build(rx) {
    const numbers = Array.from({ length: 5 }, (_, i) => i);
    const res: number[] = [];
    const A = rx.signal(0);
    const B = rx.signal(0);
    const C = rx.computed(() => (A.read() % 2) + (B.read() % 2));
    const D = rx.computed(() => numbers.map(i => ({ x: i + (A.read() % 2) - (B.read() % 2) })));
    const E = rx.computed(() => hard(C.read() + A.read() + D.read()[0].x));
    const F = rx.computed(() => hard(D.read()[2].x || B.read()));
    const G = rx.computed(() => C.read() + (C.read() || E.read() % 2) + D.read()[4].x + F.read());
    rx.effect(() => res.push(hard(G.read())));
    rx.effect(() => res.push(G.read()));
    rx.effect(() => res.push(hard(F.read())));
    let i = 0;
    return () => {
      i++;
      res.length = 0;
      rx.withBatch(() => {
        B.write(1);
        A.write(1 + i * 2);
      });
      rx.withBatch(() => {
        A.write(2 + i * 2);
        B.write(2);
      });
    };
  },
};

export const kairoCases: Case[] = [
  avoidable,
  broad,
  deep,
  diamond,
  mux,
  repeated,
  triangle,
  unstable,
  mol,
];
